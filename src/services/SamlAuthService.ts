import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import puppeteer, { Browser, HTTPRequest } from 'puppeteer-core';
import { STSClient, AssumeRoleWithSAMLCommand } from '@aws-sdk/client-sts';

export interface SamlRoleOption {
  roleArn: string;
  principalArn: string;
  accountNumber: string;
  roleName: string;
}

export interface SamlAuthResult {
  roleArn: string;
  principalArn: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  sessionExpiration: number;
}

/**
 * Searches the local machine for installed Chrome or Microsoft Edge executables.
 * Returns a list of all existing browser executable paths, prioritizing Google Chrome for CDP stability.
 */
export function findSystemBrowsers(): string[] {
  const candidates: string[] = [];

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    candidates.push(
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable'
    );
  }

  const existing: string[] = [];
  for (const p of candidates) {
    if (p && fs.existsSync(p) && !existing.includes(p)) {
      existing.push(p);
    }
  }
  return existing;
}

export function findSystemBrowser(): string | undefined {
  const browsers = findSystemBrowsers();
  return browsers.length > 0 ? browsers[0] : undefined;
}

/**
 * Launches an installed browser with fallback across all detected executables,
 * sanitizing environment variables to prevent Electron/VS Code conflicts.
 */
async function launchBrowserInstance(
  onProgress?: (message: string) => void
): Promise<{ browser: Browser; tempProfileDir: string; browserPath: string }> {
  const browsers = findSystemBrowsers();
  if (browsers.length === 0) {
    throw new Error('No compatible browser (Google Chrome or Microsoft Edge) found on your system.');
  }

  // Sanitize environment variables so Electron/VS Code specifics (e.g. ELECTRON_RUN_AS_NODE)
  // are not leaked into the spawned browser process.
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (
      v !== undefined &&
      !k.startsWith('ELECTRON_') &&
      !k.startsWith('VSCODE_') &&
      k !== 'NODE_OPTIONS' &&
      k !== 'CHROME_CRASHPAD_PIPE_NAME' &&
      k !== 'ORIGINAL_XDG_CURRENT_DESKTOP'
    ) {
      cleanEnv[k] = v;
    }
  }

  const launchErrors: string[] = [];

  for (const browserPath of browsers) {
    const isChrome = path.basename(browserPath).toLowerCase().includes('chrome');
    const browserName = isChrome ? 'Google Chrome' : 'Microsoft Edge';
    const tempProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-saml-'));

    try {
      if (onProgress) {
        onProgress(`Launching ${browserName} for SAML login...`);
      }

      const browser = await puppeteer.launch({
        executablePath: browserPath,
        headless: false,
        userDataDir: tempProfileDir,
        defaultViewport: null,
        dumpio: false,
        env: cleanEnv,
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
          '--no-first-run',
          '--no-default-browser-check',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-gpu',
          '--disable-dev-shm-usage',
          '--disable-background-networking',
          '--disable-background-mode',
          '--disable-features=msEdgeStartupBoost',
          '--window-size=1050,850'
        ]
      });

      return { browser, tempProfileDir, browserPath };
    } catch (err: any) {
      launchErrors.push(`${browserName} (${browserPath}): ${err.message}`);
      try {
        fs.rmSync(tempProfileDir, { recursive: true, force: true });
      } catch {}
      // If there are other browsers available, try the next one in the list
    }
  }

  throw new Error(`Failed to launch browser. Attempts:\n${launchErrors.join('\n')}`);
}

/**
 * Parses all available AWS Role and SAML Provider ARN pairs from a Base64-encoded SAML XML assertion.
 */
export function parseRolesFromSaml(samlBase64: string): SamlRoleOption[] {
  try {
    const xml = Buffer.from(samlBase64, 'base64').toString('utf-8');
    const roles: SamlRoleOption[] = [];
    const regex = /<[^>]*AttributeValue[^>]*>([\s\S]*?)<\/[^>]*AttributeValue>/gi;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(xml)) !== null) {
      const val = match[1].trim();
      if (val.includes(':role/') && val.includes(':saml-provider/')) {
        const parts = val.split(',').map(p => p.trim());
        const roleArn = parts.find(p => p.includes(':role/'));
        const principalArn = parts.find(p => p.includes(':saml-provider/'));
        if (roleArn && principalArn) {
          const roleParts = roleArn.split(':');
          const accountNumber = roleParts.length > 4 ? roleParts[4] : '';
          const roleName = roleArn.includes(':role/') ? roleArn.split(':role/')[1] : roleArn;
          roles.push({ roleArn, principalArn, accountNumber, roleName });
        }
      }
    }
    return roles;
  } catch {
    return [];
  }
}

/**
 * Executes an interactive browser SAML login:
 * 1. Launches local Chrome/Edge in a dedicated visible window.
 * 2. Navigates to the user's corporate SAML IdP URL.
 * 3. Listens for the SAML assertion POST to signin.aws.amazon.com/saml.
 * 4. Captures the chosen role (or auto-selects if only one role is present).
 * 5. Calls AWS STS AssumeRoleWithSAML to fetch temporary credentials.
 * 6. Automatically closes the browser window upon completion.
 */
export async function executeSamlLogin(
  samlUrl: string,
  region: string = 'us-east-1',
  onProgress?: (message: string) => void
): Promise<SamlAuthResult> {
  const { browser, tempProfileDir } = await launchBrowserInstance(onProgress);

  return new Promise<SamlAuthResult>(async (resolve, reject) => {
    let resolved = false;
    let capturedSaml: string | undefined;
    let availableRoles: SamlRoleOption[] = [];

    // Cleanup helper
    const cleanup = async () => {
      try {
        await browser.close();
      } catch {}
      try {
        fs.rmSync(tempProfileDir, { recursive: true, force: true });
      } catch {}
    };

    // If user closes browser window manually before completion
    browser.on('disconnected', () => {
      if (!resolved) {
        resolved = true;
        try {
          fs.rmSync(tempProfileDir, { recursive: true, force: true });
        } catch {}
        reject(new Error('SAML login was cancelled by closing the browser window.'));
      }
    });

    // Timeout after 5 minutes
    const timeoutTimer = setTimeout(async () => {
      if (!resolved) {
        resolved = true;
        await cleanup();
        reject(new Error('SAML login timed out after 5 minutes.'));
      }
    }, 5 * 60 * 1000);

    const assumeRole = async (roleArn: string, principalArn: string, samlAssertion: string) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutTimer);

      try {
        if (onProgress) {
          onProgress('Assuming IAM role via AWS STS...');
        }

        const sts = new STSClient({ region: region || 'us-east-1' });
        const response = await sts.send(
          new AssumeRoleWithSAMLCommand({
            RoleArn: roleArn,
            PrincipalArn: principalArn,
            SAMLAssertion: samlAssertion,
            DurationSeconds: 3600
          })
        );

        const creds = response.Credentials;
        if (!creds?.AccessKeyId || !creds?.SecretAccessKey || !creds?.SessionToken) {
          throw new Error('AWS STS did not return temporary credentials.');
        }

        if (onProgress) {
          onProgress('Login complete! Closing browser...');
        }

        await cleanup();

        resolve({
          roleArn,
          principalArn,
          accessKeyId: creds.AccessKeyId,
          secretAccessKey: creds.SecretAccessKey,
          sessionToken: creds.SessionToken,
          sessionExpiration: creds.Expiration ? creds.Expiration.getTime() : Date.now() + 3600 * 1000
        });
      } catch (err: any) {
        await cleanup();
        reject(err);
      }
    };

    try {
      const pages = await browser.pages();
      const page = pages.length > 0 ? pages[0] : await browser.newPage();

      // Enable request interception so we can read POST body data.
      // In puppeteer-core v25+, postData() returns null without this.
      await page.setRequestInterception(true);

      // Intercept network requests — MUST call request.continue() on every
      // request or the browser will hang (blank page) waiting for a response.
      page.on('request', async (req: HTTPRequest) => {
        if (resolved) {
          try { await req.continue(); } catch {}
          return;
        }

        const url = req.url();
        if (url.includes('signin.aws.amazon.com/saml') && req.method() === 'POST') {
          // Read POST body: try postData() first, fall back to fetchPostData()
          // for large payloads that aren't buffered inline.
          let postData = req.postData();
          if (!postData && req.hasPostData()) {
            try {
              postData = await req.fetchPostData() ?? undefined;
            } catch {}
          }

          if (postData) {
            const params = new URLSearchParams(postData);
            const saml = params.get('SAMLResponse');
            if (saml) {
              capturedSaml = saml;
              availableRoles = parseRolesFromSaml(saml);

              // If only one role exists, assume immediately
              if (availableRoles.length === 1) {
                try { await req.continue(); } catch {}
                await assumeRole(availableRoles[0].roleArn, availableRoles[0].principalArn, saml);
                return;
              }
            }

            // If user clicked a role on the AWS role selection page
            const roleIndex = params.get('roleIndex');
            if (roleIndex && capturedSaml) {
              const selectedRoleArn = roleIndex.includes(':role/')
                ? roleIndex.split(',').find(p => p.includes(':role/')) || roleIndex
                : roleIndex;
              const matched = availableRoles.find(r => r.roleArn === selectedRoleArn || r.roleArn.endsWith(`/${selectedRoleArn}`));
              if (matched) {
                try { await req.continue(); } catch {}
                await assumeRole(matched.roleArn, matched.principalArn, capturedSaml);
                return;
              } else if (availableRoles.length > 0) {
                const idx = parseInt(roleIndex, 10);
                if (!isNaN(idx) && availableRoles[idx]) {
                  try { await req.continue(); } catch {}
                  await assumeRole(availableRoles[idx].roleArn, availableRoles[idx].principalArn, capturedSaml);
                  return;
                } else if (!isNaN(idx) && availableRoles[idx - 1]) {
                  try { await req.continue(); } catch {}
                  await assumeRole(availableRoles[idx - 1].roleArn, availableRoles[idx - 1].principalArn, capturedSaml);
                  return;
                }
                try { await req.continue(); } catch {}
                await assumeRole(availableRoles[0].roleArn, availableRoles[0].principalArn, capturedSaml);
                return;
              }
            }
          }
        }

        // Allow the request to proceed — critical for page navigation to work
        try { await req.continue(); } catch {}
      });

      if (onProgress) {
        onProgress('Navigating to SAML login URL...');
      }

      await page.goto(samlUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (err: any) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutTimer);
        await cleanup();
        reject(err);
      }
    }
  });
}
