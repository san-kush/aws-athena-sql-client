import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, type ChildProcess } from 'child_process';
import puppeteer, { Browser } from 'puppeteer-core';
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
 * Kills a browser process and its children.
 *
 * Needed because the browser is spawned detached and attached to over CDP, so
 * Browser.process() is null and puppeteer cannot kill it for us.
 */
function killProcessTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' }).unref();
    } else {
      // Detached spawn puts the child in its own process group.
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

/**
 * Kills any browser process still using the given profile directory.
 *
 * The spawned process is not always the surviving browser process - Edge in
 * particular relaunches itself and the original child exits immediately - so
 * killing the recorded pid alone can leave an orphaned window on screen. The
 * temp profile path is unique per login, which makes it a reliable way to find
 * every process belonging to this launch and nothing else.
 */
function killBrowsersUsingProfile(profileDir: string): void {
  if (!profileDir) { return; }
  try {
    if (process.platform === 'win32') {
      const escaped = profileDir.replace(/'/g, "''");
      // Match only browser executables, and never this PowerShell process: the
      // profile path appears in its own command line, so an unfiltered match
      // would have it terminate itself before doing the work.
      spawn('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Where-Object { ' +
          '$_.ProcessId -ne $PID -and ' +
          "($_.Name -eq 'chrome.exe' -or $_.Name -eq 'msedge.exe') -and " +
          `$_.CommandLine -like '*${escaped}*' ` +
        '} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
      ], { stdio: 'ignore' }).unref();
    } else {
      spawn('pkill', ['-f', `(chrome|chromium|msedge|Microsoft Edge).*${profileDir}`], { stdio: 'ignore' }).unref();
    }
  } catch {}
}

/**
 * Best-effort sweep of profile directories left behind by earlier logins.
 *
 * A login that is killed off abruptly can leave its temp profile on disk. Only
 * directories older than an hour are touched, so a concurrent login is never
 * disturbed.
 */
function sweepStaleProfiles(): void {
  try {
    const tmp = os.tmpdir();
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const entry of fs.readdirSync(tmp)) {
      if (!entry.startsWith('athena-saml-')) { continue; }
      const full = path.join(tmp, entry);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.rmSync(full, { recursive: true, force: true });
        }
      } catch {}
    }
  } catch {}
}

/**
 * Deletes a temp profile directory, retrying briefly.
 *
 * Immediately after the browser is told to close it may still hold files in the
 * profile open, so a single attempt can fail and leave the directory behind.
 */
async function removeProfileDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!fs.existsSync(dir)) { return; }
    } catch {}
    await new Promise(r => setTimeout(r, 400));
  }
}

/**
 * Resolves the browser's CDP websocket endpoint by reading the
 * DevToolsActivePort file the browser writes into its profile directory.
 *
 * Deliberately avoids HTTP. Querying /json/version looked fine in a plain node
 * process but failed inside the VS Code extension host with "Unexpected end of
 * JSON input": the extension host installs its own proxy handling over Node's
 * http module, so a request meant for 127.0.0.1 does not necessarily arrive
 * there. Reading the file is also how puppeteer itself discovers the endpoint,
 * and it lets the browser choose its own port (--remote-debugging-port=0),
 * which removes the race in reserving one up front.
 */
async function readDevToolsEndpoint(
  profileDir: string,
  child: ChildProcess,
  timeoutMs: number
): Promise<string> {
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  let exitedAt = 0;

  while (Date.now() < deadline) {
    try {
      const raw = fs.readFileSync(portFile, 'utf-8');
      const lines = raw.split('\n');
      const port = Number((lines[0] || '').trim());
      const wsPath = (lines[1] || '').trim();
      if (port > 0 && wsPath) {
        return `ws://127.0.0.1:${port}${wsPath}`;
      }
    } catch {
      // Not written yet.
    }

    // The launcher process exiting is not instantly fatal (some builds relaunch
    // themselves), but if nothing appears shortly after, give up.
    if (child.exitCode !== null || child.signalCode !== null) {
      if (!exitedAt) {
        exitedAt = Date.now();
      } else if (Date.now() - exitedAt > 4000) {
        throw new Error(
          `the browser process exited (code ${child.exitCode}) without exposing its debugging endpoint`
        );
      }
    }

    await new Promise(r => setTimeout(r, 150));
  }

  throw new Error(
    'the browser did not write a DevToolsActivePort file, so it never exposed its ' +
    'debugging endpoint (remote debugging may be disabled by group policy)'
  );
}

/**
 * Starts a browser for the login and attaches to it over CDP.
 *
 * The browser is spawned detached with its stdio ignored, then attached to via
 * puppeteer.connect, rather than using puppeteer.launch.
 *
 * This is not incidental. puppeteer.launch spawns the browser as an attached
 * child with piped stdio; done from the VS Code extension host that produces a
 * browser whose window never presents a frame. Everything else works - CDP
 * responds, navigation reports HTTP 200, and Page.captureScreenshot returns the
 * correctly rendered page - but nothing is ever drawn on screen, so the user
 * sees only a blank white rectangle with no tab strip or address bar. Spawning
 * it the way a normal application launch does and connecting over the debugging
 * port renders correctly. Request interception, which is what captures the SAML
 * assertion, works identically over connect().
 *
 * The login URL is passed on the browser's command line so the first navigation
 * is performed by the browser itself; see the note beside it below.
 */
async function launchBrowserInstance(
  targetUrl: string,
  onProgress?: (message: string) => void
): Promise<{ browser: Browser; tempProfileDir: string; browserPath: string; child: ChildProcess }> {
  const browsers = findSystemBrowsers();
  if (browsers.length === 0) {
    throw new Error('No compatible browser (Google Chrome or Microsoft Edge) found on your system.');
  }

  sweepStaleProfiles();

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

  for (let i = 0; i < browsers.length; i++) {
    const browserPath = browsers[i];
    const isChrome = path.basename(browserPath).toLowerCase().includes('chrome');
    const browserName = isChrome ? 'Google Chrome' : 'Microsoft Edge';
    const tempProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-saml-'));
    let child: ChildProcess | undefined;
    let windowWasShown = false;

    try {
      if (onProgress) {
        onProgress(`Launching ${browserName} for SAML login...`);
      }

      const args = [
        `--user-data-dir=${tempProfileDir}`,
        // Let the browser pick the port and report it back via
        // DevToolsActivePort, rather than reserving one here and hoping it is
        // still free by the time the browser binds it.
        '--remote-debugging-port=0',
        '--window-size=1050,850',
        '--window-position=80,60',
        '--no-first-run',
        '--no-default-browser-check',
        // On a fresh profile the browser otherwise phones home and opens a
        // forced "Sign in to Chrome" tab in the foreground, which covers the
        // login page with a blank page.
        '--disable-background-networking',
        '--disable-background-mode',
        '--disable-sync',
        // The window opens behind VS Code; don't let the renderer be throttled
        // or left unpainted while it is unfocused or occluded.
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=msEdgeStartupBoost',
        // The login URL is given to the browser on its command line rather than
        // navigated to over CDP. Right after connect() a page target can exist
        // while still reporting an empty url, and calling goto() on a target in
        // that state hangs silently - the window sits on about:blank forever and
        // nothing reports an error. Letting the browser do the first navigation
        // itself removes that race. The caller still attaches its listeners
        // within a second or so, long before any interactive login can finish,
        // and the DOM watcher covers the assertion either way.
        targetUrl
      ];

      child = spawn(browserPath, args, {
        detached: true,
        stdio: 'ignore',
        env: cleanEnv
      });
      // Don't hold the extension host's event loop open on the browser.
      child.unref();

      child.on('error', err => {
        console.log(`[Athena SAML] Browser process error: ${err.message}`);
      });

      // Distinguish "this executable cannot start at all" from "it started and
      // is showing the user a login page". Only the former may fall through to
      // another browser; once a window is up, the user may already be typing
      // into it and must never be sent to a second browser to start over.
      const spawnFailure = await new Promise<Error | undefined>(resolve => {
        const onError = (e: Error) => resolve(e);
        child!.once('error', onError);
        setTimeout(() => {
          child!.removeListener('error', onError);
          resolve(undefined);
        }, 800);
      });
      if (spawnFailure) {
        throw Object.assign(spawnFailure, { spawnFailed: true });
      }
      windowWasShown = true;

      // 20s is generous: the port file normally appears in well under a second.
      // It must also stay short, because this runs while the login window is
      // already on screen and a failure here closes it.
      const wsEndpoint = await readDevToolsEndpoint(tempProfileDir, child, 20000);

      const browser = await puppeteer.connect({
        browserWSEndpoint: wsEndpoint,
        defaultViewport: null
      });

      return { browser, tempProfileDir, browserPath, child };
    } catch (err: any) {
      launchErrors.push(`${browserName}: ${err.message}`);

      if (child && child.pid) {
        killProcessTree(child.pid);
      }
      // Also clear anything still holding this profile, so a window the user can
      // see is never left behind.
      killBrowsersUsingProfile(tempProfileDir);
      await removeProfileDir(tempProfileDir);

      const canTryAnother = !windowWasShown && i < browsers.length - 1;
      if (!canTryAnother) {
        throw new Error(
          `Could not start ${browserName} for the SAML login: ${err.message}`
        );
      }
      // The executable never started, so nothing was shown to the user; it is
      // safe to try the next installed browser.
    }
  }

  throw new Error(`Could not start a browser for the SAML login.\n${launchErrors.join('\n')}`);
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

  const { browser, tempProfileDir, child: browserProcess } =
    await launchBrowserInstance(normalizedUrl, onProgress);

  return new Promise<SamlAuthResult>(async (resolve, reject) => {
    let resolved = false;
    let settled = false; // tracks whether resolve/reject has actually been called
    let teardownStarted = false; // true once *we* initiate the browser shutdown
    let capturedSaml: string | undefined;
    let availableRoles: SamlRoleOption[] = [];
    let selectedRoleArn: string | undefined;
    let pollTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const log = (msg: string) => {
      if (onProgress) { onProgress(msg); }
      console.log(`[Athena SAML] ${msg}`);
    };

    const stopPolling = () => {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };

    const stopTimers = () => {
      stopPolling();
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };

    // Safe wrappers to guarantee the promise settles exactly once
    const safeResolve = (result: SamlAuthResult) => {
      if (settled) { console.log('[Athena SAML] safeResolve skipped — already settled'); return; }
      settled = true;
      stopTimers();
      log(`✅ Resolving with role ${result.roleArn}`);
      resolve(result);
    };
    const safeReject = (err: Error) => {
      if (settled) { console.log('[Athena SAML] safeReject skipped — already settled'); return; }
      settled = true;
      stopTimers();
      log(`❌ Rejecting: ${err.message}`);
      reject(err);
    };

    /**
     * Closes the browser and removes the temp profile.
     *
     * `teardownStarted` is set synchronously *before* browser.close() so the
     * 'disconnected' handler can tell an intentional shutdown apart from the
     * user closing the window. Without that distinction the disconnect fired by
     * our own close() settles the promise as an error and the real result
     * (including a successful set of credentials) is thrown away.
     *
     * The close is also bounded: a page with a beforeunload handler can stall
     * Browser.close indefinitely, so fall back to killing the process.
     */
    const teardown = async () => {
      if (teardownStarted) { return; }
      teardownStarted = true;
      stopTimers();

      try {
        log('Cleanup: closing browser...');
        await Promise.race([
          browser.close(),
          new Promise<void>(r => setTimeout(r, 5000))
        ]);
        log('Cleanup: browser closed');
      } catch (e: any) {
        log(`Cleanup: browser.close() error (safe to ignore): ${e.message}`);
      }

      // The browser was spawned detached, so puppeteer has no handle on the
      // process. Make sure it is really gone before deleting its profile.
      try {
        if (browserProcess.pid && browserProcess.exitCode === null && !browserProcess.killed) {
          log('Cleanup: browser still running, killing process tree');
          killProcessTree(browserProcess.pid);
          await new Promise<void>(r => setTimeout(r, 600));
        }
      } catch {}

      // Belt and braces: the spawned pid is not always the surviving browser
      // process, so sweep anything still using this login's profile. Without
      // this an orphaned window can be left on screen with no way to close it
      // from the extension.
      killBrowsersUsingProfile(tempProfileDir);
      await removeProfileDir(tempProfileDir);
    };

    // The browser is spawned with stdio ignored (piping it is part of what
    // breaks on-screen rendering), so log process exit instead.
    browserProcess.on('exit', (code, signal) => {
      log(`Browser process exited (code=${code}, signal=${signal})`);
    });

    // If the user closes the browser window manually before completion
    browser.on('disconnected', () => {
      log(`Browser disconnected event — resolved=${resolved}, settled=${settled}, teardownStarted=${teardownStarted}`);

      if (teardownStarted) {
        // We asked for this close. The result is delivered by whoever called teardown().
        return;
      }

      // Only stop polling here: the 5 minute backstop must stay armed in case an
      // in-flight STS call never returns.
      stopPolling();
      // The browser is exiting and may still hold profile files open, so this
      // runs in the background with retries rather than blocking the handler.
      void removeProfileDir(tempProfileDir);

      if (!resolved) {
        resolved = true;
        safeReject(new Error('SAML login was cancelled by closing the browser window.'));
      } else {
        // A role was already chosen and the STS call is in flight. That call does
        // not need the browser, so let it finish and report the real outcome; the
        // 5 minute timer remains the backstop if it never returns.
        log('Browser closed while the STS call was in flight — waiting for it to finish');
      }
    });

    // Timeout after 5 minutes. Keyed on `settled`, not `resolved`, so a hung STS
    // call cannot leave the caller waiting forever.
    timeoutTimer = setTimeout(async () => {
      if (settled) { return; }
      resolved = true;
      await teardown();
      safeReject(new Error('SAML login timed out after 5 minutes.'));
    }, 5 * 60 * 1000);

    const assumeRole = async (roleArn: string, principalArn: string, samlAssertion: string) => {
      if (resolved) { log(`assumeRole skipped — already resolved (settled=${settled})`); return; }
      resolved = true;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      // The 5 minute timer stays armed until the promise settles so a hung STS
      // call still surfaces an error instead of hanging the caller.

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

        const authResult: SamlAuthResult = {
          roleArn,
          principalArn,
          accessKeyId: creds.AccessKeyId,
          secretAccessKey: creds.SecretAccessKey,
          sessionToken: creds.SessionToken,
          sessionExpiration: creds.Expiration ? creds.Expiration.getTime() : Date.now() + 3600 * 1000
        };

        log('Credentials received, closing browser...');
        await teardown();
        safeResolve(authResult);
      } catch (err: any) {
        log(`assumeRole ERROR: ${err.message}`);
        try { await teardown(); } catch (cleanupErr: any) {
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

        // A renderer crash closes the window while the browser process keeps
        // running, so no 'disconnected' ever fires. Without this the login would
        // wait for the full 5 minutes with nothing on screen.
        p.on('error', (err: any) => {
          log(`⚠️ Browser page crashed: ${err?.message || err}`);
          if (!resolved) {
            resolved = true;
            void teardown().then(() => {
              safeReject(new Error(
                'The SAML login window crashed before login completed. Please try again.'
              ));
            });
          }
        });

        // Surface failed top-level navigations: a blank window is usually a
        // proxy, DNS or certificate failure, which is otherwise invisible.
        p.on('requestfailed', (req: any) => {
          try {
            const f = req.frame();
            if (f && !f.parentFrame() && req.isNavigationRequest()) {
              log(`⚠️ Navigation failed: ${req.url().substring(0, 90)} — ${req.failure()?.errorText}`);
            }
          } catch {}
        });

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
      let sawAnyPage = false;
      let emptyPolls = 0;
      // The browser performs the first navigation itself, so a DNS/proxy/TLS
      // failure shows up as the browser's own error page rather than a thrown
      // error. Watch for that page for the first few seconds and report it.
      let errorPageChecks = 0;
      const maxErrorPageChecks = 40; // ~12s at the 300ms poll interval
      const checkState = async () => {
        if (resolved) return;
        try {
          const currentPages = await browser.pages();

          // Liveness watchdog. If every window goes away while the browser
          // process stays alive (renderer crash, or the last window being
          // closed without the process exiting) no 'disconnected' event fires,
          // and the login would otherwise hang until the 5 minute timeout.
          if (currentPages.length === 0) {
            if (sawAnyPage && ++emptyPolls >= 3) {
              log('⚠️ All browser windows are gone but the browser process is still alive');
              resolved = true;
              await teardown();
              safeReject(new Error(
                'The SAML login window was closed before login completed.'
              ));
              return;
            }
          } else {
            sawAnyPage = true;
            emptyPolls = 0;
          }

          for (const p of currentPages) {
            attachPageListeners(p);

            let pageUrl = '';
            try { pageUrl = p.url(); } catch { continue; }

            if (pageUrl !== lastLoggedUrl && !pageUrl.startsWith('about:')) {
              lastLoggedUrl = pageUrl;
              log(`Browser navigated to: ${pageUrl.substring(0, 80)}`);
            }

            // Did the browser fail to reach the identity provider at all?
            if (errorPageChecks < maxErrorPageChecks && pageUrl && !pageUrl.startsWith('about:')) {
              errorPageChecks++;
              try {
                const netError = await p.evaluate(`(() => {
                  if (!document.querySelector('#main-frame-error')) return null;
                  const code = document.querySelector('.error-code');
                  return (code && code.textContent ? code.textContent.trim() : '') || 'unknown error';
                })()`) as string | null;

                if (netError) {
                  log(`❌ The browser could not reach the SAML URL: ${netError}`);
                  resolved = true;
                  await teardown();
                  safeReject(new Error(
                    `Could not open the SAML login page (${normalizedUrl}): ${netError}`
                  ));
                  return;
                }
                // A real page loaded, stop probing.
                errorPageChecks = maxErrorPageChecks;
              } catch {
                // Page busy or navigating; try again on the next poll.
              }
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

      // Wait for a page target that is actually initialized. Immediately after
      // connect() a target can be present while url() is still empty; driving a
      // page in that state is what hangs, so don't touch it until it settles.
      const waitForReadyPage = async (timeoutMs: number) => {
        const deadline = Date.now() + timeoutMs;
        let pages = await browser.pages();
        while (Date.now() < deadline) {
          pages = await browser.pages();
          const ready = pages.find(p => {
            try { return !!p.url(); } catch { return false; }
          });
          if (ready) { return { pages, ready }; }
          await new Promise(r => setTimeout(r, 150));
        }
        return { pages, ready: undefined };
      };

      const { pages: initialPages, ready } = await waitForReadyPage(20000);
      log(`Browser ready with ${initialPages.length} page(s): ` +
          initialPages.map(p => { try { return JSON.stringify(p.url().substring(0, 60)); } catch { return '"?"'; } }).join(', '));

      // Attach listeners before anything else, then start the watcher.
      initialPages.forEach(attachPageListeners);
      scheduleNextPoll();

      if (!ready) {
        log('❌ The browser never produced a usable page.');
        if (!resolved) {
          resolved = true;
          await teardown();
          safeReject(new Error('The browser opened but never produced a usable page for the SAML login.'));
        }
        return;
      }

      // The browser was given the login URL on its command line, so it should
      // already be loading it. If it is still sitting on a blank page, drive the
      // navigation over CDP as a fallback.
      let currentUrl = '';
      try { currentUrl = ready.url(); } catch {}

      if (!currentUrl || currentUrl === 'about:blank' || currentUrl.startsWith('chrome://newtab')) {
        log(`Page is still on ${currentUrl || 'an empty URL'}; navigating to the SAML URL over CDP...`);
        try {
          const response = await ready.goto(normalizedUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
          });
          const status = response?.status();
          log(`Login page loaded (HTTP ${status ?? 'n/a'}): ${ready.url().substring(0, 90)}`);
          if (status && status >= 400) {
            log(`⚠️ Identity provider returned HTTP ${status}. Check the SAML URL.`);
          }
        } catch (navErr: any) {
          // Puppeteer surfaces the underlying Chromium network error here, e.g.
          // net::ERR_PROXY_CONNECTION_FAILED or net::ERR_NAME_NOT_RESOLVED.
          log(`❌ Could not open the SAML URL: ${navErr.message}`);
          if (!resolved) {
            resolved = true;
            await teardown();
            safeReject(new Error(
              `Could not open the SAML login page (${normalizedUrl}): ${navErr.message}`
            ));
          }
          return;
        }
      } else {
        log(`Login page opening: ${currentUrl.substring(0, 90)}`);
      }

      try {
        await ready.bringToFront();
      } catch {}

      log('Setup complete — waiting for SAML login in browser...');
    } catch (err: any) {
      log(`Setup error: ${err.message}`);
      if (!resolved) {
        resolved = true;
        await teardown();
        safeReject(err);
      }
    }
  });
}
