/**
 * THROWAWAY live verification probe (headed) — deferred item 7d:
 * In-page queue strip + Q/W badges on a REAL watch page, then strip + shorts
 * rail on a REAL shorts page — geometric no-overlap assertions + DPI-aware
 * desktop captures (virtual screen, window activated first).
 * Run: node tests/verify-coexist.js
 */
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
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

// Activate the test window by (unique) title so the user's own windows can't
// occlude the capture, then DPI-aware capture of the FULL virtual screen
// (the test window may sit on a non-primary monitor).
function activateWindow(title) {
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      "(New-Object -ComObject WScript.Shell).AppActivate('" + title + "') | Out-Null; Start-Sleep -Milliseconds 500"]);
  } catch {}
}
function captureDesktop(file) {
  const psScript =
    "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();' -Name U -Namespace W; " +
    '[W.U]::SetProcessDPIAware() | Out-Null; ' +
    'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ' +
    '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen; ' +
    '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; ' +
    '$g=[System.Drawing.Graphics]::FromImage($bmp); ' +
    '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); ' +
    "$bmp.Save('" + file + "'); " +
    '$g.Dispose(); $bmp.Dispose()';
  execFileSync('powershell', ['-NoProfile', '-Command', psScript]);
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });

  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--window-size=1600,950',
      '--autoplay-policy=no-user-gesture-required',
    ],
    viewport: null,
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');

  await sw.evaluate(() => {
    self.__errors = [];
    const orig = console.error;
    console.error = (...a) => { self.__errors.push(a.map(String).join(' ')); orig(...a); };
  });

  // Wait out the onInstalled seeding race before writing storage
  await sw.evaluate(async () => {
    for (let i = 0; i < 50; i++) {
      const r = await chrome.storage.local.get(['yt_settings', 'yt_videos']);
      if (r.yt_settings && r.yt_videos) return;
      await new Promise(res => setTimeout(res, 100));
    }
  });

  // Enable the strip + seed a queue (real thumbnails)
  await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_settings');
    await chrome.storage.local.set({
      yt_settings: { ...(r.yt_settings || {}), inPageQueue: true },
    });
    const ids = ['dQw4w9WgXcQ', 'jNQXAC9IVRw', '9bZkp7q19f0', 'kJQP7kiw5Fk'];
    await chrome.storage.local.set({
      yt_videos: ids.map((id, i) => ({
        id, url: 'https://www.youtube.com/watch?v=' + id,
        title: 'Coexist probe ' + (i + 1), channel: 'Verify',
        thumbnail: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg',
        duration: 200 + i, addedAt: Date.now() - i * 1000, uploadedAt: null,
        isShort: false, watched: false, starred: false, sessionId: 'main', addCount: 1,
      })),
    });
  });

  const pageErrors = [];
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', e => pageErrors.push('pageerror: ' + String(e.message).slice(0, 300)));

  // ---------- REAL watch page: strip + Q/W badges ----------
  console.log('Opening real watch page (strip + badges)...');
  await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
    waitUntil: 'domcontentloaded', timeout: 60000,
  });
  await page.waitForTimeout(7000);
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) { v.muted = true; }
  });

  // Seed two sidebar recommendation ids (one queued, one watched) so Q AND W
  // badges appear on the live page
  const recIds = await page.evaluate(() => {
    const ids = [];
    for (const a of document.querySelectorAll(
      'a.ytLockupViewModelContentImage[href], a.yt-lockup-view-model__content-image[href], a#thumbnail[href]')) {
      const m = (a.getAttribute('href') || '').match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);
      if (m && !ids.includes(m[1]) && ids.length < 2) ids.push(m[1]);
    }
    return ids;
  });
  check('Found 2 badge-eligible recommendation ids', recIds.length === 2, JSON.stringify(recIds));
  await sw.evaluate(async (ids) => {
    const r = await chrome.storage.local.get('yt_videos');
    const videos = r.yt_videos || [];
    ids.forEach((id, i) => videos.push({
      id, url: 'https://www.youtube.com/watch?v=' + id,
      title: i === 0 ? 'Rec queued' : 'Rec watched', channel: 'Verify',
      thumbnail: 'https://i.ytimg.com/vi/' + id + '/mqdefault.jpg',
      duration: 100, addedAt: Date.now(), uploadedAt: null, isShort: false,
      watched: i === 1, starred: false, sessionId: 'main', addCount: 1,
    }));
    await chrome.storage.local.set({ yt_videos: videos });
  }, recIds);
  await page.waitForTimeout(4000); // onChanged + 1.5s throttle + paint

  const watchState = await page.evaluate(() => {
    const rect = (el) => el ? el.getBoundingClientRect() : null;
    const overlap = (a, b) => a && b && a.width > 0 && b.width > 0 &&
      !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    const strip = rect(document.getElementById('ytm-inpage-queue'));
    const center = rect(document.querySelector('ytd-masthead #container #center'));
    const end = rect(document.querySelector('ytd-masthead #container #end'));
    return {
      strip: !!strip && strip.width > 0,
      tiles: document.querySelectorAll('#ytm-inpage-queue .ytm-ipq-item').length,
      qBadges: document.querySelectorAll('.ytm-status-badge--queued').length,
      wBadges: document.querySelectorAll('.ytm-status-badge--watched').length,
      stripVsSearch: overlap(strip, center),
      stripVsEnd: overlap(strip, end),
    };
  });
  check('Strip visible on the real watch page', watchState.strip, JSON.stringify(watchState));
  check('Strip tiles rendered (got ' + watchState.tiles + ')', watchState.tiles >= 4);
  check('Q badges on live thumbnails (got ' + watchState.qBadges + ')', watchState.qBadges >= 1);
  check('W badge on a live thumbnail (got ' + watchState.wBadges + ')', watchState.wBadges >= 1);
  check('Strip does NOT overlap the search box', watchState.stripVsSearch === false);
  check('Strip does NOT overlap the masthead end buttons', watchState.stripVsEnd === false);

  await page.evaluate(() => { document.title = 'YTM VERIFY WATCH'; });
  activateWindow('YTM VERIFY WATCH');
  captureDesktop(path.join(outDir, 'coexist-watch-desktop.png'));
  console.log('  Screenshot: screenshots/verify/coexist-watch-desktop.png');

  // ---------- REAL shorts page: strip + rail coexistence ----------
  console.log('Navigating to the real Shorts feed (strip + rail)...');
  await page.goto('https://www.youtube.com/shorts', {
    waitUntil: 'domcontentloaded', timeout: 60000,
  });
  await page.waitForTimeout(7000);
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) v.muted = true;
  });

  const shortsState = await page.evaluate(() => {
    const rect = (el) => el ? el.getBoundingClientRect() : null;
    const overlap = (a, b) => a && b && a.width > 0 && b.width > 0 &&
      !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    const rail = rect(document.getElementById('ytm-shorts-rail'));
    const strip = rect(document.getElementById('ytm-inpage-queue'));
    const reel = rect(document.querySelector('ytd-reel-video-renderer[is-active], #shorts-player'));
    return {
      onShorts: location.pathname.startsWith('/shorts/'),
      rail: !!rail && rail.width > 0,
      strip: !!strip && strip.width > 0,
      railVsReel: overlap(rail, reel),
      railVsStrip: overlap(rail, strip),
    };
  });
  check('Landed on a real Short', shortsState.onShorts, JSON.stringify(shortsState));
  check('Shorts rail present alongside the strip', shortsState.rail, JSON.stringify(shortsState));
  check('Strip still visible on the shorts page', shortsState.strip, JSON.stringify(shortsState));
  check('Rail does NOT overlap the active reel', shortsState.railVsReel === false);
  check('Rail does NOT overlap the strip', shortsState.railVsStrip === false);

  await page.evaluate(() => { document.title = 'YTM VERIFY SHORTS'; });
  activateWindow('YTM VERIFY SHORTS');
  captureDesktop(path.join(outDir, 'coexist-shorts-desktop.png'));
  console.log('  Screenshot: screenshots/verify/coexist-shorts-desktop.png');

  // ---------- console hygiene ----------
  const swErrors = await sw.evaluate(() => self.__errors);
  console.log('\nSW console.error entries (' + swErrors.length + '):');
  swErrors.slice(0, 10).forEach(e => console.log('   [sw] ' + e));
  console.log('Page console errors (' + pageErrors.length + '):');
  pageErrors.slice(0, 15).forEach(e => console.log('   [page] ' + e));
  check('No service-worker console.error entries', swErrors.length === 0, JSON.stringify(swErrors.slice(0, 5)));

  await context.close();

  console.log('\n=============================');
  console.log('Coexistence probe: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Probe failed to run:', err);
  process.exit(1);
});
