/**
 * Test: strict YouTube host validation
 * A tab whose URL merely CONTAINS youtube.com/watch?v=... (hostile or
 * accidental) must not be counted, collected, or logged. Real watch URLs
 * must still work.
 */
const { chromium } = require('playwright');
const path = require('path');

const extensionPath = path.resolve(__dirname, '..');
// example.com serves a 404 for this path, but the TAB URL is what matters
const EVIL_URL = 'https://example.com/youtube.com/watch?v=AAAAAAAAAAA';
const REAL_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

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

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);

  const evilPage = await context.newPage();
  await evilPage.goto(EVIL_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const realPage = await context.newPage();
  await realPage.goto(REAL_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await popup.waitForTimeout(1500);

  console.log('\n--- Stats ignore lookalike URLs ---');
  const stats = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_STATS' }));
  check('Exactly 1 YouTube tab counted (got ' + stats.ytTabs + ')', stats.ytTabs === 1);

  console.log('\n--- Collect ignores lookalike URLs ---');
  await sw.evaluate(() => chrome.storage.local.set({ yt_videos: [], yt_logged_videos: [] }));
  const collected = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'COLLECT_TABS' }));
  const queue = await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_videos');
    return (r.yt_videos || []).map(v => ({ id: v.id, url: v.url }));
  });
  check('Real video collected', queue.some(v => v.id === 'dQw4w9WgXcQ'));
  check('Hostile URL NOT collected (AAAAAAAAAAA absent)',
    !queue.some(v => v.id === 'AAAAAAAAAAA'), JSON.stringify(queue));
  check('No queue entry points at example.com',
    !queue.some(v => v.url.includes('example.com')), JSON.stringify(queue));

  console.log('\n--- Silent log ignores lookalike URLs ---');
  const logged = await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_logged_videos');
    return r.yt_logged_videos || [];
  });
  check('Hostile URL not silently logged',
    !logged.some(v => v.id === 'AAAAAAAAAAA'), JSON.stringify(logged));

  await context.close();

  console.log('\n=============================');
  console.log('URL validation: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('URL validation test failed to run:', err);
  process.exit(1);
});
