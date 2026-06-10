/**
 * Live E2E (headed): opens real Chrome on a real youtube.com Short and
 * verifies the pieces that fake pages cannot prove:
 *  - the in-page rail injects into the left gutter without overlap
 *  - YouTube's nav-button selector (#navigation-button-down button /
 *    aria-label "Next video") still exists (auto-scroll's primary path)
 *  - ArrowRight/ArrowLeft scrub the real Shorts <video> by ±5s
 *  - the in-panel embed bridge actually receives onStateChange messages from
 *    a REAL embed (the widget protocol only emits them after the
 *    addEventListener command — plan §6 headed item 4 / audit regression)
 * Captures screenshots/stages/shorts/live-shorts-rail.png for review.
 * Run manually: node tests/test-shorts-live.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const extensionPath = path.resolve(__dirname, '..');
const stageShotDir = path.join(extensionPath, 'screenshots', 'stages', 'shorts');

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
      '--window-size=1600,950',
      // The embed-bridge check needs the panel-page iframe to autoplay
      // without a gesture so playerState events flow
      '--autoplay-policy=no-user-gesture-required',
    ],
    viewport: null,
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');

  console.log('Opening real YouTube Shorts feed...');
  const page = await context.newPage();
  // /shorts redirects to a current Short — no hardcoded id to go stale
  await page.goto('https://www.youtube.com/shorts', {
    waitUntil: 'domcontentloaded', timeout: 60000,
  });
  await page.waitForTimeout(6000); // hydration + content-script init

  const onShorts = await page.evaluate(() => location.pathname.startsWith('/shorts/'));
  check('Landed on a /shorts/<id> page', onShorts, await page.url());

  // Rail injection + geometry sanity (left gutter, not overlapping the reel)
  const rail = await page.evaluate(() => {
    const r = document.getElementById('ytm-shorts-rail');
    if (!r) return null;
    const rect = r.getBoundingClientRect();
    const reel = document.querySelector('ytd-reel-video-renderer[is-active], #shorts-player');
    const reelRect = reel ? reel.getBoundingClientRect() : null;
    const guide = document.querySelector('#guide');
    const guideOpen = !!document.querySelector('ytd-app[guide-persistent-and-visible]');
    return {
      buttons: r.querySelectorAll('button').length,
      left: rect.left, right: rect.right,
      reelLeft: reelRect ? reelRect.left : null,
      guideWidth: guideOpen && guide ? guide.getBoundingClientRect().width : 0,
    };
  });
  check('Rail injected with 5 buttons on the real page', rail?.buttons === 5,
    JSON.stringify(rail));
  check('Rail sits in the left gutter (clear of the player)',
    !!rail && (rail.reelLeft === null || rail.right < rail.reelLeft),
    JSON.stringify(rail));
  check('Rail clears YouTube\'s left guide when open',
    !!rail && rail.left >= rail.guideWidth, JSON.stringify(rail));

  // Native nav selector audit (auto-scroll primary path)
  const navAudit = await page.evaluate(() => ({
    down: !!document.querySelector('#navigation-button-down button, button[aria-label="Next video"]'),
    up: !!document.querySelector('#navigation-button-up button, button[aria-label="Previous video"]'),
  }));
  check('Native next-video button selector still matches', navAudit.down === true,
    JSON.stringify(navAudit));

  // Arrow scrubbing on the real <video>
  const before = await page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) return null;
    v.pause();
    v.currentTime = 0.2;
    return { ct: v.currentTime, dur: v.duration };
  });
  check('Real Shorts <video> found', !!before, JSON.stringify(before));
  if (before) {
    // Real streams snap seeks to keyframes — assert the ±5s intent with a
    // generous tolerance, and measure the back-seek from the REAL position
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => document.querySelector('video').currentTime);
    const expected = Math.min(0.2 + 5, before.dur - 0.25);
    check('ArrowRight scrubbed +5s on the real Short (got ' + after.toFixed(2) +
      ', want ~' + expected.toFixed(2) + ')', Math.abs(after - expected) < 1.0);
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(400);
    const back = await page.evaluate(() => document.querySelector('video').currentTime);
    const expectedBack = Math.max(0, after - 5);
    check('ArrowLeft scrubbed -5s back (got ' + back.toFixed(2) +
      ', want ~' + expectedBack.toFixed(2) + ')', Math.abs(back - expectedBack) < 1.0);
  }

  const shot = path.join(stageShotDir, 'live-shorts-rail.png');
  await page.screenshot({ path: shot });
  console.log('  Screenshot: ' + path.relative(extensionPath, shot));

  // --- In-panel embed bridge against the REAL embed protocol ---
  // The raw widget protocol emits onStateChange only after the parent posts
  // the addEventListener command; this proves the subscription end-to-end.
  console.log('Verifying the in-panel embed onStateChange bridge...');
  const shortId = await page.evaluate(() =>
    location.pathname.startsWith('/shorts/') ? location.pathname.split('/')[2] : null);
  check('Live Short id resolved for the embed-bridge check', !!shortId, await page.url());
  if (shortId) {
    await sw.evaluate((id) => chrome.storage.local.set({
      yt_videos: [{
        id, url: 'https://www.youtube.com/shorts/' + id, title: 'Live bridge Short',
        channel: 'live', thumbnail: '', duration: 30, addedAt: Date.now(),
        uploadedAt: null, isShort: true, watched: false, starred: false,
        sessionId: 'main', addCount: 1,
      }],
    }), shortId);
    const extensionId = sw.url().split('/')[2];
    const panel = await context.newPage();
    await panel.goto('chrome-extension://' + extensionId + '/sidepanel/sidepanel.html');
    await panel.waitForTimeout(1500);
    await panel.evaluate(() => {
      window.__ytmBridge = { stateChanges: 0, states: [] };
      window.addEventListener('message', (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d.event === 'onStateChange') {
            window.__ytmBridge.stateChanges++;
            window.__ytmBridge.states.push(d.info);
          }
        } catch {}
      });
    });
    await panel.evaluate((id) => openShortsPlayer(id), shortId);
    await panel.waitForTimeout(10000); // embed load + autoplay + state events
    const bridge = await panel.evaluate(() => ({
      iframe: !!document.querySelector('#shorts-player iframe'),
      ...window.__ytmBridge,
    }));
    check('In-panel embed iframe rendered for the live Short', bridge.iframe);
    check('Embed posts onStateChange after the addEventListener command (got ' +
      bridge.stateChanges + ': ' + JSON.stringify(bridge.states) + ')',
      bridge.stateChanges > 0);
    const bridgeShot = path.join(stageShotDir, 'live-panel-embed-bridge.png');
    await panel.screenshot({ path: bridgeShot });
    console.log('  Screenshot: ' + path.relative(extensionPath, bridgeShot));
    await panel.close();
  }

  await context.close();

  console.log('\n=============================');
  console.log('Shorts live: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Shorts live test failed to run:', err);
  process.exit(1);
});
