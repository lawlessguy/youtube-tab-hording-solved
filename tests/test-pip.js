/**
 * Test: PiP stage (03) — contracts + graceful degradation (headless).
 *  - Panel pip controls round-trip: opacity slider, S/M/L presets, auto-PiP
 *    toggle persist via UPDATE_SETTINGS and reload from settings
 *  - GET_MEDIA_STATE contract: content response carries pipActive (false at
 *    rest) and docPipSupported (boolean); worker passthrough keeps them
 *  - MEDIA_COMMAND 'exitPip' is a no-op-safe {success:true}; unknown actions
 *    respond {success:false} without throwing
 *  - __ytmTogglePip via chrome.scripting.executeScript: in environments that
 *    allow gesture-less requestWindow (current headless Chromium does) the
 *    FULL float/restore cycle is asserted (#movie_player moves into the PiP
 *    document, placeholder appears, media state still resolves the floated
 *    video, exitPip restores); otherwise the call must degrade with
 *    pipActive=false and ZERO console errors either way
 *  - Auto-PiP registration smoke: flipping pipAutoEnabled through storage
 *    runs syncAutoPip with no errors (register + unregister)
 *  - Settings written by other surfaces sync into the panel row without
 *    reload (storage.onChanged)
 *
 * Real PiP windows/gestures (trusted clicks, always-on-top compositing,
 * strip resizeTo, opacity hover-restore) are headed-only: tests/test-pip-live.js.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const extensionPath = path.resolve(__dirname, '..');
const stageShotDir = path.join(extensionPath, 'screenshots', 'stages', 'pip');
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

// Skeleton watch page (shared tiny-webm fixture, contract section 7) — real
// watch URL pattern so getCurrentVideoId() works in the content script.
function watchPageHtml(dataUrl) {
  return '<!DOCTYPE html><html><head><title>PiP test - YouTube</title><style>' +
    'body{margin:0;background:#0f0f0f;color:#eee;font-family:Arial,sans-serif}' +
    '#player-container{width:640px;height:360px}' +
    '#player-container-inner{width:100%;height:100%}' +
    '#movie_player{width:100%;height:100%;background:#000;position:relative}' +
    'video{width:100%;height:100%}' +
    '</style></head><body>' +
    '<ytd-watch-flexy>' +
    '<div id="player-container-outer"><div id="player-container">' +
    '<div id="player-container-inner"><div id="movie_player" class="html5-video-player">' +
    '<video src="' + dataUrl + '" muted playsinline preload="auto" loop></video>' +
    '</div></div></div></div>' +
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

  const readSettings = () => sw.evaluate(async () =>
    (await chrome.storage.local.get('yt_settings')).yt_settings || {});
  const mergeSettings = patch => sw.evaluate(async p => {
    const r = await chrome.storage.local.get('yt_settings');
    await chrome.storage.local.set({ yt_settings: { ...(r.yt_settings || {}), ...p } });
  }, patch);

  // Representative queue so panel screenshots show real cards
  await sw.evaluate(() => chrome.storage.local.set({
    yt_videos: [
      { id: 'PIPQUEUEAA1', url: 'https://www.youtube.com/watch?v=PIPQUEUEAA1',
        title: 'Floating player demo video', channel: 'PiP Channel', thumbnail: '',
        duration: 612, addedAt: Date.now() - 90000, uploadedAt: null, isShort: false,
        watched: false, starred: false, sessionId: 'main', addCount: 1 },
      { id: 'PIPQUEUEBB2', url: 'https://www.youtube.com/watch?v=PIPQUEUEBB2',
        title: 'Opacity + size presets demo', channel: 'PiP Channel', thumbnail: '',
        duration: 1543, addedAt: Date.now() - 45000, uploadedAt: null, isShort: false,
        watched: false, starred: true, sessionId: 'main', addCount: 1 },
    ],
  }));
  // Thumbnail stub so fake videoIds don't 404 into the console watch
  const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64');
  await context.route('https://i.ytimg.com/**', route =>
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1x1 }));

  // --- 1. Panel controls round-trip ---
  console.log('\n--- Panel pip controls round-trip ---');
  const panel = await context.newPage();
  watchConsole(panel, 'panel');
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  await panel.setViewportSize({ width: 350, height: 900 });
  await panel.waitForTimeout(900);

  check('PiP row present (slider + 3 size buttons)', await panel.evaluate(() =>
    !!document.getElementById('pip-opacity-slider') &&
    document.querySelectorAll('.pip-size-btn').length === 3));
  check('PiP row enabled while no tab is displayed (defaults editable)',
    await panel.evaluate(() => !document.getElementById('pip-opacity-slider').disabled));

  await panel.evaluate(() => {
    const sl = document.getElementById('pip-opacity-slider');
    sl.value = 60;
    sl.dispatchEvent(new Event('input'));
  });
  check('Opacity label tracks input (60%)',
    (await panel.textContent('#pip-opacity-value')) === '60%');
  await panel.evaluate(() =>
    document.getElementById('pip-opacity-slider').dispatchEvent(new Event('change')));
  await panel.waitForTimeout(500);
  let s = await readSettings();
  check('pipOpacity persisted as 60 (got ' + s.pipOpacity + ')', s.pipOpacity === 60);

  await panel.click('#pip-size-large');
  await panel.waitForTimeout(500);
  s = await readSettings();
  check('pipSize persisted as large (got ' + s.pipSize + ')', s.pipSize === 'large');
  check('L preset active, siblings not', await panel.evaluate(() =>
    document.getElementById('pip-size-large').classList.contains('active') &&
    !document.getElementById('pip-size-medium').classList.contains('active') &&
    !document.getElementById('pip-size-small').classList.contains('active')));

  await panel.click('#tb-autopip');
  await panel.waitForTimeout(500);
  s = await readSettings();
  check('pipAutoEnabled persisted as true (got ' + s.pipAutoEnabled + ')',
    s.pipAutoEnabled === true);
  check('Auto-PiP toggle shows active', await panel.evaluate(() =>
    document.getElementById('tb-autopip').classList.contains('active')));

  await panel.screenshot({ path: path.join(stageShotDir, 'sidepanel-pip-controls-set.png') });

  // Reload → loadSettings restores all three
  await panel.reload();
  await panel.waitForTimeout(900);
  check('Reload restores opacity 60%', (await panel.inputValue('#pip-opacity-slider')) === '60'
    && (await panel.textContent('#pip-opacity-value')) === '60%');
  check('Reload restores size large', await panel.evaluate(() =>
    document.getElementById('pip-size-large').classList.contains('active')));
  check('Reload restores auto-PiP active', await panel.evaluate(() =>
    document.getElementById('tb-autopip').classList.contains('active')));

  // --- 2. Content-script contract on a fake watch page ---
  console.log('\n--- Content-script GET_MEDIA_STATE / exitPip contract ---');
  const dataUrl = require(ASSET_PATH).dataUrl;
  const PAGE = watchPageHtml(dataUrl);
  await context.route('https://www.youtube.com/watch*', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));

  const watchPage = await context.newPage();
  watchConsole(watchPage, 'watch');
  await watchPage.goto('https://www.youtube.com/watch?v=PIPTEST0001');
  await watchPage.waitForFunction(() => {
    const v = document.querySelector('video');
    return v && v.readyState >= 2;
  }, { timeout: 20000 });
  await watchPage.waitForTimeout(2500); // content-script init

  const tabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/watch*' });
    return tabs[0]?.id;
  });
  check('Fake watch tab present (id ' + tabId + ')', typeof tabId === 'number');

  const state0 = await sw.evaluate(tid =>
    chrome.tabs.sendMessage(tid, { type: 'GET_MEDIA_STATE' }), tabId);
  check('videoId resolved (got ' + state0?.videoId + ')', state0?.videoId === 'PIPTEST0001');
  check('pipActive false at rest', state0?.pipActive === false);
  check('docPipSupported is a boolean (got ' + state0?.docPipSupported + ')',
    typeof state0?.docPipSupported === 'boolean');

  const exitIdle = await sw.evaluate(tid =>
    chrome.tabs.sendMessage(tid, { type: 'MEDIA_COMMAND', action: 'exitPip' }), tabId);
  check('exitPip with nothing open is a graceful {success:true}',
    exitIdle?.success === true, JSON.stringify(exitIdle));

  const unknown = await sw.evaluate(tid =>
    chrome.tabs.sendMessage(tid, { type: 'MEDIA_COMMAND', action: 'definitelyNotAnAction' }), tabId);
  check('Unknown MEDIA_COMMAND action responds {success:false} without throwing',
    unknown?.success === false, JSON.stringify(unknown));

  // Worker passthrough carries the new fields (active-tab paused path)
  await watchPage.bringToFront();
  const viaWorker = await panel.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_MEDIA_STATE' }));
  check('Worker passthrough keeps pipActive/docPipSupported',
    viaWorker && typeof viaWorker.pipActive === 'boolean' &&
    typeof viaWorker.docPipSupported === 'boolean', JSON.stringify(viaWorker));

  // --- 3. __ytmTogglePip via executeScript ---
  // Headless Chromium currently allows gesture-less requestWindow, so this
  // exercises the REAL float path; if the environment rejects instead, the
  // call must degrade silently (pipActive stays false, zero console errors).
  console.log('\n--- __ytmTogglePip float/degrade ---');
  const docPipSupported = state0?.docPipSupported === true;
  await sw.evaluate(async (tid) => {
    await chrome.scripting.executeScript({
      target: { tabId: tid },
      func: () => { if (window.__ytmTogglePip) window.__ytmTogglePip({ opacity: 60, size: 'small' }); },
    });
  }, tabId);
  await watchPage.waitForTimeout(1200);

  const state1 = await sw.evaluate(tid =>
    chrome.tabs.sendMessage(tid, { type: 'GET_MEDIA_STATE' }), tabId);
  const floated = state1?.pipActive === true;
  console.log('  (environment ' + (floated ? 'allowed' : 'rejected') +
    ' gesture-less Document PiP — both paths are contract-legal)');

  if (floated && docPipSupported) {
    // Full float assertions
    const pageState = await watchPage.evaluate(() => ({
      playerInMain: !!document.getElementById('movie_player'),
      placeholder: !!document.querySelector('.ytm-pip-placeholder'),
      placeholderText: document.querySelector('.ytm-pip-placeholder')?.textContent || '',
    }));
    check('#movie_player left the main document', pageState.playerInMain === false);
    check('Placeholder card inserted at the old spot', pageState.placeholder === true);
    check('Placeholder explains the float', pageState.placeholderText.includes('floating window'));
    check('Media state still resolves the floated video (ruling 6)',
      state1?.videoId === 'PIPTEST0001' && typeof state1?.duration === 'number');

    // Volume-boost clamp while floated (ruling 7): >100% must NOT init the
    // GainNode chain against the cross-document element — element volume
    // pins to 1 only via boost, so a clamped 300% behaves like 100%
    await sw.evaluate(tid =>
      chrome.tabs.sendMessage(tid, { type: 'SET_VOLUME', value: 300 }), tabId);
    await watchPage.waitForTimeout(300);
    // Read from the ISOLATED world — the same world the PiP was opened from
    const clampedVol = await sw.evaluate(async (tid) => {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: () => {
          const w = window.documentPictureInPicture?.window;
          const v = (w && w.document.querySelector('video')) || document.querySelector('video');
          return v ? v.volume : null;
        },
      });
      return res[0]?.result;
    }, tabId);
    check('Boost request clamps to 100% while floated (volume 1, got ' + clampedVol + ')',
      clampedVol === 1);

    // Transparency contract on the REAL float: open-time opacity applies,
    // a panel-side settings write live-drives the open window, and the 30%
    // floor clamps (spec: transparency slider for the floating player)
    const readPipOpacity = () => sw.evaluate(async (tid) => {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tid },
        func: () => {
          const w = window.documentPictureInPicture?.window;
          return w ? w.document.documentElement.style.getPropertyValue('--ytm-pip-op') : null;
        },
      });
      return res[0]?.result;
    }, tabId);
    check('Open-time opacity 60 applied (--ytm-pip-op 0.6)',
      (await readPipOpacity()) === '0.6', 'got ' + (await readPipOpacity()));
    await mergeSettings({ pipOpacity: 40 });
    await watchPage.waitForTimeout(700);
    check('Settings write live-drives the open window to 0.4',
      (await readPipOpacity()) === '0.4', 'got ' + (await readPipOpacity()));
    await mergeSettings({ pipOpacity: 5 });
    await watchPage.waitForTimeout(700);
    check('Opacity floor clamps 5 → 0.3',
      (await readPipOpacity()) === '0.3', 'got ' + (await readPipOpacity()));
    await mergeSettings({ pipOpacity: 60 });
    await watchPage.waitForTimeout(400);

    await watchPage.screenshot({ path: path.join(stageShotDir, 'fake-watch-floated-placeholder.png') });

    // exitPip restores the player
    const exitFloated = await sw.evaluate(tid =>
      chrome.tabs.sendMessage(tid, { type: 'MEDIA_COMMAND', action: 'exitPip' }), tabId);
    check('exitPip while floated responds {success:true}', exitFloated?.success === true);
    await watchPage.waitForTimeout(800);
    const restored = await watchPage.evaluate(() => ({
      playerBack: !!document.getElementById('movie_player'),
      placeholderGone: !document.querySelector('.ytm-pip-placeholder'),
      videoInPlayer: !!document.querySelector('#movie_player video'),
    }));
    check('#movie_player restored to the main document', restored.playerBack === true);
    check('Placeholder removed on restore', restored.placeholderGone === true);
    check('<video> still inside the restored player', restored.videoInPlayer === true);
    const state2 = await sw.evaluate(tid =>
      chrome.tabs.sendMessage(tid, { type: 'GET_MEDIA_STATE' }), tabId);
    check('pipActive false after restore', state2?.pipActive === false);
    await watchPage.screenshot({ path: path.join(stageShotDir, 'fake-watch-restored.png') });
  } else {
    // Degradation contract: no float, no errors, page intact
    check('pipActive stays false after gesture-less toggle', state1?.pipActive === false);
    check('#movie_player untouched after degraded toggle',
      await watchPage.evaluate(() => !!document.getElementById('movie_player')));
    check('No placeholder after degraded toggle',
      await watchPage.evaluate(() => !document.querySelector('.ytm-pip-placeholder')));
  }

  // --- 4. Auto-PiP registration smoke (storage.onChanged → syncAutoPip) ---
  console.log('\n--- Auto-PiP registration smoke ---');
  const errCountBefore = errors.length;
  await mergeSettings({ pipAutoEnabled: true });
  await watchPage.waitForTimeout(600);
  await mergeSettings({ pipAutoEnabled: false });
  await watchPage.waitForTimeout(600);
  check('Register + unregister cycle produced no console errors',
    errors.length === errCountBefore,
    errors.slice(errCountBefore).join(' | '));

  // --- 5. Settings written elsewhere sync into the panel without reload ---
  console.log('\n--- Panel syncs pip settings via storage.onChanged ---');
  await mergeSettings({ pipOpacity: 45, pipSize: 'small' });
  await panel.waitForTimeout(700);
  check('Opacity label live-updates to 45%',
    (await panel.textContent('#pip-opacity-value')) === '45%');
  check('Slider thumb live-updates to 45',
    (await panel.inputValue('#pip-opacity-slider')) === '45');
  check('Size preset live-updates to S', await panel.evaluate(() =>
    document.getElementById('pip-size-small').classList.contains('active') &&
    !document.getElementById('pip-size-large').classList.contains('active')));
  check('Auto-PiP toggle live-updated to inactive', await panel.evaluate(() =>
    !document.getElementById('tb-autopip').classList.contains('active')));

  // --- 6. Now-playing card carries the float button while a video plays ---
  console.log('\n--- Now-playing float button ---');
  await watchPage.evaluate(() => document.querySelector('video').play());
  // Keep the WATCH tab active: the worker's GET_MEDIA_STATE finds a playing
  // active tab on every poll (the all-tabs scan is gated to once per 10s)
  await watchPage.bringToFront();
  await panel.waitForTimeout(3500); // ≥1 poll of the (throttled) 1.5s loop
  check('#np-pip-btn rendered on the now-playing card',
    !!(await panel.$('#np-pip-btn')));
  check('Float button not active while nothing is floating', await panel.evaluate(() => {
    const b = document.getElementById('np-pip-btn');
    return b && !b.classList.contains('active');
  }));
  await panel.screenshot({ path: path.join(stageShotDir, 'sidepanel-nowplaying-pip-btn.png') });

  // --- 7. Console errors across all surfaces ---
  console.log('\n--- Console errors ---');
  if (errors.length) errors.forEach(e => console.log('    ' + e));
  check('No console errors on panel or watch page', errors.length === 0);

  await context.close();

  console.log('\n=============================');
  console.log('PiP: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('PiP test failed to run:', err);
  process.exit(1);
});
