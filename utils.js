const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const OUTPUT_DIR = path.join(__dirname, 'output');
const PAGES_DIR = path.join(OUTPUT_DIR, 'pages');
const SCREENSHOTS_DIR = path.join(OUTPUT_DIR, 'screenshots');
const AUTH_STATE_PATH = path.join(OUTPUT_DIR, 'auth.json');
const AUTH_META_PATH = path.join(OUTPUT_DIR, 'auth-meta.json');
const SITEMAP_PATH = path.join(OUTPUT_DIR, 'sitemap.json');
const TESTCASES_PATH = path.join(OUTPUT_DIR, 'testcases.json');
const FAILED_PAGES_PATH = path.join(OUTPUT_DIR, 'failed-pages.json');

function sanitizeText(value = '') {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).replace(/\s+/g, ' ').trim();
}

function slugify(value = '') {
  const normalized = sanitizeText(value)
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .replace(/_/g, '-')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return normalized || 'page';
}

function shortHash(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 8);
}

async function ensureDir(targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
}

async function ensureOutputDirs() {
  await Promise.all([
    ensureDir(OUTPUT_DIR),
    ensureDir(PAGES_DIR),
    ensureDir(SCREENSHOTS_DIR),
  ]);
}

async function resetOutputDir() {
  await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
  await ensureOutputDirs();
}

async function writeJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function readJson(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitForAppReady(page, timeout = 4_000) {
  await page.waitForLoadState('domcontentloaded');

  try {
    await page.waitForLoadState('networkidle', { timeout });
  } catch {
    // File-based apps with external scripts do not always reach network idle cleanly.
  }

  await page.waitForTimeout(300);
}

async function waitForDynamicUi(page) {
  try {
    const loading = page.locator('#loading');
    if (await loading.count()) {
      await loading.waitFor({ state: 'hidden', timeout: 20_000 });
    }
  } catch {
    // Ignore transient prediction loading failures and keep extracting the page state.
  }

  try {
    const historyLoading = page.locator('#history-loading');
    if (await historyLoading.count()) {
      await historyLoading.waitFor({ state: 'hidden', timeout: 10_000 });
    }
  } catch {
    // Ignore transient history loading failures and keep extracting the page state.
  }

  await page.waitForTimeout(250);
}

async function waitForStateStabilized(page) {
  await waitForAppReady(page);
  await waitForDynamicUi(page);
}

function buildFingerprint(pageDetails) {
  const visibleButtons = pageDetails.interactive.buttons
    .filter((button) => button.visible)
    .map((button) => `${button.selector}:${button.text}:${button.onclick || ''}`)
    .sort();
  const visibleInputs = pageDetails.interactive.inputs
    .filter((input) => input.visible || input.type === 'file')
    .map((input) => `${input.selector}:${input.type}:${input.name}:${input.placeholder}`)
    .sort();
  const visibleLinks = pageDetails.interactive.links
    .filter((link) => link.visible)
    .map((link) => `${link.selector}:${link.href}:${link.text}`)
    .sort();

  return shortHash(
    JSON.stringify({
      url: pageDetails.url,
      title: pageDetails.title,
      visibleIds: pageDetails.visibleIds,
      visibleButtons,
      visibleInputs,
      visibleLinks,
      protectedRoute: pageDetails.protectedRoute,
    }),
  );
}

function deriveStateName(pageDetails) {
  const visibleIds = new Set(pageDetails.visibleIds);

  if (visibleIds.has('auth-screen') && visibleIds.has('form-register')) {
    return 'register';
  }

  if (visibleIds.has('auth-screen') && visibleIds.has('form-login')) {
    return 'login';
  }

  if (visibleIds.has('main-screen') && visibleIds.has('section-history')) {
    return pageDetails.interactive.buttons.some((button) => (button.onclick || '').includes('delH'))
      ? 'history-populated'
      : 'history';
  }

  if (visibleIds.has('main-screen') && visibleIds.has('result-card')) {
    return 'predict-results';
  }

  if (visibleIds.has('main-screen') && visibleIds.has('action-container')) {
    return 'predict-ready';
  }

  if (visibleIds.has('main-screen') && visibleIds.has('section-predict')) {
    return 'predict';
  }

  return slugify(pageDetails.title || 'page-state');
}

function buildSlug(pageDetails, existingSlugs) {
  const base = deriveStateName(pageDetails);
  const withHash = `${base}-${pageDetails.fingerprint}`;

  if (!existingSlugs.has(withHash)) {
    return withHash;
  }

  let index = 2;
  while (existingSlugs.has(`${withHash}-${index}`)) {
    index += 1;
  }

  return `${withHash}-${index}`;
}

function isInternalUrl(href, baseUrl) {
  if (!href) {
    return false;
  }

  if (/^(javascript:|mailto:|tel:)/i.test(href)) {
    return false;
  }

  try {
    const target = new URL(href, baseUrl);
    const base = new URL(baseUrl);

    if (base.protocol === 'file:' && target.protocol === 'file:') {
      return target.pathname === base.pathname;
    }

    return target.origin === base.origin;
  } catch {
    return false;
  }
}

function toOutputRelative(filePath) {
  return path.relative(OUTPUT_DIR, filePath).replace(/\\/g, '/');
}

function dedupeBy(items, keyBuilder) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyBuilder(item);
    if (!key || seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

async function extractPageDetails(page, navigationPath = []) {
  const details = await page.evaluate((navPath) => {
    const clean = (value = '') => {
      if (value === null || value === undefined) {
        return '';
      }

      return String(value).replace(/\s+/g, ' ').trim();
    };
    const cssEscape = (value) => {
      if (window.CSS && typeof window.CSS.escape === 'function') {
        return window.CSS.escape(value);
      }

      return String(value).replace(/["\\]/g, '\\$&');
    };

    const isVisible = (element) => {
      if (!element) {
        return false;
      }

      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || '1') > 0
        && rect.width > 0
        && rect.height > 0;
    };

    const buildSelector = (element) => {
      if (!element) {
        return '';
      }

      if (element.id) {
        return `#${cssEscape(element.id)}`;
      }

      const tag = element.tagName.toLowerCase();
      const attributeNames = ['data-testid', 'data-test', 'name', 'aria-label', 'type'];

      for (const attributeName of attributeNames) {
        const attributeValue = element.getAttribute(attributeName);
        if (attributeValue) {
          return `${tag}[${attributeName}="${cssEscape(attributeValue)}"]`;
        }
      }

      if (tag === 'a') {
        const href = element.getAttribute('href');
        if (href) {
          return `a[href="${cssEscape(href)}"]`;
        }
      }

      const parts = [];
      let current = element;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
        if (current.id) {
          parts.unshift(`#${cssEscape(current.id)}`);
          break;
        }

        let index = 1;
        let sibling = current.previousElementSibling;
        while (sibling) {
          if (sibling.tagName === current.tagName) {
            index += 1;
          }
          sibling = sibling.previousElementSibling;
        }

        parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${index})`);
        current = current.parentElement;
      }

      return parts.join(' > ');
    };

    const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]'))
      .map((element) => ({
        text: clean(
          element.innerText
          || element.value
          || element.getAttribute('aria-label')
          || element.getAttribute('title')
          || element.getAttribute('onclick')
          || element.querySelector('i')?.className
          || '',
        ),
        selector: buildSelector(element),
        visible: isVisible(element),
        disabled: Boolean(element.disabled),
        type: element.getAttribute('type') || element.tagName.toLowerCase(),
        onclick: element.getAttribute('onclick') || '',
      }));

    const inputs = Array.from(document.querySelectorAll('input, textarea, select'))
      .map((element) => ({
        type: element.getAttribute('type') || element.tagName.toLowerCase(),
        name: clean(element.getAttribute('name') || element.id || ''),
        placeholder: clean(element.getAttribute('placeholder') || ''),
        selector: buildSelector(element),
        visible: isVisible(element),
        required: Boolean(element.required),
        value: element.getAttribute('value') || '',
      }));

    const links = Array.from(document.querySelectorAll('a[href]'))
      .map((element) => ({
        text: clean(element.innerText || element.getAttribute('aria-label') || element.getAttribute('title')),
        href: element.getAttribute('href') || '',
        selector: buildSelector(element),
        visible: isVisible(element),
      }));

    const forms = Array.from(document.querySelectorAll('form'))
      .map((form) => ({
        selector: buildSelector(form),
        action: form.getAttribute('action') || '',
        method: (form.getAttribute('method') || 'get').toLowerCase(),
        visible: isVisible(form),
      }));

    const visibleIds = Array.from(document.querySelectorAll('[id]'))
      .filter((element) => isVisible(element))
      .map((element) => element.id)
      .sort();

    const tokenPresent = Boolean(window.localStorage.getItem('access_token'));
    const authVisible = Boolean(document.querySelector('#auth-screen') && isVisible(document.querySelector('#auth-screen')));
    const mainVisible = Boolean(document.querySelector('#main-screen') && isVisible(document.querySelector('#main-screen')));

    return {
      url: window.location.href,
      title: document.title,
      navigationPath: navPath,
      visibleIds,
      tokenPresent,
      protectedRoute: tokenPresent && mainVisible && !authVisible,
      interactive: {
        buttons,
        inputs,
        links,
        forms,
      },
    };
  }, navigationPath);

  details.interactive.buttons = dedupeBy(details.interactive.buttons, (button) => `${button.selector}|${button.text}|${button.onclick}`);
  details.interactive.inputs = dedupeBy(details.interactive.inputs, (input) => `${input.selector}|${input.type}|${input.name}`);
  details.interactive.links = dedupeBy(details.interactive.links, (link) => `${link.selector}|${link.href}|${link.text}`);
  details.interactive.forms = dedupeBy(details.interactive.forms, (form) => `${form.selector}|${form.action}|${form.method}`);
  details.fingerprint = buildFingerprint(details);
  return details;
}

function buildTestCases(pageRecord) {
  const scenarios = [];
  const pageLabel = pageRecord.title || pageRecord.slug;

  scenarios.push({
    id: `${pageRecord.slug}-page-load`,
    page: pageRecord.slug,
    type: 'page-load',
    title: `${pageLabel} loads successfully`,
    steps: [
      `Navigate to ${pageRecord.url}.`,
      'Wait for the page title and primary container to render.',
    ],
    expected: [
      'The page is displayed without console or network blocking errors.',
      'The expected title and key interactive elements are visible.',
    ],
  });

  if (pageRecord.navigationPath.length > 0) {
    scenarios.push({
      id: `${pageRecord.slug}-navigation`,
      page: pageRecord.slug,
      type: 'navigation',
      title: `${pageLabel} can be reached through the UI`,
      steps: pageRecord.navigationPath.map((step, index) => `${index + 1}. ${step}`),
      expected: [
        `The browser remains on the authenticated experience and reaches ${pageLabel}.`,
      ],
    });
  }

  pageRecord.interactive.forms
    .filter((form) => form.visible)
    .forEach((form, index) => {
      scenarios.push({
        id: `${pageRecord.slug}-form-${index + 1}`,
        page: pageRecord.slug,
        type: 'form-submit',
        title: `${pageLabel} form ${index + 1} submits correctly`,
      selector: form.selector,
      steps: [
        `Locate the form using ${form.selector}.`,
        'Populate required fields with valid data.',
        'Submit the form and wait for the expected success state.',
      ],
      expected: [
        'Validation errors are not shown for valid data.',
        'The expected success state, navigation, or response is displayed.',
      ],
    });
  });

  pageRecord.interactive.buttons
    .filter((button) => button.visible)
    .forEach((button, index) => {
      scenarios.push({
        id: `${pageRecord.slug}-button-${index + 1}`,
        page: pageRecord.slug,
        type: 'button-click',
        title: `${pageLabel} button ${index + 1} reacts correctly`,
        selector: button.selector,
        label: button.text || button.onclick || 'icon button',
        steps: [
          `Locate the button using ${button.selector}.`,
          'Click the button and observe the resulting state change.',
        ],
        expected: [
          'The button click triggers the intended navigation, modal, or content update.',
        ],
      });
    });

  return scenarios;
}

module.exports = {
  AUTH_META_PATH,
  AUTH_STATE_PATH,
  FAILED_PAGES_PATH,
  OUTPUT_DIR,
  PAGES_DIR,
  SCREENSHOTS_DIR,
  SITEMAP_PATH,
  TESTCASES_PATH,
  buildSlug,
  buildTestCases,
  deriveStateName,
  ensureOutputDirs,
  extractPageDetails,
  fileExists,
  isInternalUrl,
  readJson,
  resetOutputDir,
  sanitizeText,
  shortHash,
  slugify,
  toOutputRelative,
  waitForAppReady,
  waitForStateStabilized,
  writeJson,
};
