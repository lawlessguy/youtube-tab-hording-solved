/**
 * Test: Player stage (02) — speed sync, resizable player, timeline history.
 *  - SPEED_CHANGED: native ratechange on a watch page persists to
 *    yt_settings.speedLevel (clamped, deduped, no echo to other tabs)
 *  - Panel + popup sliders/labels live-update via storage.onChanged with the
 *    shared fmtSpeed rendering (off-step values like 0.25 stay exact)
 *  - Loop guard: extension-driven SET_SPEED never ping-pongs back through
 *    SPEED_CHANGED (lastAppliedRate + worker write-skip)
 *  - Ad guard: ratechange while .ad-showing is ignored
 *  - Resize: handles injected on /watch, drag persists per-mode size on
 *    pointerup only, double-click resets, playerResizeEnabled kills it all
 *  - Timeline history: >=3s seeks recorded; Ctrl+Z / Ctrl+Shift+Z restore;
 *    editable targets and sub-threshold jumps are ignored
 *
 * Shared fixture: tests/assets/tiny-webm.js (contract section 7) — generated
 * once here via a MediaRecorder canvas capture if absent, then checked in.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const extensionPath = path.resolve(__dirname, '..');
const stageShotDir = path.join(extensionPath, 'screenshots', 'stages', 'player');
const ASSET_PATH = path.join(__dirname, 'assets', 'tiny-webm.js');

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

// One-time fixture generation (no ffmpeg dependency): a ~5s 64x64 VP8/WebM
// clip recorded from an animated canvas, exported as a base64 data URL.
async function ensureTinyWebm(context) {
  if (fs.existsSync(ASSET_PATH)) return require(ASSET_PATH).dataUrl;
  console.log('Generating tests/assets/tiny-webm.js (one-time MediaRecorder capture)...');
  const page = await context.newPage();
  const dataUrl = await page.evaluate(() => new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(15);
    const rec = new MediaRecorder(stream, {
      mimeType: 'video/webm;codecs=vp8',
      videoBitsPerSecond: 120000,
    });
    const chunks = [];
    rec.ondataavailable = ev => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    rec.onerror = () => reject(new Error('MediaRecorder error'));
    rec.onstop = async () => {
      try {
        const blob = new Blob(chunks, { type: 'video/webm' });
        const buf = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        const STEP = 0x8000;
        for (let i = 0; i < buf.length; i += STEP) {
          bin += String.fromCharCode.apply(null, buf.subarray(i, i + STEP));
        }
        resolve('data:video/webm;base64,' + btoa(bin));
      } catch (e) { reject(e); }
    };
    let n = 0;
    const timer = setInterval(() => {
      ctx.fillStyle = 'hsl(' + ((n * 7) % 360) + ', 80%, 50%)';
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = '#fff';
      ctx.font = '20px monospace';
      ctx.fillText(String(n % 100), 8, 40);
      n++;
      if (n * 50 >= 5000) { clearInterval(timer); rec.stop(); }
    }, 50);
    rec.start(250);
  }));
  await page.close();
  const content =
    '// Auto-generated once by tests/test-player.js (Playwright MediaRecorder\n' +
    '// canvas capture, ~5s 64x64 VP8/WebM). Shared seekable <video> fixture for\n' +
    '// fake-YouTube watch pages — see integration contract section 7. Checked in\n' +
    '// so every suite reuses the same clip; delete this file to regenerate.\n' +
    "module.exports = { dataUrl: '" + dataUrl + "' };\n";
  fs.mkdirSync(path.dirname(ASSET_PATH), { recursive: true });
  fs.writeFileSync(ASSET_PATH, content);
  console.log('  Wrote tests/assets/tiny-webm.js (' + dataUrl.length + ' chars)');
  return dataUrl;
}

// Skeleton watch page matching the selectors the content script targets.
// The content script gates on hostname (manifest match) + location.pathname.
function watchPageHtml(dataUrl) {
  return '<!DOCTYPE html><html><head><title>Player test - YouTube</title><style>' +
    'body{margin:0;background:#0f0f0f;color:#eee;font-family:Arial,sans-serif}' +
    '#player-container{width:640px;height:360px}' +
    '#player-container-inner{width:100%;height:100%}' +
    '#movie_player{width:100%;height:100%;background:#000;position:relative}' +
    'video{width:100%;height:100%}' +
    '#secondary{width:200px}' +
    '</style></head><body>' +
    '<ytd-watch-flexy>' +
    '<div id="player-container-outer"><div id="player-container">' +
    '<div id="player-container-inner"><div id="movie_player" class="html5-video-player">' +
    '<video src="' + dataUrl + '" muted playsinline preload="auto"></video>' +
    '</div></div></div></div>' +
    '<div id="secondary"></div>' +
    '</ytd-watch-flexy>' +
    '</body></html>';
}

(async () => {
  fs.mkdirSync(stageShotDir, { recursive: true });

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
  console.log('Extension ID:', extensionId);

  const errors = [];
  function watchConsole(page, label) {
    page.on('console', m => { if (m.type() === 'error') errors.push('[' + label + '] ' + m.text()); });
    page.on('pageerror', e => errors.push('[' + label + '] ' + e.message));
  }

  const dataUrl = await ensureTinyWebm(context);
  check('Fixture tests/assets/tiny-webm.js exists', fs.existsSync(ASSET_PATH));
  check('Fixture is a webm data URL', dataUrl.startsWith('data:video/webm;base64,'));

  const PAGE = watchPageHtml(dataUrl);
  await context.route('https://www.youtube.com/watch*', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
  // The panel's now-playing card fetches i.ytimg.com thumbnails for whatever
  // is playing — stub them so fake videoIds don't 404 into the console watch
  const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64');
  await context.route('https://i.ytimg.com/**', route =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1x1 }));

  const readSettings = () => sw.evaluate(async () =>
    (await chrome.storage.local.get('yt_settings')).yt_settings || {});
  const mergeSettings = patch => sw.evaluate(async p => {
    const r = await chrome.storage.local.get('yt_settings');
    await chrome.storage.local.set({ yt_settings: { ...(r.yt_settings || {}), ...p } });
  }, patch);

  // Representative queue so panel screenshots show real cards
  await sw.evaluate(() => chrome.storage.local.set({
    yt_videos: [
      { id: 'PLAYERVIDA1', url: 'https://www.youtube.com/watch?v=PLAYERVIDA1',
        title: 'Resizable player demo video', channel: 'Player Channel', thumbnail: '',
        duration: 754, addedAt: Date.now() - 60000, uploadedAt: null, isShort: false,
        watched: false, starred: false, sessionId: 'main', addCount: 1 },
      { id: 'PLAYERVIDB2', url: 'https://www.youtube.com/watch?v=PLAYERVIDB2',
        title: 'Timeline history demo video', channel: 'Player Channel', thumbnail: '',
        duration: 1325, addedAt: Date.now() - 30000, uploadedAt: null, isShort: false,
        watched: false, starred: true, sessionId: 'main', addCount: 2 },
    ],
  }));

  // --- Fake watch page ---
  const watchPage = await context.newPage();
  watchConsole(watchPage, 'watch');
  await watchPage.goto('https://www.youtube.com/watch?v=PLAYERTEST1');
  await watchPage.waitForFunction(() => {
    const v = document.querySelector('video');
    return v && v.readyState >= 2;
  }, { timeout: 20000 });
  await watchPage.waitForTimeout(2500); // content-script init + applyYouTubeUI (2s)

  // --- 1. Speed sync: native ratechange → yt_settings ---
  console.log('\n--- Speed sync: native ratechange persists ---');
  await watchPage.evaluate(() => document.querySelector('video').play());
  await watchPage.waitForTimeout(1100); // 'playing' + 500ms arming + slack
  await watchPage.evaluate(() => { document.querySelector('video').playbackRate = 1.5; });
  await watchPage.waitForTimeout(800); // 250ms debounce + worker write
  let s = await readSettings();
  check('Native rate change persisted to speedLevel 1.5 (got ' + s.speedLevel + ')',
    s.speedLevel === 1.5);

  // --- 2. Panel initial load reflects storage ---
  console.log('\n--- Panel + popup slider sync ---');
  const panel = await context.newPage();
  watchConsole(panel, 'panel');
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  await panel.setViewportSize({ width: 350, height: 900 });
  await panel.waitForTimeout(900);
  check('Panel slider initial value 15', (await panel.inputValue('#speed-slider')) === '15');
  check('Panel label initial 1.5x', (await panel.textContent('#speed-value')) === '1.5x');

  const popup = await context.newPage();
  watchConsole(popup, 'popup');
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.setViewportSize({ width: 400, height: 600 });
  await popup.waitForTimeout(700);
  check('Popup label initial 1.5x', (await popup.textContent('#speed-value')) === '1.5x');

  // --- 3. Live update via storage.onChanged, off-step value ---
  await mergeSettings({ speedLevel: 0.25 });
  await panel.waitForTimeout(600);
  check('Panel label live-updates to 0.25x without reload',
    (await panel.textContent('#speed-value')) === '0.25x');
  check('Panel slider thumb rounds to 3 (Math.round(0.25*10))',
    (await panel.inputValue('#speed-slider')) === '3');
  check('Popup label live-updates to 0.25x without reload',
    (await popup.textContent('#speed-value')) === '0.25x');
  check('Popup slider thumb rounds to 3',
    (await popup.inputValue('#speed-slider')) === '3');

  await panel.screenshot({ path: path.join(stageShotDir, 'sidepanel-speed-025.png') });
  await popup.screenshot({ path: path.join(stageShotDir, 'popup-speed-025.png') });
  console.log('  Screenshots: screenshots/stages/player/{sidepanel,popup}-speed-025.png');

  // --- 4. Loop guard: panel slider → SET_SPEED → no oscillation ---
  console.log('\n--- Loop guard ---');
  await watchPage.bringToFront(); // SET_SPEED scope "tab" targets the active tab
  await panel.evaluate(() => {
    const sl = document.getElementById('speed-slider');
    sl.value = 20;
    sl.dispatchEvent(new Event('input'));
    sl.dispatchEvent(new Event('change'));
  });
  await watchPage.waitForTimeout(1000);
  const reads = [];
  for (let i = 0; i < 3; i++) {
    reads.push((await readSettings()).speedLevel);
    await watchPage.waitForTimeout(300);
  }
  check('speedLevel stable at 2 across 3 reads (got ' + reads.join(',') + ')',
    reads.every(v => v === 2));
  const inPageRate = await watchPage.evaluate(() => document.querySelector('video').playbackRate);
  check('In-page playbackRate applied as 2 (got ' + inPageRate + ')', inPageRate === 2);

  // --- 5. Ad guard ---
  console.log('\n--- Ad guard ---');
  await watchPage.evaluate(() => {
    document.getElementById('movie_player').classList.add('ad-showing');
    document.querySelector('video').playbackRate = 1;
  });
  await watchPage.waitForTimeout(800);
  s = await readSettings();
  check('speedLevel still 2 after ad-induced 1.0x flip (got ' + s.speedLevel + ')',
    s.speedLevel === 2);
  await watchPage.evaluate(() =>
    document.getElementById('movie_player').classList.remove('ad-showing'));

  // --- 6. Resize: handles + style baseline ---
  console.log('\n--- Resize: handles, drag, reset, kill switch ---');
  const handleInfo = await watchPage.evaluate(() => {
    const o = document.getElementById('ytm-resize-handles');
    return o ? {
      count: o.querySelectorAll('.ytm-resize-handle').length,
      mode: o.dataset.mode,
    } : null;
  });
  check('Handles overlay injected with 3 handles in default mode',
    !!handleInfo && handleInfo.count === 3 && handleInfo.mode === 'default',
    JSON.stringify(handleInfo));
  check('No #ytm-resize-style while both stored sizes are null',
    !(await watchPage.$('#ytm-resize-style')));

  // --- 7. Drag the bottom handle +50px; persist on pointerup only ---
  const box = await watchPage.locator('.ytm-resize-handle--s').boundingBox();
  check('South handle has a hover-reachable box', !!box && box.height >= 6);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await watchPage.mouse.move(cx, cy);
  await watchPage.mouse.down();
  await watchPage.mouse.move(cx, cy + 25, { steps: 4 });
  await watchPage.waitForTimeout(200); // let the rAF style write land
  const midStyle = await watchPage.evaluate(() =>
    document.getElementById('ytm-resize-style')?.textContent || '');
  const midStored = (await readSettings()).playerSizeDefault;
  await watchPage.mouse.move(cx, cy + 50, { steps: 4 });
  await watchPage.waitForTimeout(150);
  await watchPage.screenshot({ path: path.join(stageShotDir, 'watch-resize-dragging.png') });
  await watchPage.mouse.up();
  check('Mid-drag style contains a live height rule', midStyle.includes('height:'));
  check('Mid-drag storage still null (persist on pointerup only)',
    midStored === null || midStored === undefined, JSON.stringify(midStored));
  await watchPage.waitForTimeout(700);
  s = await readSettings();
  check('playerSizeDefault.h persisted ~410 (got ' + JSON.stringify(s.playerSizeDefault) + ')',
    !!s.playerSizeDefault && typeof s.playerSizeDefault.h === 'number' &&
    Math.abs(s.playerSizeDefault.h - 410) <= 4);
  const styleNow = await watchPage.evaluate(() =>
    document.getElementById('ytm-resize-style')?.textContent || '');
  check('Doubled-id height rule present after drag',
    styleNow.includes('#player-container-inner#player-container-inner') &&
    styleNow.includes('height:'));

  // --- 8. Double-click reset ---
  await watchPage.locator('.ytm-resize-handle--s').dblclick();
  await watchPage.waitForTimeout(700);
  s = await readSettings();
  check('Double-click reset persists playerSizeDefault null',
    s.playerSizeDefault === null, JSON.stringify(s.playerSizeDefault));
  check('Resize style removed after reset', !(await watchPage.$('#ytm-resize-style')));

  // --- 9. Kill switch via storage.onChanged ---
  await mergeSettings({ playerResizeEnabled: false });
  await watchPage.waitForTimeout(700);
  check('Handles removed when playerResizeEnabled=false',
    !(await watchPage.$('#ytm-resize-handles')));
  check('Resize style stays gone while disabled', !(await watchPage.$('#ytm-resize-style')));
  await panel.waitForTimeout(200);
  check('Panel tb-resize toggle reflects OFF without reload',
    !(await panel.evaluate(() => document.getElementById('tb-resize').classList.contains('active'))));
  await panel.screenshot({ path: path.join(stageShotDir, 'sidepanel-resize-off.png') });

  await mergeSettings({ playerResizeEnabled: true });
  await watchPage.waitForTimeout(700);
  check('Handles return when re-enabled (event-driven)',
    !!(await watchPage.$('#ytm-resize-handles')));
  check('Panel tb-resize toggle reflects ON again',
    await panel.evaluate(() => document.getElementById('tb-resize').classList.contains('active')));
  await panel.screenshot({ path: path.join(stageShotDir, 'sidepanel-resize-on.png') });
  console.log('  Screenshots: screenshots/stages/player/sidepanel-resize-{off,on}.png');

  // --- 10. Timeline history (fresh page = fresh in-memory stacks) ---
  console.log('\n--- Timeline history: Ctrl+Z / Ctrl+Shift+Z ---');
  await watchPage.reload();
  await watchPage.waitForFunction(() => {
    const v = document.querySelector('video');
    return v && v.readyState >= 2;
  }, { timeout: 20000 });
  await watchPage.waitForTimeout(2200);

  // MediaRecorder webm may report Infinity duration: normalize seekability
  // with the end-seek trick, then flush the content script's seek stacks via
  // a synthetic SPA navigation to a different videoId (stack reset path).
  const durInfo = await watchPage.evaluate(async () => {
    const v = document.querySelector('video');
    if (!isFinite(v.duration)) {
      v.currentTime = 1e9;
      await new Promise(r => v.addEventListener('seeked', r, { once: true }));
      v.currentTime = 0;
      await new Promise(r => v.addEventListener('seeked', r, { once: true }));
    }
    return { duration: v.duration, seekableEnd: v.seekable.length ? v.seekable.end(0) : 0 };
  });
  console.log('  Fixture duration ' + durInfo.duration + 's, seekable to ' + durInfo.seekableEnd + 's');
  check('Fixture seekable past 3.5s', durInfo.seekableEnd >= 3.5,
    JSON.stringify(durInfo));
  await watchPage.evaluate(() => {
    history.pushState(null, '', '/watch?v=PLAYERTEST2');
    document.body.appendChild(document.createElement('div')); // trip the URL observer
  });
  await watchPage.waitForTimeout(500);

  const seekTo = t => watchPage.evaluate(async target => {
    const v = document.querySelector('video');
    v.currentTime = target;
    await new Promise(r => v.addEventListener('seeked', r, { once: true }));
    return v.currentTime;
  }, t);
  const curTime = () => watchPage.evaluate(() => document.querySelector('video').currentTime);

  // Threshold: ~1s jumps record nothing → Ctrl+Z falls through
  await seekTo(0.3);
  await watchPage.waitForTimeout(1000); // coalesce window closes
  await seekTo(1.3);
  await watchPage.waitForTimeout(1000);
  await watchPage.keyboard.press('Control+z');
  await watchPage.waitForTimeout(300);
  let t = await curTime();
  check('Sub-threshold jump not undoable (still ~1.3, got ' + t.toFixed(2) + ')',
    Math.abs(t - 1.3) < 0.15);

  // Real jump >= 3s records the pre-seek origin
  await seekTo(0.4);
  await watchPage.waitForTimeout(1000);
  const landed = await seekTo(3.5);
  await watchPage.waitForTimeout(1100); // 800ms finalize + slack
  await watchPage.keyboard.press('Control+z');
  await watchPage.waitForTimeout(150);
  await watchPage.screenshot({ path: path.join(stageShotDir, 'watch-seek-toast.png') });
  await watchPage.waitForTimeout(250);
  t = await curTime();
  check('Ctrl+Z returns to pre-seek origin ~0.4 (got ' + t.toFixed(2) + ')',
    Math.abs(t - 0.4) <= 0.3);
  const toastText = await watchPage.evaluate(() =>
    document.getElementById('ytm-seek-toast')?.textContent || null);
  check('Seek toast rendered over the player (got "' + toastText + '")',
    !!toastText && toastText.includes('0:00'));

  await watchPage.keyboard.press('Control+Shift+z');
  await watchPage.waitForTimeout(400);
  t = await curTime();
  check('Ctrl+Shift+Z redoes to ~' + landed.toFixed(2) + ' (got ' + t.toFixed(2) + ')',
    Math.abs(t - landed) <= 0.3);

  // Editable guard: focused textarea keeps its native text undo
  await watchPage.evaluate(() => {
    const ta = document.createElement('textarea');
    ta.id = 'guard-ta';
    document.body.appendChild(ta);
    ta.focus();
  });
  await watchPage.keyboard.press('Control+z');
  await watchPage.waitForTimeout(300);
  t = await curTime();
  check('Ctrl+Z inside a textarea leaves playback untouched (got ' + t.toFixed(2) + ')',
    Math.abs(t - landed) <= 0.3);
  await watchPage.evaluate(() => document.getElementById('guard-ta').remove());

  // --- 11. Console errors across all surfaces ---
  console.log('\n--- Console errors ---');
  if (errors.length) errors.forEach(e => console.log('    ' + e));
  check('No console errors on watch page, panel, or popup', errors.length === 0);

  await context.close();

  console.log('\n=============================');
  console.log('Player: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Player test failed to run:', err);
  process.exit(1);
});
