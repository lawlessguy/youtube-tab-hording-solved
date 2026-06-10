/**
 * THROWAWAY live verification probe (headed) — deferred items 7a/7b/7c:
 *  7b. shortsAutoScroll on a REAL Short: let it loop once -> navigates to a
 *      different /shorts/ id (native next-button click path)
 *  7a. shortsAutoClose on a REAL Short: let it loop once -> the tab closes
 *      (worker CLOSE_SHORT_TAB path)
 *  7c. In-panel Shorts embed for a REAL short id: iframe loads (or clean
 *      error card for embed-disabled) — screenshot
 * Plus console hygiene: SW console.error patch + page console errors.
 * Run: node tests/verify-shorts-auto.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const extensionPath = path.resolve(__dirname, '..');
const outDir = path.join(extensionPath, 'screenshots', 'verify');

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) { console.log('  ✔ ' + label); passed++; }
  else { console.log('  ✘ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });

  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--window-size=1500,950',
      '--autoplay-policy=no-user-gesture-required',
    ],
    viewport: null,
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extensionId = sw.url().split('/')[2];

  await sw.evaluate(() => {
    self.__errors = [];
    const orig = console.error;
    console.error = (...a) => { self.__errors.push(a.map(String).join(' ')); orig(...a); };
  });

  // Wait for onInstalled seeding (writing settings immediately races it)
  await sw.evaluate(async () => {
    for (let i = 0; i < 50; i++) {
      const r = await chrome.storage.local.get(['yt_settings', 'yt_videos']);
      if (r.yt_settings && r.yt_videos) return;
      await new Promise(res => setTimeout(res, 100));
    }
  });

  const pageErrors = [];
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', e => pageErrors.push('pageerror: ' + String(e.message).slice(0, 300)));

  // ---------- 7b: auto-scroll on a real looping Short ----------
  await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_settings');
    await chrome.storage.local.set({
      yt_settings: { ...(r.yt_settings || {}), shortsAutoScroll: true, shortsAutoClose: false },
    });
  });

  console.log('Opening real Shorts feed (auto-scroll probe)...');
  await page.goto('https://www.youtube.com/shorts', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000); // hydration + content-script init

  const idA = await page.evaluate(() =>
    location.pathname.startsWith('/shorts/') ? location.pathname.split('/')[2] : null);
  check('Landed on a real Short (id ' + idA + ')', !!idA, page.url());

  // Mute + fast-forward to ~3s before the loop boundary (the manual-seek
  // guard is 1.5s, so the wrap fires the finish detector)
  const fastForward = () => page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v || !isFinite(v.duration) || v.duration < 4 || v.readyState < 2) return null;
    v.muted = true;
    v.play().catch(() => {});
    v.currentTime = Math.max(0, v.duration - 3);
    return { dur: Math.round(v.duration), t: Math.round(v.currentTime) };
  });
  let ff = null;
  for (let i = 0; i < 20 && !ff; i++) { ff = await fastForward(); if (!ff) await page.waitForTimeout(1000); }
  check('Real Shorts <video> playing, seeked near end', !!ff, JSON.stringify(ff));

  let idB = null;
  try {
    await page.waitForFunction(
      (a) => location.pathname.startsWith('/shorts/') && location.pathname.split('/')[2] !== a,
      idA, { timeout: 30000 });
    idB = await page.evaluate(() => location.pathname.split('/')[2]);
  } catch {}
  check('Auto-scroll advanced to a DIFFERENT Short after one loop (' + idA + ' → ' + idB + ')',
    !!idB && idB !== idA);
  await page.screenshot({ path: path.join(outDir, 'shorts-autoscroll-after.png') }).catch(() => {});

  // ---------- 7a: auto-close on a real looping Short ----------
  await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_settings');
    await chrome.storage.local.set({
      yt_settings: { ...(r.yt_settings || {}), shortsAutoScroll: false, shortsAutoClose: true },
    });
  });
  await page.waitForTimeout(2000); // storage.onChanged refresh of cachedSettings

  console.log('Auto-close probe on the current Short (' + idB + ')...');
  ff = null;
  for (let i = 0; i < 20 && !ff; i++) { ff = await fastForward(); if (!ff) await page.waitForTimeout(1000); }
  check('Short playing for the auto-close probe', !!ff, JSON.stringify(ff));

  const closed = page.isClosed() ? true : await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 30000);
    page.on('close', () => { clearTimeout(t); resolve(true); });
  });
  check('Tab auto-closed at the loop boundary (worker CLOSE_SHORT_TAB path)', closed);

  const shortsTabs = await sw.evaluate(async () =>
    (await chrome.tabs.query({ url: '*://www.youtube.com/shorts/*' })).length);
  check('No /shorts/ tabs remain (got ' + shortsTabs + ')', shortsTabs === 0);

  // ---------- 7c: in-panel embed for a REAL short id ----------
  console.log('In-panel Shorts embed probe (panel page as tab, real id ' + idA + ')...');
  const embedId = idA || idB;
  if (embedId) {
    await sw.evaluate(async (id) => {
      await chrome.storage.local.set({
        yt_videos: [{
          id, url: 'https://www.youtube.com/shorts/' + id, title: 'Verify embed Short',
          channel: 'verify', thumbnail: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg',
          duration: 30, addedAt: Date.now(), uploadedAt: null, isShort: true,
          watched: false, starred: false, sessionId: 'main', addCount: 1,
        }],
      });
    }, embedId);
    const panel = await context.newPage();
    panel.on('console', m => { if (m.type() === 'error') pageErrors.push('[panel] ' + m.text().slice(0, 300)); });
    panel.on('pageerror', e => pageErrors.push('[panel] pageerror: ' + String(e.message).slice(0, 300)));
    await panel.goto('chrome-extension://' + extensionId + '/sidepanel/sidepanel.html');
    await panel.setViewportSize({ width: 380, height: 900 });
    await panel.waitForTimeout(2000);
    await panel.evaluate((id) => openShortsPlayer(id), embedId);
    await panel.waitForTimeout(8000); // embeddability pre-flight + iframe load
    const embedState = await panel.evaluate(() => {
      const iframe = document.querySelector('#shorts-player iframe');
      return {
        iframe: !!iframe,
        iframeSrcOk: iframe ? iframe.src.startsWith('https://www.youtube.com/embed/') : false,
        errorCard: !!document.querySelector('#shorts-player .sp-error'),
        errorText: document.querySelector('#shorts-player .sp-error')?.textContent || null,
        title: document.querySelector('#shorts-player .sp-title')?.textContent || null,
      };
    });
    console.log('  Embed state: ' + JSON.stringify(embedState));
    check('In-panel player rendered an iframe OR a clean error card',
      (embedState.iframe && embedState.iframeSrcOk) || embedState.errorCard,
      JSON.stringify(embedState));
    await panel.screenshot({ path: path.join(outDir, 'panel-shorts-embed.png') });
    console.log('  Screenshot: screenshots/verify/panel-shorts-embed.png');
  } else {
    check('In-panel embed probe had a real short id', false, 'no id captured');
  }

  // ---------- console hygiene ----------
  const swErrors = await sw.evaluate(() => self.__errors);
  console.log('\nSW console.error entries (' + swErrors.length + '):');
  swErrors.slice(0, 10).forEach(e => console.log('   [sw] ' + e));
  console.log('Page console errors (' + pageErrors.length + '):');
  pageErrors.slice(0, 15).forEach(e => console.log('   [page] ' + e));
  check('No service-worker console.error entries', swErrors.length === 0, JSON.stringify(swErrors.slice(0, 5)));

  await context.close();

  console.log('\n=============================');
  console.log('Shorts auto probes: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Probe failed to run:', err);
  process.exit(1);
});
