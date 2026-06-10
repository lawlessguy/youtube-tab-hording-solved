/**
 * Test: tab management hardening
 *  - duplicate removal never closes the active tab
 *  - side panel enablement follows same-tab navigation
 *  - interception state is mirrored into chrome.storage.session
 *  - intercept 'close' queues but keeps the ACTIVE tab; closes background tabs
 */
const { chromium } = require('playwright');
const path = require('path');

const extensionPath = path.resolve(__dirname, '..');
const WATCH_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

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

  // --- M6: side panel enablement follows same-tab navigation ---
  console.log('\n--- Side panel enablement on navigation ---');
  const navPage = await context.newPage();
  await navPage.goto(WATCH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await navPage.waitForTimeout(1000);
  const navTabId = await popup.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find(t => t.url && t.url.includes('youtube.com/watch'))?.id;
  });
  let opts = await sw.evaluate(tabId => chrome.sidePanel.getOptions({ tabId }), navTabId);
  check('Panel enabled on YouTube tab', opts.enabled === true, JSON.stringify(opts));

  await navPage.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await navPage.waitForTimeout(1000);
  opts = await sw.evaluate(tabId => chrome.sidePanel.getOptions({ tabId }), navTabId);
  check('Panel disabled after navigating away (same tab)', opts.enabled === false, JSON.stringify(opts));

  await navPage.goto(WATCH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await navPage.waitForTimeout(1000);
  opts = await sw.evaluate(tabId => chrome.sidePanel.getOptions({ tabId }), navTabId);
  check('Panel re-enabled after navigating back', opts.enabled === true, JSON.stringify(opts));
  await navPage.close();

  // --- M8: session mirroring ---
  console.log('\n--- Session-persisted interception state ---');
  const sessionState = await sw.evaluate(() =>
    chrome.storage.session.get(['recentTabs', 'extOpenedTabs']));
  check('recentTabs mirrored to storage.session',
    sessionState.recentTabs && Object.keys(sessionState.recentTabs).length >= 0);
  const opened = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'OPEN_VIDEO_NEW_TAB', url: 'https://www.youtube.com/watch?v=TESTVIDEO99' }));
  const sessionAfter = await sw.evaluate(() => chrome.storage.session.get('extOpenedTabs'));
  check('Extension-opened tab whitelisted in storage.session',
    sessionAfter.extOpenedTabs && String(opened.tabId) in sessionAfter.extOpenedTabs,
    JSON.stringify(sessionAfter));
  await popup.evaluate(tabId => chrome.tabs.remove(tabId), opened.tabId);
  await popup.waitForTimeout(500);

  // --- M5: duplicate removal keeps the active tab ---
  console.log('\n--- Duplicate removal preserves active tab ---');
  const tabA = await context.newPage();
  await tabA.goto(WATCH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  const tabB = await context.newPage();
  await tabB.goto(WATCH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await tabB.bringToFront(); // B is the active duplicate — must survive
  await popup.waitForTimeout(500);

  const removed = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'REMOVE_DUPLICATES' }));
  await popup.waitForTimeout(800);
  check('One duplicate removed (got ' + removed.removed + ')', removed.removed === 1);
  check('Active duplicate (B) survived', !tabB.isClosed());
  check('Background duplicate (A) closed', tabA.isClosed());
  if (!tabB.isClosed()) await tabB.close();
  if (!tabA.isClosed()) await tabA.close();

  // --- M8: intercept close keeps active tab, closes background tab ---
  console.log('\n--- Intercept close-mode active-tab guard ---');
  await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: { interceptEnabled: 'close' } }));
  await sw.evaluate(() => chrome.storage.local.set({ yt_videos: [] }));

  // Active tab: should be queued but stay open
  const fg = await context.newPage(); // newPage is brought to front
  try {
    await fg.goto(WATCH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch {}
  await popup.waitForTimeout(1500);
  const fgState = {
    open: !fg.isClosed(),
    queued: await sw.evaluate(async () => {
      const r = await chrome.storage.local.get('yt_videos');
      return (r.yt_videos || []).some(v => v.id === 'dQw4w9WgXcQ');
    }),
  };
  check('Active tab queued but NOT closed', fgState.open && fgState.queued,
    JSON.stringify(fgState));

  // Background tab: should be queued AND closed
  await sw.evaluate(() => chrome.storage.local.set({ yt_videos: [] }));
  const bg = await context.newPage();
  await popup.bringToFront(); // bg goes to background before navigating
  let bgNavError = false;
  try {
    await bg.goto(WATCH_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch {
    bgNavError = true; // tab closed mid-navigation is expected
  }
  await popup.waitForTimeout(2000);
  const bgState = {
    closed: bg.isClosed(),
    queued: await sw.evaluate(async () => {
      const r = await chrome.storage.local.get('yt_videos');
      return (r.yt_videos || []).some(v => v.id === 'dQw4w9WgXcQ');
    }),
  };
  check('Background tab queued AND closed', bgState.closed && bgState.queued,
    JSON.stringify(bgState) + ' navErr=' + bgNavError);

  if (!fg.isClosed()) await fg.close();

  // --- Middle-click bypass regression (stage 04 verify-don't-rebuild) ---
  // auxclick on a card → OPEN_VIDEO_NEW_TAB → whitelistExtensionTab(30s) →
  // isExtensionOpenedTab early-return in tabs.onUpdated: with intercept
  // 'close' STILL ON, the tab must survive and neither the queue nor the
  // silent log may change.
  console.log('\n--- Middle-click bypasses interception ---');
  await context.route('https://www.youtube.com/watch?v=MIDCLICK001', route =>
    route.fulfill({ status: 200, contentType: 'text/html',
      body: '<!DOCTYPE html><html><head><title>m</title></head><body>mid</body></html>' }));
  await sw.evaluate(() => chrome.storage.local.set({
    yt_logged_videos: [],
    yt_videos: [{
      id: 'MIDCLICK001', url: 'https://www.youtube.com/watch?v=MIDCLICK001',
      title: 'Middle click me', channel: 'T', thumbnail: '', duration: 60,
      addedAt: 1000, uploadedAt: null, isShort: false, watched: false,
      starred: false, sessionId: 'main', addCount: 1,
    }],
  }));

  const midPanel = await context.newPage();
  await midPanel.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  await midPanel.setViewportSize({ width: 350, height: 900 });
  await midPanel.waitForTimeout(1000);
  check('Seeded card rendered', !!(await midPanel.$('.video-item[data-id="MIDCLICK001"]')));

  await midPanel.evaluate(() => {
    document.querySelector('.video-item[data-id="MIDCLICK001"]')
      .dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
  });
  await midPanel.waitForTimeout(2500); // intercept resolves on onUpdated, immediately

  const midTabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find(t => t.url && t.url.includes('MIDCLICK001'))?.id ?? null;
  });
  check('Middle-clicked tab opened and SURVIVED intercept close-mode', midTabId !== null);

  const midState = await sw.evaluate(async () => {
    const r = await chrome.storage.local.get(['yt_videos', 'yt_logged_videos']);
    const v = (r.yt_videos || []).find(x => x.id === 'MIDCLICK001');
    return {
      entries: (r.yt_videos || []).filter(x => x.id === 'MIDCLICK001').length,
      addCount: v?.addCount,
      addedAt: v?.addedAt,
      logged: (r.yt_logged_videos || []).some(x => x.id === 'MIDCLICK001'),
    };
  });
  check('Queue unchanged (no re-add bump: addCount 1, addedAt 1000)',
    midState.entries === 1 && midState.addCount === 1 && midState.addedAt === 1000,
    JSON.stringify(midState));
  check('Silent log unchanged (bypass skips logging too)', midState.logged === false);

  if (midTabId !== null) {
    await sw.evaluate(id => chrome.tabs.remove(id).catch(() => {}), midTabId);
  }
  await midPanel.close();
  // Reset intercept so the profile state doesn't leak past this suite
  await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: { interceptEnabled: 'off' } }));

  await context.close();

  console.log('\n=============================');
  console.log('Tab management: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Tab management test failed to run:', err);
  process.exit(1);
});
