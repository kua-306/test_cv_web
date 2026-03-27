const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test'); // Nhớ thêm @ vào trước playwright nhé

// ROOT_DIR sẽ trỏ về thư mục 'app'
const ROOT_DIR = path.resolve(__dirname, '..');

// Tự động tạo URL file:// phù hợp với mọi hệ điều hành (Windows/Linux)
const BASE_URL = `file://${path.join(ROOT_DIR, 'app.html')}`;
const SAMPLE_IMAGE_PATH = path.join(ROOT_DIR, '456.jpg');
const TESTCASES_PATH = path.join(ROOT_DIR, 'output', 'testcases.json');
const AUTH_META_PATH = path.join(ROOT_DIR, 'output', 'auth-meta.json');

const testcaseData = JSON.parse(fs.readFileSync(TESTCASES_PATH, 'utf8'));
const authMeta = fs.existsSync(AUTH_META_PATH)
  ? JSON.parse(fs.readFileSync(AUTH_META_PATH, 'utf8'))
  : null;

test.use({ storageState: `${path.join(ROOT_DIR, 'output', 'auth.json')}` });
test.describe.configure({ mode: 'serial' });

function findScenario(slugPrefix, type) {
  return testcaseData.scenarios.find(
    (scenario) => scenario.page.startsWith(slugPrefix) && scenario.type === type,
  ) || testcaseData.scenarios.find((scenario) => scenario.page.startsWith(slugPrefix));
}

function buildTestTitle(pageKey, scenario, fallbackTitle) {
  return `[${pageKey}] ${scenario?.title || fallbackTitle}`;
}

async function waitForNetworkIdle(page) {
  try {
    await page.waitForLoadState('networkidle', { timeout: 10_000 });
  } catch {
    await page.waitForTimeout(500);
  }
}

async function gotoApp(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await waitForNetworkIdle(page);
}

async function restoreAuthenticatedSession(page) {
  if (!authMeta?.accessToken) {
    throw new Error('Missing output/auth-meta.json access token for protected-route tests.');
  }

  await page.evaluate((token) => {
    window.localStorage.setItem('access_token', token);
  }, authMeta.accessToken);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForNetworkIdle(page);
}

async function gotoProtectedApp(page) {
  await gotoApp(page);
  await restoreAuthenticatedSession(page);
  await expect(page.locator('#main-screen')).toBeVisible();
}

async function clickAndWait(page, selector) {
  await page.locator(selector).click();
  await waitForNetworkIdle(page);
}

async function uploadSampleImage(page) {
  await page.locator('#image-upload').setInputFiles(SAMPLE_IMAGE_PATH);
  await waitForNetworkIdle(page);
}

const loginScenario = findScenario('login-', 'form-submit');
const registerScenario = findScenario('register-', 'form-submit');
const predictScenario = findScenario('predict-', 'navigation');
const predictReadyScenario = findScenario('predict-ready-', 'button-click');
const predictResultsScenario = findScenario('predict-results-', 'button-click');
const historyScenario = findScenario('history-', 'navigation');
const historyPopulatedScenario = findScenario('history-populated-', 'navigation');

test(buildTestTitle('login', loginScenario, 'Login form accepts credentials entry'), async ({ page }) => {
  await gotoApp(page);

  await page.locator('#login-username').fill('thune@gmail.com');
  await page.locator('#login-password').fill('ntltcua3006');

  await expect(page.locator('#form-login')).toBeVisible();
  await expect(page.locator('#login-username')).toHaveValue('thune@gmail.com');
});

test(buildTestTitle('register', registerScenario, 'Register form can be opened and filled'), async ({ page }) => {
  await gotoApp(page);

  await clickAndWait(page, '#tab-register');
  await page.locator('#reg-username').fill(`qa_${Date.now()}`);
  await page.locator('#reg-password').fill('TestPassword123!');

  await expect(page.locator('#form-register')).toBeVisible();
  await expect(page.locator('#reg-password')).toHaveValue('TestPassword123!');
});

test(buildTestTitle('predict', predictScenario, 'Predict section is reachable for authenticated users'), async ({ page }) => {
  await gotoProtectedApp(page);

  await clickAndWait(page, 'button[onclick="showAppSection(\'predict\')"]');

  await expect(page.locator('#section-predict')).toBeVisible();
  await expect(page.locator('#main-screen')).toBeVisible();
});

test(buildTestTitle('history', historyScenario, 'History section can be opened'), async ({ page }) => {
  await gotoProtectedApp(page);

  await clickAndWait(page, 'button[onclick="loadHistory()"]');

  await expect(page.locator('#section-history')).toBeVisible();
});

test(buildTestTitle('predict-ready', predictReadyScenario, 'Uploading an image enables prediction'), async ({ page }) => {
  await gotoProtectedApp(page);

  await clickAndWait(page, 'button[onclick="showAppSection(\'predict\')"]');
  await uploadSampleImage(page);

  await expect(page.locator('#predict-btn')).toBeVisible();
  await expect(page.locator('#upload-box-img')).toBeVisible();
});

test(buildTestTitle('predict-results', predictResultsScenario, 'Prediction displays a results card'), async ({ page }) => {
  await gotoProtectedApp(page);

  await clickAndWait(page, 'button[onclick="showAppSection(\'predict\')"]');
  await uploadSampleImage(page);
  await clickAndWait(page, '#predict-btn');

  await expect(page.locator('#result-card')).toBeVisible();
  await expect(page.locator('#prediction-list > div')).toHaveCount(5);
});

test(buildTestTitle('history-populated', historyPopulatedScenario, 'History shows entries after a successful prediction'), async ({ page }) => {
  await gotoProtectedApp(page);

  await clickAndWait(page, 'button[onclick="showAppSection(\'predict\')"]');
  await uploadSampleImage(page);
  await clickAndWait(page, '#predict-btn');
  await clickAndWait(page, 'button[onclick="loadHistory()"]');

  await expect(page.locator('#section-history')).toBeVisible();
  await expect(page.locator('#history-list .glass-card').first()).toBeVisible();
});
