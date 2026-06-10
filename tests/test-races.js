/**
 * Test: storage mutation race conditions
 * Fires concurrent messages at the service worker and verifies no updates
 * are lost and no duplicate queue entries are created.
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

  // Use the popup page as a message-sending context (extension page →
  // runtime.sendMessage reaches the service worker's onMessage)
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await page.waitForTimeout(500);

  // --- Test 1: concurrent TRACK_WATCH_TIME must not lose increments ---
  console.log('\n--- Race 1: 20 concurrent TRACK_WATCH_TIME ---');
  await sw.evaluate(() => chrome.storage.local.set({ yt_watch_time: {} }));
  await page.evaluate(async () => {
    const sends = [];
    for (let i = 0; i < 20; i++) {
      sends.push(chrome.runtime.sendMessage({ type: 'TRACK_WATCH_TIME', minutes: 1 }));
    }
    await Promise.all(sends);
  });
  const totalMinutes = await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_watch_time');
    return Object.values(r.yt_watch_time || {}).reduce((a, b) => a + b, 0);
  });
  check('All 20 minutes recorded (got ' + totalMinutes + ')', totalMinutes === 20);

  // --- Test 2: concurrent same-id ADD_VIDEO must create exactly 1 entry ---
  console.log('\n--- Race 2: 10 concurrent ADD_VIDEO (same id) ---');
  await sw.evaluate(() => chrome.storage.local.set({ yt_videos: [] }));
  await page.evaluate(async () => {
    const sends = [];
    for (let i = 0; i < 10; i++) {
      sends.push(chrome.runtime.sendMessage({
        type: 'ADD_VIDEO',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      }));
    }
    await Promise.all(sends);
  });
  const sameIdCount = await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_videos');
    return (r.yt_videos || []).filter(v => v.id === 'dQw4w9WgXcQ').length;
  });
  check('Exactly 1 queue entry (got ' + sameIdCount + ')', sameIdCount === 1);

  // --- Test 3: concurrent distinct ADD_VIDEOs must all survive ---
  console.log('\n--- Race 3: 10 concurrent ADD_VIDEO (distinct ids) ---');
  await sw.evaluate(() => chrome.storage.local.set({ yt_videos: [] }));
  await page.evaluate(async () => {
    const sends = [];
    for (let i = 0; i < 10; i++) {
      const id = 'TESTVIDEO' + String(i).padStart(2, '0'); // 11 chars
      sends.push(chrome.runtime.sendMessage({
        type: 'ADD_VIDEO',
        url: 'https://www.youtube.com/watch?v=' + id,
      }));
    }
    await Promise.all(sends);
  });
  const distinctCount = await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_videos');
    return (r.yt_videos || []).length;
  });
  check('All 10 entries present (got ' + distinctCount + ')', distinctCount === 10);

  // --- Test 4: concurrent UPDATE_VIDEO + REMOVE_VIDEO on different ids ---
  console.log('\n--- Race 4: interleaved UPDATE_VIDEO/REMOVE_VIDEO ---');
  const updateRemoveResult = await page.evaluate(async () => {
    await Promise.all([
      chrome.runtime.sendMessage({ type: 'UPDATE_VIDEO', videoId: 'TESTVIDEO01', updates: { watched: true } }),
      chrome.runtime.sendMessage({ type: 'REMOVE_VIDEO', videoId: 'TESTVIDEO02' }),
      chrome.runtime.sendMessage({ type: 'UPDATE_VIDEO', videoId: 'TESTVIDEO03', updates: { starred: true } }),
      chrome.runtime.sendMessage({ type: 'REMOVE_VIDEO', videoId: 'TESTVIDEO04' }),
    ]);
    return true;
  });
  const finalState = await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_videos');
    const videos = r.yt_videos || [];
    return {
      count: videos.length,
      v1watched: videos.find(v => v.id === 'TESTVIDEO01')?.watched,
      v2gone: !videos.some(v => v.id === 'TESTVIDEO02'),
      v3starred: videos.find(v => v.id === 'TESTVIDEO03')?.starred,
      v4gone: !videos.some(v => v.id === 'TESTVIDEO04'),
    };
  });
  check('Both removes applied (8 left, got ' + finalState.count + ')', finalState.count === 8);
  check('Update 1 applied (watched)', finalState.v1watched === true);
  check('Update 2 applied (starred)', finalState.v3starred === true);
  check('Removes applied', finalState.v2gone && finalState.v4gone);

  // --- Test 5: concurrent CREATE_SESSION must not lose sessions ---
  console.log('\n--- Race 5: 10 concurrent CREATE_SESSION ---');
  await sw.evaluate(() => chrome.storage.local.set({
    yt_sessions: { activeId: 'main', list: [{ id: 'main', name: 'Main', createdAt: 0 }] },
  }));
  await page.evaluate(async () => {
    const sends = [];
    for (let i = 0; i < 10; i++) {
      sends.push(chrome.runtime.sendMessage({ type: 'CREATE_SESSION', name: 'Race ' + i }));
    }
    await Promise.all(sends);
  });
  const sessState = await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_sessions');
    return r.yt_sessions;
  });
  check('All 10 sessions created (got ' + (sessState.list.length - 1) + ')',
    sessState.list.length === 11);
  check('All session ids distinct',
    new Set(sessState.list.map(s => s.id)).size === sessState.list.length);
  check('activeId points at an existing session',
    sessState.list.some(s => s.id === sessState.activeId));

  // --- Test 6: concurrent LOG_ACTIVITY_EVENT — no loss, contiguous seqs ---
  console.log('\n--- Race 6: 20 concurrent LOG_ACTIVITY_EVENT ---');
  await sw.evaluate(() => chrome.storage.local.set({
    yt_activity_log: { v: 1, seq: 0, events: [] },
  }));
  await page.evaluate(async () => {
    const sends = [];
    for (let i = 0; i < 20; i++) {
      sends.push(chrome.runtime.sendMessage({
        type: 'LOG_ACTIVITY_EVENT',
        event: { type: 'marked_watched', videoId: 'RACEVIDEO' + String(i).padStart(2, '0') },
      }));
    }
    await Promise.all(sends);
  });
  const logState = await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_activity_log');
    return r.yt_activity_log;
  });
  check('All 20 events recorded (got ' + (logState?.events?.length ?? 0) + ')',
    logState?.events?.length === 20);
  const seqs = (logState?.events || []).map(e => e.seq);
  check('Seqs are 20 distinct contiguous values in order',
    seqs.length === 20 && seqs.every((s, i) => s === i + 1));
  check('Log seq counter is 20', logState?.seq === 20);

  await context.close();

  console.log('\n=============================');
  console.log('Races: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Race test failed to run:', err);
  process.exit(1);
});
