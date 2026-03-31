/**
 * Test: YouTube thumbnail QUEUED indicators
 * Loads extension, adds a video to queue, then checks if badges appear on YouTube.
 */
const { chromium } = require('playwright');
const path = require('path');

const extensionPath = path.resolve(__dirname, '..');
const screenshotDir = path.join(extensionPath, 'screenshots');

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

  // Find the first video link — try multiple selectors for different YT layouts
  let firstVideoId = await ytPage.evaluate(() => {
    // New layout
    let link = document.querySelector('a.yt-lockup-view-model__content-image[href*="/watch"]');
    if (link) {
      const m = link.getAttribute('href').match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);
      if (m) return m[1];
    }
    // Old layout
    link = document.querySelector('a#thumbnail[href*="/watch"]');
    if (link) {
      const m = link.getAttribute('href').match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);
      if (m) return m[1];
    }
    // Any anchor with /watch
    link = document.querySelector('a[href*="/watch?v="]');
    if (link) {
      const m = link.getAttribute('href').match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);
      if (m) return m[1];
    }
    return null;
  });

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

  // Add some recommended video IDs to the queue too
  const recIds = await ytPage.evaluate(() => {
    const anchors = document.querySelectorAll(
      'a.yt-lockup-view-model__content-image[href*="/watch"], ' +
      'a#thumbnail[href*="/watch"], ' +
      'a[href*="/watch?v="]'
    );
    const ids = [];
    for (const a of anchors) {
      const m = (a.getAttribute('href') || '').match(/\/watch\?v=([a-zA-Z0-9_-]{11})/);
      if (m && ids.length < 3) ids.push(m[1]);
    }
    return ids;
  });
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
  const debugInfo = await ytPage.evaluate(() => {
    const badges = document.querySelectorAll('.ytm-status-badge');
    const style = document.getElementById('ytm-indicator-style');

    // Check what thumbnail anchors exist
    const lockupAnchors = document.querySelectorAll('a.yt-lockup-view-model__content-image');
    const oldAnchors = document.querySelectorAll('a#thumbnail[href]');

    // Check all anchors with watch/shorts hrefs that have images
    const allThumbAnchors = document.querySelectorAll(
      'a.yt-lockup-view-model__content-image, a#thumbnail[href]'
    );

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
  });

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

  if (debugInfo.badgeCount > 0) {
    console.log('\n✔ SUCCESS: Found', debugInfo.badgeCount, 'badge(s) on thumbnails');
  } else {
    console.log('\n✘ FAIL: No badges found');
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
})();
