/**
 * Test: side panel opens from a real click without losing gesture context
 * Reproduces: "sidePanel.open() may only be called in response to a user
 * gesture" — awaiting setOptions before open() consumed the gesture.
 * The service worker's console.error is patched to capture the failure.
 */
const { chromium } = require('playwright');
const path = require('path');

const extensionPath = path.resolve(__dirname, '..');
const headed = process.argv.includes('--headed');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log('  ✔ ' + label);
    passed++;
  } else {
    console.log('  ✘ ' + label + (detail ? ' — ' + detail : ''));
    failed++;
  }
}

(async () => {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: !headed,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extensionId = sw.url().split('/')[2];

  // Capture worker-side console.error (where the gesture failure surfaces)
  await sw.evaluate(() => {
    self.__errors = [];
    const orig = console.error;
    console.error = (...a) => { self.__errors.push(a.map(String).join(' ')); orig(...a); };
  });

  // Open the popup as a tab. Its own URL is chrome-extension://, so the
  // worker marks the panel disabled for this tab — the exact precondition
  // that used to fail.
  const popup = await context.newPage();
  const pageErrors = [];
  popup.on('pageerror', e => pageErrors.push(e.message));
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.waitForTimeout(800);

  // Real trusted click (carries user activation, like the user's click).
  // The handler ends with window.close(), so the page may vanish mid-call.
  try { await popup.click('#open-sidepanel', { noWaitAfter: true }); } catch {}
  await new Promise(r => setTimeout(r, 2000));

  // ANY worker error counts — the first regression threw "user gesture",
  // the second "No active side panel for tabId"
  const swErrors = await sw.evaluate(() => self.__errors);
  check('No errors at all in service worker', swErrors.length === 0,
    JSON.stringify(swErrors));
  check('No page errors in popup', pageErrors.length === 0, JSON.stringify(pageErrors));

  // Authoritative check: the panel document exists as a SIDE_PANEL context.
  // (Playwright does not expose side panel targets as pages.)
  let panelContexts = [];
  for (let i = 0; i < 10 && panelContexts.length === 0; i++) {
    panelContexts = await sw.evaluate(() =>
      chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }));
    if (panelContexts.length === 0) await new Promise(r => setTimeout(r, 500));
  }
  check('Side panel actually opened (SIDE_PANEL context exists)',
    panelContexts.length > 0, JSON.stringify(panelContexts));

  await context.close();

  console.log('\n=============================');
  console.log('Panel gesture: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Panel gesture test failed to run:', err);
  process.exit(1);
});
