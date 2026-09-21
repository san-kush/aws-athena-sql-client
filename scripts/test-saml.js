const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer-core');
const { STSClient, AssumeRoleWithSAMLCommand } = require('@aws-sdk/client-sts');

function findSystemBrowsers() {
  const candidates = [];
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
      '/usr/bin/microsoft-edge'
    );
  }
  return candidates.filter(p => p && fs.existsSync(p));
}

function parseRolesFromSaml(samlBase64) {
  try {
    const xml = Buffer.from(samlBase64, 'base64').toString('utf-8');
    const roles = [];
    const regex = /<[^>]*AttributeValue[^>]*>([\s\S]*?)<\/[^>]*AttributeValue>/gi;
    let match;
    while ((match = regex.exec(xml)) !== null) {
      const val = match[1].trim();
      if (val.includes(':role/') && val.includes(':saml-provider/')) {
        const parts = val.split(',').map(p => p.trim());
        const roleArn = parts.find(p => p.includes(':role/'));
        const principalArn = parts.find(p => p.includes(':saml-provider/'));
        if (roleArn && principalArn) {
          roles.push({ roleArn, principalArn });
        }
      }
    }
    return roles;
  } catch {
    return [];
  }
}

async function run() {
  const urlArg = process.argv[2];
  if (!urlArg) {
    console.log('Usage: node scripts/test-saml.js <SAML_IDP_URL> [AWS_REGION]');
    console.log('Example: node scripts/test-saml.js "https://myapps.microsoft.com/..." us-east-1');
    process.exit(1);
  }

  const region = process.argv[3] || 'us-east-1';
  const browsers = findSystemBrowsers();
  console.log('🔍 Detected system browsers:', browsers);

  if (browsers.length === 0) {
    console.error('❌ No compatible Chrome/Edge browser found.');
    process.exit(1);
  }

  const browserPath = browsers[0];
  console.log(`🚀 Launching ${path.basename(browserPath)}...`);

  const tempProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-test-profile-'));
  const cleanEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (
      v !== undefined &&
      !k.startsWith('ELECTRON_') &&
      !k.startsWith('VSCODE_') &&
      k !== 'NODE_OPTIONS' &&
      k !== 'CHROME_CRASHPAD_PIPE_NAME'
    ) {
      cleanEnv[k] = v;
    }
  }

  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: false,
    userDataDir: tempProfileDir,
    defaultViewport: null,
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

  const cleanup = async () => {
    try { await browser.close(); } catch {}
    try { fs.rmSync(tempProfileDir, { recursive: true, force: true }); } catch {}
  };

  const pages = await browser.pages();
  const page = pages.length > 0 ? pages[0] : await browser.newPage();

  console.log(`🌐 Navigating to: ${urlArg}`);
  console.log('⏳ Waiting for user login and SAML assertion post...');

  let capturedSaml;
  let availableRoles = [];

  page.on('request', async req => {
    const url = req.url();
    if (url.includes('signin.aws.amazon.com/saml') && req.method() === 'POST') {
      const postData = req.postData();
      if (postData) {
        const params = new URLSearchParams(postData);
        const saml = params.get('SAMLResponse');
        if (saml) {
          capturedSaml = saml;
          availableRoles = parseRolesFromSaml(saml);
          console.log(`\n📋 Intercepted SAML assertion! Found ${availableRoles.length} roles:`);
          availableRoles.forEach((r, i) => console.log(`   [${i}] ${r.roleArn}`));

          if (availableRoles.length === 1) {
            console.log('Single role detected. Assuming role automatically...');
            await assumeRole(availableRoles[0]);
          }
        }

        const roleIndex = params.get('roleIndex');
        if (roleIndex && capturedSaml) {
          console.log(`Role selected from AWS page: ${roleIndex}`);
          const selectedRoleArn = roleIndex.includes(':role/')
            ? roleIndex.split(',').find(p => p.includes(':role/')) || roleIndex
            : roleIndex;
          const matched = availableRoles.find(r => r.roleArn === selectedRoleArn || r.roleArn.endsWith(`/${selectedRoleArn}`));
          if (matched) {
            await assumeRole(matched);
          } else if (availableRoles.length > 0) {
            const idx = parseInt(roleIndex, 10);
            await assumeRole(availableRoles[idx] || availableRoles[0]);
          }
        }
      }
    }
  });

  async function assumeRole(role) {
    console.log(`\n🔐 Calling AWS STS AssumeRoleWithSAML for ${role.roleArn}...`);
    try {
      const sts = new STSClient({ region });
      const resp = await sts.send(new AssumeRoleWithSAMLCommand({
        RoleArn: role.roleArn,
        PrincipalArn: role.principalArn,
        SAMLAssertion: capturedSaml,
        DurationSeconds: 3600
      }));

      console.log('✅ AWS STS Authentication Succeeded!');
      console.log('----------------------------------------------------');
      console.log('AccessKeyId:    ', resp.Credentials.AccessKeyId);
      console.log('SecretAccessKey:', resp.Credentials.SecretAccessKey ? '****** (captured)' : 'missing');
      console.log('SessionToken:   ', resp.Credentials.SessionToken ? `${resp.Credentials.SessionToken.substring(0, 30)}...` : 'missing');
      console.log('Expiration:     ', resp.Credentials.Expiration);
      console.log('----------------------------------------------------');
      console.log('Closing browser window...');
      await cleanup();
      console.log('🎉 Browser test completed successfully!');
      process.exit(0);
    } catch (err) {
      console.error('❌ STS AssumeRoleWithSAML error:', err.message);
      await cleanup();
      process.exit(1);
    }
  }

  await page.goto(urlArg, { waitUntil: 'domcontentloaded' });
}

run().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});

