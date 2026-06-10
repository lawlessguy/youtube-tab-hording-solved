/**
 * Test: Analytics (stage 06) — activity log, silent capture, suggested sort,
 * export.
 *  - worker event pipeline: added_to_queue / watch_progress / marked_watched /
 *    removed / video_completed / skipped, with strictly increasing seqs
 *  - TRACK_WATCH_TIME stays backward compatible (no telemetry → no event)
 *  - 5000-event FIFO rotation with a monotonic seq counter
 *  - silent capture: video_opened logged with intercept OFF, deduped per
 *    tab+video, and NOT added to the queue
 *  - suggest scoring: per-channel composite, lazy compute, seq-gated cache
 *  - panel Suggested sort: button, ordering, settings persistence, drag guard
 *  - Export: real download event from the panel document, parseable JSON
 *
 * Security note: page.evaluate()/$eval() below are Playwright's sandboxed
 * page-evaluation APIs running fixed test code (the established harness
 * pattern in this repo) — NOT JavaScript eval(); export output is parsed
 * with JSON.parse only.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const extensionPath = path.resolve(__dirname, '..');
const stageShotDir = path.join(extensionPath, 'screenshots', 'stages', 'analytics');

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

// 11-char ids only; defaults: unwatched non-short in Main
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

  // Console errors collected from page creation onward (panel surface)
  const errors = [];
  function watchConsole(page, label) {
    page.on('console', m => { if (m.type() === 'error') errors.push('[' + label + '] ' + m.text()); });
    page.on('pageerror', e => errors.push('[' + label + '] ' + e.message));
  }

  // Stub YouTube thumbnail CDN — the now-playing card requests
  // i.ytimg.com/vi/<fakeId>/mqdefault.jpg, which would 404 live and pollute
  // the console-error check (1x1 transparent GIF)
  const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  await context.route('https://i.ytimg.com/**', route =>
    route.fulfill({ status: 200, contentType: 'image/gif', body: GIF }));

  const panel = await context.newPage();
  watchConsole(panel, 'panel');
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  await panel.setViewportSize({ width: 350, height: 900 });
  await panel.waitForTimeout(1000);

  const send = m => panel.evaluate(msg => chrome.runtime.sendMessage(msg), m);
  const getLog = () => sw.evaluate(async () =>
    (await chrome.storage.local.get('yt_activity_log')).yt_activity_log);
  const resetLog = () => sw.evaluate(() =>
    chrome.storage.local.set({ yt_activity_log: { v: 1, seq: 0, events: [] } }));
  const seedVideos = videos => sw.evaluate(
    v => chrome.storage.local.set({ yt_videos: v }), videos);

  // ===== 1. Worker event pipeline =====
  console.log('\n--- 1. Worker event pipeline ---');
  await resetLog();
  await sw.evaluate(() => chrome.storage.local.set({ yt_watch_time: {}, yt_videos: [] }));

  // onInstalled initialized the key (we just reset it; assert the shape)
  const initLog = await getLog();
  check('Log shape is { v:1, seq, events[] }',
    initLog?.v === 1 && initLog.seq === 0 && Array.isArray(initLog.events));

  // 1a. ADD_VIDEO → added_to_queue
  await send({ type: 'ADD_VIDEO', url: 'https://www.youtube.com/watch?v=ANALYTVID01' });
  let log = await getLog();
  const addEvents = log.events.filter(e => e.type === 'added_to_queue');
  check('ADD_VIDEO appended exactly one added_to_queue event', addEvents.length === 1,
    JSON.stringify(log.events.map(e => e.type)));
  check('added_to_queue has source manual', addEvents[0]?.source === 'manual');
  check('added_to_queue seq === 1', addEvents[0]?.seq === 1);
  check('added_to_queue videoId correct', addEvents[0]?.videoId === 'ANALYTVID01');

  // 1b. TRACK_WATCH_TIME with telemetry → watch_progress + watch time
  await send({
    type: 'TRACK_WATCH_TIME', minutes: 0.5,
    telemetry: {
      videoId: 'ANALYTVID01', url: 'https://www.youtube.com/watch?v=ANALYTVID01',
      isShort: false, secondsWatched: 30, maxPercent: 42, durationSec: 600,
      title: 'T', channel: 'Chan A',
    },
  });
  log = await getLog();
  const wp = log.events.find(e => e.type === 'watch_progress');
  check('watch_progress appended', !!wp);
  check('watch_progress fields preserved',
    wp?.videoId === 'ANALYTVID01' && wp?.secondsWatched === 30 && wp?.maxPercent === 42 &&
    wp?.durationSec === 600 && wp?.title === 'T' && wp?.channel === 'Chan A' &&
    wp?.source === 'content', JSON.stringify(wp));
  const wt1 = await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_watch_time');
    return Object.values(r.yt_watch_time || {}).reduce((a, b) => a + b, 0);
  });
  check('Watch time incremented by 0.5 (regression: old behavior preserved)', wt1 === 0.5,
    'got ' + wt1);

  // 1c. TRACK_WATCH_TIME without telemetry → time updates, NO event
  const lenBefore = log.events.length;
  await send({ type: 'TRACK_WATCH_TIME', minutes: 1 });
  log = await getLog();
  check('No-telemetry TRACK_WATCH_TIME appended nothing (backward compat)',
    log.events.length === lenBefore, lenBefore + ' -> ' + log.events.length);
  const wt2 = await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_watch_time');
    return Object.values(r.yt_watch_time || {}).reduce((a, b) => a + b, 0);
  });
  check('Watch time still accumulates without telemetry', wt2 === 1.5, 'got ' + wt2);

  // 1d-1f. UPDATE_VIDEO watched:true → marked_watched once (wasWatched guard)
  await seedVideos([
    mkVideo('UPDVID00001', { title: 'Upd video', channel: 'Chan U', duration: 300 }),
    mkVideo('REMVID00001', { title: 'Remove me', channel: 'Chan R', duration: 120 }),
    mkVideo('MARKVID0001', { title: 'Mark auto', channel: 'Chan M', duration: 200 }),
  ]);
  await send({ type: 'UPDATE_VIDEO', videoId: 'UPDVID00001', updates: { watched: true } });
  log = await getLog();
  const mwManual = log.events.filter(e => e.type === 'marked_watched' && e.source === 'manual');
  check('UPDATE_VIDEO {watched:true} → marked_watched (manual)',
    mwManual.length === 1 && mwManual[0].videoId === 'UPDVID00001',
    JSON.stringify(mwManual));
  await send({ type: 'UPDATE_VIDEO', videoId: 'UPDVID00001', updates: { watched: true } });
  log = await getLog();
  check('Repeating it appends nothing (wasWatched guard)',
    log.events.filter(e => e.type === 'marked_watched').length === 1);

  // 1g. REMOVE_VIDEO → removed with the entry's title/channel
  await send({ type: 'REMOVE_VIDEO', videoId: 'REMVID00001' });
  log = await getLog();
  const rm = log.events.find(e => e.type === 'removed');
  check('removed event carries title/channel of the removed entry',
    rm?.videoId === 'REMVID00001' && rm?.title === 'Remove me' &&
    rm?.channel === 'Chan R' && rm?.durationSec === 120, JSON.stringify(rm));

  // 1h. MARK_WATCHED (content auto-rule) → marked_watched source content
  await send({ type: 'MARK_WATCHED', videoId: 'MARKVID0001' });
  log = await getLog();
  const mwContent = log.events.find(e => e.type === 'marked_watched' && e.source === 'content');
  check('MARK_WATCHED → marked_watched with source content',
    mwContent?.videoId === 'MARKVID0001' && mwContent?.title === 'Mark auto',
    JSON.stringify(mwContent));

  // 1i. VIDEO_ENDED with autoplay OFF → video_completed despite early-return
  const endedRes = await send({ type: 'VIDEO_ENDED', videoId: 'ANALYTVID01' });
  check('VIDEO_ENDED response unchanged (autoPlayed false)', endedRes?.autoPlayed === false);
  log = await getLog();
  const vc = log.events.find(e => e.type === 'video_completed');
  check('video_completed appended despite the autoplay early-return',
    vc?.videoId === 'ANALYTVID01' && vc?.maxPercent === 100 && vc?.source === 'content',
    JSON.stringify(vc));

  // 1j. SKIP_VIDEO (empty queue → no navigation) → skipped
  await seedVideos([]);
  await send({ type: 'SKIP_VIDEO', videoId: 'SKIPVID0001' });
  log = await getLog();
  const sk = log.events.find(e => e.type === 'skipped');
  check('skipped event appended with source manual',
    sk?.videoId === 'SKIPVID0001' && sk?.source === 'manual', JSON.stringify(sk));

  // 1k. seqs strictly increasing across everything above
  const seqs = log.events.map(e => e.seq);
  check('Seqs strictly increasing (' + seqs.join(',') + ')',
    seqs.every((s, i) => i === 0 || s > seqs[i - 1]));
  check('Log seq counter matches last event seq', log.seq === seqs[seqs.length - 1]);

  // ===== 2. Rotation & cap =====
  console.log('\n--- 2. FIFO rotation at 5000 events ---');
  await sw.evaluate(() => {
    const events = [];
    for (let i = 1; i <= 5000; i++) {
      events.push({ seq: i, ts: Date.now(), type: 'marked_watched', videoId: 'ROTATE' + i });
    }
    return chrome.storage.local.set({ yt_activity_log: { v: 1, seq: 5000, events } });
  });
  await send({
    type: 'TRACK_WATCH_TIME', minutes: 0.1,
    telemetry: { videoId: 'ROTATEVID01', secondsWatched: 6, maxPercent: 10 },
  });
  log = await getLog();
  check('Length capped at 5000', log.events.length === 5000, 'got ' + log.events.length);
  check('Oldest event rotated out (events[0].seq === 2)', log.events[0]?.seq === 2,
    'got ' + log.events[0]?.seq);
  check('Seq counter survived rotation (5001)', log.seq === 5001, 'got ' + log.seq);
  check('Newest event is the appended watch_progress',
    log.events[4999]?.type === 'watch_progress' && log.events[4999]?.seq === 5001);

  // ===== 3. Silent capture + dedupe (intercept OFF) =====
  console.log('\n--- 3. Silent capture with intercept OFF ---');
  await resetLog();
  await seedVideos([]);
  const FAKE_WATCH = '<!DOCTYPE html><html><head><title>w</title></head>' +
    '<body><h1>fake watch</h1></body></html>';
  await context.route('https://www.youtube.com/watch*', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: FAKE_WATCH }));

  const ytPage = await context.newPage();
  await ytPage.goto('https://www.youtube.com/watch?v=OPENTEST001', { timeout: 30000 });
  await ytPage.waitForTimeout(1200);
  log = await getLog();
  const opened = log.events.filter(e => e.type === 'video_opened' && e.videoId === 'OPENTEST001');
  check('video_opened captured with intercept OFF (THE silent-capture check)',
    opened.length === 1, 'got ' + opened.length);
  check('video_opened source is browse', opened[0]?.source === 'browse',
    JSON.stringify(opened[0]));
  check('video_opened carries tabId + url',
    typeof opened[0]?.tabId === 'number' && (opened[0]?.url || '').includes('OPENTEST001'));

  await ytPage.goto('https://www.youtube.com/watch?v=OPENTEST001', { timeout: 30000 });
  await ytPage.waitForTimeout(1200);
  log = await getLog();
  const openedAgain = log.events.filter(e => e.type === 'video_opened' && e.videoId === 'OPENTEST001');
  check('Same tab+video within 60s deduped (still 1 event)', openedAgain.length === 1,
    'got ' + openedAgain.length);

  const queued = await sw.evaluate(async () =>
    (await chrome.storage.local.get('yt_videos')).yt_videos || []);
  check('Video NOT added to the queue (intercept off unaffected)',
    !queued.some(v => v.id === 'OPENTEST001'), JSON.stringify(queued.map(v => v.id)));
  await ytPage.close();

  // ===== 4. Suggest scoring + cache =====
  console.log('\n--- 4. Suggest scoring + seq-gated cache ---');
  const now = Date.now();
  await sw.evaluate(({ now }) => {
    const mkWatch = (seq, videoId, channel, maxPercent, ts) => ({
      seq, ts, type: 'watch_progress', videoId, title: null, channel,
      durationSec: 600, isShort: false, source: 'content', tabId: null,
      url: null, secondsWatched: 30, maxPercent,
    });
    const events = [
      mkWatch(1, 'CHANAVID001', 'Chan A', 95, now - 3600000),
      mkWatch(2, 'CHANAVID002', 'Chan A', 95, now - 3600000),
      mkWatch(3, 'CHANAVID003', 'Chan A', 95, now - 3600000),
      mkWatch(4, 'CHANBVID001', 'Chan B', 10, now - 30 * 86400000),
    ];
    return Promise.all([
      chrome.storage.local.set({ yt_activity_log: { v: 1, seq: 4, events } }),
      chrome.storage.local.remove('yt_suggest_scores'),
    ]);
  }, { now });
  // Chan B queued NEWER than Chan A: default Added(desc) shows B first, so a
  // Chan-A-first ordering later proves the Suggested comparator actually ran
  await seedVideos([
    mkVideo('CHANAQUEUE1', { channel: 'Chan A', title: 'Suggested first', addedAt: 1000 }),
    mkVideo('CHANBQUEUE1', { channel: 'Chan B', title: 'Suggested second', addedAt: 2000 }),
  ]);

  const scores1 = await send({ type: 'GET_SUGGEST_SCORES' });
  check('Scores computed for both channels',
    !!scores1?.channels?.['chan a'] && !!scores1?.channels?.['chan b'],
    JSON.stringify(Object.keys(scores1?.channels || {})));
  check('Chan A outscores Chan B',
    scores1?.channels?.['chan a']?.score > scores1?.channels?.['chan b']?.score,
    JSON.stringify(scores1?.channels));
  check('computedAtSeq === log.seq (4)', scores1?.computedAtSeq === 4);
  check('Chan A watchCount 3 / Chan B 1',
    scores1?.channels?.['chan a']?.watchCount === 3 &&
    scores1?.channels?.['chan b']?.watchCount === 1);
  const persistedScores = await sw.evaluate(async () =>
    (await chrome.storage.local.get('yt_suggest_scores')).yt_suggest_scores);
  check('yt_suggest_scores persisted', persistedScores?.computedAtSeq === 4);

  await panel.waitForTimeout(30); // computedAt would differ if recomputed
  const scores2 = await send({ type: 'GET_SUGGEST_SCORES' });
  check('Second call is a cache hit (computedAt unchanged)',
    scores2?.computedAt === scores1?.computedAt,
    scores1?.computedAt + ' vs ' + scores2?.computedAt);

  await send({ type: 'LOG_ACTIVITY_EVENT', event: { type: 'marked_watched', videoId: 'CACHEPOKE01' } });
  await panel.waitForTimeout(30);
  const scores3 = await send({ type: 'GET_SUGGEST_SCORES' });
  check('1 appended event stays below the 25-event rebuild threshold (cache hit)',
    scores3?.computedAtSeq === 4 && scores3?.computedAt === scores1?.computedAt,
    JSON.stringify({ seq: scores3?.computedAtSeq, at: scores3?.computedAt }));

  const badEvent = await send({ type: 'LOG_ACTIVITY_EVENT', event: { type: 'nope_event' } });
  check('LOG_ACTIVITY_EVENT rejects unknown types', badEvent?.success === false);

  // ===== 5. Panel Suggested sort =====
  console.log('\n--- 5. Panel Suggested sort ---');
  const suggestBtn = await panel.$('.sort-btn[data-sort="suggested"]');
  check('Suggest sort button present', !!suggestBtn);
  // Load the seeded queue under the default sort first
  await sw.evaluate(() => chrome.runtime.sendMessage({ type: 'VIDEOS_UPDATED' }).catch(() => {}));
  await panel.waitForTimeout(600);
  const firstDefault = await panel.$eval('#video-list .video-item', n => n.dataset.id)
    .catch(() => null);
  check('Default Added sort shows Chan B (newer) first', firstDefault === 'CHANBQUEUE1',
    'got ' + firstDefault);
  await panel.screenshot({ path: path.join(stageShotDir, 'panel-added-sort.png') });

  await panel.click('.sort-btn[data-sort="suggested"]');
  await panel.waitForTimeout(800);
  check('Suggest button gains .active', await panel.evaluate(() =>
    document.querySelector('.sort-btn[data-sort="suggested"]').classList.contains('active')));
  const firstSuggested = await panel.$eval('#video-list .video-item', n => n.dataset.id)
    .catch(() => null);
  check('First card is Chan A\'s video under Suggested sort',
    firstSuggested === 'CHANAQUEUE1', 'got ' + firstSuggested);
  const sortSetting = await sw.evaluate(async () =>
    (await chrome.storage.local.get('yt_settings')).yt_settings?.sortBy);
  check('yt_settings.sortBy persisted as suggested', sortSetting === 'suggested');
  const draggableOff = await panel.$eval('#video-list .video-item', n => n.getAttribute('draggable'));
  check('Cards not draggable while Suggested sort is active', draggableOff === 'false');
  await panel.screenshot({ path: path.join(stageShotDir, 'panel-suggest-active.png') });

  await panel.reload();
  await panel.waitForTimeout(1200);
  check('Suggested still active after panel reload', await panel.evaluate(() =>
    document.querySelector('.sort-btn[data-sort="suggested"]').classList.contains('active')));
  const firstAfterReload = await panel.$eval('#video-list .video-item', n => n.dataset.id)
    .catch(() => null);
  check('Ordering identical after reload (settings restore path)',
    firstAfterReload === 'CHANAQUEUE1', 'got ' + firstAfterReload);
  await panel.screenshot({ path: path.join(stageShotDir, 'panel-suggest-after-reload.png') });

  // ===== 6. Export =====
  console.log('\n--- 6. Export JSON download ---');
  check('Export button present in the secondary toggle-bar row',
    !!(await panel.$('.toggle-bar--secondary #tb-export')));
  check('Export button has data-desc', !!(await panel.$('#tb-export[data-desc]')));
  await panel.hover('#tb-export');
  await panel.waitForTimeout(300);
  const desc = await panel.textContent('#toggle-desc');
  check('Hover shows the export description', (desc || '').includes('Export activity log'),
    'got "' + desc + '"');
  await panel.screenshot({ path: path.join(stageShotDir, 'panel-export-hover.png') });

  const dlPromise = panel.waitForEvent('download', { timeout: 10000 });
  await panel.click('#tb-export');
  const dl = await dlPromise;
  check('Download filename matches yt-activity-log-YYYY-MM-DD.json',
    /^yt-activity-log-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()),
    dl.suggestedFilename());
  const dlPath = await dl.path();
  const parsed = JSON.parse(fs.readFileSync(dlPath, 'utf8'));
  check('Export schema is yt_activity_log', parsed.schema === 'yt_activity_log');
  check('Export schemaVersion 1', parsed.schemaVersion === 1);
  check('Export events is an array', Array.isArray(parsed.events));
  check('Export eventCount === events.length', parsed.eventCount === parsed.events.length);
  check('Export carries the seq counter', typeof parsed.seq === 'number' && parsed.seq >= 5);

  // ===== 7. Console errors =====
  console.log('\n--- 7. Console errors ---');
  if (errors.length > 0) {
    console.log('  Console errors found:');
    errors.forEach(e => console.log('    ' + e));
  }
  check('No console errors on the panel across all interactions', errors.length === 0);

  await context.close();

  console.log('\n=============================');
  console.log('Analytics: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Analytics test failed to run:', err);
  process.exit(1);
});
