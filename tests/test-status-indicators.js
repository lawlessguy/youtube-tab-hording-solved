/**
 * Test: Status Indicators & Badges (stage 05-indicators)
 *  - yt_open_tab_ids (chrome.storage.session) tracks the open-tab videoId
 *    set, worker-side, event-driven (create/navigate/remove), with Set
 *    semantics and a no-churn guarantee on title-only tab events
 *  - side panel TAB chip (top-left of thumb) reacts via storage.onChanged
 *    (area === 'session') without a reload
 *  - addCount chip (top-right of thumb): hidden < 2, "N×" text, "9+×" cap,
 *    legacy videos without the field treated as 1
 *  - addCount increment semantics: ADD_VIDEO bumps, COLLECT_TABS does not
 *  - .thumb-duration overlay still renders (verify-only item)
 *  - card geometry guard: chips must not change CARD_HEIGHT (63 = 59 + 4)
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const extensionPath = path.resolve(__dirname, '..');
const stageShotDir = path.join(extensionPath, 'screenshots', 'stages', 'indicators');

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
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extensionId = sw.url().split('/')[2];

  // Deterministic fake watch pages — the committed URL is what tabs.onUpdated
  // sees, so the worker tracks routed tabs exactly like real ones
  const FAKE_WATCH = '<!DOCTYPE html><html><head><title>w</title></head>' +
    '<body><h1>fake watch page</h1></body></html>';
  await context.route('https://www.youtube.com/watch*', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: FAKE_WATCH }));

  const readOpenIds = () => sw.evaluate(async () => {
    const r = await chrome.storage.session.get('yt_open_tab_ids');
    return r.yt_open_tab_ids || [];
  });

  // --- 1. Open-tab set tracks tab lifecycle (worker side) ---
  console.log('\n--- Open-tab set tracks tab lifecycle ---');
  const tabA = await context.newPage();
  await tabA.goto('https://www.youtube.com/watch?v=OPENTABTST1', { timeout: 30000 });
  await tabA.waitForTimeout(1200); // 250ms debounce + slack

  let ids = await readOpenIds();
  check('Open tab tracked in yt_open_tab_ids (got ' + JSON.stringify(ids) + ')',
    ids.includes('OPENTABTST1'));

  const tabB = await context.newPage();
  await tabB.goto('https://www.youtube.com/watch?v=OPENTABTST1', { timeout: 30000 });
  await tabB.waitForTimeout(1200);
  ids = await readOpenIds();
  check('Duplicate tab of same video keeps one entry (Set semantics)',
    ids.filter(id => id === 'OPENTABTST1').length === 1,
    'got ' + JSON.stringify(ids));

  await tabB.close();
  await tabA.waitForTimeout(1200);
  ids = await readOpenIds();
  check('Id survives while one tab of the video remains open',
    ids.includes('OPENTABTST1'), 'got ' + JSON.stringify(ids));

  // --- 2. No-churn guarantee ---
  console.log('\n--- No spurious session writes on title-only tab events ---');
  await sw.evaluate(() => {
    globalThis.__otWrites = 0;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'session' && changes.yt_open_tab_ids) globalThis.__otWrites++;
    });
  });
  for (let i = 0; i < 5; i++) {
    await tabA.evaluate(n => { document.title = 'x' + n; }, i);
    await tabA.waitForTimeout(100);
  }
  // Hash-free same-URL replaceState no-op — even if Chrome reports it as a
  // URL commit, the recompute diff must suppress the write
  await tabA.evaluate(() => history.replaceState(null, '', location.href));
  await tabA.waitForTimeout(2000);
  const writes = await sw.evaluate(() => globalThis.__otWrites);
  check('Zero yt_open_tab_ids writes during title churn (got ' + writes + ')',
    writes === 0);

  // --- 3 + 4 + 6 + 7. Panel chips on seeded queue ---
  console.log('\n--- Panel TAB badge + addCount chips ---');
  await sw.evaluate(() => chrome.storage.local.set({
    yt_videos: [
      { id: 'OPENTABTST1', url: 'https://www.youtube.com/watch?v=OPENTABTST1',
        title: 'Currently open in a tab', channel: 'Chan A', thumbnail: '',
        duration: 100, addedAt: 9000, uploadedAt: null, isShort: false,
        watched: false, starred: false, sessionId: 'main', addCount: 1 },
      { id: 'COUNT3BBBBB', url: 'https://www.youtube.com/watch?v=COUNT3BBBBB',
        title: 'Added three times', channel: 'Chan B', thumbnail: '',
        duration: 3725, addedAt: 8000, uploadedAt: null, isShort: false,
        watched: false, starred: false, sessionId: 'main', addCount: 3 },
      { id: 'LEGACYCCCCC', url: 'https://www.youtube.com/watch?v=LEGACYCCCCC',
        title: 'Legacy video without addCount', channel: 'Chan C', thumbnail: '',
        duration: 60, addedAt: 7000, uploadedAt: null, isShort: false,
        watched: false, starred: false },
      { id: 'COUNT12DDDD', url: 'https://www.youtube.com/watch?v=COUNT12DDDD',
        title: 'Added twelve times', channel: 'Chan D', thumbnail: '',
        duration: 240, addedAt: 6000, uploadedAt: null, isShort: false,
        watched: false, starred: false, sessionId: 'main', addCount: 12 },
    ],
  }));

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  await panel.setViewportSize({ width: 350, height: 900 });
  await panel.waitForTimeout(1000);

  check('TAB badge on the card whose video is open in a tab',
    !!(await panel.$('.video-item[data-id="OPENTABTST1"] .thumb-tab-badge')));
  const tabBadgeTitle = await panel.getAttribute(
    '.video-item[data-id="OPENTABTST1"] .thumb-tab-badge', 'title');
  check('TAB badge has a tooltip', !!tabBadgeTitle && tabBadgeTitle.length > 0);
  check('No TAB badge on cards without an open tab',
    !(await panel.$('.video-item[data-id="COUNT3BBBBB"] .thumb-tab-badge')));

  check('No addCount chip when addCount = 1',
    !(await panel.$('.video-item[data-id="OPENTABTST1"] .thumb-addcount')));
  check('No addCount chip on legacy video (field missing => 1)',
    !(await panel.$('.video-item[data-id="LEGACYCCCCC"] .thumb-addcount')));

  const chip3 = await panel.$('.video-item[data-id="COUNT3BBBBB"] .thumb-addcount');
  check('Chip rendered for addCount = 3', !!chip3);
  const chip3Text = chip3 ? await chip3.textContent() : null;
  check('Chip text is 3× (got ' + chip3Text + ')', chip3Text === '3×');
  const chip3Title = chip3 ? await chip3.getAttribute('title') : '';
  check('Chip title contains "3 times"', (chip3Title || '').includes('3 times'));

  const chip12 = await panel.$('.video-item[data-id="COUNT12DDDD"] .thumb-addcount');
  const chip12Text = chip12 ? await chip12.textContent() : null;
  check('Chip capped at 9+× for addCount = 12 (got ' + chip12Text + ')',
    chip12Text === '9+×');

  // Duration overlay (verify-only item — no code change in this stage)
  const durText = await panel.textContent('.video-item[data-id="COUNT3BBBBB"] .thumb-duration');
  check('.thumb-duration renders 1:02:05 for 3725s (got ' + durText + ')',
    durText === '1:02:05');

  // Card geometry guard — chips are absolutely positioned inside .thumb-wrap,
  // so CARD_HEIGHT 63 (59px card + 4px margin) must be unchanged
  const cardH = await panel.evaluate(() =>
    document.querySelector('.video-item').getBoundingClientRect().height);
  check('Card height + 4 still equals CARD_HEIGHT 63 (got ' + cardH + ' + 4)',
    Math.round(cardH) + 4 === 63);

  await panel.screenshot({ path: path.join(stageShotDir, 'sidepanel-chips.png') });
  console.log('  Screenshot: screenshots/stages/indicators/sidepanel-chips.png');

  // --- 3b. Badge disappears event-driven (no reload) when the tab closes ---
  await tabA.close();
  await panel.waitForTimeout(1500);
  check('TAB badge removed after tab close without panel reload',
    !(await panel.$('.video-item[data-id="OPENTABTST1"] .thumb-tab-badge')));
  ids = await readOpenIds();
  check('Id removed from session set after last tab closed',
    !ids.includes('OPENTABTST1'), 'got ' + JSON.stringify(ids));

  await panel.screenshot({ path: path.join(stageShotDir, 'sidepanel-tab-closed.png') });
  console.log('  Screenshot: screenshots/stages/indicators/sidepanel-tab-closed.png');

  // --- 5. addCount increment semantics (worker logic) ---
  console.log('\n--- addCount increment semantics ---');
  const readCount = () => sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_videos');
    const v = (r.yt_videos || []).find(x => x.id === 'COUNTTEST01');
    return v ? v.addCount : null;
  });

  await panel.evaluate(() => chrome.runtime.sendMessage(
    { type: 'ADD_VIDEO', url: 'https://www.youtube.com/watch?v=COUNTTEST01' }));
  let count = await readCount();
  check('First ADD_VIDEO inserts with addCount 1 (got ' + count + ')', count === 1);

  await panel.evaluate(() => chrome.runtime.sendMessage(
    { type: 'ADD_VIDEO', url: 'https://www.youtube.com/watch?v=COUNTTEST01' }));
  count = await readCount();
  check('Second ADD_VIDEO bumps addCount to 2 (got ' + count + ')', count === 2);

  // COLLECT_TABS with a tab open at the same video: the tab sweep AND the
  // silent-log drain both pass bumpCount:false — count must not inflate
  const tabC = await context.newPage();
  await tabC.goto('https://www.youtube.com/watch?v=COUNTTEST01', { timeout: 30000 });
  await tabC.waitForTimeout(1200);
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'COLLECT_TABS' }));
  await panel.waitForTimeout(800);
  count = await readCount();
  check('COLLECT_TABS does not bump addCount (still ' + count + ')', count === 2);

  await context.close();

  console.log('\n=============================');
  console.log('Status indicators: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Status indicators test failed to run:', err);
  process.exit(1);
});
