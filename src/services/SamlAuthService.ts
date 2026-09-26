import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import puppeteer, { Browser } from 'puppeteer-core';
import type { CDPSession } from 'puppeteer-core';
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
      path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')
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
 * Uses --app=${targetUrl} so it opens directly as an identified application window
 * in Windows with taskbar icon, window title, and direct rendering (avoiding blank window).
 */
async function launchBrowserInstance(
  targetUrl: string,
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

      const args = [
        '--window-size=1050,850',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=msEdgeStartupBoost'
      ];
      if (isChrome && process.platform === 'win32') {
        args.push('--disable-gpu');
      }

      const browser = await puppeteer.launch({
        executablePath: browserPath,
        headless: false,
        userDataDir: tempProfileDir,
        defaultViewport: null,
        dumpio: false,
        env: cleanEnv,
        ignoreDefaultArgs: ['--enable-automation'],
        args
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
 * Normalizes a Base64 SAML string by converting any spaces (' ') back to '+'.
 * In application/x-www-form-urlencoded POST data or URL decoding, '+' is often
 * converted to spaces, which corrupts Base64 decoding.
 */
export function normalizeSamlBase64(saml: string): string {
  if (!saml) return '';
  const trimmed = saml.trim();
  return trimmed.replace(/\s+/g, '+');
}

/**
 * Parses all available AWS Role and SAML Provider ARN pairs from a Base64-encoded SAML XML assertion.
 */
export function parseRolesFromSaml(samlBase64: string): SamlRoleOption[] {
  try {
    const cleaned = normalizeSamlBase64(samlBase64);
    const xml = Buffer.from(cleaned, 'base64').toString('utf-8');
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
 * 3. Passively monitors network traffic via CDP for the SAML assertion POST to signin.aws.amazon.com/saml.
 * 4. Captures the chosen role (or auto-selects if only one role is present).
 * 5. Calls AWS STS AssumeRoleWithSAML to fetch temporary credentials.
 * 6. Automatically closes the browser window upon completion.
 */
export async function executeSamlLogin(
  samlUrl: string,
  region: string = 'us-east-1',
  onProgress?: (message: string) => void
): Promise<SamlAuthResult> {
  let normalizedUrl = (samlUrl || '').trim();
  if (!/^(https?|file):\/\//i.test(normalizedUrl)) {
    if (/^[a-zA-Z]:[\\/]/.test(normalizedUrl)) {
      normalizedUrl = 'file:///' + normalizedUrl.replace(/\\/g, '/');
    } else {
      normalizedUrl = 'https://' + normalizedUrl;
    }
  }

  const { browser, tempProfileDir } = await launchBrowserInstance(normalizedUrl, onProgress);

  return new Promise<SamlAuthResult>(async (resolve, reject) => {
    let resolved = false;
    let settled = false; // tracks whether resolve/reject has actually been called
    let capturedSaml: string | undefined;
    let availableRoles: SamlRoleOption[] = [];

    const log = (msg: string) => {
      if (onProgress) { onProgress(msg); }
      console.log(`[Athena SAML] ${msg}`);
    };

    // Safe wrappers to guarantee the promise settles exactly once
    const safeResolve = (result: SamlAuthResult) => {
      if (settled) { console.log('[Athena SAML] safeResolve skipped — already settled'); return; }
      settled = true;
      log(`✅ Resolving with role ${result.roleArn}`);
      resolve(result);
    };
    const safeReject = (err: Error) => {
      if (settled) { console.log('[Athena SAML] safeReject skipped — already settled'); return; }
      settled = true;
      log(`❌ Rejecting: ${err.message}`);
      reject(err);
    };

    // Cleanup helper
    const cleanup = async () => {
      try {
        log('Cleanup: closing browser...');
        await browser.close();
        log('Cleanup: browser closed');
      } catch (e: any) {
        log(`Cleanup: browser.close() error (safe to ignore): ${e.message}`);
      }
      try {
        fs.rmSync(tempProfileDir, { recursive: true, force: true });
      } catch {}
    };

    // If user closes browser window manually before completion
    browser.on('disconnected', () => {
      log(`Browser disconnected event — resolved=${resolved}, settled=${settled}`);
      if (!resolved) {
        resolved = true;
        try {
          fs.rmSync(tempProfileDir, { recursive: true, force: true });
        } catch {}
        safeReject(new Error('SAML login was cancelled by closing the browser window.'));
      } else if (!settled) {
        // Safety net: resolved was set (assumeRole started) but promise never settled
        // This can happen if STS call hangs or cleanup throws before resolve/reject
        log('⚠️ Safety net: browser disconnected while assumeRole was in-flight, settling as error');
        safeReject(new Error('Browser closed before SAML authentication could complete.'));
      }
    });

    // Timeout after 5 minutes
    const timeoutTimer = setTimeout(async () => {
      if (!resolved) {
        resolved = true;
        await cleanup();
        safeReject(new Error('SAML login timed out after 5 minutes.'));
      }
    }, 5 * 60 * 1000);

    const assumeRole = async (roleArn: string, principalArn: string, samlAssertion: string) => {
      if (resolved) { log(`assumeRole skipped — already resolved (settled=${settled})`); return; }
      resolved = true;
      clearTimeout(timeoutTimer);

      log(`assumeRole called: role=${roleArn}, principal=${principalArn}, assertionLen=${samlAssertion.length}`);

      try {
        log('Creating STS client...');
        const cleanAssertion = normalizeSamlBase64(samlAssertion);
        const sts = new STSClient({ region: region || 'us-east-1' });
        log(`Calling AssumeRoleWithSAML (region=${region || 'us-east-1'})...`);
        const response = await sts.send(
          new AssumeRoleWithSAMLCommand({
            RoleArn: roleArn,
            PrincipalArn: principalArn,
            SAMLAssertion: cleanAssertion,
            DurationSeconds: 3600
          })
        );
        log('STS call succeeded!');

        const creds = response.Credentials;
        if (!creds?.AccessKeyId || !creds?.SecretAccessKey || !creds?.SessionToken) {
          throw new Error('AWS STS did not return temporary credentials.');
        }

        log('Credentials received, closing browser...');
        await cleanup();
        safeResolve({
          roleArn,
          principalArn,
          accessKeyId: creds.AccessKeyId,
          secretAccessKey: creds.SecretAccessKey,
          sessionToken: creds.SessionToken,
          sessionExpiration: creds.Expiration ? creds.Expiration.getTime() : Date.now() + 3600 * 1000
        });
      } catch (err: any) {
        log(`assumeRole ERROR: ${err.message}`);
        try { await cleanup(); } catch (cleanupErr: any) {
          log(`Cleanup during error also failed: ${cleanupErr.message}`);
        }
        safeReject(err);
      }
    };

    try {
      const pages = await browser.pages();
      const page = pages.length > 0 ? pages[0] : await browser.newPage();

      // Channel 1: In-page DOM form submit listener via exposed function
      await page.exposeFunction('__athenaOnSamlSubmit', (data: { saml?: string; selectedRole?: string }) => {
        log(`DOM channel fired: saml=${data?.saml ? `${data.saml.length} chars` : 'NONE'}, selectedRole=${data?.selectedRole || 'NONE'}, resolved=${resolved}`);
        if (resolved || !data || !data.saml) {
          log('DOM channel: skipping (resolved or no SAML data)');
          return;
        }
        const saml = normalizeSamlBase64(data.saml);
        capturedSaml = saml;
        availableRoles = parseRolesFromSaml(saml);
        log(`DOM channel: parsed ${availableRoles.length} roles`);

        if (data.selectedRole) {
          const selectedRoleArn = data.selectedRole.includes(':role/')
            ? data.selectedRole.split(',').find(p => p.includes(':role/')) || data.selectedRole
            : data.selectedRole;
          log(`DOM channel: selectedRole parsed as ${selectedRoleArn}`);
          const matched = availableRoles.find(r => r.roleArn === selectedRoleArn || r.roleArn.endsWith(`/${selectedRoleArn}`));
          if (matched) {
            log(`DOM channel: matched role ${matched.roleArn}, calling assumeRole`);
            assumeRole(matched.roleArn, matched.principalArn, saml).catch(e => log(`DOM assumeRole floating rejection (safe): ${e.message}`));
            return;
          } else if (availableRoles.length > 0) {
            log(`DOM channel: no exact match, falling back to first role ${availableRoles[0].roleArn}`);
            assumeRole(availableRoles[0].roleArn, availableRoles[0].principalArn, saml).catch(e => log(`DOM assumeRole floating rejection (safe): ${e.message}`));
            return;
          }
        } else if (availableRoles.length === 1) {
          log(`DOM channel: single role, auto-selecting ${availableRoles[0].roleArn}`);
          assumeRole(availableRoles[0].roleArn, availableRoles[0].principalArn, saml).catch(e => log(`DOM assumeRole floating rejection (safe): ${e.message}`));
          return;
        } else if (availableRoles.length > 1) {
          log(`DOM channel: ${availableRoles.length} roles, waiting for user to pick one`);
        }
      });

      // Inject DOM interceptor on every new document (persists across navigations)
      await page.evaluateOnNewDocument(`
        (function() {
          function attachListeners() {
            var forms = document.querySelectorAll('form');
            forms.forEach(function(form) {
              form.addEventListener('submit', function() {
                var samlInput = form.querySelector('input[name="SAMLResponse"]');
                var roleInput = form.querySelector('input[name="roleIndex"]:checked') ||
                                form.querySelector('input[name="roleIndex"]');
                if (samlInput && samlInput.value && window.__athenaOnSamlSubmit) {
                  window.__athenaOnSamlSubmit({
                    saml: samlInput.value,
                    selectedRole: roleInput ? roleInput.value : undefined
                  });
                }
              }, true);
            });

            var signinBtn = document.querySelector('#signin_button, button[type=submit], input[type=submit]');
            if (signinBtn) {
              signinBtn.addEventListener('click', function() {
                var samlInput = document.querySelector('input[name="SAMLResponse"]');
                var roleInput = document.querySelector('input[name="roleIndex"]:checked');
                if (samlInput && samlInput.value && window.__athenaOnSamlSubmit) {
                  window.__athenaOnSamlSubmit({
                    saml: samlInput.value,
                    selectedRole: roleInput ? roleInput.value : undefined
                  });
                }
              }, true);
            }
          }

          if (document.readyState === 'loading') {
            window.addEventListener('DOMContentLoaded', attachListeners);
          } else {
            attachListeners();
          }
        })();
      `);

      // Passively monitor page frame navigations to detect AWS role selection page
      page.on('framenavigated', async (frame) => {
        if (resolved || frame !== page.mainFrame()) return;
        const frameUrl = frame.url();
        log(`Frame navigated: ${frameUrl.substring(0, 80)}`);
        if (frameUrl.includes('signin.aws.amazon.com/saml')) {
          try {
            const domSaml = await page.evaluate(
              'document.querySelector("input[name=\\"SAMLResponse\\"]") ? document.querySelector("input[name=\\"SAMLResponse\\"]").value : null'
            ) as string | null;
            log(`Frame nav DOM probe: saml=${domSaml ? `${domSaml.length} chars` : 'null'}, capturedSaml=${capturedSaml ? 'yes' : 'no'}`);
            if (domSaml && !capturedSaml) {
              capturedSaml = normalizeSamlBase64(domSaml);
              availableRoles = parseRolesFromSaml(capturedSaml);
              log(`Frame nav: parsed ${availableRoles.length} roles`);
              if (availableRoles.length === 1) {
                assumeRole(availableRoles[0].roleArn, availableRoles[0].principalArn, capturedSaml).catch(e => log(`Frame assumeRole floating rejection (safe): ${e.message}`));
              } else if (availableRoles.length > 1) {
                log(`Frame nav: multiple roles, waiting for selection`);
              }
            }
          } catch (e: any) {
            log(`Frame nav DOM probe error (safe): ${e.message}`);
          }
        }
      });

      // Channel 2: Passive CDP Network events (backup for network-level capture)
      const cdpSession: CDPSession = await page.createCDPSession();
      await cdpSession.send('Network.enable');

      cdpSession.on('Network.requestWillBeSent', async (event: any) => {
        if (resolved) return;

        const url: string = event.request?.url || '';
        const method: string = event.request?.method || '';
        let postData: string | undefined = event.request?.postData;

        if (url.includes('signin.aws.amazon.com/saml') && method === 'POST') {
          log(`CDP channel: POST to signin.aws.amazon.com/saml detected (postData=${postData ? `${postData.length} chars` : 'none'}, hasPostData=${event.request?.hasPostData})`);
          // If postData was omitted in the event, fetch it via CDP
          if (!postData && event.request?.hasPostData) {
            try {
              const res = await cdpSession.send('Network.getRequestPostData', { requestId: event.requestId });
              postData = res.postData;
              log(`CDP channel: fetched postData via getRequestPostData (${postData?.length || 0} chars)`);
            } catch (e: any) {
              log(`CDP channel: getRequestPostData failed: ${e.message}`);
            }
          }

          if (postData) {
            const params = new URLSearchParams(postData);
            const rawSaml = params.get('SAMLResponse');
            const roleIndex = params.get('roleIndex');
            log(`CDP channel: SAMLResponse=${rawSaml ? `${rawSaml.length} chars` : 'none'}, roleIndex=${roleIndex || 'none'}`);

            if (rawSaml) {
              const saml = normalizeSamlBase64(rawSaml);
              capturedSaml = saml;
              availableRoles = parseRolesFromSaml(saml);
              log(`CDP channel: parsed ${availableRoles.length} roles from SAMLResponse`);

              // If only one role exists, assume immediately
              if (availableRoles.length === 1) {
                log(`CDP channel: single role, auto-selecting ${availableRoles[0].roleArn}`);
                assumeRole(availableRoles[0].roleArn, availableRoles[0].principalArn, saml).catch(e => log(`CDP assumeRole floating rejection (safe): ${e.message}`));
                return;
              } else if (availableRoles.length > 1) {
                log(`CDP channel: ${availableRoles.length} roles, waiting for selection`);
              }
            }

            // If user clicked a role on the AWS role selection page
            if (roleIndex && capturedSaml) {
              log(`CDP channel: role selection detected, roleIndex=${roleIndex}`);
              const selectedRoleArn = roleIndex.includes(':role/')
                ? roleIndex.split(',').find(p => p.includes(':role/')) || roleIndex
                : roleIndex;
              const matched = availableRoles.find(r => r.roleArn === selectedRoleArn || r.roleArn.endsWith(`/${selectedRoleArn}`));
              if (matched) {
                log(`CDP channel: matched role ${matched.roleArn}, calling assumeRole`);
                assumeRole(matched.roleArn, matched.principalArn, capturedSaml).catch(e => log(`CDP assumeRole floating rejection (safe): ${e.message}`));
                return;
              } else if (availableRoles.length > 0) {
                const idx = parseInt(roleIndex, 10);
                if (!isNaN(idx) && availableRoles[idx]) {
                  log(`CDP channel: using numeric index ${idx}`);
                  assumeRole(availableRoles[idx].roleArn, availableRoles[idx].principalArn, capturedSaml).catch(e => log(`CDP assumeRole floating rejection (safe): ${e.message}`));
                  return;
                } else if (!isNaN(idx) && availableRoles[idx - 1]) {
                  log(`CDP channel: using numeric index ${idx - 1} (adjusted)`);
                  assumeRole(availableRoles[idx - 1].roleArn, availableRoles[idx - 1].principalArn, capturedSaml).catch(e => log(`CDP assumeRole floating rejection (safe): ${e.message}`));
                  return;
                }
                log(`CDP channel: no index match, falling back to first role`);
                assumeRole(availableRoles[0].roleArn, availableRoles[0].principalArn, capturedSaml).catch(e => log(`CDP assumeRole floating rejection (safe): ${e.message}`));
                return;
              }
            }
          }
        }
      });

      log('Navigating to SAML login URL...');

      // Always navigate even if --app already loaded the URL, to ensure
      // puppeteer fully owns the page lifecycle and CDP events fire properly.
      await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      log('Page navigation complete');
    } catch (err: any) {
      log(`Setup error: ${err.message}`);
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutTimer);
        await cleanup();
        safeReject(err);
      }
    }
  });
}
