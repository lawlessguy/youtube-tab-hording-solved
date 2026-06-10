/**
 * Test: Viewing Modes (stage 01 viewing-modes)
 *  Part A — in-page masthead queue strip (deterministic fake masthead page):
 *   default-off, ensure/teardown on yt_settings.inPageQueue, ACTIVE-session
 *   filtering (contract ruling 2: reacts to yt_sessions AND yt_videos
 *   onChanged), sort order, 30-tile cap + "+N" pill, hover-remove,
 *   middle-click new tab, left-click OPEN_VIDEO same-tab replace.
 *  Part B — slim panel mode: body.slim CSS collapse, cardHeight() 63/94
 *   virtual-scroll geometry, stage-05 chips stay visible with the hover
 *   overlay clear of the top 14px of the thumb, persistence across panels.
 *  Part C — settings round-trip: panel #tb-inpage ↔ popup #inpage-queue-toggle.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const extensionPath = path.resolve(__dirname, '..');
const stageShotDir = path.join(extensionPath, 'screenshots', 'stages', 'viewing-modes');

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

function vid(prefix, i) {
  return (prefix + String(i)).padEnd(11, 'x').slice(0, 11);
}

function makeVideo(id, overrides = {}) {
  return {
    id,
    url: 'https://www.youtube.com/watch?v=' + id,
    title: 'Video ' + id,
    channel: 'Channel ' + id,
    thumbnail: '',
    duration: 120,
    addedAt: 1000,
    uploadedAt: null,
    isShort: false,
    watched: false,
    starred: false,
    sessionId: 'main',
    addCount: 1,
    ...overrides,
  };
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

  const setSettings = (patch) => sw.evaluate(async (p) => {
    const r = await chrome.storage.local.get('yt_settings');
    await chrome.storage.local.set({ yt_settings: { ...(r.yt_settings || {}), ...p } });
  }, patch);
  const setVideos = (videos) => sw.evaluate(v => chrome.storage.local.set({ yt_videos: v }), videos);
  const setSessions = (sessions) => sw.evaluate(s => chrome.storage.local.set({ yt_sessions: s }), sessions);
  const getVideoIds = () => sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_videos');
    return (r.yt_videos || []).map(v => v.id);
  });
  const countWatchTabs = () => sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: '*://www.youtube.com/watch*' });
    return tabs.length;
  });

  // ============================================================
  // Part A — in-page queue strip on a deterministic fake masthead
  // ============================================================
  console.log('\n=== Part A: in-page queue strip ===');

  const MASTHEAD_PAGE = '<!DOCTYPE html><html><head><title>m</title></head><body>' +
    '<ytd-masthead><div id="container">' +
    '<div id="start"></div><div id="center"><input id="search"></div><div id="end"></div>' +
    '</div></ytd-masthead></body></html>';
  await context.route('https://www.youtube.com/__masthead_test__', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: MASTHEAD_PAGE }));
  const WATCH_STUB = '<!DOCTYPE html><html><head><title>w</title></head><body>watch stub</body></html>';
  await context.route('https://www.youtube.com/watch*', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: WATCH_STUB }));

  const page = await context.newPage();
  await page.goto('https://www.youtube.com/__masthead_test__');
  await page.waitForTimeout(2500); // content script init + settled

  // A.1 default-off
  console.log('\n--- A.1 default off ---');
  check('No strip with inPageQueue unset (default false)',
    !(await page.$('#ytm-inpage-queue')));

  // A.2 enable → strip appears next to #center, empty-hidden
  console.log('\n--- A.2 enable ---');
  await setSettings({ inPageQueue: true });
  await page.waitForTimeout(1000); // onChanged → ensureInPageQueue is direct
  check('Strip exists after enabling', !!(await page.$('#ytm-inpage-queue')));
  check('Strip is the next element sibling of #center',
    await page.evaluate(() =>
      document.querySelector('ytd-masthead #container #center')?.nextElementSibling?.id === 'ytm-inpage-queue'));
  check('Empty strip is :empty-hidden',
    await page.evaluate(() => {
      const s = document.getElementById('ytm-inpage-queue');
      return s.childElementCount === 0 && getComputedStyle(s).display === 'none';
    }));

  // A.3 filtering: unwatched + non-short + ACTIVE session only; sorted
  console.log('\n--- A.3 filtering + sort ---');
  const A = vid('AAA', 1), B = vid('BBB', 2);
  await setVideos([
    makeVideo(A, { addedAt: 2000 }),
    makeVideo(B, { addedAt: 1000 }),
    makeVideo(vid('WWW', 3), { watched: true, addedAt: 3000 }),
    makeVideo(vid('SSS', 4), { isShort: true, addedAt: 4000 }),
    makeVideo(vid('OOO', 5), { sessionId: 's_other', addedAt: 5000 }),
  ]);
  await page.waitForTimeout(800);
  const tileIds = await page.evaluate(() =>
    [...document.querySelectorAll('.ytm-ipq-item')].map(t => t.dataset.videoId));
  check('Exactly 2 tiles (watched/short/other-session filtered out), got ' + JSON.stringify(tileIds),
    tileIds.length === 2);
  check('Tiles sorted addedAt desc', tileIds[0] === A && tileIds[1] === B);
  check('Tiles carry a non-empty title tooltip',
    await page.evaluate(() =>
      [...document.querySelectorAll('.ytm-ipq-item')].every(t => (t.title || '').length > 0)));

  // A.3b active-session switch re-filters via yt_sessions onChanged
  console.log('\n--- A.3b session switch (contract ruling 2) ---');
  await setSessions({
    activeId: 's_other',
    list: [{ id: 'main', name: 'Main', createdAt: 0 }, { id: 's_other', name: 'Other', createdAt: 1 }],
  });
  await page.waitForTimeout(800);
  const otherIds = await page.evaluate(() =>
    [...document.querySelectorAll('.ytm-ipq-item')].map(t => t.dataset.videoId));
  check('Strip shows only the new active session\'s video (got ' + JSON.stringify(otherIds) + ')',
    otherIds.length === 1 && otherIds[0] === vid('OOO', 5));
  await setSessions({
    activeId: 'main',
    list: [{ id: 'main', name: 'Main', createdAt: 0 }, { id: 's_other', name: 'Other', createdAt: 1 }],
  });
  await page.waitForTimeout(800);
  check('Switching back restores the main-session tiles',
    await page.evaluate(() => document.querySelectorAll('.ytm-ipq-item').length) === 2);

  // A.4 hover-remove (× button) — storage loses the id, strip re-renders
  console.log('\n--- A.4 remove button ---');
  await page.hover('.ytm-ipq-item[data-video-id="' + A + '"]');
  await page.click('.ytm-ipq-item[data-video-id="' + A + '"] .ytm-ipq-remove');
  await page.waitForTimeout(800);
  const idsAfterRemove = await getVideoIds();
  check('REMOVE_VIDEO removed the entry from storage', !idsAfterRemove.includes(A));
  check('Tile count dropped via onChanged re-render',
    await page.evaluate(() => document.querySelectorAll('.ytm-ipq-item').length) === 1);
  check('Other-session entry survived the session-scoped remove',
    idsAfterRemove.includes(vid('OOO', 5)));

  // A.5 30-tile cap + "+N" overflow pill
  console.log('\n--- A.5 overflow pill ---');
  const many = [];
  for (let i = 0; i < 35; i++) {
    many.push(makeVideo(vid('T' + String(i).padStart(2, '0'), i), { addedAt: 100000 - i }));
  }
  await setVideos(many);
  await page.waitForTimeout(800);
  check('Tile count capped at 30',
    await page.evaluate(() => document.querySelectorAll('.ytm-ipq-item').length) === 30);
  const moreText = await page.evaluate(() => document.querySelector('.ytm-ipq-more')?.textContent);
  check('Overflow pill reads +5 (got ' + moreText + ')', moreText === '+5');

  await page.screenshot({ path: path.join(stageShotDir, 'strip-fake-masthead.png') });
  console.log('  Screenshot: screenshots/stages/viewing-modes/strip-fake-masthead.png');

  // A.6 middle-click → OPEN_VIDEO_NEW_TAB (background tab)
  console.log('\n--- A.6 middle-click ---');
  const watchTabsBefore = await countWatchTabs();
  await page.bringToFront();
  await page.click('.ytm-ipq-item[data-video-id="' + vid('T01', 1) + '"]', { button: 'middle' });
  let newTabOk = false;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(250);
    const info = await sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: '*://www.youtube.com/watch*' });
      return tabs.map(t => ({ active: t.active, url: t.url }));
    });
    if (info.length === watchTabsBefore + 1 && info.some(t => !t.active && t.url.includes(vid('T01', 1)))) {
      newTabOk = true;
      break;
    }
  }
  check('Middle-click opened an inactive background watch tab', newTabOk);

  // A.7 toggle off removes the strip; re-enabling restores it
  console.log('\n--- A.7 teardown / re-ensure ---');
  await setSettings({ inPageQueue: false });
  await page.waitForTimeout(800);
  check('Strip removed when inPageQueue turns off', !(await page.$('#ytm-inpage-queue')));
  await setSettings({ inPageQueue: true });
  await page.waitForTimeout(800);
  check('Strip restored when inPageQueue turns back on', !!(await page.$('#ytm-inpage-queue')));

  // A.8 left-click → OPEN_VIDEO replaces the current tab (smart open)
  console.log('\n--- A.8 left-click same-tab open ---');
  const tabsBeforeClick = await sw.evaluate(async () => (await chrome.tabs.query({})).length);
  await page.bringToFront();
  await page.click('.ytm-ipq-item[data-video-id="' + vid('T02', 2) + '"]');
  await page.waitForURL('**/watch?v=' + vid('T02', 2), { timeout: 10000 });
  check('Left-click navigated the SAME tab to the watch URL', true);
  const tabsAfterClick = await sw.evaluate(async () => (await chrome.tabs.query({})).length);
  check('No extra tab created by the replace path (got ' + tabsAfterClick + ' vs ' + tabsBeforeClick + ')',
    tabsAfterClick === tabsBeforeClick);

  // ============================================================
  // Part B — slim panel mode
  // ============================================================
  console.log('\n=== Part B: slim panel mode ===');

  const seeded = [];
  for (let i = 0; i < 40; i++) {
    seeded.push(makeVideo(vid('P' + String(i).padStart(2, '0'), i), {
      addedAt: 500000 - i * 1000,
      addCount: i === 0 ? 3 : 1, // P00 gets a stage-05 addCount chip
    }));
  }
  await setVideos(seeded);

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  await panel.setViewportSize({ width: 350, height: 700 });
  await panel.waitForTimeout(1000);

  // B.1 full-mode baseline
  console.log('\n--- B.1 full-mode baseline ---');
  check('#panel-mode-toggle present', !!(await panel.$('#panel-mode-toggle')));
  check('body.slim absent by default',
    await panel.evaluate(() => !document.body.classList.contains('slim')));
  const fullGeo = await panel.evaluate(() => ({
    cardH: Math.round(document.querySelector('.video-item').getBoundingClientRect().height),
    listH: document.getElementById('video-list').style.height,
  }));
  check('Full card height is 59 (got ' + fullGeo.cardH + ')', fullGeo.cardH === 59);
  check('Full list height is 40×63 = 2520px (got ' + fullGeo.listH + ')', fullGeo.listH === '2520px');

  await panel.screenshot({ path: path.join(stageShotDir, 'sidepanel-full.png') });
  console.log('  Screenshot: screenshots/stages/viewing-modes/sidepanel-full.png');

  // B.2 switch to slim
  console.log('\n--- B.2 slim mode ---');
  await panel.click('#panel-mode-toggle');
  await panel.waitForTimeout(500);
  check('body gains .slim', await panel.evaluate(() => document.body.classList.contains('slim')));
  check('Mode toggle gains .active',
    await panel.evaluate(() => document.getElementById('panel-mode-toggle').classList.contains('active')));
  const hidden = await panel.evaluate(() => ({
    toggleBar: document.querySelector('.toggle-bar').offsetParent === null,
    controlsBar: document.querySelector('.controls-bar').offsetParent === null,
    filterBar: document.querySelector('.filter-search-bar').offsetParent === null,
    nowPlaying: document.getElementById('now-playing').offsetParent === null,
    watched: document.querySelector('.section').offsetParent === null,
    contentTabs: document.querySelector('.content-tabs').offsetParent !== null,
    // The CSS must hide .shorts-tools in slim even when the JS would show it
    // (displayed tab is a Short) — force the inline style on to prove it
    shortsTools: (() => {
      const st = document.getElementById('shorts-tools');
      const prev = st.style.display;
      st.style.display = '';
      const isHidden = st.offsetParent === null;
      st.style.display = prev;
      return isHidden;
    })(),
  }));
  check('Toggle bar hidden in slim', hidden.toggleBar);
  check('Controls bar hidden in slim', hidden.controlsBar);
  check('Filter/search bar hidden in slim', hidden.filterBar);
  check('Now-playing hidden in slim', hidden.nowPlaying);
  check('Watched section hidden in slim', hidden.watched);
  check('Content tabs (Videos/Shorts) still visible', hidden.contentTabs);
  check('Shorts tools strip hidden in slim (CSS rule, fix pass)', hidden.shortsTools);

  const slimGeo = await panel.evaluate(() => {
    const item = document.querySelector('.video-item');
    return {
      cardH: Math.round(item.getBoundingClientRect().height),
      cardW: Math.round(item.getBoundingClientRect().width),
      listH: document.getElementById('video-list').style.height,
      infoHidden: getComputedStyle(item.querySelector('.video-info')).display === 'none',
      titleAttr: item.title,
    };
  });
  check('Slim tile height is 90 (got ' + slimGeo.cardH + ')', slimGeo.cardH === 90);
  check('Slim tile width is 164 (got ' + slimGeo.cardW + ')', slimGeo.cardW === 164);
  check('Slim list height is 40×94 = 3760px (got ' + slimGeo.listH + ')', slimGeo.listH === '3760px');
  check('.video-info hidden on slim tiles', slimGeo.infoHidden);
  check('Slim tile carries a title tooltip', (slimGeo.titleAttr || '').length > 0);

  // Stage-05 chip visibility + hover overlay clearance (contract section 5)
  const chip = await panel.evaluate(() => {
    const item = document.querySelector('.video-item[data-id^="P00"]');
    const c = item?.querySelector('.thumb-addcount');
    if (!c) return null;
    const cr = item.querySelector('.card-right').getBoundingClientRect();
    const thumb = item.querySelector('.video-thumb').getBoundingClientRect();
    const chipRect = c.getBoundingClientRect();
    return {
      visible: getComputedStyle(c).display !== 'none' && chipRect.height > 0,
      overlayClearance: cr.top - thumb.top,
      chipBottomAboveOverlay: chipRect.bottom <= cr.top + 0.5,
    };
  });
  check('addCount chip rendered + visible on slim tile', !!chip && chip.visible);
  check('Hover overlay clears the top 14px of the thumb (clearance ' +
    (chip ? chip.overlayClearance.toFixed(1) : '?') + 'px)',
    !!chip && chip.overlayClearance >= 14);
  check('Chip sits fully above the overlay', !!chip && chip.chipBottomAboveOverlay);

  await panel.screenshot({ path: path.join(stageShotDir, 'sidepanel-slim.png') });
  console.log('  Screenshot: screenshots/stages/viewing-modes/sidepanel-slim.png');

  // Hover overlay screenshot (design review)
  await panel.hover('.video-item[data-id^="P00"]');
  await panel.waitForTimeout(300);
  await panel.screenshot({ path: path.join(stageShotDir, 'sidepanel-slim-hover.png') });
  console.log('  Screenshot: screenshots/stages/viewing-modes/sidepanel-slim-hover.png');

  // B.2b channel filter chip in slim (fix pass, cross-group 01×04): an
  // active channel filter keeps constraining the tile list, so its only
  // indicator/clear affordance must stay visible in slim mode
  console.log('\n--- B.2b channel chip stays visible in slim ---');
  await panel.evaluate(() => {
    // .channel-link is display:none in slim — element click still dispatches
    document.querySelector('#video-list .video-item .channel-link').click();
  });
  await panel.waitForTimeout(600);
  const slimChip = await panel.evaluate(() => ({
    chipVisible: document.getElementById('channel-chip').offsetParent !== null,
    name: document.getElementById('channel-chip-name').textContent,
    tiles: document.querySelectorAll('#video-list .video-item').length,
  }));
  check('Channel chip VISIBLE in slim while a filter is active',
    slimChip.chipVisible, JSON.stringify(slimChip));
  check('Filter constrains the slim tiles (1 of 40)', slimChip.tiles === 1,
    'got ' + slimChip.tiles);
  await panel.click('#channel-chip-clear');
  await panel.waitForTimeout(600);
  check('Chip clear works from slim mode (full list restored)',
    await panel.evaluate(() =>
      document.getElementById('channel-chip').style.display === 'none' &&
      document.querySelectorAll('#video-list .video-item').length > 1));

  // B.3 virtual scroll still works at the slim height
  console.log('\n--- B.3 slim virtual scroll ---');
  const deep = await panel.evaluate(async () => {
    const sa = document.querySelector('.scroll-area');
    sa.scrollTop = sa.scrollHeight;
    sa.dispatchEvent(new Event('scroll'));
    await new Promise(r => setTimeout(r, 200));
    const ids = [...document.querySelectorAll('#video-list .video-item')].map(n => n.dataset.id);
    return { mounted: ids.length, last: ids[ids.length - 1] };
  });
  check('Last video rendered at bottom (got ' + deep.last + ')', deep.last === vid('P39', 39));
  check('Mounted DOM stays bounded in slim (' + deep.mounted + ' of 40)',
    deep.mounted > 0 && deep.mounted < 35);

  // B.4 persistence — storage + a second panel instance
  console.log('\n--- B.4 persistence ---');
  const storedMode = await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_settings');
    return r.yt_settings?.panelMode;
  });
  check('panelMode persisted as slim', storedMode === 'slim');
  const panel2 = await context.newPage();
  await panel2.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  await panel2.waitForTimeout(1000);
  check('Second panel loads with body.slim already applied',
    await panel2.evaluate(() => document.body.classList.contains('slim')));
  await panel2.close();

  // B.5 back to full
  console.log('\n--- B.5 back to full ---');
  await panel.click('#panel-mode-toggle');
  await panel.waitForTimeout(500);
  check('body.slim removed', await panel.evaluate(() => !document.body.classList.contains('slim')));
  const backGeo = await panel.evaluate(() => ({
    cardH: Math.round(document.querySelector('.video-item').getBoundingClientRect().height),
    listH: document.getElementById('video-list').style.height,
  }));
  check('Card height back to 59 (got ' + backGeo.cardH + ')', backGeo.cardH === 59);
  check('List height back to 2520px (got ' + backGeo.listH + ')', backGeo.listH === '2520px');

  // ============================================================
  // Part C — settings round-trip (panel #tb-inpage ↔ popup checkbox)
  // ============================================================
  console.log('\n=== Part C: settings round-trip ===');
  await setSettings({ inPageQueue: false });
  await panel.waitForTimeout(500);
  check('tb-inpage inactive after reset',
    await panel.evaluate(() => !document.getElementById('tb-inpage').classList.contains('active')));

  await panel.click('#tb-inpage');
  await panel.waitForTimeout(500);
  check('tb-inpage gains .active on click',
    await panel.evaluate(() => document.getElementById('tb-inpage').classList.contains('active')));
  let ipq = await sw.evaluate(async () =>
    (await chrome.storage.local.get('yt_settings')).yt_settings?.inPageQueue);
  check('inPageQueue true in storage after panel click', ipq === true);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.waitForTimeout(800);
  check('Popup checkbox reflects enabled state',
    await popup.evaluate(() => document.getElementById('inpage-queue-toggle').checked));

  await popup.screenshot({ path: path.join(stageShotDir, 'popup-inpage-toggle.png') });
  console.log('  Screenshot: screenshots/stages/viewing-modes/popup-inpage-toggle.png');

  await popup.click('#inpage-queue-toggle'); // native checkbox — no force needed
  await popup.waitForTimeout(500);
  ipq = await sw.evaluate(async () =>
    (await chrome.storage.local.get('yt_settings')).yt_settings?.inPageQueue);
  check('Unchecking in the popup flips storage back to false', ipq === false);
  check('Panel tb-inpage loses .active via storage.onChanged (no reload)',
    await panel.evaluate(() => !document.getElementById('tb-inpage').classList.contains('active')));

  await context.close();

  console.log('\n=============================');
  console.log('Viewing modes: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Viewing modes test failed to run:', err);
  process.exit(1);
});
