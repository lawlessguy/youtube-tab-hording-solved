/**
 * Live E2E (headed, manual): loads REAL youtube.com, enables the in-page
 * queue strip with a seeded queue, and verifies the strip injects into the
 * real masthead between #center and #end. Captures
 * screenshots/stages/viewing-modes/strip-live-youtube.png for design review.
 * Run manually: node tests/test-viewing-live.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const extensionPath = path.resolve(__dirname, '..');
const stageShotDir = path.join(extensionPath, 'screenshots', 'stages', 'viewing-modes');

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
  fs.mkdirSync(stageShotDir, { recursive: true });

  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--window-size=1500,900',
    ],
    viewport: null,
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');

  // Wait for onInstalled to finish seeding storage on the fresh profile —
  // seeding immediately races its writes (normalizeLegacyVideos initializes
  // an absent yt_videos to [] and would clobber our seed)
  await sw.evaluate(async () => {
    for (let i = 0; i < 50; i++) {
      const r = await chrome.storage.local.get(['yt_settings', 'yt_videos']);
      if (r.yt_settings && r.yt_videos) return;
      await new Promise(res => setTimeout(res, 100));
    }
  });

  // Enable the strip + seed a queue with real thumbnail URLs
  await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_settings');
    await chrome.storage.local.set({
      yt_settings: { ...(r.yt_settings || {}), inPageQueue: true },
    });
    const ids = ['dQw4w9WgXcQ', 'jNQXAC9IVRw', '9bZkp7q19f0', 'kJQP7kiw5Fk', 'M7lc1UVf-VE'];
    await chrome.storage.local.set({
      yt_videos: ids.map((id, i) => ({
        id,
        url: 'https://www.youtube.com/watch?v=' + id,
        title: 'Live test video ' + (i + 1),
        channel: 'Live Channel',
        thumbnail: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg',
        duration: 200 + i,
        addedAt: Date.now() - i * 1000,
        uploadedAt: null,
        isShort: false,
        watched: false,
        starred: false,
        sessionId: 'main',
        addCount: 1,
      })),
    });
  });

  console.log('Opening real YouTube home page...');
  const page = await context.newPage();
  await page.goto('https://www.youtube.com/', {
    waitUntil: 'domcontentloaded', timeout: 60000,
  });
  await page.waitForTimeout(5000); // content script init + masthead settle

  const strip = await page.evaluate(() => {
    const s = document.getElementById('ytm-inpage-queue');
    if (!s) return null;
    const center = document.querySelector('ytd-masthead #container #center');
    const rect = s.getBoundingClientRect();
    return {
      siblingOfCenter: center ? center.nextElementSibling === s : false,
      tiles: s.querySelectorAll('.ytm-ipq-item').length,
      visible: rect.width > 0 && rect.height > 0,
      top: rect.top, height: rect.height,
    };
  });
  check('Strip injected on real YouTube masthead', !!strip);
  check('Strip is the next sibling of #center', !!strip && strip.siblingOfCenter);
  check('All 5 seeded tiles rendered (got ' + (strip && strip.tiles) + ')',
    !!strip && strip.tiles === 5);
  check('Strip is visible in the masthead row', !!strip && strip.visible && strip.top < 80);

  // Masthead area screenshot for design review (strip is in-page — no
  // browser chrome needed)
  await page.screenshot({
    path: path.join(stageShotDir, 'strip-live-youtube.png'),
    clip: { x: 0, y: 0, width: 1500, height: 120 },
  });
  console.log('  Screenshot: screenshots/stages/viewing-modes/strip-live-youtube.png');

  // Full-page context shot as well
  await page.screenshot({
    path: path.join(stageShotDir, 'strip-live-youtube-full.png'),
  });
  console.log('  Screenshot: screenshots/stages/viewing-modes/strip-live-youtube-full.png');

  await context.close();

  console.log('\n=============================');
  console.log('Live viewing modes: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Live viewing-modes test failed to run:', err);
  process.exit(1);
});
