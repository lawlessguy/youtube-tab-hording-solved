(function () {
  'use strict';

  let audioContext = null;
  let gainNode = null;
  let accumulatedSeconds = 0;
  let trackingInterval = null;
  let hasMarkedWatched = false;
  const FLUSH_INTERVAL = 30000;

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
  }

  // --- Speed Control ---

  function setSpeed(speed) {
    const video = getVideoElement();
    if (!video) return;
    video.playbackRate = speed;
  }

  // --- Watch Progress (10% = marked watched) ---

  function checkWatchProgress(video) {
    if (hasMarkedWatched) return;
    if (!video.duration || video.duration === 0) return;
    const progress = video.currentTime / video.duration;
    if (progress >= 0.2) {
      hasMarkedWatched = true;
      const videoId = getCurrentVideoId();
      if (videoId) {
        chrome.runtime.sendMessage({ type: 'MARK_WATCHED', videoId }).catch(() => {});
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
      chrome.runtime.sendMessage({
        type: 'VIDEO_ENDED',
        videoId: videoId || undefined,
      }).catch(() => {});
    });
  }

  // --- Watch Time Tracking ---

  // --- Auto-apply stored volume/speed to new videos ---

  async function applyStoredSettings() {
    try {
      const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
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

  function startTracking() {
    if (trackingInterval) clearInterval(trackingInterval);
    trackingInterval = setInterval(() => {
      const video = getVideoElement();
      if (video && !video.paused && !video.ended) {
        accumulatedSeconds++;
        checkWatchProgress(video);
      }
    }, 1000);

    setInterval(() => { flushWatchTime(); }, FLUSH_INTERVAL);
    setupEndedListener();
    setupAutoApply();
    applyStoredSettings();
  }

  function flushWatchTime() {
    if (accumulatedSeconds < 1) return;
    const minutes = accumulatedSeconds / 60;
    chrome.runtime.sendMessage({ type: 'TRACK_WATCH_TIME', minutes }).catch(() => {});
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
      chrome.runtime.sendMessage({
        type: 'VIDEO_METADATA',
        videoId,
        duration: duration || undefined,
        title: title || undefined,
        channel: channel || undefined,
        uploadDate: uploadDate || undefined,
      }).catch(() => {});
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

      case 'YT_UI_UPDATE':
        applyYouTubeUI();
        sendResponse({ success: true });
        break;

      default:
        sendResponse({});
    }
    return true;
  });

  // --- YouTube UI Modifications ---

  async function getSettings() {
    try {
      return await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    } catch { return {}; }
  }

  async function applyYouTubeUI() {
    const settings = await getSettings();
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
        /* Hide all recommendation containers */
        ytd-watch-next-secondary-results-renderer,
        #related.ytd-watch-flexy,
        #items.ytd-watch-next-secondary-results-renderer {
          display: none !important;
        }

        /* When comments are in the sidebar, style the secondary column */
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

  // --- Initialization ---

  function init() {
    const video = getVideoElement();
    if (video) {
      startTracking();
      setTimeout(reportMetadata, 3000);
      setTimeout(applyYouTubeUI, 2000);
    } else {
      setTimeout(init, 1000);
    }
  }

  // Watch for YouTube SPA navigation
  let lastUrl = window.location.href;
  const observer = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      flushWatchTime();
      accumulatedSeconds = 0;
      hasMarkedWatched = false;
      // Reset comments position on navigation (YouTube will re-render them)
      commentsMovedToSidebar = false;
      originalCommentsParent = null;
      originalCommentsNextSibling = null;
      const sc = document.getElementById('ytm-sidebar-comments');
      if (sc) sc.remove();
      const sec = document.querySelector('.ytm-comments-sidebar');
      if (sec) sec.classList.remove('ytm-comments-sidebar');
      setTimeout(reportMetadata, 3000);
      setTimeout(setupEndedListener, 3000);
      setTimeout(setupAutoApply, 2000);
      setTimeout(applyStoredSettings, 2000);
      setTimeout(applyYouTubeUI, 3000);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  window.addEventListener('beforeunload', flushWatchTime);

  // Re-apply YouTube UI modifications periodically
  // (YouTube lazy-loads content, and theater mode can toggle)
  setInterval(async () => {
    try {
      const s = await getSettings();
      if (s.hideRecs) {
        applyHideRecs(true);
      }
    } catch {}
  }, 3000);

  init();
})();
