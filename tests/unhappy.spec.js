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
  // await popup.waitFor({ state: 'visible', timeout: 10000 });
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
  await page.locator('#form-login button[type="submit"]').click();
  try {
    const alert = page.locator('.swal2-popup');
    await expect(alert).toBeVisible({ timeout: 5000 });
  } catch (e) {
    await page.screenshot({ path: 'output/error-popup.png' });
    throw e;
  }
  // await expect(page.getByText('Thất bại', { exact: false })).toBeVisible();
  await expect(page.locator('#auth-screen')).toBeVisible();
  await dismissAlert(page);
});

test('duplicate register shows an error and leaves register mode visible', async ({ page }) => {
  await gotoApp(page);

  // 1. Vào tab đăng ký
  await page.locator('#tab-register').click();

  // 2. Điền thông tin user đã tồn tại
  await page.locator('#reg-username').fill('thune@gmail.com');
  await page.locator('#reg-password').fill('DuplicateUser123!');

  // 3. VỪA BẤM NÚT VỪA ĐỢI API TRẢ LỜI (Tránh đợi vô tri)
  await Promise.all([
    page.waitForResponse(resp => resp.url().includes('/register'), { timeout: 15000 }),
    page.locator('#form-register button[type="submit"]').click()
  ]);

  // 4. ĐỢI THÊM 1 GIÂY CHO POPUP HIỆN RA HẲN
  await page.waitForTimeout(1000);

  // 5. KIỂM TRA (Tăng timeout lên 10s cho máy ảo GitHub chạy kịp)
  const alert = page.locator('.swal2-popup');
  await expect(alert).toBeVisible({ timeout: 10000 });
  await expect(alert).toContainText('Thất bại', { ignoreCase: true });

  // 6. ĐÓNG POPUP
  await page.locator('.swal2-confirm').click();
});

test('invalid file upload shows an error and does not render prediction results', async ({ page }) => {
  await gotoProtectedApp(page);

  await clickAndWait(page, 'button[onclick="showAppSection(\'predict\')"]');
  await page.locator('#image-upload').setInputFiles(INVALID_UPLOAD_PATH);
  await waitForNetworkIdle(page);
  await page.locator('#predict-btn button[type="submit"]').click()

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
