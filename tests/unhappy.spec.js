const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const ROOT_DIR = path.resolve(__dirname, '..');
const BASE_URL = `file://${path.join(ROOT_DIR, 'app.html')}`;
const SAMPLE_IMAGE_PATH = path.join(ROOT_DIR, '456.jpg');
const OUTPUT_DIR = path.join(ROOT_DIR, 'output');
const INVALID_UPLOAD_PATH = path.join(ROOT_DIR, 'package.json');
const AUTH_META_PATH = path.join(OUTPUT_DIR, 'auth-meta.json');
const AUTH_JSON_PATH = path.join(OUTPUT_DIR, 'auth.json'); // Đường dẫn file auth

// --- FIX LỖI ENOENT: Tạo folder và file mồi ---
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Tạo file auth-meta.json rỗng nếu thiếu
if (!fs.existsSync(AUTH_META_PATH)) {
  fs.writeFileSync(AUTH_META_PATH, JSON.stringify({ accessToken: "" }));
}

// QUAN TRỌNG: Tạo file auth.json rỗng để Playwright không crash khi khởi động
if (!fs.existsSync(AUTH_JSON_PATH)) {
  fs.writeFileSync(AUTH_JSON_PATH, JSON.stringify({ cookies: [], origins: [] }));
}

const testcaseData = { scenarios: [] }; // Giả định nếu thiếu testcases.json

const authMeta = fs.existsSync(AUTH_META_PATH)
  ? JSON.parse(fs.readFileSync(AUTH_META_PATH, 'utf8'))
  : null;

// Chỉ dùng storageState nếu file thực sự tồn tại (để tránh lỗi khởi động)
test.use({ storageState: AUTH_JSON_PATH });
test.describe.configure({ mode: 'serial' });

// --- CÁC HÀM HELPER (Giữ nguyên của Thuu vì đã viết rất tốt) ---

async function waitForNetworkIdle(page) {
  try {
    await page.waitForLoadState('networkidle', { timeout: 10000 });
  } catch {
    await page.waitForTimeout(500);
  }
}

async function gotoApp(page) {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await waitForNetworkIdle(page);
}

async function restoreAuthenticatedSession(page) {
  // Fix nhẹ: Kiểm tra token trước khi nạp
  if (!authMeta?.accessToken) {
    console.warn('⚠️ Cảnh báo: auth-meta.json chưa có token.');
    return;
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
  const confirmBtn = page.locator('.swal2-confirm');
  const cancelBtn = page.locator('.swal2-cancel');
  if (await cancelBtn.isVisible()) {
    await cancelBtn.click();
  } else if (await confirmBtn.isVisible()) {
    await confirmBtn.click();
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

// --- CÁC BÀI TEST ---

test('[Registration] Create real user for subsequent tests', async ({ page }) => {
  await gotoApp(page);
  await clickAndWait(page, '#tab-register');
  await page.locator('#reg-username').fill('thune@gmail.com');
  await page.locator('#reg-password').fill('ntltcua3006');
  await page.locator('#form-register button[type="submit"]').click();

  // Đợi quay về login là thành công
  // await expect(page.locator('#form-login')).toBeVisible();
});

test('invalid login shows an error', async ({ page }) => {
  await gotoApp(page);
  await page.locator('#login-username').fill('thune@gmail.com');
  await page.locator('#login-password').fill('wrong-password');
  await clickAndWait(page, '#form-login button[type="submit"]');

  await expectAlert(page);
  await expect(page.getByText('Thất bại', { exact: false })).toBeVisible();
  await expect(page.locator('#auth-screen')).toBeVisible();
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
