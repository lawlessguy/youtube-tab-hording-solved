/**
 * Live E2E (headed): player stage (02) against REAL youtube.com.
 * Verifies on a real watch page:
 *  - resize handles inject on the real #player-container and a south-handle
 *    drag grows the real player (height rule + window-resize re-fit)
 *  - double-click reset restores native sizing
 *  - a >=3s timeline seek is undoable with Ctrl+Z (toast over the player)
 *  - a native-equivalent ratechange persists to yt_settings.speedLevel
 * Screenshots: screenshots/stages/player/live-*.png
 * Run manually: node tests/test-player-live.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const extensionPath = path.resolve(__dirname, '..');
const stageShotDir = path.join(extensionPath, 'screenshots', 'stages', 'player');

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
      '--window-size=1500,950',
    ],
    viewport: { width: 1480, height: 880 },
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');

  console.log('Opening real YouTube watch page...');
  const page = await context.newPage();
  await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
    waitUntil: 'domcontentloaded', timeout: 60000,
  });
  await page.waitForTimeout(3000);

  // Consent dialog (region-dependent)
  try {
    const consentBtn = await page.$('button[aria-label*="Accept"], button[aria-label*="Reject"]');
    if (consentBtn) { await consentBtn.click(); await page.waitForTimeout(2500); }
  } catch {}

  // Mute + wait out preroll ads (resize works during ads; seeks do not)
  try {
    await page.keyboard.press('m');
    await page.waitForFunction(
      () => !document.querySelector('.html5-video-player.ad-showing'),
      { timeout: 90000 });
  } catch { console.log('  (ad still showing after 90s — continuing)'); }
  await page.waitForTimeout(3500); // applyYouTubeUI(2s) + handle injection

  // --- Handles present on the real container ---
  const handleInfo = await page.evaluate(() => {
    const o = document.getElementById('ytm-resize-handles');
    if (!o) return null;
    return {
      count: o.querySelectorAll('.ytm-resize-handle').length,
      mode: o.dataset.mode,
      parent: o.parentElement?.id || o.parentElement?.tagName,
    };
  });
  check('Resize handles injected on real watch page', !!handleInfo, JSON.stringify(handleInfo));
  check('3 handles in default mode', handleInfo?.count === 3 && handleInfo?.mode === 'default',
    JSON.stringify(handleInfo));

  const heightBefore = await page.evaluate(() =>
    document.querySelector('#player-container-inner')?.getBoundingClientRect().height || 0);

  // Hover the south handle so its highlight shows in the screenshot
  const sBox = await page.locator('.ytm-resize-handle--s').boundingBox();
  check('South handle hover-reachable (not clipped)', !!sBox && sBox.height >= 6,
    JSON.stringify(sBox));
  if (sBox) {
    await page.mouse.move(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
    await page.waitForTimeout(400);
  }
  await page.screenshot({ path: path.join(stageShotDir, 'live-handles-hover.png') });
  console.log('  Screenshot: screenshots/stages/player/live-handles-hover.png');

  // --- Drag the south handle down 80px: the REAL player must re-fit ---
  if (sBox) {
    const cx = sBox.x + sBox.width / 2;
    const cy = sBox.y + sBox.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy + 40, { steps: 6 });
    await page.mouse.move(cx, cy + 80, { steps: 6 });
    await page.waitForTimeout(200);
    await page.mouse.up();
    await page.waitForTimeout(1200);
  }
  const heightAfter = await page.evaluate(() =>
    document.querySelector('#player-container-inner')?.getBoundingClientRect().height || 0);
  check('Real player grew by ~80px (' + Math.round(heightBefore) + ' → ' + Math.round(heightAfter) + ')',
    heightAfter - heightBefore > 50);
  const videoFits = await page.evaluate(() => {
    const v = document.querySelector('video');
    const c = document.querySelector('#player-container-inner');
    if (!v || !c) return null;
    return { vh: v.getBoundingClientRect().height, ch: c.getBoundingClientRect().height };
  });
  check('Real <video> re-fit into the resized box (window-resize technique)',
    !!videoFits && videoFits.vh > heightBefore - 10, JSON.stringify(videoFits));
  const stored = await sw.evaluate(async () =>
    (await chrome.storage.local.get('yt_settings')).yt_settings?.playerSizeDefault);
  check('playerSizeDefault persisted (got ' + JSON.stringify(stored) + ')',
    !!stored && typeof stored.h === 'number');
  await page.screenshot({ path: path.join(stageShotDir, 'live-resized.png') });
  console.log('  Screenshot: screenshots/stages/player/live-resized.png');

  // --- Double-click reset restores native sizing ---
  await page.locator('.ytm-resize-handle--s').dblclick();
  await page.waitForTimeout(1200);
  const heightReset = await page.evaluate(() =>
    document.querySelector('#player-container-inner')?.getBoundingClientRect().height || 0);
  check('Double-click restored native height (' + Math.round(heightReset) + ')',
    Math.abs(heightReset - heightBefore) < 20,
    'before=' + heightBefore + ' reset=' + heightReset);

  // --- Timeline history on the real player ---
  await page.evaluate(() => { document.querySelector('video').currentTime = 5; });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { document.querySelector('video').currentTime = 45; });
  await page.waitForTimeout(1500); // 800ms coalesce + slack
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(stageShotDir, 'live-seek-toast.png') });
  console.log('  Screenshot: screenshots/stages/player/live-seek-toast.png');
  const afterUndo = await page.evaluate(() => document.querySelector('video').currentTime);
  check('Ctrl+Z restored the pre-seek position (~5s, got ' + afterUndo.toFixed(1) + ')',
    Math.abs(afterUndo - 5) < 2);
  const toast = await page.evaluate(() =>
    document.getElementById('ytm-seek-toast')?.textContent || null);
  check('Toast rendered over the real player (got "' + toast + '")', !!toast);

  // --- Speed sync: rate change on the real video persists ---
  await page.evaluate(() => { document.querySelector('video').playbackRate = 0.75; });
  await page.waitForTimeout(1000);
  const speed = await sw.evaluate(async () =>
    (await chrome.storage.local.get('yt_settings')).yt_settings?.speedLevel);
  check('Rate change persisted to speedLevel 0.75 (got ' + speed + ')', speed === 0.75);

  await context.close();

  console.log('\n=============================');
  console.log('Player live: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Player live test failed to run:', err);
  process.exit(1);
});
