/**
 * Test: YouTube thumbnail QUEUED indicators
 * Loads extension, adds a video to queue, then checks if badges appear on YouTube.
 */
const { chromium } = require('playwright');
const path = require('path');

const extensionPath = path.resolve(__dirname, '..');
const screenshotDir = path.join(extensionPath, 'screenshots');

// Badge-eligible thumbnail anchors — keep in sync with content.js
// applyThumbnailIndicators(). Seeding ids from anchors OUTSIDE this set
// produces ids that never receive badges (the old generic
// a[href*="/watch?v="] fallback did exactly that on current YouTube).
const THUMB_ANCHOR_SELECTOR =
  'a.ytLockupViewModelContentImage[href], ' +       // current lockup layout (2026, camelCase)
  'a.yt-lockup-view-model__content-image[href], ' + // lockup layout (2024)
  'a#thumbnail[href]';                              // legacy layout

(async () => {
  console.log('Launching Chromium with extension...');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  // Get extension ID
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extensionId = sw.url().split('/')[2];
  console.log('Extension ID:', extensionId);

  // Wait for onInstalled to finish seeding storage on the fresh profile —
  // writing yt_videos immediately races normalizeLegacyVideos (it initializes
  // an absent yt_videos to [] and would clobber our seed)
  await sw.evaluate(async () => {
    for (let i = 0; i < 50; i++) {
      const r = await chrome.storage.local.get(['yt_settings', 'yt_videos']);
      if (r.yt_settings && r.yt_videos) return;
      await new Promise(res => setTimeout(res, 100));
    }
  });

  // Step 1: Open a YouTube video to add to the queue
  console.log('\n--- Step 1: Open YouTube video ---');
  const ytPage = await context.newPage();
  await ytPage.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded' });
  await ytPage.waitForTimeout(3000);

  // Handle consent dialog if present
  try {
    const consentBtn = await ytPage.$('button[aria-label*="Accept"], button[aria-label*="Reject"], form[action*="consent"] button');
    if (consentBtn) {
      await consentBtn.click();
      await ytPage.waitForTimeout(2000);
    }
  } catch {}

  // Find the first video link — ONLY from badge-eligible thumbnail anchors
  // (current lockup layout first); seeding from generic anchors yields ids
  // the indicator pass never decorates
  let firstVideoId = await ytPage.evaluate((sel) => {
    for (const link of document.querySelectorAll(sel)) {
      const m = (link.getAttribute('href') || '').match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);
      if (m) return m[1];
    }
    return null;
  }, THUMB_ANCHOR_SELECTOR);

  // If still null, check what's on the page
  if (!firstVideoId) {
    const pageDebug = await ytPage.evaluate(() => ({
      url: location.href,
      title: document.title,
      allAnchors: document.querySelectorAll('a').length,
      watchAnchors: document.querySelectorAll('a[href*="/watch"]').length,
      bodyText: document.body?.innerText?.substring(0, 200),
    }));
    console.log('Page debug:', JSON.stringify(pageDebug, null, 2));
    // Use a well-known video ID as fallback
    firstVideoId = 'dQw4w9WgXcQ';
    console.log('Using fallback video ID:', firstVideoId);
  } else {
    console.log('First video ID on page:', firstVideoId);
  }

  // Step 2: Add this video to the queue via the service worker
  console.log('\n--- Step 2: Add video to queue ---');
  await sw.evaluate(async (videoId) => {
    const url = 'https://www.youtube.com/watch?v=' + videoId;
    await chrome.storage.local.get('yt_videos').then(async (r) => {
      const videos = r.yt_videos || [];
      if (!videos.some(v => v.id === videoId)) {
        videos.push({
          id: videoId,
          url: url,
          title: 'Test Video',
          channel: 'Test Channel',
          thumbnail: 'https://i.ytimg.com/vi/' + videoId + '/mqdefault.jpg',
          duration: 300,
          addedAt: Date.now(),
          uploadedAt: null,
          isShort: false,
          category: 'Uncategorized',
          watched: false,
          starred: false,
          order: 0,
        });
        await chrome.storage.local.set({ yt_videos: videos });
      }
    });
  }, firstVideoId);

  // Verify it's in the queue
  const queuedIds = await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_videos');
    return (r.yt_videos || []).filter(v => !v.watched).map(v => v.id);
  });
  console.log('Queued video IDs:', queuedIds);

  // Step 3: Navigate to a video page to get recommendations in sidebar
  console.log('\n--- Step 3: Navigate to video page for recommendations ---');
  await ytPage.goto('https://www.youtube.com/watch?v=' + firstVideoId, { waitUntil: 'domcontentloaded' });
  await ytPage.waitForTimeout(6000); // Wait for recommendations + content script cycle

  // Add some recommended video IDs to the queue too — again, only ids whose
  // thumbnails the indicator pass actually decorates
  const recIds = await ytPage.evaluate((sel) => {
    const ids = [];
    for (const a of document.querySelectorAll(sel)) {
      const m = (a.getAttribute('href') || '').match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);
      if (m && !ids.includes(m[1]) && ids.length < 3) ids.push(m[1]);
    }
    return ids;
  }, THUMB_ANCHOR_SELECTOR);
  console.log('Recommended video IDs found:', recIds.length, recIds.slice(0, 3));

  // Add the first rec as queued (unwatched), second as watched
  if (recIds[0]) {
    await sw.evaluate(async (videoId) => {
      const r = await chrome.storage.local.get('yt_videos');
      const videos = r.yt_videos || [];
      if (!videos.some(v => v.id === videoId)) {
        videos.push({
          id: videoId, url: 'https://www.youtube.com/watch?v=' + videoId,
          title: 'Rec Queued', channel: 'Test', thumbnail: 'https://i.ytimg.com/vi/' + videoId + '/mqdefault.jpg',
          duration: 200, addedAt: Date.now(), uploadedAt: null, isShort: false,
          category: 'Uncategorized', watched: false, starred: false, order: 0,
        });
        await chrome.storage.local.set({ yt_videos: videos });
      }
    }, recIds[0]);
  }
  if (recIds[1]) {
    await sw.evaluate(async (videoId) => {
      const r = await chrome.storage.local.get('yt_videos');
      const videos = r.yt_videos || [];
      if (!videos.some(v => v.id === videoId)) {
        videos.push({
          id: videoId, url: 'https://www.youtube.com/watch?v=' + videoId,
          title: 'Rec Watched', channel: 'Test', thumbnail: 'https://i.ytimg.com/vi/' + videoId + '/mqdefault.jpg',
          duration: 200, addedAt: Date.now(), uploadedAt: null, isShort: false,
          category: 'Uncategorized', watched: true, starred: false, order: 0,
        });
        await chrome.storage.local.set({ yt_videos: videos });
      }
    }, recIds[1]);
  }

  const allQueued = await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_videos');
    return (r.yt_videos || []).map(v => v.id);
  });
  console.log('All queued IDs now:', allQueued);

  // Wait for the content script to refresh and apply indicators
  await ytPage.waitForTimeout(5000);

  // Step 4: Check what the content script found
  const debugInfo = await ytPage.evaluate((sel) => {
    const badges = document.querySelectorAll('.ytm-status-badge');
    const style = document.getElementById('ytm-indicator-style');

    // Check what thumbnail anchors exist (current camelCase lockup vs legacy)
    const lockupAnchors = document.querySelectorAll(
      'a.ytLockupViewModelContentImage, a.yt-lockup-view-model__content-image');
    const oldAnchors = document.querySelectorAll('a#thumbnail[href]');

    // All badge-eligible thumbnail anchors
    const allThumbAnchors = document.querySelectorAll(sel);

    const anchorDetails = [...allThumbAnchors].slice(0, 5).map(a => {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/) || href.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
      return {
        videoId: m ? m[1] : null,
        cls: a.className.substring(0, 60),
        parentPos: a.parentElement ? getComputedStyle(a.parentElement).position : 'N/A',
      };
    });

    return {
      badgeCount: badges.length,
      styleInjected: !!style,
      lockupAnchors: lockupAnchors.length,
      oldAnchors: oldAnchors.length,
      totalThumbAnchors: allThumbAnchors.length,
      anchorDetails,
    };
  }, THUMB_ANCHOR_SELECTOR);

  console.log('Debug info:', JSON.stringify(debugInfo, null, 2));

  // Take screenshot
  await ytPage.screenshot({ path: path.join(screenshotDir, 'yt-indicators.png'), fullPage: false });
  console.log('Screenshot: screenshots/yt-indicators.png');

  // Step 5: Check if badges exist
  // Check for Q and W badges separately
  const badgeDetails = await ytPage.evaluate(() => {
    const qBadges = document.querySelectorAll('.ytm-status-badge--queued');
    const wBadges = document.querySelectorAll('.ytm-status-badge--watched');
    return { queued: qBadges.length, watched: wBadges.length };
  });
  console.log('Badge breakdown — Q (queued):', badgeDetails.queued, ', W (watched):', badgeDetails.watched);

  // A watched badge is only expected when a watched rec was actually seeded
  const expectWatched = recIds.length > 1;
  const ok = badgeDetails.queued > 0 && (!expectWatched || badgeDetails.watched > 0);

  if (ok) {
    console.log('\n✔ SUCCESS: Found', debugInfo.badgeCount, 'badge(s) on thumbnails (Q:',
      badgeDetails.queued + ', W:', badgeDetails.watched + ')');
  } else {
    console.log('\n✘ FAIL: Expected Q' + (expectWatched ? ' and W' : '') +
      ' badges, got Q:', badgeDetails.queued, 'W:', badgeDetails.watched);
    console.log('  Style injected:', debugInfo.styleInjected);
    console.log('  Lockup anchors:', debugInfo.lockupAnchors);
    console.log('  Old-style anchors:', debugInfo.oldAnchors);

    // Extra debug: check if the content script is running at all
    const contentScriptRunning = await ytPage.evaluate(() => {
      return typeof window.__ytmContentScriptLoaded !== 'undefined' ||
             !!document.getElementById('ytm-indicator-style') ||
             !!document.getElementById('ytm-video-info-overlay');
    });
    console.log('  Content script evidence:', contentScriptRunning);

    // Check console for errors
    const consoleMsgs = [];
    ytPage.on('console', msg => consoleMsgs.push(msg.text()));
    await ytPage.waitForTimeout(1000);
    if (consoleMsgs.length) console.log('  Console messages:', consoleMsgs.slice(0, 5));
  }

  await context.close();
  console.log('\nDone.');
  process.exit(ok ? 0 : 1);
})();
