(function () {
  'use strict';

  let audioContext = null;
  let gainNode = null;
  let accumulatedSeconds = 0;
  let trackingInterval = null;
  let hasMarkedWatched = false;
  const FLUSH_INTERVAL = 30000;
  // Watch telemetry (stage 06) — captured during the existing 1s playback
  // tick, flushed with TRACK_WATCH_TIME. NOT reset on flush (maxPercent keeps
  // accumulating across flushes); reset only on SPA navigation/video change.
  let trackedVideoId = null, trackedUrl = null, trackedTitle = null,
      trackedChannel = null, trackedDurationSec = 0, trackedMaxPercent = 0;

  // Check if the extension context is still valid (becomes invalid after reload/update)
  function isContextValid() {
    try { return !!chrome.runtime?.id; }
    catch { return false; }
  }

  // Safe message sender — chrome.runtime.sendMessage throws synchronously
  // when the extension context is invalidated (e.g. after extension reload)
  function safeSend(data) {
    if (!isContextValid()) return Promise.resolve();
    try { return chrome.runtime.sendMessage(data).catch(() => {}); }
    catch { return Promise.resolve(); }
  }

  // --- URL Parsing ---

  function getCurrentVideoId() {
    const url = window.location.href;
    const match = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (match) return match[1];
    const shortsMatch = url.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
    if (shortsMatch) return shortsMatch[1];
    return null;
  }

  function getVideoElement() {
    return document.querySelector('video');
  }

  // --- Volume Control (Web Audio API for >100% boost) ---

  function initAudioBoost(video) {
    if (audioContext) return;
    try {
      audioContext = new AudioContext();
      const source = audioContext.createMediaElementSource(video);
      gainNode = audioContext.createGain();
      source.connect(gainNode);
      gainNode.connect(audioContext.destination);
    } catch (e) {
      console.error('[YT Tab Manager] Audio boost init failed:', e);
    }
  }

  // Once createMediaElementSource() has rerouted the video's audio, a
  // suspended AudioContext silences it completely — even at volumes <=100%.
  // resume() only succeeds after user activation, so retry opportunistically.
  function resumeAudioContext() {
    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
  }

  function setVolume(percent) {
    const video = getVideoElement();
    if (!video) return;
    if (percent > 100) {
      initAudioBoost(video);
      video.volume = 1;
      if (gainNode) gainNode.gain.value = percent / 100;
    } else {
      video.volume = percent / 100;
      if (gainNode) gainNode.gain.value = 1;
    }
    resumeAudioContext();
  }

  // --- Speed Control ---

  function setSpeed(speed) {
    const video = getVideoElement();
    if (!video) return;
    video.playbackRate = speed;
  }

  // --- Watch Progress (20% = marked watched) ---

  function checkWatchProgress(video) {
    if (hasMarkedWatched) return;
    if (!video.duration || video.duration === 0) return;
    const progress = video.currentTime / video.duration;
    if (progress >= 0.2) {
      hasMarkedWatched = true;
      const videoId = getCurrentVideoId();
      if (videoId) {
        safeSend({ type: 'MARK_WATCHED', videoId });
      }
    }
  }

  // --- Video Ended (auto-play next) ---

  function setupEndedListener() {
    const video = getVideoElement();
    if (!video || video._ytmEndedBound) return;
    video._ytmEndedBound = true;
    video.addEventListener('ended', () => {
      const videoId = getCurrentVideoId();
      safeSend({
        type: 'VIDEO_ENDED',
        videoId: videoId || undefined,
      });
    });
  }

  // --- Watch Time Tracking ---

  // --- Settings (read from storage directly — no service worker round-trip) ---

  let cachedSettings = null;

  async function getSettings() {
    if (cachedSettings) return cachedSettings;
    try {
      if (!isContextValid()) return {};
      const r = await chrome.storage.local.get('yt_settings');
      cachedSettings = r.yt_settings || {};
    } catch { return {}; }
    return cachedSettings;
  }

  // --- Auto-apply stored volume/speed to new videos ---

  async function applyStoredSettings() {
    try {
      const settings = await getSettings();
      if (!settings) return;
      if (settings.volumeLevel !== undefined && settings.volumeLevel !== 100) {
        setVolume(settings.volumeLevel);
      }
      if (settings.speedLevel !== undefined && settings.speedLevel !== 1.0) {
        setSpeed(settings.speedLevel);
      }
    } catch {}
  }

  function setupAutoApply() {
    const video = getVideoElement();
    if (!video || video._ytmAutoApplyBound) return;
    video._ytmAutoApplyBound = true;
    video.addEventListener('loadeddata', () => applyStoredSettings());
  }

  // Started once at init; the tick is a no-op without a playing video, so it
  // is safe (and cheap) to run on pages that never get one
  function startTracking() {
    if (trackingInterval) clearInterval(trackingInterval);
    trackingInterval = setInterval(() => {
      if (!isContextValid()) { clearInterval(trackingInterval); return; }
      const video = getVideoElement();
      if (video && !video.paused && !video.ended) {
        // A playing video implies user activation — recover a boost context
        // that was created before activation existed
        resumeAudioContext();
        accumulatedSeconds++;
        checkWatchProgress(video);

        // Telemetry capture (no extra loop — rides this existing tick)
        const vid = getCurrentVideoId();
        if (vid && vid !== trackedVideoId) {
          trackedVideoId = vid; trackedUrl = window.location.href;
          trackedTitle = null; trackedChannel = null;
          trackedDurationSec = 0; trackedMaxPercent = 0;
        }
        // Livestreams: duration === Infinity → isFinite guard leaves both 0
        if (vid && isFinite(video.duration) && video.duration > 0) {
          trackedDurationSec = Math.round(video.duration);
          const pct = Math.min(100, Math.round((video.currentTime / video.duration) * 100));
          if (pct > trackedMaxPercent) trackedMaxPercent = pct;
        }
        // Opportunistic title/channel scrape — no network fetches
        if (vid && (!trackedTitle || !trackedChannel)) {
          const t = document.title.replace(/\s*-\s*YouTube\s*$/, '').trim();
          if (t && t !== 'YouTube') trackedTitle = trackedTitle || t;
          const chEl = document.querySelector('#channel-name a, ytd-channel-name a, #owner #channel-name a');
          trackedChannel = trackedChannel || chEl?.textContent?.trim() || null;
        }
      }
    }, 1000);

    setInterval(() => { if (isContextValid()) flushWatchTime(); }, FLUSH_INTERVAL);
  }

  // Bind the <video>-dependent features once the element exists. Retries are
  // capped — the SPA navigation handler restarts them — so pages without a
  // video (home, subscriptions) no longer spin a retry loop forever.
  let videoBindTimer = null;

  function bindVideoFeatures(attempt = 0) {
    if (videoBindTimer) { clearTimeout(videoBindTimer); videoBindTimer = null; }
    const video = getVideoElement();
    if (!video) {
      if (attempt < 15) {
        videoBindTimer = setTimeout(() => bindVideoFeatures(attempt + 1), 1000);
      }
      return;
    }
    setupEndedListener();
    setupAutoApply();
    applyStoredSettings();
  }

  function flushWatchTime() {
    if (accumulatedSeconds < 1) return;
    const payload = { type: 'TRACK_WATCH_TIME', minutes: accumulatedSeconds / 60 };
    // Telemetry describes the video the seconds were accumulated AGAINST
    // (trackers are captured during playback ticks and the SPA nav handler
    // flushes BEFORE resetting them — never the new video)
    if (trackedVideoId) {
      payload.telemetry = {
        videoId: trackedVideoId, url: trackedUrl,
        isShort: /\/shorts\//.test(trackedUrl || ''),
        secondsWatched: accumulatedSeconds,
        maxPercent: trackedMaxPercent || null,
        durationSec: trackedDurationSec || null,
        title: trackedTitle, channel: trackedChannel,
      };
    }
    safeSend(payload);
    accumulatedSeconds = 0;
  }

  // --- Upload Date Extraction ---

  function extractUploadDate() {
    // Method 1: JSON-LD structured data (most reliable on rendered page)
    const ldJsonEls = document.querySelectorAll('script[type="application/ld+json"]');
    for (const scriptEl of ldJsonEls) {
      try {
        const data = JSON.parse(scriptEl.textContent);
        if (data.uploadDate) return data.uploadDate;
        if (data.datePublished) return data.datePublished;
        // Handle @graph arrays
        if (Array.isArray(data)) {
          for (const item of data) {
            if (item.uploadDate) return item.uploadDate;
          }
        }
      } catch {}
    }

    // Method 2: Parse from ytInitialData in script tags
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const text = s.textContent || '';
      // Match "uploadDate":"2024-01-15" or "publishDate":"2024-01-15"
      const m = text.match(/"(?:uploadDate|publishDate)"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/);
      if (m) return m[1];
    }

    // Method 3: Parse from the info section text (e.g., "Jan 15, 2024")
    const infoEls = document.querySelectorAll('#info-strings yt-formatted-string, #info span');
    for (const el of infoEls) {
      const text = el.textContent?.trim();
      // Match dates like "Jan 15, 2024" or "15 Jan 2024"
      const dateMatch = text?.match(/(\w{3,9}\s+\d{1,2},?\s+\d{4})/);
      if (dateMatch) {
        const parsed = new Date(dateMatch[1]);
        if (!isNaN(parsed.getTime())) {
          return parsed.toISOString().split('T')[0];
        }
      }
    }

    return null;
  }

  // --- Metadata Extraction ---

  function reportMetadata() {
    const videoId = getCurrentVideoId();
    if (!videoId) return;

    const video = getVideoElement();
    const duration = video && isFinite(video.duration) ? Math.round(video.duration) : 0;

    const titleEl = document.querySelector(
      'h1.ytd-watch-metadata yt-formatted-string, ' +
      'h1.title yt-formatted-string, ' +
      '#title h1 yt-formatted-string'
    );
    const title = titleEl?.textContent?.trim();

    const channelEl = document.querySelector(
      '#channel-name a, ytd-channel-name a, #owner #channel-name a'
    );
    const channel = channelEl?.textContent?.trim();

    const uploadDate = extractUploadDate();

    if (duration || title || channel || uploadDate) {
      safeSend({
        type: 'VIDEO_METADATA',
        videoId,
        duration: duration || undefined,
        title: title || undefined,
        channel: channel || undefined,
        uploadDate: uploadDate || undefined,
      });
    }
  }

  // --- Message Listener ---

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const video = getVideoElement();

    switch (message.type) {
      case 'SET_VOLUME':
        setVolume(message.value);
        sendResponse({ success: true });
        break;

      case 'SET_SPEED':
        setSpeed(message.value);
        sendResponse({ success: true });
        break;

      case 'GET_MEDIA_STATE':
        sendResponse({
          paused: video ? video.paused : true,
          currentTime: video ? video.currentTime : 0,
          duration: video && isFinite(video.duration) ? video.duration : 0,
          videoId: getCurrentVideoId(),
        });
        break;

      case 'MEDIA_COMMAND':
        if (!video) { sendResponse({ success: false }); break; }
        switch (message.action) {
          case 'playPause':
            video.paused ? video.play() : video.pause();
            break;
          case 'restart':
            video.currentTime = 0;
            video.play();
            break;
          case 'forward':
            video.currentTime = Math.min(video.currentTime + 10, video.duration || Infinity);
            break;
          case 'rewind':
            video.currentTime = Math.max(video.currentTime - 10, 0);
            break;
        }
        sendResponse({ success: true, paused: video.paused });
        break;

      default:
        sendResponse({});
    }
    return true;
  });

  // --- YouTube UI Modifications ---

  async function applyYouTubeUI() {
    const settings = await getSettings() || {};
    applyVideoInfoOverlay(settings.showVideoInfo);
    applyHideRecs(settings.hideRecs);
  }

  function applyVideoInfoOverlay(enabled) {
    const existing = document.getElementById('ytm-video-info-overlay');
    if (!enabled) {
      if (existing) existing.remove();
      return;
    }

    // Find the actions bar (like, share, etc.)
    const actionsBar = document.querySelector('#actions.ytd-watch-metadata, #top-level-buttons-computed');
    if (!actionsBar) return;

    // Extract view count
    const viewEl = document.querySelector(
      '#info-text .view-count, ' +
      'ytd-video-primary-info-renderer .view-count, ' +
      '#info-strings yt-formatted-string'
    );
    const viewText = viewEl?.textContent?.trim() || '';

    // Extract upload date from structured data or info section
    let dateText = '';
    const uploadDate = extractUploadDate();
    if (uploadDate) {
      const d = new Date(uploadDate);
      if (!isNaN(d.getTime())) {
        const now = new Date();
        const diffDays = Math.floor((now - d) / (1000 * 60 * 60 * 24));
        if (diffDays === 0) dateText = 'Today';
        else if (diffDays === 1) dateText = 'Yesterday';
        else if (diffDays < 30) dateText = diffDays + ' days ago';
        else if (diffDays < 365) dateText = Math.floor(diffDays / 30) + ' months ago';
        else dateText = Math.floor(diffDays / 365) + ' years ago';
        dateText += ' (' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ')';
      }
    }

    if (!viewText && !dateText) return;

    // Create or update overlay
    let overlay = document.getElementById('ytm-video-info-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'ytm-video-info-overlay';
      overlay.style.cssText = 'display:flex;gap:12px;align-items:center;padding:4px 0 6px;font-size:13px;color:#aaa;font-family:Roboto,Arial,sans-serif;';
      // Insert above the actions bar
      const container = actionsBar.closest('#above-the-fold, #top-row, ytd-watch-metadata');
      if (container) {
        actionsBar.parentElement.insertBefore(overlay, actionsBar);
      }
    }

    overlay.textContent = '';
    if (viewText) {
      const viewSpan = document.createElement('span');
      viewSpan.textContent = viewText;
      overlay.appendChild(viewSpan);
    }
    if (viewText && dateText) {
      const dot = document.createElement('span');
      dot.textContent = '\u00B7';
      dot.style.color = '#555';
      overlay.appendChild(dot);
    }
    if (dateText) {
      const dateSpan = document.createElement('span');
      dateSpan.textContent = dateText;
      overlay.appendChild(dateSpan);
    }
  }

  // --- Hide Recommendations & Move Comments to Sidebar ---

  const YTM_STYLE_ID = 'ytm-hide-recs-style';
  let commentsMovedToSidebar = false;
  let originalCommentsParent = null;
  let originalCommentsNextSibling = null;

  function applyHideRecs(enabled) {
    if (!enabled) {
      restoreLayout();
      return;
    }

    // Inject CSS to hide recommendations and adjust layout
    if (!document.getElementById(YTM_STYLE_ID)) {
      const style = document.createElement('style');
      style.id = YTM_STYLE_ID;
      style.textContent = `
        /* Hide the entire secondary column (recommendations sidebar) */
        #secondary.ytd-watch-flexy:not(.ytm-comments-sidebar) {
          display: none !important;
        }

        /* Hide recommendation items even when comments are in sidebar */
        ytd-watch-next-secondary-results-renderer,
        #items.ytd-watch-next-secondary-results-renderer {
          display: none !important;
        }

        /* Expand the primary content to fill the full width */
        ytd-watch-flexy:not([theater]):not([fullscreen]) #primary.ytd-watch-flexy {
          max-width: 100% !important;
          flex: 1 1 100% !important;
        }

        ytd-watch-flexy:not([theater]):not([fullscreen]) #primary-inner.ytd-watch-flexy {
          max-width: 100% !important;
        }

        /* Let the video player expand */
        ytd-watch-flexy:not([theater]):not([fullscreen]) #player-container-outer {
          max-width: 100% !important;
        }

        /* Expand the below-player content (title, actions, description, comments) */
        ytd-watch-flexy:not([theater]):not([fullscreen]) #below.ytd-watch-flexy {
          max-width: 100% !important;
        }

        ytd-watch-flexy:not([theater]):not([fullscreen]) ytd-watch-metadata {
          max-width: 100% !important;
        }

        /* Remove the columns flex container min-width constraint */
        ytd-watch-flexy:not([theater]):not([fullscreen]) #columns.ytd-watch-flexy {
          max-width: 100% !important;
        }

        /* When comments are in the sidebar, show the secondary column */
        #secondary.ytd-watch-flexy.ytm-comments-sidebar {
          display: block !important;
        }

        #secondary.ytd-watch-flexy.ytm-comments-sidebar #ytm-sidebar-comments {
          padding: 0 8px;
        }

        /* Make the comments section fit the sidebar width */
        #ytm-sidebar-comments ytd-comments#comments {
          max-width: 100%;
        }

        #ytm-sidebar-comments ytd-comments#comments #header,
        #ytm-sidebar-comments ytd-comments#comments #contents {
          max-width: 100%;
        }

        /* Hide the original comments placeholder when moved */
        #below.ytd-watch-flexy ytd-comments#comments.ytm-moved {
          display: none !important;
        }
      `;
      document.head.appendChild(style);
    }

    moveCommentsToSidebar();
  }

  function moveCommentsToSidebar() {
    if (commentsMovedToSidebar) return;

    // Check if in theater mode — don't move comments in theater mode
    const isTheater = document.querySelector('ytd-watch-flexy[theater]') !== null;
    if (isTheater) return;

    const comments = document.querySelector('ytd-comments#comments');
    const secondary = document.querySelector('#secondary.ytd-watch-flexy, #secondary-inner');
    if (!comments || !secondary) return;

    // Save original position for restoration
    originalCommentsParent = comments.parentElement;
    originalCommentsNextSibling = comments.nextSibling;

    // Create container in sidebar
    let sidebarComments = document.getElementById('ytm-sidebar-comments');
    if (!sidebarComments) {
      sidebarComments = document.createElement('div');
      sidebarComments.id = 'ytm-sidebar-comments';
      secondary.appendChild(sidebarComments);
    }

    // Move comments
    comments.classList.add('ytm-moved');
    sidebarComments.appendChild(comments);
    secondary.classList.add('ytm-comments-sidebar');
    commentsMovedToSidebar = true;
  }

  function restoreLayout() {
    // Remove injected style
    const style = document.getElementById(YTM_STYLE_ID);
    if (style) style.remove();

    // Move comments back to original position
    if (commentsMovedToSidebar && originalCommentsParent) {
      const comments = document.querySelector('ytd-comments#comments.ytm-moved');
      if (comments) {
        comments.classList.remove('ytm-moved');
        if (originalCommentsNextSibling) {
          originalCommentsParent.insertBefore(comments, originalCommentsNextSibling);
        } else {
          originalCommentsParent.appendChild(comments);
        }
      }
    }

    // Clean up sidebar container
    const sidebarComments = document.getElementById('ytm-sidebar-comments');
    if (sidebarComments) sidebarComments.remove();

    const secondary = document.querySelector('#secondary.ytd-watch-flexy.ytm-comments-sidebar');
    if (secondary) secondary.classList.remove('ytm-comments-sidebar');

    commentsMovedToSidebar = false;
    originalCommentsParent = null;
    originalCommentsNextSibling = null;
  }

  // --- Thumbnail Indicators (show which videos are in the queue) ---

  const YTM_INDICATOR_STYLE_ID = 'ytm-indicator-style';
  let knownQueuedIds = new Set();
  let knownWatchedIds = new Set();

  function injectIndicatorStyles() {
    if (document.getElementById(YTM_INDICATOR_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = YTM_INDICATOR_STYLE_ID;
    style.textContent = `
      .ytm-status-badge {
        position: absolute !important;
        top: 4px !important;
        left: 4px !important;
        width: 18px !important;
        height: 18px !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        color: #fff !important;
        font-size: 11px !important;
        font-weight: 700 !important;
        border-radius: 3px !important;
        z-index: 2000 !important;
        pointer-events: none !important;
        font-family: Roboto, Arial, sans-serif !important;
        line-height: 1 !important;
      }
      .ytm-status-badge--queued {
        background: rgba(255, 0, 0, 0.9) !important;
      }
      .ytm-status-badge--watched {
        background: rgba(43, 166, 64, 0.9) !important;
      }
    `;
    document.head.appendChild(style);
  }

  function setQueuedIdsFrom(videos) {
    knownQueuedIds = new Set(videos.filter(v => !v.watched).map(v => v.id));
    knownWatchedIds = new Set(videos.filter(v => v.watched).map(v => v.id));
  }

  async function refreshQueuedIds() {
    try {
      if (!isContextValid()) return;
      const r = await chrome.storage.local.get('yt_videos');
      setQueuedIdsFrom(r.yt_videos || []);
    } catch {}
  }

  function extractVideoIdFromHref(href) {
    if (!href || href === '#') return null;
    const m = href.match(/\/watch\?v=([a-zA-Z0-9_-]{11})/) || href.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  function applyThumbnailIndicators() {
    // Find all video thumbnail anchors — supports old, new, and shorts-shelf
    // YouTube layouts. Class-substring matching here is DOM targeting against
    // YouTube's own markup, not URL validation — videoIds still come only
    // from extractVideoIdFromHref.
    const anchors = document.querySelectorAll(
      'a.yt-lockup-view-model__content-image, ' + // lockup layout (2024)
      'a.ytLockupViewModelContentImage, '       + // lockup layout (2026, camelCase rename)
      'a#thumbnail[href], '                       + // old layout
      'a[class*="shortsLockup"][href]'              // shorts shelves (2025 layout)
    );
    for (const link of anchors) {
      const videoId = extractVideoIdFromHref(link.getAttribute('href'));
      if (!videoId) continue;

      // Find the best positioned parent for badge placement
      let container = link;
      let el = link.parentElement;
      for (let i = 0; i < 4 && el; i++) {
        if (getComputedStyle(el).position !== 'static') { container = el; break; }
        el = el.parentElement;
      }

      const existing = container.querySelector('.ytm-status-badge');
      const isQueued = knownQueuedIds.has(videoId);
      const isWatched = knownWatchedIds.has(videoId);

      if (isQueued || isWatched) {
        const wantClass = isQueued ? 'ytm-status-badge--queued' : 'ytm-status-badge--watched';
        const wantText = isQueued ? 'Q' : 'W';
        const wantTitle = isQueued
          ? 'In queue (YouTube Tab Manager)'
          : 'Watched (YouTube Tab Manager)';
        if (existing) {
          // Update if state changed (e.g. queued → watched)
          if (!existing.classList.contains(wantClass)) {
            existing.className = 'ytm-status-badge ' + wantClass;
            existing.textContent = wantText;
            existing.title = wantTitle;
          }
        } else {
          const badge = document.createElement('span');
          badge.className = 'ytm-status-badge ' + wantClass;
          badge.textContent = wantText;
          badge.title = wantTitle;
          container.appendChild(badge);
        }
      } else {
        if (existing) existing.remove();
      }
    }
  }

  // --- Ctrl+Middle-Click Detection (star tag) ---

  document.addEventListener('auxclick', (e) => {
    if (e.button !== 1 || !e.ctrlKey) return;
    const link = e.target.closest('a[href]');
    if (!link) return;
    const videoId = extractVideoIdFromHref(link.getAttribute('href'));
    if (!videoId) return;
    const href = link.getAttribute('href');
    const fullUrl = href.startsWith('http') ? href : 'https://www.youtube.com' + href;
    safeSend({ type: 'TAG_STARRED', videoId, url: fullUrl });
  }, true);

  // --- Event-driven refresh (replaces the old polling loops) ---

  // Throttled, mutation-driven indicator/UI refresh: runs at most once per
  // 1.5s and only while the page is actually mutating (lazy-loaded
  // thumbnails, re-rendered sidebars). Idle pages cost nothing.
  let indicatorRefreshPending = false;
  function scheduleIndicatorRefresh() {
    if (indicatorRefreshPending) return;
    indicatorRefreshPending = true;
    setTimeout(() => {
      indicatorRefreshPending = false;
      if (!isContextValid()) return;
      applyThumbnailIndicators();
      if (cachedSettings?.hideRecs) applyHideRecs(true);
    }, 1500);
  }

  // Queue/settings changes arrive via storage.onChanged instead of polling
  // the service worker — no messages, and the worker can stay asleep
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.yt_videos) {
        setQueuedIdsFrom(changes.yt_videos.newValue || []);
        scheduleIndicatorRefresh();
      }
      if (changes.yt_settings) {
        cachedSettings = changes.yt_settings.newValue || {};
        applyYouTubeUI();
      }
    });
  } catch {}

  // --- Initialization ---

  function init() {
    injectIndicatorStyles();
    refreshQueuedIds().then(applyThumbnailIndicators);
    startTracking();
    bindVideoFeatures();
    setTimeout(reportMetadata, 3000);
    setTimeout(applyYouTubeUI, 2000);
  }

  // Watch for YouTube SPA navigation
  let lastUrl = window.location.href;
  const observer = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      flushWatchTime();
      accumulatedSeconds = 0;
      hasMarkedWatched = false;
      // Telemetry trackers reset AFTER the flush above sent the old video's
      // numbers — the next tick re-captures for the new video
      trackedVideoId = null; trackedUrl = null; trackedTitle = null;
      trackedChannel = null; trackedDurationSec = 0; trackedMaxPercent = 0;
      // Reset comments position on navigation (YouTube will re-render them)
      commentsMovedToSidebar = false;
      originalCommentsParent = null;
      originalCommentsNextSibling = null;
      const sc = document.getElementById('ytm-sidebar-comments');
      if (sc) sc.remove();
      const sec = document.querySelector('.ytm-comments-sidebar');
      if (sec) sec.classList.remove('ytm-comments-sidebar');
      setTimeout(reportMetadata, 3000);
      setTimeout(applyYouTubeUI, 3000);
      bindVideoFeatures();
    }
    scheduleIndicatorRefresh();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // beforeunload is unreliable in MV3 — pagehide catches the cases it misses
  // (flushing twice is safe: the accumulator resets on flush)
  window.addEventListener('beforeunload', flushWatchTime);
  window.addEventListener('pagehide', flushWatchTime);

  init();
})();
