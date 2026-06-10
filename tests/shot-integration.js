/**
 * Visual verification for the final integration stage (NOT part of test:all).
 * Seeds representative cross-feature data, then screenshots the integrated
 * side panel (full + slim + shorts tab) and the popup to
 * screenshots/stages/integration/.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const extensionPath = path.resolve(__dirname, '..');
const shotDir = path.join(extensionPath, 'screenshots', 'stages', 'integration');

(async () => {
  fs.mkdirSync(shotDir, { recursive: true });

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

  const now = Date.now();
  const mkVideo = (i, over = {}) => ({
    id: 'vid' + String(i).padStart(8, '0'),
    url: `https://www.youtube.com/watch?v=vid${String(i).padStart(8, '0')}`,
    title: `Integration check video ${i} — long enough title to wrap around`,
    channel: i % 2 ? 'Channel Alpha' : 'Channel Beta',
    thumbnail: '',
    duration: 60 * (i + 3),
    addedAt: now - i * 60000,
    uploadedAt: now - i * 86400000,
    isShort: false,
    watched: false,
    starred: i === 1,
    sessionId: 'main',
    addCount: i === 0 ? 3 : 1,
    ...over,
  });

  const videos = [
    mkVideo(0),
    mkVideo(1),
    mkVideo(2),
    mkVideo(3, { watched: true }),
    mkVideo(4, { sessionId: 'research' }),
    mkVideo(5, {
      isShort: true, duration: 42,
      url: 'https://www.youtube.com/shorts/vid00000005',
    }),
    mkVideo(6, {
      isShort: true, duration: 30,
      url: 'https://www.youtube.com/shorts/vid00000006',
    }),
  ];

  await sw.evaluate(async (videos) => {
    const d = new Date();
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    await chrome.storage.local.set({
      yt_videos: videos,
      yt_sessions: {
        activeId: 'main',
        list: [
          { id: 'main', name: 'Main', createdAt: 0 },
          { id: 'research', name: 'Research', createdAt: Date.now() },
        ],
      },
      yt_watch_time: { [key]: 47 },
    });
  }, videos);

  // Open a routed fake watch tab so the worker tracks it in yt_open_tab_ids
  // (seeding the session key directly gets overwritten by the recompute) and
  // the first card earns its TAB chip.
  await context.route('https://www.youtube.com/watch*', route =>
    route.fulfill({ status: 200, contentType: 'text/html',
      body: '<!DOCTYPE html><html><head><title>w</title></head><body>fake</body></html>' }));
  const ytTab = await context.newPage();
  await ytTab.goto('https://www.youtube.com/watch?v=vid00000000');
  await ytTab.waitForTimeout(700); // 250ms debounce + slack

  // --- Side panel, full mode ---
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 360, height: 720 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  await panel.waitForSelector('.video-item');
  await panel.waitForTimeout(400);
  await panel.screenshot({ path: path.join(shotDir, 'panel-full.png') });
  console.log('saved panel-full.png');

  // --- Slim mode ---
  await panel.click('#panel-mode-toggle');
  await panel.waitForTimeout(400);
  await panel.screenshot({ path: path.join(shotDir, 'panel-slim.png') });
  console.log('saved panel-slim.png');
  await panel.click('#panel-mode-toggle'); // back to full
  await panel.waitForTimeout(300);

  // --- Shorts content tab ---
  await panel.click('#tab-shorts');
  await panel.waitForTimeout(300);
  await panel.screenshot({ path: path.join(shotDir, 'panel-shorts-tab.png') });
  console.log('saved panel-shorts-tab.png');

  // --- Popup ---
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 600 });
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.waitForTimeout(500);
  await popup.screenshot({ path: path.join(shotDir, 'popup.png') });
  console.log('saved popup.png');

  await context.close();
  console.log('done');
})().catch((e) => { console.error(e); process.exit(1); });
