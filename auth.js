const path = require('node:path');
const {
  AUTH_META_PATH,
  AUTH_STATE_PATH,
  readJson,
  waitForAppReady,
  writeJson,
} = require('./utils');

const USERNAME_CANDIDATES = [
  '#login-username',
  'input[type="email"]',
  'input[name="username"]',
  'input[name="email"]',
  'input[id*="user"]',
  'input[placeholder*="mail" i]',
  'input[placeholder*="tài khoản" i]',
  'form input[type="text"]',
  'input[type="text"]',
];

const PASSWORD_CANDIDATES = [
  '#login-password',
  'input[type="password"]',
  'input[name="password"]',
  'input[id*="pass"]',
  'input[placeholder*="mật khẩu" i]',
];

const SUBMIT_CANDIDATES = [
  '#form-login button[type="submit"]',
  '#form-login button',
  'form button[type="submit"]',
  'button[type="submit"]',
  'input[type="submit"]',
];

async function findFirstUsableSelector(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count()) {
      return selector;
    }
  }

  return null;
}

async function detectLoginForm(page) {
  const usernameSelector = await findFirstUsableSelector(page, USERNAME_CANDIDATES);
  const passwordSelector = await findFirstUsableSelector(page, PASSWORD_CANDIDATES);
  const submitSelector = await findFirstUsableSelector(page, SUBMIT_CANDIDATES);

  if (!usernameSelector || !passwordSelector || !submitSelector) {
    throw new Error('Unable to detect the login form fields automatically.');
  }

  return {
    usernameSelector,
    passwordSelector,
    submitSelector,
  };
}

async function performLogin(page, credentials) {
  await waitForAppReady(page);

  if (await page.locator('#tab-login').count()) {
    await page.locator('#tab-login').click({ timeout: 5_000 }).catch(() => {});
  }

  const selectors = await detectLoginForm(page);

  await page.locator(selectors.usernameSelector).fill(credentials.username);
  await page.locator(selectors.passwordSelector).fill(credentials.password);
  await page.locator(selectors.submitSelector).click();

  try {
    await Promise.any([
      page.waitForFunction(
        () => Boolean(window.localStorage.getItem('access_token')),
        undefined,
        { timeout: 10_000 },
      ),
      page.locator('#main-screen').waitFor({ state: 'visible', timeout: 10_000 }),
      page.waitForURL((url) => !url.href.includes('app.html') || url.hash.length > 0, { timeout: 10_000 }),
    ]);
  } catch {
    const errorText = await page.locator('.swal2-popup, .swal2-html-container').first().textContent().catch(() => '');
    throw new Error(`Login did not complete successfully. ${errorText || 'No success indicator was detected.'}`.trim());
  }

  const accessToken = await page.evaluate(() => window.localStorage.getItem('access_token'));
  if (!accessToken) {
    throw new Error('Login completed without persisting an access token in localStorage.');
  }

  return {
    accessToken,
    selectors,
  };
}

async function saveAuthArtifacts(context, accessToken, selectors, baseUrl) {
  const base = new URL(baseUrl);
  const origin = base.protocol === 'file:' ? 'file://' : base.origin;
  await context.storageState({ path: AUTH_STATE_PATH });
  await writeJson(AUTH_META_PATH, {
    savedAt: new Date().toISOString(),
    baseUrl,
    origin,
    accessToken,
    selectors,
  });
}

async function loadAuthMetadata() {
  return readJson(AUTH_META_PATH);
}

async function createAuthenticatedContext(browser, authMeta) {
  const context = await browser.newContext({
    storageState: AUTH_STATE_PATH,
  });

  if (authMeta?.accessToken) {
    await context.addInitScript(({ token }) => {
      try {
        if (token) {
          window.localStorage.setItem('access_token', token);
        }
      } catch {
        // Ignore localStorage restore failures and let the caller retry login.
      }
    }, { token: authMeta.accessToken });
  }

  return context;
}

async function restoreAuthInPage(page, authMeta) {
  if (!authMeta?.accessToken) {
    return false;
  }

  await page.evaluate((token) => {
    window.localStorage.setItem('access_token', token);
  }, authMeta.accessToken);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppReady(page);
  return true;
}

module.exports = {
  AUTH_META_PATH,
  AUTH_STATE_PATH,
  createAuthenticatedContext,
  detectLoginForm,
  loadAuthMetadata,
  performLogin,
  restoreAuthInPage,
  saveAuthArtifacts,
};
