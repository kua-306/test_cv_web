const path = require('node:path');
const { chromium } = require('playwright');

const {
  createAuthenticatedContext,
  loadAuthMetadata,
  performLogin,
  restoreAuthInPage,
  saveAuthArtifacts,
} = require('./auth');
const {
  FAILED_PAGES_PATH,
  OUTPUT_DIR,
  PAGES_DIR,
  SCREENSHOTS_DIR,
  SITEMAP_PATH,
  TESTCASES_PATH,
  buildSlug,
  buildTestCases,
  deriveStateName,
  extractPageDetails,
  fileExists,
  isInternalUrl,
  resetOutputDir,
  toOutputRelative,
  waitForStateStabilized,
  writeJson,
} = require('./utils');

const CONFIG = {
  baseUrl: process.env.BASE_URL || 'file:///C:/Users/thuu/Desktop/DATN/app/app.html',
  username: process.env.APP_USERNAME || 'thune@gmail.com',
  password: process.env.APP_PASSWORD || 'ntltcua3006',
  maxDepth: Number(process.env.MAX_DEPTH || 3),
  maxPages: Number(process.env.MAX_PAGES || 50),
  headless: process.env.HEADLESS !== 'false',
  sampleUploadPath: process.env.SAMPLE_UPLOAD_PATH || path.join(__dirname, '456.jpg'),
};

function isDestructiveAction(action) {
  const haystack = [action.label, action.selector, action.href, action.onclick]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return /(logout|log out|delete|remove|trash|power-off|power off|xóa|hủy|cancel|delh|history-delete)/i.test(haystack);
}

function summarizeAction(action) {
  if (action.type === 'goto') {
    return `Open link ${action.href}`;
  }

  if (action.type === 'setInputFiles') {
    return `Upload sample file with ${action.selector}`;
  }

  return `Click ${action.label || action.onclick || action.selector}`;
}

async function ensureAuthenticated(page, authMeta) {
  await waitForStateStabilized(page);

  const mainVisible = await page.locator('#main-screen').isVisible().catch(() => false);
  if (mainVisible) {
    return;
  }

  const authVisible = await page.locator('#auth-screen').isVisible().catch(() => false);
  if (!authVisible) {
    return;
  }

  const restored = await restoreAuthInPage(page, authMeta);
  if (!restored) {
    return;
  }

  const loginVisible = await page.locator('#auth-screen').isVisible().catch(() => false);
  if (loginVisible) {
    const loginResult = await performLogin(page, {
      username: CONFIG.username,
      password: CONFIG.password,
    });
    authMeta.accessToken = loginResult.accessToken;
  }
}

async function savePageRecord(page, navigationPath, registry) {
  const pageDetails = await extractPageDetails(page, navigationPath);
  const stateName = deriveStateName(pageDetails);

  if (registry.byFingerprint.has(pageDetails.fingerprint)) {
    return registry.byFingerprint.get(pageDetails.fingerprint);
  }

  if (registry.byStateName.has(stateName)) {
    return registry.byStateName.get(stateName);
  }

  const slug = buildSlug(pageDetails, registry.slugs);
  registry.slugs.add(slug);

  const screenshotPath = path.join(SCREENSHOTS_DIR, `${slug}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const record = {
    ...pageDetails,
    slug,
    screenshot: toOutputRelative(screenshotPath),
    pageFile: toOutputRelative(path.join(PAGES_DIR, `${slug}.json`)),
  };

  registry.byFingerprint.set(record.fingerprint, record);
  registry.byStateName.set(stateName, record);
  registry.records.push(record);

  await writeJson(path.join(PAGES_DIR, `${slug}.json`), record);
  return record;
}

function buildActionQueueItem(pathSteps, depth) {
  return {
    pathSteps,
    depth,
    key: pathSteps.map((step) => `${step.type}:${step.selector || step.href || step.filePath}`).join(' > ') || 'root',
  };
}

async function discoverActions(page, pageRecord) {
  const actions = [];

  for (const button of pageRecord.interactive.buttons) {
    if (!button.visible || button.disabled || !button.selector) {
      continue;
    }

    const action = {
      type: 'click',
      selector: button.selector,
      label: button.text || button.onclick || button.selector,
      onclick: button.onclick,
    };

    if (!isDestructiveAction(action)) {
      actions.push(action);
    }
  }

  for (const link of pageRecord.interactive.links) {
    if (!link.visible || !link.href || !link.selector) {
      continue;
    }

    if (!isInternalUrl(link.href, CONFIG.baseUrl)) {
      continue;
    }

    const resolvedHref = new URL(link.href, CONFIG.baseUrl).href;
    actions.push({
      type: 'goto',
      selector: link.selector,
      href: resolvedHref,
      label: link.text || resolvedHref,
    });
  }

  const sampleImageExists = await fileExists(CONFIG.sampleUploadPath);
  if (sampleImageExists) {
    for (const input of pageRecord.interactive.inputs) {
      if (input.type !== 'file' || !input.selector) {
        continue;
      }

      actions.push({
        type: 'setInputFiles',
        selector: input.selector,
        filePath: CONFIG.sampleUploadPath,
        label: 'Upload sample image',
      });
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const action of actions) {
    const key = `${action.type}|${action.selector}|${action.href || ''}|${action.filePath || ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(action);
    }
  }

  return deduped;
}

async function applyAction(page, action) {
  if (action.type === 'goto') {
    await page.goto(action.href, { waitUntil: 'domcontentloaded' });
    await waitForStateStabilized(page);
    return;
  }

  if (action.type === 'setInputFiles') {
    await page.locator(action.selector).setInputFiles(action.filePath);
    await waitForStateStabilized(page);
    return;
  }

  const locator = page.locator(action.selector).first();
  await locator.waitFor({ state: 'attached', timeout: 5_000 });
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ timeout: 5_000 });
  await waitForStateStabilized(page);
}

async function replayPath(context, authMeta, pathSteps) {
  const page = await context.newPage();
  await page.goto(CONFIG.baseUrl, { waitUntil: 'domcontentloaded' });
  await ensureAuthenticated(page, authMeta);

  for (const action of pathSteps) {
    await applyAction(page, action);
    await ensureAuthenticated(page, authMeta);
  }

  return page;
}

async function capturePublicAuthStates(browser, registry, failedPages) {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(CONFIG.baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForStateStabilized(page);
    await savePageRecord(page, ['Open login page'], registry);

    if (await page.locator('#tab-register').count()) {
      await page.locator('#tab-register').click({ timeout: 5_000 });
      await waitForStateStabilized(page);
      await savePageRecord(page, ['Open login page', 'Switch to register mode'], registry);
      await page.locator('#tab-login').click({ timeout: 5_000 });
      await waitForStateStabilized(page);
    }
  } catch (error) {
    failedPages.push({
      stage: 'public-auth-states',
      navigationPath: ['Open login page'],
      error: error.message,
    });
  } finally {
    await context.close();
  }
}

async function authenticate(browser, registry, failedPages) {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(CONFIG.baseUrl, { waitUntil: 'domcontentloaded' });
    await waitForStateStabilized(page);

    const loginResult = await performLogin(page, {
      username: CONFIG.username,
      password: CONFIG.password,
    });

    await ensureAuthenticated(page, {
      accessToken: loginResult.accessToken,
    });

    await saveAuthArtifacts(context, loginResult.accessToken, loginResult.selectors, CONFIG.baseUrl);
    const landingRecord = await savePageRecord(page, ['Authenticate and open the main application'], registry);

    return {
      authMeta: await loadAuthMetadata(),
      landingRecord,
    };
  } catch (error) {
    failedPages.push({
      stage: 'authentication',
      navigationPath: ['Authenticate and open the main application'],
      error: error.message,
    });
    throw error;
  } finally {
    await context.close();
  }
}

async function crawlAuthenticatedStates(browser, authMeta, registry, failedPages) {
  const context = await createAuthenticatedContext(browser, authMeta);
  const queue = [buildActionQueueItem([], 0)];
  const processedPaths = new Set();

  try {
    while (queue.length > 0 && registry.records.length < CONFIG.maxPages) {
      const current = queue.shift();
      if (processedPaths.has(current.key)) {
        continue;
      }
      processedPaths.add(current.key);

      let page;
      try {
        page = await replayPath(context, authMeta, current.pathSteps);
        const navigationPath = current.pathSteps.map((step) => summarizeAction(step));
        const pageRecord = await savePageRecord(page, navigationPath, registry);

        if (current.depth >= CONFIG.maxDepth) {
          await page.close();
          continue;
        }

        const actions = await discoverActions(page, pageRecord);
        for (const action of actions) {
          const nextSteps = [...current.pathSteps, action];
          const nextItem = buildActionQueueItem(nextSteps, current.depth + 1);
          if (!processedPaths.has(nextItem.key)) {
            queue.push(nextItem);
          }
        }
      } catch (error) {
        failedPages.push({
          stage: 'crawl',
          navigationPath: current.pathSteps.map((step) => summarizeAction(step)),
          error: error.message,
        });
      } finally {
        if (page && !page.isClosed()) {
          await page.close();
        }
      }
    }
  } finally {
    await context.close();
  }
}

async function writeOutputs(registry, failedPages) {
  const sitemap = {
    generatedAt: new Date().toISOString(),
    baseUrl: CONFIG.baseUrl,
    totalPages: registry.records.length,
    pages: registry.records.map((record) => ({
      slug: record.slug,
      url: record.url,
      title: record.title,
      protectedRoute: record.protectedRoute,
      navigationPath: record.navigationPath,
      screenshot: record.screenshot,
      pageFile: record.pageFile,
    })),
  };

  const testcases = {
    generatedAt: new Date().toISOString(),
    baseUrl: CONFIG.baseUrl,
    scenarios: registry.records.flatMap((record) => buildTestCases(record)),
  };

  await writeJson(SITEMAP_PATH, sitemap);
  await writeJson(TESTCASES_PATH, testcases);
  await writeJson(FAILED_PAGES_PATH, failedPages);
}

async function main() {
  await resetOutputDir();

  const registry = {
    records: [],
    byFingerprint: new Map(),
    byStateName: new Map(),
    slugs: new Set(),
  };
  const failedPages = [];
  const browser = await chromium.launch({
    headless: CONFIG.headless,
    args: [
      '--allow-file-access-from-files',
      '--disable-web-security',
    ],
  });

  try {
    await capturePublicAuthStates(browser, registry, failedPages);
    const { authMeta } = await authenticate(browser, registry, failedPages);
    await crawlAuthenticatedStates(browser, authMeta, registry, failedPages);
    await writeOutputs(registry, failedPages);

    console.log(`UI crawl complete. Generated ${registry.records.length} page records in ${OUTPUT_DIR}.`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('Crawler failed:', error);
  process.exitCode = 1;
});
