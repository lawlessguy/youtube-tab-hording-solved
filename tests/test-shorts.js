/**
 * Test: Shorts stage (07) — headless contracts on routed fake pages.
 *  A. Arrow-key scrubbing on /shorts/: ±5s with end-clamp (duration − 0.25),
 *     0-clamp, input guard, modifier passthrough; MEDIA_COMMAND seconds
 *     override; GET_MEDIA_STATE isShorts + url; shortsNext/shortsPrev actions.
 *  F. In-page rail: 5 buttons, add-to-queue (isShort entry + activity event
 *     source 'shorts'), star, event-driven .ytm-on repaint from storage.
 *  B. First-loop-boundary detection → auto-scroll clicks YouTube's own
 *     #navigation-button-down button.
 *  D. Panel context awareness: #shorts-tools strip appears for a displayed
 *     Short, now-playing seek labels become 5, strip prev routes to the tab,
 *     auto toggles are mutually exclusive and repaint from storage; strip
 *     hides when the Short goes away.
 *  E. In-panel player: per-card ⧉ on Shorts cards only (59px height
 *     invariant), embed iframe (autoplay+jsapi), prev/next within the panel
 *     list, deterministic UNPLAYABLE pre-flight → error card, close.
 *  C. Auto-close: finishing Short closes ONLY its own (validated) tab;
 *     negative control stays open; non-tab senders are refused.
 *  G. Zero console errors across every surface.
 *
 * Real-YouTube selector/keyboard audits are headed-only: tests/test-shorts-live.js.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const extensionPath = path.resolve(__dirname, '..');
const stageShotDir = path.join(extensionPath, 'screenshots', 'stages', 'shorts');
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

// Fake Shorts page (shared tiny-webm fixture, contract section 7). Real
// /shorts/<11-char-id> URL so getCurrentVideoId()/isShortsPage() work, plus
// YouTube's nav-button DOM shape (#navigation-button-down > button) and an
// input for the text-context guard. Deliberately NO autoplay: the loop-finish
// detector fires once per videoId, so playback (and therefore the first wrap)
// must start only when the test scripts it — after the relevant toggle is set.
function shortsPageHtml(dataUrl) {
  return '<!DOCTYPE html><html><head><title>Short - YouTube</title><style>' +
    'body{margin:0;background:#0f0f0f;color:#eee;font-family:Arial,sans-serif;' +
    'display:flex;flex-direction:column;align-items:center}' +
    '.reel{width:320px;height:520px;background:#000;margin-top:16px}' +
    'video{width:100%;height:100%;object-fit:cover}' +
    '#fake-comment{margin:10px;width:280px}' +
    '</style></head><body>' +
    '<div class="reel"><video muted loop playsinline preload="auto" src="' + dataUrl + '"></video></div>' +
    '<input id="fake-comment" placeholder="Add a comment...">' +
    '<div id="navigation-button-down"><button onclick="window.__navClicked=(window.__navClicked||0)+1">v</button></div>' +
    '<div id="navigation-button-up"><button onclick="window.__navPrevClicked=(window.__navPrevClicked||0)+1">^</button></div>' +
    // MediaRecorder WebMs report duration Infinity until a seek past the end
    // forces Chrome to compute it. Settle at 0.6s (>= 0.5) so the fixup's own
    // end→start seek pattern can never look like a loop wrap to the detector.
    '<script>(function(){' +
    'var v=document.querySelector("video");' +
    'function fix(){if(!isFinite(v.duration)){v.currentTime=1e10;return;}' +
    'if(v.currentTime>1)v.currentTime=0.6;}' +
    'v.addEventListener("loadedmetadata",fix);' +
    'v.addEventListener("durationchange",fix);' +
    'if(v.readyState>=1)fix();' +
    '})();</script>' +
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

  // --- Routes (all page-originated traffic stays offline) ---
  const dataUrl = require(ASSET_PATH).dataUrl;
  const SHORTS_PAGE = shortsPageHtml(dataUrl);
  await context.route('https://www.youtube.com/shorts/*', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: SHORTS_PAGE }));
  // Deterministic embeddability pre-flight: SHRTTEST002 is the UNPLAYABLE one
  await context.route('https://www.youtube.com/embed/**', route => {
    const unplayable = route.request().url().includes('SHRTTEST002');
    const body = unplayable
      ? '<!DOCTYPE html><html><body>{"playabilityStatus":{"status":"UNPLAYABLE"},"playableInEmbed":false}</body></html>'
      : '<!DOCTYPE html><html><body style="background:#000;color:#666;font-family:Arial">' +
        '<div style="padding:20px">embed stub {"playableInEmbed":true}</div></body></html>';
    route.fulfill({ status: 200, contentType: 'text/html', body });
  });
  // Thumbnail stubs so fake videoIds don't 404 into the console watch
  const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64');
  for (const host of ['https://i.ytimg.com/**', 'https://img.youtube.com/**']) {
    await context.route(host, route =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1x1 }));
  }

  // =====================================================================
  console.log('\n--- A. Arrow scrubbing on a fake Shorts page ---');
  const shorts1 = await context.newPage();
  watchConsole(shorts1, 'shorts1');
  await shorts1.goto('https://www.youtube.com/shorts/SHRTTEST001');
  await shorts1.waitForFunction(() => {
    const v = document.querySelector('video');
    // readiness + the page's duration fixup finished (settled back ≤ 1s)
    return v && v.readyState >= 2 && isFinite(v.duration) && v.duration > 1 &&
      v.currentTime <= 1;
  }, { timeout: 20000 });
  await shorts1.waitForTimeout(2500); // content-script init
  await shorts1.bringToFront();

  // Stable baseline: paused at 0.1s
  await shorts1.evaluate(() => {
    const v = document.querySelector('video');
    v.pause();
    v.currentTime = 0.1;
  });
  const dur = await shorts1.evaluate(() => document.querySelector('video').duration);

  await shorts1.keyboard.press('ArrowRight');
  await shorts1.waitForTimeout(200);
  let ct = await shorts1.evaluate(() => document.querySelector('video').currentTime);
  const expectFwd = Math.min(0.1 + 5, dur - 0.25);
  check('ArrowRight seeks +5s clamped below duration (got ' + ct.toFixed(2) +
    ', want ~' + expectFwd.toFixed(2) + ')', Math.abs(ct - expectFwd) < 0.2);

  await shorts1.keyboard.press('ArrowLeft');
  await shorts1.waitForTimeout(200);
  ct = await shorts1.evaluate(() => document.querySelector('video').currentTime);
  const expectBack = Math.max(0, expectFwd - 5);
  check('ArrowLeft seeks -5s clamped at 0 (got ' + ct.toFixed(2) + ')',
    Math.abs(ct - expectBack) < 0.2);

  await shorts1.focus('#fake-comment');
  await shorts1.keyboard.press('ArrowRight');
  await shorts1.waitForTimeout(200);
  ct = await shorts1.evaluate(() => document.querySelector('video').currentTime);
  check('ArrowRight inside an input does NOT scrub (got ' + ct.toFixed(2) + ')',
    Math.abs(ct - expectBack) < 0.2);

  await shorts1.evaluate(() => document.getElementById('fake-comment').blur());
  await shorts1.keyboard.press('Alt+ArrowRight');
  await shorts1.waitForTimeout(200);
  ct = await shorts1.evaluate(() => document.querySelector('video').currentTime);
  check('Modifier-held arrow passes through untouched (got ' + ct.toFixed(2) + ')',
    Math.abs(ct - expectBack) < 0.2);

  // --- Message contract on the same tab ---
  console.log('\n--- A2. MEDIA_COMMAND seconds / GET_MEDIA_STATE / shortsNext ---');
  const tab1Id = await sw.evaluate(async () =>
    (await chrome.tabs.query({ url: 'https://www.youtube.com/shorts/SHRTTEST001' }))[0]?.id);
  check('Fake Shorts tab present (id ' + tab1Id + ')', typeof tab1Id === 'number');

  await sw.evaluate(tid =>
    chrome.tabs.sendMessage(tid, { type: 'MEDIA_COMMAND', action: 'forward', seconds: 2 }), tab1Id);
  await shorts1.waitForTimeout(200);
  ct = await shorts1.evaluate(() => document.querySelector('video').currentTime);
  check('MEDIA_COMMAND forward honors seconds:2 (got ' + ct.toFixed(2) + ')',
    Math.abs(ct - 2) < 0.2);

  await sw.evaluate(tid =>
    chrome.tabs.sendMessage(tid, { type: 'MEDIA_COMMAND', action: 'rewind', seconds: 1 }), tab1Id);
  await shorts1.waitForTimeout(200);
  ct = await shorts1.evaluate(() => document.querySelector('video').currentTime);
  check('MEDIA_COMMAND rewind honors seconds:1 (got ' + ct.toFixed(2) + ')',
    Math.abs(ct - 1) < 0.2);

  const mState = await sw.evaluate(tid =>
    chrome.tabs.sendMessage(tid, { type: 'GET_MEDIA_STATE' }), tab1Id);
  check('GET_MEDIA_STATE carries isShorts:true', mState?.isShorts === true);
  check('GET_MEDIA_STATE carries the page url',
    typeof mState?.url === 'string' && mState.url.includes('/shorts/SHRTTEST001'));
  check('PiP fields still present alongside (merged shape)',
    typeof mState?.pipActive === 'boolean' && typeof mState?.docPipSupported === 'boolean');

  const nextRes = await sw.evaluate(tid =>
    chrome.tabs.sendMessage(tid, { type: 'MEDIA_COMMAND', action: 'shortsNext' }), tab1Id);
  const navClicked = await shorts1.evaluate(() => window.__navClicked || 0);
  check('shortsNext clicks the native nav button ({success:true})',
    nextRes?.success === true && navClicked >= 1, JSON.stringify(nextRes));

  // =====================================================================
  console.log('\n--- F. In-page rail ---');
  const railShape = await shorts1.evaluate(() => {
    const r = document.getElementById('ytm-shorts-rail');
    return r ? { buttons: r.querySelectorAll('button').length,
      fixed: getComputedStyle(r).position === 'fixed' } : null;
  });
  check('Rail injected with 5 buttons', railShape?.buttons === 5, JSON.stringify(railShape));
  check('Rail is fixed-position (left gutter)', railShape?.fixed === true);

  await shorts1.click('#ytm-rail-add');
  await shorts1.waitForTimeout(900);
  const added = await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_videos');
    return (r.yt_videos || []).find(v => v.id === 'SHRTTEST001') || null;
  });
  check('Rail add queued the Short (isShort:true)', !!added && added.isShort === true,
    JSON.stringify(added));
  const lastAddEvent = await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_activity_log');
    const evs = (r.yt_activity_log?.events || []).filter(e => e.type === 'added_to_queue');
    return evs[evs.length - 1] || null;
  });
  check('added_to_queue event has source shorts (contract §4)',
    lastAddEvent?.source === 'shorts' && lastAddEvent?.videoId === 'SHRTTEST001',
    JSON.stringify(lastAddEvent));

  await shorts1.click('#ytm-rail-star');
  await shorts1.waitForTimeout(900);
  const starred = await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_videos');
    return (r.yt_videos || []).find(v => v.id === 'SHRTTEST001')?.starred;
  });
  check('Rail star starred the queued Short', starred === true);

  await shorts1.screenshot({ path: path.join(stageShotDir, 'fake-shorts-rail.png') });

  // Event-driven repaint: storage write (not a click) lights the toggle
  await mergeSettings({ shortsAutoScroll: true, shortsAutoClose: false });
  await shorts1.waitForTimeout(900);
  const railOn = await shorts1.evaluate(() => ({
    scroll: document.getElementById('ytm-rail-autoscroll')?.classList.contains('ytm-on'),
    close: document.getElementById('ytm-rail-autoclose')?.classList.contains('ytm-on'),
  }));
  check('Rail auto-scroll button gains .ytm-on from storage', railOn.scroll === true);
  check('Rail auto-close button stays off', railOn.close === false);
  await shorts1.screenshot({ path: path.join(stageShotDir, 'fake-shorts-rail-on.png') });

  // =====================================================================
  console.log('\n--- B. First-loop boundary → auto-scroll ---');
  await shorts1.evaluate(() => { window.__navClicked = 0; });
  await shorts1.evaluate(() => {
    const v = document.querySelector('video');
    v.currentTime = Math.max(0, v.duration - 0.6);
    return v.play().catch(() => {});
  });
  await shorts1.waitForFunction(() => (window.__navClicked || 0) >= 1, { timeout: 8000 })
    .catch(() => {});
  const loopNav = await shorts1.evaluate(() => window.__navClicked || 0);
  check('Loop wrap fired auto-scroll exactly once (got ' + loopNav + ')', loopNav === 1);
  // Keep looping a while longer — once-per-videoId guard must hold
  await shorts1.waitForTimeout(2000);
  const loopNav2 = await shorts1.evaluate(() => window.__navClicked || 0);
  check('Subsequent loops do not re-fire (still ' + loopNav2 + ')', loopNav2 === 1);

  // =====================================================================
  console.log('\n--- D. Panel context awareness (strip + adapted controls) ---');
  const panel = await context.newPage();
  watchConsole(panel, 'panel');
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  await panel.setViewportSize({ width: 350, height: 900 });
  await shorts1.bringToFront(); // displayed tab = the playing Short
  await panel.waitForFunction(() =>
    getComputedStyle(document.getElementById('shorts-tools')).display !== 'none',
    { timeout: 7000 }).catch(() => {});
  check('#shorts-tools strip visible while a Short is displayed',
    await panel.evaluate(() =>
      getComputedStyle(document.getElementById('shorts-tools')).display !== 'none'));

  const npLabels = await panel.evaluate(() =>
    Array.from(document.querySelectorAll('.now-playing .np-btn-label')).map(e => e.textContent));
  check('Now-playing seek labels read 5 on a Short (got ' + JSON.stringify(npLabels) + ')',
    npLabels.length === 2 && npLabels.every(t => t === '5'));

  // Strip prev routes panel → worker → content script → native button
  await panel.evaluate(() => document.getElementById('st-prev').click());
  await panel.waitForTimeout(800);
  check('Strip Prev clicked the tab\'s native prev button',
    (await shorts1.evaluate(() => window.__navPrevClicked || 0)) >= 1);

  // Mutual exclusion (shortsAutoScroll is currently true from F/B)
  await panel.evaluate(() => document.getElementById('st-autoclose').click());
  await panel.waitForTimeout(800);
  let s = await readSettings();
  check('Auto-close on forces auto-scroll off (one UPDATE_SETTINGS)',
    s.shortsAutoClose === true && s.shortsAutoScroll === false);
  check('Strip toggle classes match storage after the round-trip',
    await panel.evaluate(() =>
      document.getElementById('st-autoclose').classList.contains('active') &&
      !document.getElementById('st-autoscroll').classList.contains('active')));
  await panel.screenshot({ path: path.join(stageShotDir, 'sidepanel-shorts-strip.png') });

  await panel.evaluate(() => document.getElementById('st-autoscroll').click());
  await panel.waitForTimeout(800);
  s = await readSettings();
  check('Auto-scroll on forces auto-close off (mutual exclusion)',
    s.shortsAutoScroll === true && s.shortsAutoClose === false);
  check('Rail mirrors the panel toggle (never disagree)',
    await shorts1.evaluate(() =>
      document.getElementById('ytm-rail-autoscroll').classList.contains('ytm-on') &&
      !document.getElementById('ytm-rail-autoclose').classList.contains('ytm-on')));

  // Reset both off before the player/auto-close phases
  await mergeSettings({ shortsAutoScroll: false, shortsAutoClose: false });
  await panel.waitForTimeout(500);

  // Strip hides when the Short goes away
  await shorts1.close();
  await panel.bringToFront();
  await panel.waitForFunction(() =>
    getComputedStyle(document.getElementById('shorts-tools')).display === 'none',
    { timeout: 7000 }).catch(() => {});
  check('#shorts-tools hides after the Shorts tab closes',
    await panel.evaluate(() =>
      getComputedStyle(document.getElementById('shorts-tools')).display === 'none'));

  // =====================================================================
  console.log('\n--- E. In-panel Shorts player ---');
  await sw.evaluate(() => chrome.storage.local.set({ yt_videos: [
    { id: 'SHRTTEST001', url: 'https://www.youtube.com/shorts/SHRTTEST001',
      title: 'Embeddable short demo', channel: 'Shorts Channel', thumbnail: '',
      duration: 35, addedAt: Date.now(), uploadedAt: null, isShort: true,
      watched: false, starred: false, sessionId: 'main', addCount: 1 },
    { id: 'SHRTTEST002', url: 'https://www.youtube.com/shorts/SHRTTEST002',
      title: 'Embed-disabled short', channel: 'Shorts Channel', thumbnail: '',
      duration: 28, addedAt: Date.now() - 60000, uploadedAt: null, isShort: true,
      watched: false, starred: true, sessionId: 'main', addCount: 2 },
    { id: 'REGULARVID1', url: 'https://www.youtube.com/watch?v=REGULARVID1',
      title: 'Regular long-form video', channel: 'Main Channel', thumbnail: '',
      duration: 754, addedAt: Date.now() - 30000, uploadedAt: null, isShort: false,
      watched: false, starred: false, sessionId: 'main', addCount: 1 },
  ] }));
  await panel.reload();
  await panel.waitForTimeout(900);

  check('Regular video card has NO panel-play button',
    await panel.evaluate(() =>
      document.querySelectorAll('#video-list .card-panel-btn').length === 0 &&
      document.querySelectorAll('#video-list .video-item').length === 1));

  await panel.click('#tab-shorts');
  await panel.waitForTimeout(500);
  check('Both Shorts cards carry the panel-play button',
    await panel.evaluate(() =>
      document.querySelectorAll('#shorts-list .card-panel-btn').length === 2));
  check('Shorts card height stays 59px (CARD_HEIGHT invariant)',
    await panel.evaluate(() =>
      document.querySelector('#shorts-list .video-item')?.offsetHeight === 59));

  await panel.click('#shorts-list .video-item[data-id="SHRTTEST001"] .card-panel-btn');
  await panel.waitForTimeout(1000); // pre-flight fetch round-trip
  const playerState = await panel.evaluate(() => {
    const c = document.getElementById('shorts-player');
    const f = c.querySelector('iframe');
    return {
      visible: getComputedStyle(c).display !== 'none',
      src: f ? f.src : null,
      title: c.querySelector('.sp-title')?.textContent || '',
      pos: c.querySelector('.sp-pos')?.textContent || '',
      prevDisabled: c.querySelector('#sp-prev')?.disabled,
      nextDisabled: c.querySelector('#sp-next')?.disabled,
    };
  });
  check('Player visible with embed iframe', playerState.visible && !!playerState.src);
  check('Iframe src has /embed/<id>, autoplay and jsapi',
    !!playerState.src && playerState.src.includes('/embed/SHRTTEST001') &&
    playerState.src.includes('autoplay=1') && playerState.src.includes('enablejsapi=1'),
    playerState.src);
  check('Header shows the queue title', playerState.title === 'Embeddable short demo');
  check('Position reads 1 / 2', playerState.pos === '1 / 2');
  check('Prev disabled at the list start, next enabled',
    playerState.prevDisabled === true && playerState.nextDisabled === false);
  await panel.screenshot({ path: path.join(stageShotDir, 'sidepanel-player-open.png') });

  await panel.click('#sp-next');
  await panel.waitForTimeout(1000);
  const errState = await panel.evaluate(() => {
    const c = document.getElementById('shorts-player');
    return {
      iframe: !!c.querySelector('iframe'),
      error: c.querySelector('.sp-error')?.textContent || '',
      hasOpenBtn: !!Array.from(c.querySelectorAll('.sp-error button'))
        .find(b => b.textContent === 'Open in tab'),
      pos: c.querySelector('.sp-pos')?.textContent || '',
      nextDisabled: c.querySelector('#sp-next')?.disabled,
    };
  });
  check('UNPLAYABLE Short renders the error card instead of an iframe',
    errState.iframe === false && errState.error.includes("can't be embedded"));
  check('Error card offers Open in tab', errState.hasOpenBtn === true);
  check('Position reads 2 / 2 with next disabled',
    errState.pos === '2 / 2' && errState.nextDisabled === true);
  await panel.screenshot({ path: path.join(stageShotDir, 'sidepanel-player-error.png') });

  await panel.click('#sp-close');
  await panel.waitForTimeout(300);
  check('Close hides the player and empties it', await panel.evaluate(() => {
    const c = document.getElementById('shorts-player');
    return getComputedStyle(c).display === 'none' && !c.querySelector('iframe');
  }));

  // =====================================================================
  console.log('\n--- C. Auto-close (the one sanctioned active-tab close) ---');
  await mergeSettings({ shortsAutoClose: true, shortsAutoScroll: false });
  const shorts2 = await context.newPage();
  watchConsole(shorts2, 'shorts2');
  await shorts2.goto('https://www.youtube.com/shorts/SHRTTEST002');
  await shorts2.waitForFunction(() => {
    const v = document.querySelector('video');
    // readiness + the page's duration fixup finished (settled back ≤ 1s)
    return v && v.readyState >= 2 && isFinite(v.duration) && v.duration > 1 &&
      v.currentTime <= 1;
  }, { timeout: 20000 });
  await shorts2.waitForTimeout(2500); // content-script init
  await shorts2.bringToFront();       // active tab — the explicit exception
  await shorts2.evaluate(() => {
    const v = document.querySelector('video');
    v.currentTime = Math.max(0, v.duration - 0.6);
    return v.play().catch(() => {});
  });
  let closedOk = false;
  for (let i = 0; i < 16 && !closedOk; i++) {
    await panel.waitForTimeout(500);
    const n = await sw.evaluate(async () =>
      (await chrome.tabs.query({ url: 'https://www.youtube.com/shorts/SHRTTEST002' })).length);
    if (n === 0) closedOk = true;
  }
  check('Finishing Short auto-closed its own tab', closedOk);

  // Negative control: auto-close off ⇒ the tab stays
  await mergeSettings({ shortsAutoClose: false });
  const shorts3 = await context.newPage();
  watchConsole(shorts3, 'shorts3');
  await shorts3.goto('https://www.youtube.com/shorts/SHRTTEST003');
  await shorts3.waitForFunction(() => {
    const v = document.querySelector('video');
    // readiness + the page's duration fixup finished (settled back ≤ 1s)
    return v && v.readyState >= 2 && isFinite(v.duration) && v.duration > 1 &&
      v.currentTime <= 1;
  }, { timeout: 20000 });
  await shorts3.waitForTimeout(2500);
  await shorts3.bringToFront();
  await shorts3.evaluate(() => {
    const v = document.querySelector('video');
    v.currentTime = Math.max(0, v.duration - 0.6);
    return v.play().catch(() => {});
  });
  await shorts3.waitForTimeout(3500);
  const stillOpen = await sw.evaluate(async () =>
    (await chrome.tabs.query({ url: 'https://www.youtube.com/shorts/SHRTTEST003' })).length);
  check('With auto-close off the tab stays open', stillOpen === 1);

  // Sender validation. A page-mode panel runs INSIDE a tab (so sender.tab
  // exists here, unlike the real chrome.sidePanel) — force the strongest
  // gate: even with the setting ON, a sender tab whose URL is not a Short
  // must be refused by the isShortUrl re-validation.
  await mergeSettings({ shortsAutoClose: true });
  const guard = await panel.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'CLOSE_SHORT_TAB', videoId: 'SHRTTEST003' }));
  check('CLOSE_SHORT_TAB never closes a non-Short sender tab',
    guard?.closed === false &&
    (guard?.reason === 'not-short' || guard?.reason === 'no-sender-tab'),
    JSON.stringify(guard));
  check('Panel tab survived the malicious close request', !panel.isClosed());
  await mergeSettings({ shortsAutoClose: false });
  await shorts3.close();

  // =====================================================================
  console.log('\n--- G. Console errors across all surfaces ---');
  if (errors.length) errors.forEach(e => console.log('    ' + e));
  check('No console errors', errors.length === 0);

  await context.close();

  console.log('\n=============================');
  console.log('Shorts: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Shorts test failed to run:', err);
  process.exit(1);
});
