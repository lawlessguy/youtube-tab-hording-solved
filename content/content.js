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
  // Speed sync (stage 02): lastAppliedRate suppresses our own SET_SPEED
  // echoes; rate-sync only arms 500ms after the first 'playing' of each video
  // (YouTube applies its own remembered session speed during load, which must
  // not be reported as user intent). Reset on SPA video change.
  let lastAppliedRate = null;
  let rateSyncArmedAt = 0;
  let rateReportTimer = null;
  // Timeline seek history (stage 02) — in-memory per-video undo/redo stacks,
  // deliberately not persisted (cleared on video change)
  const SEEK_MIN_JUMP = 3;       // seconds — below this a seek isn't recorded
  const SEEK_COALESCE_MS = 800;  // quiet period that ends a scrub burst
  const SEEK_STACK_MAX = 50;
  let seekUndo = [];
  let seekRedo = [];
  let seekPrevTime = null;       // last known position while NOT seeking
  let seekOrigin = null;         // pre-seek position of the current burst
  let seekFinalizeTimer = null;
  let suppressSeekRecording = false; // our own undo/redo seeks aren't recorded
  let seekHistoryVideoId = null;

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
    lastAppliedRate = speed; // recorded BEFORE assigning: the ratechange this
    video.playbackRate = speed; // triggers must never be re-reported as native
  }

  // --- Speed Sync (native YouTube speed menu → yt_settings.speedLevel) ---

  function bindRateSync(video) {
    if (video._ytmRateBound) return;
    video._ytmRateBound = true;
    video.addEventListener('playing', () => {
      if (!rateSyncArmedAt) rateSyncArmedAt = Date.now() + 500;
    });
    video.addEventListener('ratechange', () => {
      if (!rateSyncArmedAt || Date.now() < rateSyncArmedAt) return; // load-time machine changes
      if (document.querySelector('.html5-video-player.ad-showing')) return; // ads run at their own rate
      if (lastAppliedRate !== null && Math.abs(video.playbackRate - lastAppliedRate) < 0.001) return; // our own SET_SPEED echo
      if (rateReportTimer) clearTimeout(rateReportTimer);
      rateReportTimer = setTimeout(() => {
        rateReportTimer = null;
        const v = getVideoElement();
        if (!v) return;
        if (document.querySelector('.html5-video-player.ad-showing')) return;
        lastAppliedRate = v.playbackRate; // repeated identical events stay quiet
        safeSend({ type: 'SPEED_CHANGED', value: v.playbackRate });
      }, 250);
    });
  }

  // --- Timeline Seek History (Ctrl-Z / Ctrl-Shift-Z / Ctrl-Y) ---

  function bindSeekHistory(video) {
    if (video._ytmSeekBound) return;
    video._ytmSeekBound = true;
    // timeupdate fires ~4Hz — cheap enough to track the pre-seek position
    // continuously without extra throttling
    video.addEventListener('timeupdate', () => {
      if (window.location.pathname !== '/watch') return;
      if (!video.seeking && !suppressSeekRecording) seekPrevTime = video.currentTime;
    });
    video.addEventListener('seeking', () => {
      if (window.location.pathname !== '/watch') return;
      if (suppressSeekRecording) return;
      // First seek of a burst captures the origin; scrub bursts keep it
      if (seekOrigin === null) seekOrigin = seekPrevTime !== null ? seekPrevTime : 0;
    });
    video.addEventListener('seeked', () => {
      if (window.location.pathname !== '/watch') return;
      if (suppressSeekRecording) { suppressSeekRecording = false; return; }
      if (seekFinalizeTimer) clearTimeout(seekFinalizeTimer);
      seekFinalizeTimer = setTimeout(finalizeSeek, SEEK_COALESCE_MS);
    });
  }

  function finalizeSeek() {
    seekFinalizeTimer = null;
    const v = getVideoElement();
    if (seekOrigin !== null && v && Math.abs(v.currentTime - seekOrigin) >= SEEK_MIN_JUMP) {
      seekUndo.push(seekOrigin);
      if (seekUndo.length > SEEK_STACK_MAX) seekUndo.splice(0, seekUndo.length - SEEK_STACK_MAX);
      seekRedo.length = 0; // a new user seek invalidates the redo branch
    }
    seekOrigin = null;
  }

  function resetSeekHistory(videoId) {
    seekUndo = [];
    seekRedo = [];
    seekOrigin = null;
    seekPrevTime = null;
    suppressSeekRecording = false;
    if (seekFinalizeTimer) { clearTimeout(seekFinalizeTimer); seekFinalizeTimer = null; }
    seekHistoryVideoId = videoId !== undefined ? videoId : null;
  }

  let seekToastTimer = null;
  function showSeekToast(seconds, isRedo) {
    const s = Math.max(0, Math.floor(seconds));
    const label = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    const host = document.getElementById('movie_player') || document.body;
    let toast = document.getElementById('ytm-seek-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'ytm-seek-toast';
      toast.style.cssText = 'position:absolute;top:12px;left:12px;' +
        'background:rgba(0,0,0,0.75);color:#fff;font-size:13px;padding:4px 10px;' +
        'border-radius:4px;z-index:9999;pointer-events:none;' +
        'font-family:Roboto,Arial,sans-serif;';
    }
    if (toast.parentElement !== host) host.appendChild(toast);
    toast.textContent = (isRedo ? '↷' : '↶') + ' ' + label; // textContent only
    toast.style.display = '';
    if (seekToastTimer) clearTimeout(seekToastTimer);
    seekToastTimer = setTimeout(() => { toast.style.display = 'none'; }, 900);
  }

  // Capture phase beats YouTube's own key handlers; the editable guard
  // preserves text undo in the comment box / search field, and empty stacks
  // pass the key through untouched.
  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    const k = (e.key || '').toLowerCase();
    if (k !== 'z' && k !== 'y') return;
    if (window.location.pathname !== '/watch') return;
    if (e.target && e.target.closest &&
        e.target.closest('input, textarea, select, [contenteditable], #contenteditable-root')) return;
    const video = getVideoElement();
    if (!video) return;
    const redo = k === 'y' || (k === 'z' && e.shiftKey);
    const stack = redo ? seekRedo : seekUndo;
    if (!stack.length) return; // empty: let the key fall through
    e.preventDefault();
    e.stopPropagation();
    const target = stack.pop();
    (redo ? seekUndo : seekRedo).push(video.currentTime);
    suppressSeekRecording = true;
    video.currentTime = target;
    showSeekToast(target, redo);
  }, true);

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
    bindRateSync(video);
    bindSeekHistory(video);
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
    // AFTER applyHideRecs: the resize style must follow the hideRecs style in
    // <head> so its doubled-id selectors win (contract ruling 8)
    applyPlayerSize();
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

  // --- Resizable Player (stage 02) ---
  // Drag handles on the watch-page player; sizes persist per-mode in
  // yt_settings (playerSizeDefault / playerSizeTheater). The size CSS uses
  // doubled-id selectors + last-in-head ordering so it deterministically
  // beats the hideRecs full-width rules (contract ruling 8).

  const RESIZE_MIN_W = 480;
  const RESIZE_MIN_H = 270;
  let resizeFlexyObserver = null;
  let resizeHandleTimer = null;
  let resizeOverride = null; // in-flight drag size — beats stored settings
  let resizeDrag = null;

  function getPlayerMode() {
    if (document.fullscreenElement ||
        document.querySelector('ytd-watch-flexy[fullscreen]')) return 'fullscreen';
    if (document.querySelector('ytd-watch-flexy[theater]')) return 'theater';
    return 'default';
  }

  function getResizeContainer(mode) {
    if (mode === 'theater') return document.querySelector('#full-bleed-container');
    return document.querySelector('#player-container.ytd-watch-flexy, #player-container');
  }

  function buildResizeCss() {
    const s = cachedSettings || {};
    let def = s.playerSizeDefault || null;
    let the = s.playerSizeTheater || null;
    if (resizeOverride) {
      if (resizeOverride.mode === 'theater') the = { h: resizeOverride.h };
      else def = { w: resizeOverride.w, h: resizeOverride.h };
    }
    // Clamp to the CURRENT viewport at apply time, never persisting the
    // clamp — a stored size from a bigger monitor must come back intact
    const maxW = Math.max(RESIZE_MIN_W, window.innerWidth - 24);
    const maxH = Math.max(RESIZE_MIN_H, window.innerHeight - 120);
    const rules = [];
    if (def && def.w != null) {
      const w = Math.round(Math.min(Math.max(def.w, RESIZE_MIN_W), maxW));
      rules.push('ytd-watch-flexy:not([theater]):not([fullscreen]) #player-container-outer#player-container-outer{max-width:' + w + 'px !important;}');
    }
    if (def && def.h != null) {
      const h = Math.round(Math.min(Math.max(def.h, RESIZE_MIN_H), maxH));
      rules.push('ytd-watch-flexy:not([theater]):not([fullscreen]) #player-container-inner#player-container-inner{height:' + h + 'px !important;padding-top:0 !important;}');
    }
    if (the && the.h != null) {
      const h = Math.round(Math.min(Math.max(the.h, RESIZE_MIN_H), maxH));
      rules.push('ytd-watch-flexy[theater]:not([fullscreen]) #full-bleed-container#full-bleed-container{height:' + h + 'px !important;max-height:none !important;min-height:0 !important;}');
    }
    return rules.join('\n');
  }

  function writeResizeStyle() {
    const css = buildResizeCss();
    let styleEl = document.getElementById('ytm-resize-style');
    if (!css) {
      if (styleEl) {
        styleEl.remove();
        window.dispatchEvent(new Event('resize')); // YouTube re-fits the video
      }
      return;
    }
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'ytm-resize-style';
    }
    const changed = styleEl.textContent !== css;
    if (changed) styleEl.textContent = css;
    // Re-append on every write so the element stays AFTER the hideRecs style
    const moved = styleEl.parentNode !== document.head ||
      document.head.lastElementChild !== styleEl;
    if (moved) document.head.appendChild(styleEl);
    if (changed || moved) window.dispatchEvent(new Event('resize'));
  }

  function removeResizeArtifacts() {
    if (resizeHandleTimer) { clearTimeout(resizeHandleTimer); resizeHandleTimer = null; }
    const handles = document.getElementById('ytm-resize-handles');
    if (handles) handles.remove();
    const styleEl = document.getElementById('ytm-resize-style');
    if (styleEl) {
      styleEl.remove();
      window.dispatchEvent(new Event('resize'));
    }
    // #ytm-resize-ui-style stays — it is inert without handles
  }

  function injectResizeUiStyle() {
    if (document.getElementById('ytm-resize-ui-style')) return;
    const style = document.createElement('style');
    style.id = 'ytm-resize-ui-style';
    style.textContent = `
      #ytm-resize-handles {
        position: absolute; inset: 0;
        pointer-events: none; z-index: 78;
      }
      .ytm-resize-handle {
        position: absolute; pointer-events: auto;
      }
      .ytm-resize-handle--e { top: 0; bottom: 0; right: -8px; width: 8px; cursor: ew-resize; }
      .ytm-resize-handle--s { left: 0; right: 0; bottom: -8px; height: 8px; cursor: ns-resize; }
      .ytm-resize-handle--se { right: -8px; bottom: -8px; width: 14px; height: 14px; cursor: nwse-resize; }
      .ytm-resize-handle:hover,
      #ytm-resize-handles.ytm-resizing .ytm-resize-handle {
        background: rgba(255, 0, 0, 0.35); border-radius: 3px;
      }
    `;
    document.head.appendChild(style);
  }

  // Theater/fullscreen flips arrive as attribute changes on ytd-watch-flexy
  // (event-driven — no polling). Re-attached after SPA navigation.
  function ensureFlexyObserver() {
    if (resizeFlexyObserver) return;
    const flexy = document.querySelector('ytd-watch-flexy');
    if (!flexy) return;
    resizeFlexyObserver = new MutationObserver(() => applyPlayerSize());
    resizeFlexyObserver.observe(flexy, {
      attributes: true, attributeFilter: ['theater', 'fullscreen', 'role'],
    });
  }

  document.addEventListener('fullscreenchange', () => applyPlayerSize());

  // Single entry point — called from applyYouTubeUI (init/SPA/onChanged), the
  // flexy attribute observer, and fullscreenchange.
  function applyPlayerSize(attempt = 0) {
    if (resizeHandleTimer) { clearTimeout(resizeHandleTimer); resizeHandleTimer = null; }
    const mode = getPlayerMode();
    if (window.location.pathname !== '/watch' ||
        (cachedSettings && cachedSettings.playerResizeEnabled === false) ||
        mode === 'fullscreen') {
      removeResizeArtifacts();
      return;
    }
    writeResizeStyle();
    ensureFlexyObserver();
    const container = getResizeContainer(mode);
    if (!container) {
      // Capped retries like bindVideoFeatures; SPA navigation restarts them
      if (attempt < 15) {
        resizeHandleTimer = setTimeout(() => applyPlayerSize(attempt + 1), 1000);
      }
      return;
    }
    buildResizeHandles(container, mode);
  }

  function buildResizeHandles(container, mode) {
    injectResizeUiStyle();
    let overlay = document.getElementById('ytm-resize-handles');
    if (overlay && overlay.parentElement === container && overlay.dataset.mode === mode) return;
    if (overlay) overlay.remove();
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }
    overlay = document.createElement('div');
    overlay.id = 'ytm-resize-handles';
    overlay.dataset.mode = mode;
    // Theater is full-bleed width by design: bottom (height) handle only
    const kinds = mode === 'theater' ? ['s'] : ['e', 's', 'se'];
    for (const kind of kinds) {
      const h = document.createElement('div');
      h.className = 'ytm-resize-handle ytm-resize-handle--' + kind;
      h.addEventListener('pointerdown', e => startResizeDrag(e, h, kind, mode, container));
      h.addEventListener('dblclick', e => {
        e.preventDefault();
        e.stopPropagation();
        resetPlayerSize(mode);
      });
      overlay.appendChild(h);
    }
    container.appendChild(overlay);
  }

  function startResizeDrag(e, handleEl, kind, mode, container) {
    if (e.button !== 0 || resizeDrag) return;
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const stored = (mode === 'theater'
      ? cachedSettings?.playerSizeTheater : cachedSettings?.playerSizeDefault) || null;
    const drag = {
      kind, mode,
      startX: e.clientX, startY: e.clientY,
      startW: rect.width, startH: rect.height,
      w: stored && stored.w != null ? stored.w : null,
      h: stored && stored.h != null ? stored.h : null,
      raf: 0, moved: false,
    };
    resizeDrag = drag;
    try { handleEl.setPointerCapture(e.pointerId); } catch {}
    const overlay = document.getElementById('ytm-resize-handles');
    if (overlay) overlay.classList.add('ytm-resizing');

    const onMove = ev => {
      if (resizeDrag !== drag) return;
      const maxW = Math.max(RESIZE_MIN_W, window.innerWidth - 24);
      const maxH = Math.max(RESIZE_MIN_H, window.innerHeight - 120);
      if (mode !== 'theater' && (kind === 'e' || kind === 'se')) {
        drag.w = Math.round(Math.min(maxW, Math.max(RESIZE_MIN_W, drag.startW + (ev.clientX - drag.startX))));
      }
      if (kind === 's' || kind === 'se') {
        drag.h = Math.round(Math.min(maxH, Math.max(RESIZE_MIN_H, drag.startH + (ev.clientY - drag.startY))));
      }
      drag.moved = true;
      resizeOverride = mode === 'theater' ? { mode, h: drag.h } : { mode, w: drag.w, h: drag.h };
      if (!drag.raf) {
        drag.raf = requestAnimationFrame(() => { // one write + resize per frame max
          drag.raf = 0;
          writeResizeStyle();
        });
      }
    };
    const onUp = () => {
      handleEl.removeEventListener('pointermove', onMove);
      handleEl.removeEventListener('pointerup', onUp);
      handleEl.removeEventListener('pointercancel', onUp);
      if (overlay) overlay.classList.remove('ytm-resizing');
      if (drag.raf) { cancelAnimationFrame(drag.raf); drag.raf = 0; }
      resizeOverride = null;
      resizeDrag = null;
      if (!drag.moved) { writeResizeStyle(); return; }
      // Persist ONCE on pointerup. Optimistic local cache keeps the style in
      // place until the storage echo re-applies the identical CSS (harmless).
      const key = mode === 'theater' ? 'playerSizeTheater' : 'playerSizeDefault';
      const value = mode === 'theater' ? { h: drag.h } : { w: drag.w, h: drag.h };
      cachedSettings = { ...(cachedSettings || {}), [key]: value };
      writeResizeStyle();
      safeSend({ type: 'UPDATE_SETTINGS', settings: { [key]: value } });
    };
    handleEl.addEventListener('pointermove', onMove);
    handleEl.addEventListener('pointerup', onUp);
    handleEl.addEventListener('pointercancel', onUp);
  }

  // Double-click any handle: restore YouTube's native sizing for this mode
  // (the stored size for the OTHER mode is untouched)
  function resetPlayerSize(mode) {
    const key = mode === 'theater' ? 'playerSizeTheater' : 'playerSizeDefault';
    cachedSettings = { ...(cachedSettings || {}), [key]: null };
    writeResizeStyle(); // instant feedback; the storage echo is idempotent
    safeSend({ type: 'UPDATE_SETTINGS', settings: { [key]: null } });
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

  // --- In-Page Queue Strip (stage 01 viewing-modes) ---
  // A horizontal strip of queue thumbnails injected into the YouTube masthead
  // (between #center and #end). Contract ruling 2: the strip shows the ACTIVE
  // session only — it reads yt_sessions + yt_videos straight from storage
  // (content scripts do not receive the worker's VIDEOS_UPDATED runtime
  // broadcast) and re-renders on storage.onChanged of EITHER key.

  const YTM_IPQ_STYLE_ID = 'ytm-inpage-queue-style';
  const IPQ_MAX_TILES = 30; // hard cap + "+N" overflow pill — no virtualization
  let lastKnownVideos = [];
  let ipqActiveSessionId = 'main';

  function injectInPageQueueStyles() {
    if (document.getElementById(YTM_IPQ_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = YTM_IPQ_STYLE_ID;
    // Theme-neutral: tiles are images with dark translucent overlays — no
    // background on the container, so light and dark YouTube both work
    style.textContent = `
      #ytm-inpage-queue {
        display: flex; align-items: center; gap: 4px;
        flex: 1 1 0; min-width: 0; max-width: 40vw;
        margin: 0 8px; overflow-x: auto; overflow-y: hidden;
        scrollbar-width: thin;
      }
      #ytm-inpage-queue:empty { display: none; }
      .ytm-ipq-item {
        position: relative; flex: 0 0 auto; width: 64px; height: 36px;
        border-radius: 4px; overflow: hidden; cursor: pointer;
        background: rgba(0,0,0,.2);
      }
      .ytm-ipq-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .ytm-ipq-item:hover { outline: 2px solid #f00; }
      .ytm-ipq-remove {
        position: absolute; top: 0; right: 0; width: 14px; height: 14px;
        display: none; align-items: center; justify-content: center;
        background: rgba(0,0,0,.75); color: #fff; font-size: 10px; line-height: 1;
        border: none; padding: 0; cursor: pointer; border-radius: 0 0 0 4px;
      }
      .ytm-ipq-item:hover .ytm-ipq-remove { display: flex; }
      .ytm-ipq-more {
        flex: 0 0 auto; height: 36px; padding: 0 8px; border-radius: 4px;
        border: none; cursor: pointer; font: 600 11px Roboto, Arial, sans-serif;
        background: rgba(0,0,0,.6); color: #fff;
      }
    `;
    document.head.appendChild(style);
  }

  // Local copy of the worker's comparator (IIFE — cannot import). 'suggested'
  // has no per-video field here and falls back to addedAt, matching the
  // worker's own fallback sorts.
  function sortVideosList(videos, sortBy, direction) {
    return [...videos].sort((a, b) => {
      let va, vb;
      switch (sortBy) {
        case 'duration': va = a.duration || 0; vb = b.duration || 0; break;
        case 'uploadedAt':
          va = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
          vb = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0; break;
        default: va = a.addedAt || 0; vb = b.addedAt || 0;
      }
      return direction === 'asc' ? va - vb : vb - va;
    });
  }

  // Create/remove the strip according to settings + masthead presence. No
  // retry loop: the throttled mutation callback re-enters when the masthead
  // appears or gets re-rendered (strip node disconnected).
  function ensureInPageQueue() {
    const existing = document.getElementById('ytm-inpage-queue');
    if (!cachedSettings?.inPageQueue) {
      if (existing) existing.remove();
      return;
    }
    const host = document.querySelector('ytd-masthead #container');
    if (!host) return;
    if (existing && existing.isConnected && host.contains(existing)) return;
    if (existing) existing.remove();

    const strip = document.createElement('div');
    strip.id = 'ytm-inpage-queue';

    // Vertical wheel scrolls the strip horizontally
    strip.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        strip.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    // Event delegation — one listener set on the strip; tiles carry no closures
    strip.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.ytm-ipq-remove');
      if (removeBtn) {
        e.stopPropagation();
        const tile = removeBtn.closest('.ytm-ipq-item');
        // sessionId scopes the removal to what the strip displays — a same-id
        // entry in ANOTHER session must survive (worker supports the scoping)
        if (tile) safeSend({ type: 'REMOVE_VIDEO', videoId: tile.dataset.videoId, sessionId: ipqActiveSessionId });
        return;
      }
      const tile = e.target.closest('.ytm-ipq-item');
      if (tile) {
        // URL built only from the stored 11-char video id — never from page data
        safeSend({ type: 'OPEN_VIDEO', url: 'https://www.youtube.com/watch?v=' + tile.dataset.videoId });
        return;
      }
      if (e.target.closest('.ytm-ipq-more')) {
        // Worker resolves sender.tab.id (stage 01 fallback). If Chrome rejects
        // the relayed gesture, the handler's error path makes this a silent
        // no-op — acceptable degraded behavior.
        safeSend({ type: 'OPEN_SIDE_PANEL' });
      }
    });
    strip.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
    strip.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      const tile = e.target.closest('.ytm-ipq-item');
      if (tile) {
        e.preventDefault();
        safeSend({ type: 'OPEN_VIDEO_NEW_TAB', url: 'https://www.youtube.com/watch?v=' + tile.dataset.videoId });
      }
    });

    const center = host.querySelector('#center');
    if (center) center.insertAdjacentElement('afterend', strip);
    else host.appendChild(strip);
    renderInPageQueueFrom(lastKnownVideos);
  }

  async function refreshInPageQueue() {
    try {
      if (!isContextValid()) return;
      const r = await chrome.storage.local.get(['yt_videos', 'yt_sessions']);
      lastKnownVideos = r.yt_videos || [];
      ipqActiveSessionId = r.yt_sessions?.activeId || 'main';
      renderInPageQueueFrom(lastKnownVideos);
    } catch {}
  }

  function renderInPageQueueFrom(videos) {
    const strip = document.getElementById('ytm-inpage-queue');
    if (!strip) return;
    // Unwatched, non-Shorts, active session only; panel's persisted sort
    const items = sortVideosList(
      (videos || []).filter(v => !v.watched && !v.isShort &&
        (v.sessionId || 'main') === ipqActiveSessionId),
      cachedSettings?.sortBy || 'addedAt',
      cachedSettings?.sortDirection || 'desc'
    );
    // textContent-only rebuild (≤31 nodes) — no innerHTML with video data
    strip.textContent = '';
    for (const v of items.slice(0, IPQ_MAX_TILES)) {
      const tile = document.createElement('div');
      tile.className = 'ytm-ipq-item';
      tile.title = (v.title || 'Unknown') + (v.channel ? ' — ' + v.channel : '');
      tile.dataset.videoId = v.id;
      const img = document.createElement('img');
      if (v.thumbnail) img.src = v.thumbnail;
      img.alt = '';
      img.loading = 'lazy';
      img.draggable = false;
      tile.appendChild(img);
      const rm = document.createElement('button');
      rm.className = 'ytm-ipq-remove';
      rm.textContent = '✕';
      rm.title = 'Remove from queue';
      tile.appendChild(rm);
      strip.appendChild(tile);
    }
    if (items.length > IPQ_MAX_TILES) {
      const more = document.createElement('button');
      more.className = 'ytm-ipq-more';
      more.textContent = '+' + (items.length - IPQ_MAX_TILES);
      more.title = 'Open the side panel to see the full queue';
      strip.appendChild(more);
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
      // Re-attach the queue strip after masthead re-renders (SPA nav, A/B
      // swaps) — same throttle, no extra observers
      ensureInPageQueue();
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
        lastKnownVideos = changes.yt_videos.newValue || [];
        renderInPageQueueFrom(lastKnownVideos);
      }
      if (changes.yt_settings) {
        cachedSettings = changes.yt_settings.newValue || {};
        applyYouTubeUI();
        ensureInPageQueue();                    // strip toggled on/off
        renderInPageQueueFrom(lastKnownVideos); // sort changes re-order tiles
      }
      if (changes.yt_sessions) {
        // Active-session switch re-filters the strip (contract ruling 2)
        ipqActiveSessionId = changes.yt_sessions.newValue?.activeId || 'main';
        renderInPageQueueFrom(lastKnownVideos);
      }
    });
  } catch {}

  // --- Initialization ---

  function init() {
    injectIndicatorStyles();
    injectInPageQueueStyles();
    refreshQueuedIds().then(applyThumbnailIndicators);
    // Settings first (ensureInPageQueue reads cachedSettings), then queue data
    getSettings().then(() => { ensureInPageQueue(); refreshInPageQueue(); });
    startTracking();
    resetSeekHistory(getCurrentVideoId());
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
      // Player stage (02): seek history and rate-sync arming are per-video —
      // reset only when the videoId actually changed (t= param tweaks don't)
      const navVideoId = getCurrentVideoId();
      if (navVideoId !== seekHistoryVideoId) {
        resetSeekHistory(navVideoId);
        rateSyncArmedAt = 0;
      }
      // Re-attach the flexy attribute observer on the new page (the 3s
      // applyYouTubeUI below reaches applyPlayerSize, which re-creates it)
      if (resizeFlexyObserver) { resizeFlexyObserver.disconnect(); resizeFlexyObserver = null; }
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
