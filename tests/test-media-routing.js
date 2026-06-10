/**
 * Test: media state/control tab routing
 * Verifies GET_MEDIA_STATE reports the tabId it's describing and that
 * MEDIA_CONTROL targets an explicitly passed tabId (with graceful fallback).
 */
const { chromium } = require('playwright');
const path = require('path');

const extensionPath = path.resolve(__dirname, '..');

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
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extensionId = sw.url().split('/')[2];

  // Open a YouTube watch page so a content script is listening there
  const ytPage = await context.newPage();
  await ytPage.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  await ytPage.waitForTimeout(4000);
  await ytPage.bringToFront();

  // Message from an extension page context
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.waitForTimeout(300);
  await ytPage.bringToFront(); // keep the YT tab active for the active-tab path

  console.log('\n--- Media state routing ---');
  const state = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_MEDIA_STATE' }));
  check('State has videoId (got ' + state?.videoId + ')', state?.videoId === 'dQw4w9WgXcQ');
  check('State includes tabId (got ' + state?.tabId + ')', typeof state?.tabId === 'number');

  console.log('\n--- Media control routing ---');
  const ctl = await popup.evaluate((tabId) =>
    chrome.runtime.sendMessage({ type: 'MEDIA_CONTROL', action: 'rewind', tabId }),
    state?.tabId);
  check('Explicit-tabId control returns a response', !!ctl && typeof ctl === 'object',
    JSON.stringify(ctl));

  const bogus = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'MEDIA_CONTROL', action: 'rewind', tabId: 999999 }));
  check('Bogus tabId falls back without crashing', !!bogus && typeof bogus === 'object',
    JSON.stringify(bogus));

  await context.close();

  console.log('\n=============================');
  console.log('Media routing: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Media routing test failed to run:', err);
  process.exit(1);
});
