/**
 * Test: event-driven updates (replacement for the old polling loops)
 *  - thumbnail badges appear on a live YouTube page after a queue change,
 *    driven by storage.onChanged (no GET_QUEUED_IDS polling)
 *  - the side panel watch-time bar updates when yt_watch_time changes,
 *    driven by storage.onChanged (no 5s poll)
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

  // --- Badges via storage.onChanged, on a deterministic fake YouTube page ---
  // Routing a www.youtube.com URL lets the content script run against
  // controlled HTML (real recommendations don't render reliably headless)
  console.log('\n--- Thumbnail badges react to queue changes ---');
  const FAKE_PAGE = `<!DOCTYPE html><html><head><title>t</title></head><body>
    <div style="position:relative"><a id="thumbnail" href="/watch?v=BADGETEST01"><img alt=""></a></div>
    <div style="position:relative"><a id="thumbnail" href="/watch?v=BADGETEST02"><img alt=""></a></div>
    <div style="position:relative"><a id="thumbnail" href="/watch?v=BADGETEST03"><img alt=""></a></div>
  </body></html>`;
  await context.route('https://www.youtube.com/__badge_test__', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: FAKE_PAGE }));

  const ytPage = await context.newPage();
  await ytPage.goto('https://www.youtube.com/__badge_test__', { timeout: 30000 });
  await ytPage.waitForTimeout(2500); // content script init + initial indicator pass

  const before = await ytPage.evaluate(() => ({
    style: !!document.getElementById('ytm-indicator-style'),
    badges: document.querySelectorAll('.ytm-status-badge').length,
  }));
  check('Content script ran (indicator style injected)', before.style);
  check('No badges before queue change (got ' + before.badges + ')', before.badges === 0);

  // Queue one + mark one watched, by writing storage directly — the content
  // script must react via storage.onChanged, with no polling
  await sw.evaluate(() => chrome.storage.local.set({
    yt_videos: [
      { id: 'BADGETEST01', url: 'https://www.youtube.com/watch?v=BADGETEST01',
        title: 'q', channel: 'T', thumbnail: '', duration: 1, addedAt: 1,
        uploadedAt: null, isShort: false, category: 'Uncategorized',
        watched: false, starred: false },
      { id: 'BADGETEST02', url: 'https://www.youtube.com/watch?v=BADGETEST02',
        title: 'w', channel: 'T', thumbnail: '', duration: 1, addedAt: 1,
        uploadedAt: null, isShort: false, category: 'Uncategorized',
        watched: true, starred: false },
    ],
  }));
  await ytPage.waitForTimeout(3000); // onChanged + 1.5s throttle + slack

  const after = await ytPage.evaluate(() => ({
    queued: document.querySelectorAll('.ytm-status-badge--queued').length,
    watched: document.querySelectorAll('.ytm-status-badge--watched').length,
  }));
  check('Queued badge appeared via storage.onChanged (got ' + after.queued + ')',
    after.queued === 1);
  check('Watched badge appeared via storage.onChanged (got ' + after.watched + ')',
    after.watched === 1);

  // Un-queue everything — badges must disappear
  await sw.evaluate(() => chrome.storage.local.set({ yt_videos: [] }));
  await ytPage.waitForTimeout(3000);
  const cleared = await ytPage.evaluate(() =>
    document.querySelectorAll('.ytm-status-badge').length);
  check('Badges removed after queue cleared (got ' + cleared + ')', cleared === 0);

  await ytPage.close();

  // --- Watch time label via storage.onChanged ---
  console.log('\n--- Panel watch time reacts to storage changes ---');
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  await panel.waitForTimeout(800);
  const wtBefore = await panel.textContent('#watch-today');

  await sw.evaluate(() => {
    const d = new Date();
    const key = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    return chrome.storage.local.set({ yt_watch_time: { [key]: 42 } });
  });
  await panel.waitForTimeout(1000);
  const wtAfter = await panel.textContent('#watch-today');
  check('Watch time updated without polling (was ' + wtBefore + ', now ' + wtAfter + ')',
    wtAfter === '42m');

  await context.close();

  console.log('\n=============================');
  console.log('Event-driven: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Event-driven test failed to run:', err);
  process.exit(1);
});
