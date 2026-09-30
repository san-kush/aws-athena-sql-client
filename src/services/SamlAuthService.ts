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
        `--app=${targetUrl}`,
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
    let selectedRoleArn: string | undefined;
    let pollTimer: NodeJS.Timeout | null = null;

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
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
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
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
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
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
        await cleanup();
        safeReject(new Error('SAML login timed out after 5 minutes.'));
      }
    }, 5 * 60 * 1000);

    const assumeRole = async (roleArn: string, principalArn: string, samlAssertion: string) => {
      if (resolved) { log(`assumeRole skipped — already resolved (settled=${settled})`); return; }
      resolved = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
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
      // Channel 1: Native Puppeteer request listener (zero CDP overhead, 100% reliable)
      // Captures SAML assertion on IdP -> AWS POST, and captures chosen role on AWS SAML submit
      const attachedPages = new WeakSet();
      const attachPageListeners = (p: any) => {
        if (attachedPages.has(p)) return;
        attachedPages.add(p);

        p.on('request', async (req: any) => {
          if (resolved) return;
          try {
            const reqUrl = req.url();
            const method = req.method();

            if (reqUrl.includes('signin.aws.amazon.com/saml') && method === 'POST') {
              const postData = req.postData();
              if (!postData) return;

              const params = new URLSearchParams(postData);
              const rawSaml = params.get('SAMLResponse');
              const roleIndex = params.get('roleIndex');

              log(`Request listener: SAML POST detected (hasSaml=${!!rawSaml}, roleIndex=${roleIndex || 'none'})`);

              if (rawSaml) {
                capturedSaml = normalizeSamlBase64(rawSaml);
                availableRoles = parseRolesFromSaml(capturedSaml);
                log(`Request listener: parsed ${availableRoles.length} roles from SAML assertion`);

                // Single role auto-select
                if (availableRoles.length === 1 && !roleIndex) {
                  log(`Request listener: single role auto-select (${availableRoles[0].roleArn})`);
                  await assumeRole(availableRoles[0].roleArn, availableRoles[0].principalArn, capturedSaml);
                  return;
                }
              }

              // User selected a role and submitted form
              if (roleIndex && capturedSaml) {
                log(`Request listener: user submitted role ${roleIndex}`);
                const cleanArn = roleIndex.includes(':role/')
                  ? roleIndex.split(',').find((part: string) => part.includes(':role/')) || roleIndex
                  : roleIndex;
                const matched = availableRoles.find(r => r.roleArn === cleanArn || r.roleArn.endsWith(`/${cleanArn}`)) || availableRoles[0];
                if (matched) {
                  await assumeRole(matched.roleArn, matched.principalArn, capturedSaml);
                  return;
                }
              }
            }
          } catch (e: any) {
            log(`Request listener error (safe): ${e.message}`);
          }
        });
      };

      // Channel 2: DOM & Navigation Watcher (Backup for role clicks & Console navigation)
      let lastLoggedUrl = '';
      const checkState = async () => {
        if (resolved) return;
        try {
          const currentPages = await browser.pages();
          for (const p of currentPages) {
            attachPageListeners(p);

            let pageUrl = '';
            try { pageUrl = p.url(); } catch { continue; }

            if (pageUrl !== lastLoggedUrl && !pageUrl.startsWith('about:')) {
              lastLoggedUrl = pageUrl;
              log(`Browser navigated to: ${pageUrl.substring(0, 80)}`);
            }

            // Probe AWS SAML page for SAML assertion & role selection state
            if (pageUrl.includes('signin.aws.amazon.com/saml')) {
              try {
                const domData = await p.evaluate(`(() => {
                  if (!window.__athenaInjected) {
                    window.__athenaInjected = true;
                    window.__athenaSelectedRole = null;
                    document.addEventListener('change', (e) => {
                      if (e.target && e.target.name === 'roleIndex') window.__athenaSelectedRole = e.target.value;
                    }, true);
                  }
                  const samlEl = document.querySelector('input[name="SAMLResponse"]');
                  const checkedEl = document.querySelector('input[name="roleIndex"]:checked');
                  return {
                    saml: samlEl && samlEl.value ? samlEl.value : null,
                    checkedRole: window.__athenaSelectedRole || (checkedEl ? checkedEl.value : null)
                  };
                })()`) as { saml: string | null; checkedRole: string | null } | null;

                if (domData?.saml && !capturedSaml) {
                  capturedSaml = normalizeSamlBase64(domData.saml);
                  availableRoles = parseRolesFromSaml(capturedSaml);
                  log(`DOM watcher: captured SAML assertion (${capturedSaml.length} chars), found ${availableRoles.length} roles`);

                  if (availableRoles.length === 1) {
                    log(`DOM watcher: single role auto-select (${availableRoles[0].roleArn})`);
                    await assumeRole(availableRoles[0].roleArn, availableRoles[0].principalArn, capturedSaml);
                    return;
                  }
                }

                if (domData?.checkedRole && domData.checkedRole !== selectedRoleArn) {
                  selectedRoleArn = domData.checkedRole;
                  log(`DOM watcher: user selected role ${selectedRoleArn}`);
                }
              } catch {
                // DOM probe can throw if page is actively submitting/unloading
              }
            }

            // If browser reached AWS Console, finalize auth
            if (
              pageUrl.includes('.console.aws.amazon.com') ||
              pageUrl.includes('/console/home') ||
              pageUrl.includes('signin.aws.amazon.com/oauth')
            ) {
              if (capturedSaml && !resolved) {
                log(`Navigation watcher: detected AWS Console (${pageUrl.substring(0, 70)})`);

                let matchedRole: SamlRoleOption | undefined;
                if (selectedRoleArn) {
                  const cleanArn = selectedRoleArn.includes(':role/')
                    ? selectedRoleArn.split(',').find(part => part.includes(':role/')) || selectedRoleArn
                    : selectedRoleArn;
                  matchedRole = availableRoles.find(r => r.roleArn === cleanArn || r.roleArn.endsWith(`/${cleanArn}`));
                }
                if (!matchedRole && availableRoles.length > 0) {
                  matchedRole = availableRoles[0];
                  log(`Navigation watcher: defaulting to first role (${matchedRole.roleArn})`);
                }

                if (matchedRole) {
                  await assumeRole(matchedRole.roleArn, matchedRole.principalArn, capturedSaml);
                  return;
                }
              }
            }
          }
        } catch {
          // Page or browser momentarily busy
        }
      };

      // Attach to new targets immediately
      browser.on('targetcreated', async (t: any) => {
        if (t.type() === 'page') {
          try {
            const p = await t.page();
            if (p) attachPageListeners(p);
          } catch {}
        }
      });
      browser.on('targetchanged', async () => {
        await checkState();
      });

      // Sequential polling schedule (prevents overlapping CDP calls)
      const scheduleNextPoll = () => {
        if (resolved) return;
        pollTimer = setTimeout(async () => {
          await checkState();
          scheduleNextPoll();
        }, 300);
      };

      // Initialize listeners on existing pages and kick off watcher
      const initialPages = await browser.pages();
      initialPages.forEach(attachPageListeners);
      scheduleNextPoll();

      log('Setup complete — waiting for SAML login in browser...');
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
