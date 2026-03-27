const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test'); // Nhớ thêm @ vào trước playwright nhé

// ROOT_DIR sẽ trỏ về thư mục 'app'
const ROOT_DIR = path.resolve(__dirname, '..');

// Tự động tạo URL file:// phù hợp với mọi hệ điều hành (Windows/Linux)
const BASE_URL = `file://${path.join(ROOT_DIR, 'app.html')}`;
const SAMPLE_IMAGE_PATH = path.join(ROOT_DIR, '456.jpg');
const OUTPUT_DIR = path.join(ROOT_DIR, 'output');
const INVALID_UPLOAD_PATH = path.join(ROOT_DIR, 'package.json');
const AUTH_META_PATH = path.join(ROOT_DIR, 'output', 'auth-meta.json');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}
if (!fs.existsSync(AUTH_META_PATH)) {
  // Tạo file json rỗng để Playwright không báo lỗi ENOENT khi require
  fs.writeFileSync(AUTH_META_PATH, JSON.stringify({ cookies: [], origins: [] }));
}
const authMeta = fs.existsSync(AUTH_META_PATH)
  ? JSON.parse(fs.readFileSync(AUTH_META_PATH, 'utf8'))
  : null;

test.use({ storageState: `${path.join(ROOT_DIR, 'output', 'auth.json')}` });
test.describe.configure({ mode: 'serial' });

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

async function expectAlert(page) {
  const popup = page.locator('.swal2-popup');
  await expect(popup).toBeVisible();
  return popup;
}

async function dismissAlert(page) {
  const cancelButton = page.locator('.swal2-cancel');
  if ((await cancelButton.count()) && await cancelButton.isVisible().catch(() => false)) {
    await cancelButton.click();
  } else {
    await page.locator('.swal2-confirm').click();
  }
  await expect(page.locator('.swal2-popup')).toBeHidden();
}

async function createPrediction(page) {
  await clickAndWait(page, 'button[onclick="showAppSection(\'predict\')"]');
  await page.locator('#image-upload').setInputFiles(SAMPLE_IMAGE_PATH);
  await waitForNetworkIdle(page);
  await clickAndWait(page, '#predict-btn');
  await expect(page.locator('#result-card')).toBeVisible();
}
test('[Registration] Create real user for subsequent tests', async ({ page }) => {
  await gotoApp(page);

  await clickAndWait(page, '#tab-register');
  await page.locator('#reg-username').fill('thune@gmail.com');
  await page.locator('#reg-password').fill('ntltcua3006');

  // Nhấn nút submit đăng ký (selector dựa trên form-register của bạn)
  await page.locator('#form-register button[type="submit"]').click();

  // Đợi một chút để DB kịp ghi và hiện thông báo thành công hoặc quay về form login
  await page.waitForTimeout(1000);
  await expect(page.locator('#form-login')).toBeVisible();
});
test('invalid login shows an error and keeps the user on the auth screen', async ({ page }) => {
  await gotoApp(page);

  await page.locator('#login-username').fill('thune@gmail.com');
  await page.locator('#login-password').fill('wrong-password');
  await clickAndWait(page, '#form-login button[type="submit"]');

  await expectAlert(page);
  await expect(page.getByText('Thất bại', { exact: false })).toBeVisible();
  await expect(page.locator('#auth-screen')).toBeVisible();
  await expect(page.locator('#main-screen')).toBeHidden();
  await dismissAlert(page);
});

test('duplicate register shows an error and leaves register mode visible', async ({ page }) => {
  await gotoApp(page);

  await clickAndWait(page, '#tab-register');
  await page.locator('#reg-username').fill('thune@gmail.com');
  await page.locator('#reg-password').fill('DuplicateUser123!');
  await clickAndWait(page, '#form-register button[type="submit"]');

  await expectAlert(page);
  await expect(page.locator('#form-register')).toBeVisible();
  await dismissAlert(page);
});

test('invalid file upload shows an error and does not render prediction results', async ({ page }) => {
  await gotoProtectedApp(page);

  await clickAndWait(page, 'button[onclick="showAppSection(\'predict\')"]');
  await page.locator('#image-upload').setInputFiles(INVALID_UPLOAD_PATH);
  await waitForNetworkIdle(page);
  await clickAndWait(page, '#predict-btn');

  await expectAlert(page);
  await expect(page.locator('#result-card')).toBeHidden();
  await dismissAlert(page);
});

test('canceling history deletion keeps the history item visible', async ({ page }) => {
  await gotoProtectedApp(page);
  await createPrediction(page);
  await clickAndWait(page, 'button[onclick="loadHistory()"]');

  const firstDeleteButton = page.locator('#history-list button[onclick^="delH"]').first();
  const historyCard = page.locator('#history-list .glass-card').first();

  await expect(historyCard).toBeVisible();
  await firstDeleteButton.click();
  // await waitForNetworkIdle(page);

  await expectAlert(page);
  await page.locator('.swal2-cancel').click();
  await expect(page.locator('.swal2-popup')).toBeHidden();
  await expect(historyCard).toBeVisible();
});

test('logout removes access to the protected UI', async ({ page }) => {
  await gotoProtectedApp(page);

  await clickAndWait(page, 'button[onclick="logout()"]');

  await expect(page.locator('#auth-screen')).toBeVisible();
  await expect(page.locator('#main-screen')).toBeHidden();
});
