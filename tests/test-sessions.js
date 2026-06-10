/**
 * Test: Sessions, channel filter & smart play (stage 04 list-panel)
 *  - session bar boots with Main only; rename/merge/delete disabled on Main
 *  - CREATE_SESSION switches to the new session; panel follows storage.onChanged
 *  - lists are session-scoped; missing sessionId reads as 'main' (legacy rule)
 *  - rename via the inline input (no prompt() in extension panels)
 *  - MERGE_SESSION moves to Main (dup: Main wins, starred OR'd, watched AND'd)
 *  - DELETE_SESSION removes videos (two-click confirm in the UI); Main protected
 *  - channel filter: click .channel-link → chip + AND with search; Unknown inert
 *  - smart play: OPEN_VIDEO focuses an existing tab instead of opening another
 *  - VIDEO_ENDED fallback next-pick is scoped to the active session
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const extensionPath = path.resolve(__dirname, '..');
const stageShotDir = path.join(extensionPath, 'screenshots', 'stages', 'list-panel');

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

// 11-char ids only; videos default to unwatched non-shorts in Main
function mkVideo(id, extra = {}) {
  return {
    id,
    url: 'https://www.youtube.com/watch?v=' + id,
    title: 'Video ' + id,
    channel: 'Chan ' + id,
    thumbnail: '',
    duration: 60,
    addedAt: 1000,
    uploadedAt: null,
    isShort: false,
    watched: false,
    starred: false,
    sessionId: 'main',
    addCount: 1,
    ...extra,
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

  // Deterministic fake watch pages for every routed watch URL. The <video>
  // lets the content script bind its 'ended' listener (VIDEO_ENDED test).
  const FAKE_WATCH = '<!DOCTYPE html><html><head><title>w</title></head>' +
    '<body><video muted></video></body></html>';
  await context.route('https://www.youtube.com/watch*', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: FAKE_WATCH }));

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  await panel.setViewportSize({ width: 350, height: 900 });
  await panel.waitForTimeout(1000);

  const send = m => panel.evaluate(msg => chrome.runtime.sendMessage(msg), m);
  const getSessionsRaw = () => sw.evaluate(async () =>
    (await chrome.storage.local.get('yt_sessions')).yt_sessions);
  const getVideosRaw = () => sw.evaluate(async () =>
    (await chrome.storage.local.get('yt_videos')).yt_videos || []);
  const seedVideos = videos => sw.evaluate(
    v => chrome.storage.local.set({ yt_videos: v }), videos);
  // The panel reloads on the VIDEOS_UPDATED broadcast (not raw storage writes)
  const broadcastVideosUpdated = () => sw.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'VIDEOS_UPDATED' }).catch(() => {}));
  const videoCount = () => panel.textContent('#video-count');

  // --- 1. Session bar boots ---
  console.log('\n--- 1. Session bar boots ---');
  check('#session-select exists', !!(await panel.$('#session-select')));
  const bootOpts = await panel.$$eval('#session-select option',
    os => os.map(o => ({ value: o.value, text: o.textContent })));
  check('Exactly one option: Main',
    bootOpts.length === 1 && bootOpts[0].value === 'main' && bootOpts[0].text === 'Main',
    JSON.stringify(bootOpts));
  const bootDisabled = await panel.evaluate(() => ({
    rename: document.getElementById('session-rename').disabled,
    merge: document.getElementById('session-merge').disabled,
    del: document.getElementById('session-delete').disabled,
  }));
  check('Rename/merge/delete disabled on Main',
    bootDisabled.rename && bootDisabled.merge && bootDisabled.del,
    JSON.stringify(bootDisabled));
  await panel.screenshot({ path: path.join(stageShotDir, 'panel-boot-main.png') });

  // --- 2. CREATE_SESSION switches and the panel follows ---
  console.log('\n--- 2. CREATE_SESSION ---');
  const created = await send({ type: 'CREATE_SESSION', name: 'Research' });
  check('Response has session and activeId = new id',
    !!created?.session?.id && created.activeId === created.session.id,
    JSON.stringify(created));
  const researchId = created.session.id;
  await panel.waitForTimeout(800);
  const selAfterCreate = await panel.evaluate(() => ({
    count: document.getElementById('session-select').options.length,
    value: document.getElementById('session-select').value,
  }));
  check('Select gained the new session via storage.onChanged', selAfterCreate.count === 2);
  check('Select switched to the new session', selAfterCreate.value === researchId);
  const emptyRes = await send({ type: 'CREATE_SESSION', name: '   ' });
  check('Whitespace-only name rejected', !!emptyRes?.error);

  // --- 3. Session-scoped lists (+ legacy missing-sessionId → main) ---
  console.log('\n--- 3. Session-scoped lists ---');
  const legacy = mkVideo('LEGACYVID01', { channel: 'Unknown' });
  delete legacy.sessionId; // legacy entry — must read as 'main'
  await seedVideos([
    mkVideo('MAINVID0001', { channel: 'Alpha Channel', title: 'Alpha quantum mechanics', addedAt: 9000 }),
    mkVideo('MAINVID0002', { channel: 'Alpha Channel', title: 'Alpha second upload', addedAt: 8000 }),
    mkVideo('MAINVID0003', { channel: 'Beta Channel', title: 'Beta video', addedAt: 7000 }),
    mkVideo('RSRCHVID001', { sessionId: researchId, channel: 'Gamma', title: 'Research one', addedAt: 6000 }),
    mkVideo('RSRCHVID002', { sessionId: researchId, channel: 'Gamma', title: 'Research two', addedAt: 5000 }),
    legacy,
  ]);
  await broadcastVideosUpdated();
  await panel.waitForTimeout(700);
  check('Active session (Research) lists 2 videos', (await videoCount()) === '2',
    'got ' + (await videoCount()));
  await panel.screenshot({ path: path.join(stageShotDir, 'session-research-two-videos.png') });

  await send({ type: 'SET_ACTIVE_SESSION', sessionId: 'main' });
  await panel.waitForTimeout(800);
  check('Main lists 4 videos (3 main + 1 legacy fallback)', (await videoCount()) === '4',
    'got ' + (await videoCount()));
  check('Select followed the switch to main',
    (await panel.evaluate(() => document.getElementById('session-select').value)) === 'main');
  const unknownActive = await send({ type: 'SET_ACTIVE_SESSION', sessionId: 's_nope0000' });
  check('SET_ACTIVE_SESSION rejects unknown id', !!unknownActive?.error);
  await panel.screenshot({ path: path.join(stageShotDir, 'session-main-four-videos.png') });

  // --- 4. Rename via inline input ---
  console.log('\n--- 4. Rename via inline input ---');
  await send({ type: 'SET_ACTIVE_SESSION', sessionId: researchId });
  await panel.waitForTimeout(800);
  check('Rename enabled on non-main session',
    !(await panel.evaluate(() => document.getElementById('session-rename').disabled)));
  await panel.click('#session-rename');
  const inputState = await panel.evaluate(() => ({
    visible: getComputedStyle(document.getElementById('session-name-input')).display !== 'none',
    selectHidden: getComputedStyle(document.getElementById('session-select')).display === 'none',
    value: document.getElementById('session-name-input').value,
  }));
  check('Inline input visible, select hidden', inputState.visible && inputState.selectHidden);
  check('Input prefilled with current name', inputState.value === 'Research');
  await panel.screenshot({ path: path.join(stageShotDir, 'rename-input-mode.png') });
  await panel.fill('#session-name-input', 'Deep Work');
  await panel.press('#session-name-input', 'Enter');
  await panel.waitForTimeout(800);
  const renamed = await getSessionsRaw();
  check('yt_sessions reflects the rename',
    renamed?.list?.find(s => s.id === researchId)?.name === 'Deep Work');
  check('Select option text updated', await panel.evaluate(() =>
    [...document.getElementById('session-select').options].some(o => o.textContent === 'Deep Work')));
  check('Input mode exited (select visible again)', await panel.evaluate(() =>
    getComputedStyle(document.getElementById('session-select')).display !== 'none'));
  const renameMain = await send({ type: 'RENAME_SESSION', sessionId: 'main', name: 'X' });
  check('RENAME_SESSION rejects main', !!renameMain?.error);

  // --- 5. MERGE_SESSION (dup: Main wins, starred OR, watched AND) ---
  console.log('\n--- 5. MERGE_SESSION ---');
  await seedVideos([
    mkVideo('DUPVIDEO001', { addedAt: 5000, starred: false, watched: true }),
    mkVideo('DUPVIDEO001', { sessionId: researchId, addedAt: 9000, starred: true, watched: false }),
    mkVideo('UNIQUEVID01', { sessionId: researchId, addedAt: 1000 }),
  ]);
  const mergeRes = await send({ type: 'MERGE_SESSION', sourceSessionId: researchId });
  check('Merge response: moved 1, duplicates 1',
    mergeRes?.success === true && mergeRes.moved === 1 && mergeRes.duplicates === 1,
    JSON.stringify(mergeRes));
  const afterMerge = await getVideosRaw();
  check('No source-session entries remain',
    afterMerge.every(v => (v.sessionId || 'main') === 'main'));
  const dups = afterMerge.filter(v => v.id === 'DUPVIDEO001');
  check('Duplicate collapsed to one Main entry', dups.length === 1);
  check('Dup kept Main addedAt (5000)', dups[0]?.addedAt === 5000);
  check('Dup starred OR\'d (true)', dups[0]?.starred === true);
  check('Dup watched AND\'d (false — unwatched wins)', dups[0]?.watched === false);
  check('Unique video moved to main',
    afterMerge.some(v => v.id === 'UNIQUEVID01' && (v.sessionId || 'main') === 'main'));
  const sessAfterMerge = await getSessionsRaw();
  check('Session list back to Main only', sessAfterMerge?.list?.length === 1);
  check('activeId back to main', sessAfterMerge?.activeId === 'main');
  const mergeMain = await send({ type: 'MERGE_SESSION', sourceSessionId: 'main' });
  check('MERGE_SESSION rejects main as source', !!mergeMain?.error);

  // --- 6. DELETE_SESSION (two-click UI confirm + worker response) ---
  console.log('\n--- 6. DELETE_SESSION ---');
  await panel.click('#session-new');
  await panel.fill('#session-name-input', 'Temp');
  await panel.press('#session-name-input', 'Enter');
  await panel.waitForTimeout(800);
  const sessTemp = await getSessionsRaw();
  const tempId = sessTemp?.list?.find(s => s.name === 'Temp')?.id;
  check('Temp session created via inline input and now active',
    !!tempId && sessTemp.activeId === tempId, JSON.stringify(sessTemp));
  await seedVideos([
    mkVideo('TEMPVIDEO01', { sessionId: tempId }),
    mkVideo('TEMPVIDEO02', { sessionId: tempId }),
  ]);
  await broadcastVideosUpdated();
  await panel.waitForTimeout(500);

  await panel.click('#session-delete'); // arm
  const armed = await panel.evaluate(() =>
    document.getElementById('session-delete').classList.contains('confirming'));
  check('First delete click arms (.confirming)', armed);
  const midVideos = await getVideosRaw();
  check('Nothing deleted after first click',
    midVideos.some(v => v.id === 'TEMPVIDEO01') && midVideos.some(v => v.id === 'TEMPVIDEO02'),
    JSON.stringify(midVideos.map(v => v.id)));
  await panel.waitForTimeout(300); // let the 0.15s .confirming transition settle
  await panel.screenshot({ path: path.join(stageShotDir, 'delete-confirming.png') });
  await panel.click('#session-delete'); // confirm
  await panel.waitForTimeout(900);
  const afterDel = await getVideosRaw();
  check('Temp session videos removed',
    !afterDel.some(v => v.id === 'TEMPVIDEO01' || v.id === 'TEMPVIDEO02'));
  const sessAfterDel = await getSessionsRaw();
  check('Temp session gone, active back to main',
    sessAfterDel?.activeId === 'main' && !sessAfterDel.list.some(s => s.id === tempId));
  check('Panel select back to Main',
    (await panel.evaluate(() => document.getElementById('session-select').value)) === 'main');

  const c2 = await send({ type: 'CREATE_SESSION', name: 'Temp2' });
  await seedVideos([
    ...(await getVideosRaw()),
    mkVideo('TEMP2VIDEO1', { sessionId: c2.session.id }),
    mkVideo('TEMP2VIDEO2', { sessionId: c2.session.id }),
  ]);
  const delRes = await send({ type: 'DELETE_SESSION', sessionId: c2.session.id });
  check('DELETE_SESSION reports removedVideos 2',
    delRes?.success === true && delRes.removedVideos === 2, JSON.stringify(delRes));
  const delMain = await send({ type: 'DELETE_SESSION', sessionId: 'main' });
  check('DELETE_SESSION rejects main', !!delMain?.error);
  const delUnknown = await send({ type: 'DELETE_SESSION', sessionId: 's_nope0000' });
  check('DELETE_SESSION rejects unknown id', !!delUnknown?.error);
  await panel.waitForTimeout(600);

  // --- 7+8. Channel filter (chip, AND with search, Unknown inert, no play) ---
  console.log('\n--- 7. Channel filter ---');
  await seedVideos([
    mkVideo('CHANAVIDEO1', { channel: 'Alpha Channel', title: 'Alpha quantum mechanics', addedAt: 9000 }),
    mkVideo('CHANAVIDEO2', { channel: 'Alpha Channel', title: 'Alpha second upload', addedAt: 8000 }),
    mkVideo('CHANBVIDEO1', { channel: 'Beta Channel', title: 'Beta video', addedAt: 7000 }),
    mkVideo('UNKNOWNVID1', { channel: 'Unknown', title: 'Unenriched video', addedAt: 6000 }),
  ]);
  await broadcastVideosUpdated();
  await panel.waitForTimeout(700);
  check('4 videos listed before filtering', (await videoCount()) === '4',
    'got ' + (await videoCount()));
  check('Channel chip hidden by default', await panel.evaluate(() =>
    getComputedStyle(document.getElementById('channel-chip')).display === 'none'));
  check('Unknown-channel span is not clickable',
    !(await panel.$('.video-item[data-id="UNKNOWNVID1"] .channel-link')));
  check('Known-channel span is clickable',
    !!(await panel.$('.video-item[data-id="CHANAVIDEO1"] .channel-link')));

  const tabsBefore = await sw.evaluate(() => chrome.tabs.query({}).then(t => t.length));
  await panel.click('.video-item[data-id="CHANAVIDEO1"] .channel-link');
  await panel.waitForTimeout(600);
  const tabsAfter = await sw.evaluate(() => chrome.tabs.query({}).then(t => t.length));
  check('Channel click did NOT open/play anything (tab count unchanged)',
    tabsBefore === tabsAfter, tabsBefore + ' -> ' + tabsAfter);

  check('Filtered to the 2 Alpha Channel videos', (await videoCount()) === '2',
    'got ' + (await videoCount()));
  const chipState = await panel.evaluate(() => ({
    visible: getComputedStyle(document.getElementById('channel-chip')).display !== 'none',
    name: document.getElementById('channel-chip-name').textContent,
  }));
  check('Chip visible with the channel name',
    chipState.visible && chipState.name === 'Alpha Channel', JSON.stringify(chipState));
  await panel.screenshot({ path: path.join(stageShotDir, 'channel-filter-active.png') });

  await panel.fill('#search-input', 'quantum');
  await panel.waitForTimeout(400);
  check('Channel AND search → 1 video', (await videoCount()) === '1',
    'got ' + (await videoCount()));
  await panel.click('#search-clear');
  await panel.waitForTimeout(300);
  await panel.click('#channel-chip-clear');
  await panel.waitForTimeout(400);
  check('Count back to 4 after clearing the chip', (await videoCount()) === '4',
    'got ' + (await videoCount()));
  check('Chip hidden again', await panel.evaluate(() =>
    getComputedStyle(document.getElementById('channel-chip')).display === 'none'));

  // --- 9. Smart play ---
  console.log('\n--- 9. Smart play ---');
  const stub = await context.newPage();
  await stub.goto('https://www.youtube.com/watch?v=SMARTPLAY01', { timeout: 30000 });
  await stub.waitForTimeout(800);
  const pagesBefore = context.pages().length;
  const res1 = await send({ type: 'OPEN_VIDEO', url: 'https://www.youtube.com/watch?v=SMARTPLAY01' });
  check('OPEN_VIDEO focused the existing tab ({focused:true})',
    res1?.focused === true, JSON.stringify(res1));
  const stubTabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.find(t => t.url && t.url.includes('SMARTPLAY01'))?.id ?? null;
  });
  check('Returned tabId matches the open tab', res1?.tabId === stubTabId,
    res1?.tabId + ' vs ' + stubTabId);
  check('No new page was created', context.pages().length === pagesBefore,
    pagesBefore + ' -> ' + context.pages().length);
  const activeUrl = await sw.evaluate(async () =>
    (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.url || '');
  check('Matched tab was activated', activeUrl.includes('SMARTPLAY01'), activeUrl);

  const res2 = await send({ type: 'OPEN_VIDEO', url: 'https://www.youtube.com/watch?v=SMARTPLAY02' });
  check('Fall-through keeps the legacy shape (replaced, no focused)',
    res2 && res2.focused === undefined && typeof res2.replaced === 'boolean',
    JSON.stringify(res2));
  await panel.waitForTimeout(700);
  const hasSecond = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.some(t => t.url && t.url.includes('SMARTPLAY02'));
  });
  check('Fall-through actually opened/navigated to the video', hasSecond);
  await stub.close();

  // --- 10. VIDEO_ENDED fallback scoped to the active session ---
  console.log('\n--- 10. VIDEO_ENDED session scoping ---');
  // Main holds the MORE attractive fallback candidate (higher addedAt, desc
  // sort) — if the session filter were missing the worker would pick it and
  // this check would fail.
  const s2 = await send({ type: 'CREATE_SESSION', name: 'Ended' }); // becomes active
  await seedVideos([
    mkVideo('MAINNEXT001', { addedAt: 999999 }),
    mkVideo('SESSNEXT001', { sessionId: s2.session.id, addedAt: 1000 }),
  ]);
  await sw.evaluate(() => chrome.storage.local.set({ yt_next_video_order: [] }));
  await send({ type: 'UPDATE_SETTINGS', settings: { autoPlayNext: true } });

  const endedPage = await context.newPage();
  await endedPage.goto('https://www.youtube.com/watch?v=ENDEDTEST01', { timeout: 30000 });
  await endedPage.waitForTimeout(2500); // content script bindVideoFeatures
  await endedPage.evaluate(() =>
    document.querySelector('video').dispatchEvent(new Event('ended')));
  await endedPage.waitForTimeout(2500);
  check('VIDEO_ENDED navigated to the ACTIVE session\'s video',
    endedPage.url().includes('SESSNEXT001'), 'url=' + endedPage.url());
  await endedPage.close();
  await send({ type: 'UPDATE_SETTINGS', settings: { autoPlayNext: false } });
  await send({ type: 'DELETE_SESSION', sessionId: s2.session.id });

  await context.close();

  console.log('\n=============================');
  console.log('Sessions: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Sessions test failed to run:', err);
  process.exit(1);
});
