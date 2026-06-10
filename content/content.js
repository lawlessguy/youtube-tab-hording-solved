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
  // Shorts (stage 07): arrow scrubbing + first-loop-boundary finish detection
  const SHORTS_SEEK_SECONDS = 5;
  let lastManualSeekAt = 0;   // suppress loop-detect right after a seek
  let prevShortTime = 0;      // last observed currentTime on the shorts <video>
  let lastLoopFiredId = null; // finish fires once per videoId

  function isShortsPage() { return location.pathname.startsWith('/shorts/'); }

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
    // While the player is floated in a Document PiP window the <video> lives
    // in that window's document — searching it first keeps volume/speed/
    // media-commands/watch-tracking working on the floated video (contract
    // ruling 6). docPipWindow is declared in the PiP section below; this
    // function is only ever called asynchronously, after the IIFE body ran.
    if (docPipWindow) {
      try {
        const v = docPipWindow.document.querySelector('video');
        if (v) return v;
      } catch {}
    }
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
    // While floated in Document PiP, never engage the GainNode boost: a
    // MediaElementAudioSourceNode belongs to the opener document's
    // AudioContext, and initializing it against a cross-document element
    // risks muting audio entirely (contract ruling 7) — clamp to 100%
    if (docPipWindow && percent > 100) percent = 100;
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
  // pass the key through untouched. Named so openDocPip() can register the
  // SAME handler on the PiP window's document — keystrokes typed while the
  // floating window has focus must keep working (contract ruling 6).
  function handleSeekHistoryKeydown(e) {
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
  }
  document.addEventListener('keydown', handleSeekHistoryKeydown, true);

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
      // Shorts fallback (stage 07): a non-looping Short fires 'ended' instead
      // of a loop boundary — same once-per-id guard as the loop watcher
      if (isShortsPage() && videoId && videoId !== lastLoopFiredId) {
        lastLoopFiredId = videoId;
        handleShortFinished(videoId);
      }
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
    setupShortsLoopWatch();
    setupAutoApply();
    bindRateSync(video);
    bindSeekHistory(video);
    applyStoredSettings();
    // Re-assert the auto-PiP handler after SPA navigation — YouTube's own
    // main-world registration is last-write-wins between worlds (stage 03)
    if (cachedSettings) syncAutoPip(cachedSettings);
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
          // Stage 07: the panel adapts its tools when the displayed tab is a
          // Short (contract section 3 final shape)
          isShorts: isShortsPage(),
          url: window.location.href,
          // Stage 03: classic PiP element OR our Document PiP window open;
          // the panel greys its pip-row knobs when docPipSupported is false
          pipActive: !!docPipWindow || !!document.pictureInPictureElement,
          docPipSupported: typeof window.documentPictureInPicture !== 'undefined',
        });
        break;

      case 'MEDIA_COMMAND': {
        // exitPip is no-op-safe and must not require a <video> (contract):
        // close our Document PiP if open, else any classic PiP element
        if (message.action === 'exitPip') {
          if (docPipWindow) closeDocPip();
          else if (document.pictureInPictureElement) {
            document.exitPictureInPicture().catch(() => {});
          }
          sendResponse({ success: true });
          break;
        }
        // Shorts feed navigation (stage 07) — clicks YouTube's own nav
        // buttons, so no <video> element is required
        if (message.action === 'shortsNext' || message.action === 'shortsPrev') {
          const ok = isShortsPage() &&
            clickShortsNav(message.action === 'shortsNext' ? 'next' : 'prev');
          sendResponse({ success: ok });
          break;
        }
        if (!video) { sendResponse({ success: false }); break; }
        // Optional seconds override for forward/rewind (contract, default 10)
        const secs = typeof message.seconds === 'number' && isFinite(message.seconds) &&
          message.seconds > 0 ? message.seconds : 10;
        let handled = true;
        switch (message.action) {
          case 'playPause':
            video.paused ? video.play() : video.pause();
            break;
          case 'restart':
            video.currentTime = 0;
            video.play();
            break;
          case 'forward':
            // Clamp BELOW duration so a forward seek on a looping Short can't
            // wrap the loop and false-fire the finish detector (stage 07)
            video.currentTime = Math.min(video.currentTime + secs,
              isFinite(video.duration) && video.duration > 0
                ? Math.max(0, video.duration - 0.25) : Infinity);
            lastManualSeekAt = Date.now();
            break;
          case 'rewind':
            video.currentTime = Math.max(video.currentTime - secs, 0);
            lastManualSeekAt = Date.now();
            break;
          default:
            handled = false; // unknown actions respond {success:false} — never throw
        }
        sendResponse(handled ? { success: true, paused: video.paused } : { success: false });
        break;
      }

      default:
        sendResponse({});
    }
    return true;
  });

  // --- Picture in Picture (stage 03) ---
  // Float: moves the whole #movie_player container (never the bare <video> —
  // YouTube's controls/layout live on the container) into a Document PiP
  // window with a hover control strip (opacity dimming, S/M/L presets,
  // restore), and re-inserts it intact on EVERY close path via 'pagehide'.
  // Auto-PiP: a MediaSession 'enterpictureinpicture' handler (Chrome 134+
  // invokes it gesture-free on tab switch when Chrome's own MEI/permission
  // gates pass) opens CLASSIC video PiP — automatic DOM surgery on YouTube
  // is too invasive for a background trigger.

  let docPipWindow = null;          // Document PiP Window object, or null
  let pipMovedPlayer = null;        // the #movie_player element while floated
  let pipOriginalParent = null;     // restore anchor (same pattern as comments-move)
  let pipOriginalNextSibling = null;
  let pipPlaceholder = null;
  let pipOpacityDebounce = null;
  const PIP_SIZES = { small: [320, 180], medium: [480, 270], large: [640, 360] };

  function getPlayerContainer() {
    // null on shorts/non-watch pages — openDocPip then falls back to classic
    return document.getElementById('movie_player');
  }

  function clampPipOpacity(v) {
    const n = Number(v);
    if (!isFinite(n)) return 100;
    return Math.min(100, Math.max(30, Math.round(n)));
  }

  function openClassicPip() {
    const v = getVideoElement();
    if (!v || typeof v.requestPictureInPicture !== 'function') return;
    try { v.requestPictureInPicture().catch(() => {}); } catch {}
  }

  function injectPipPageStyle() {
    if (document.getElementById('ytm-pip-page-style')) return;
    const style = document.createElement('style');
    style.id = 'ytm-pip-page-style';
    // Placeholder-only selectors — must never touch player sizing (contract
    // ruling 8: later styles may not override the resize rules)
    style.textContent = `
      .ytm-pip-placeholder {
        width: 100%; aspect-ratio: 16 / 9;
        display: flex; align-items: center; justify-content: center;
        background: #0f0f0f; color: #aaa;
        font: 500 14px Roboto, Arial, sans-serif;
        border: 1px solid #2a2a2a; border-radius: 12px;
        cursor: pointer; text-align: center;
      }
      .ytm-pip-placeholder:hover { color: #fff; border-color: #555; }
    `;
    document.head.appendChild(style);
  }

  async function openDocPip(opts = {}) {
    // Bail-outs (classic PiP still gives a floating video):
    //  - Document PiP unsupported (Chrome < 116 / isolated-world gap)
    //  - volume boost ever engaged: a cross-document MediaElementSource can
    //    mute audio outright (contract ruling 7)
    //  - shorts pages (different player DOM — high breakage, low value)
    //  - no #movie_player container to move
    if (!window.documentPictureInPicture || audioContext !== null ||
        window.location.pathname.startsWith('/shorts') || !getPlayerContainer()) {
      openClassicPip();
      return;
    }
    // Fire-and-forget — the transient activation must not be spent waiting
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    const sizeKey = PIP_SIZES[opts.size] ? opts.size : 'medium';
    const [w, h] = PIP_SIZES[sizeKey];
    let win;
    try {
      win = await window.documentPictureInPicture.requestWindow({ width: w, height: h });
    } catch (e) {
      console.warn('[YT Tab Manager] PiP open failed:', e);
      return;
    }
    const player = getPlayerContainer();
    if (!player) { try { win.close(); } catch {} return; }
    docPipWindow = win;
    pipMovedPlayer = player;
    pipOriginalParent = player.parentElement;
    pipOriginalNextSibling = player.nextSibling;

    const pdoc = win.document;
    const styleEl = pdoc.createElement('style');
    // Static CSS string — no user data near it
    styleEl.textContent = `
      body { margin:0; background:#0f0f0f; overflow:hidden;
             font-family:'Segoe UI',system-ui,sans-serif; }
      .ytm-pip-wrap { position:fixed; inset:0; opacity:var(--ytm-pip-op,1);
                      transition:opacity .2s; }
      .ytm-pip-wrap:hover { opacity:1 !important; }
      #movie_player { width:100% !important; height:100% !important; }
      #movie_player video { width:100% !important; height:100% !important; }
      .ytm-pip-strip { position:fixed; left:0; right:0; bottom:0; display:flex;
                       align-items:center; gap:8px; padding:6px 10px;
                       background:rgba(15,15,15,.92); opacity:0;
                       transition:opacity .2s; z-index:9999; }
      body:hover .ytm-pip-strip { opacity:1; }
      .ytm-pip-strip input[type=range] { flex:1; }
      .ytm-pip-strip button { background:#1a1a1a; border:1px solid #2a2a2a;
                              color:#aaa; border-radius:4px; padding:2px 8px;
                              font-size:11px; cursor:pointer; }
      .ytm-pip-strip button:hover { color:#f1f1f1; border-color:#555; }
    `;
    pdoc.head.appendChild(styleEl);

    const wrap = pdoc.createElement('div');
    wrap.className = 'ytm-pip-wrap';
    wrap.appendChild(player); // adopts #movie_player into the PiP document
    pdoc.body.appendChild(wrap);
    const opacity = clampPipOpacity(opts.opacity);
    pdoc.documentElement.style.setProperty('--ytm-pip-op', String(opacity / 100));

    // Hover control strip — createElement/textContent only, no innerHTML.
    // resizeTo() needs a transient activation INSIDE the PiP window, which
    // these button clicks provide (the panel's presets only set open size).
    const strip = pdoc.createElement('div');
    strip.className = 'ytm-pip-strip';
    const range = pdoc.createElement('input');
    range.type = 'range';
    range.min = '30';
    range.max = '100';
    range.step = '5';
    range.value = String(opacity);
    range.title = 'Opacity';
    range.addEventListener('input', () => {
      pdoc.documentElement.style.setProperty('--ytm-pip-op', String(Number(range.value) / 100));
      if (pipOpacityDebounce) clearTimeout(pipOpacityDebounce);
      pipOpacityDebounce = setTimeout(() => {
        pipOpacityDebounce = null;
        safeSend({ type: 'UPDATE_SETTINGS', settings: { pipOpacity: Number(range.value) } });
      }, 300);
    });
    strip.appendChild(range);
    for (const key of ['small', 'medium', 'large']) {
      const b = pdoc.createElement('button');
      b.textContent = key[0].toUpperCase();
      b.title = 'Resize to ' + PIP_SIZES[key][0] + '×' + PIP_SIZES[key][1];
      b.addEventListener('click', () => {
        if (!docPipWindow) return;
        try { docPipWindow.resizeTo(PIP_SIZES[key][0], PIP_SIZES[key][1]); } catch {}
        safeSend({ type: 'UPDATE_SETTINGS', settings: { pipSize: key } });
      });
      strip.appendChild(b);
    }
    const back = pdoc.createElement('button');
    back.textContent = '↩';
    back.title = 'Back to tab';
    back.addEventListener('click', closeDocPip);
    strip.appendChild(back);
    pdoc.body.appendChild(strip);

    // Placeholder card at the player's old spot (click restores)
    injectPipPageStyle();
    pipPlaceholder = document.createElement('div');
    pipPlaceholder.className = 'ytm-pip-placeholder';
    pipPlaceholder.textContent = 'Playing in floating window — click to restore';
    pipPlaceholder.addEventListener('click', closeDocPip);
    try {
      if (pipOriginalParent) pipOriginalParent.insertBefore(pipPlaceholder, pipOriginalNextSibling);
    } catch {}

    // 'pagehide' fires on EVERY close path (native ✕, strip restore button,
    // placeholder click, a second Doc-PiP opened elsewhere, opener unload) —
    // single restore entry point
    win.addEventListener('pagehide', restorePipPlayer);
    win.addEventListener('resize', () => {
      try { window.dispatchEvent(new Event('resize')); } catch {}
    });
    // Timeline-history shortcuts while the PiP window itself has focus —
    // same handler, capture phase; it dies with the PiP document on close,
    // so no teardown is needed in restorePipPlayer
    try { pdoc.addEventListener('keydown', handleSeekHistoryKeydown, true); } catch {}
    window.dispatchEvent(new Event('resize')); // YouTube re-measures
  }

  // Runs on the PiP window's pagehide — possibly while the opener document
  // is itself unloading, hence the blanket try/catch (restoring into a dying
  // document is harmless)
  function restorePipPlayer() {
    try {
      if (pipPlaceholder) { try { pipPlaceholder.remove(); } catch {} }
      const player = pipMovedPlayer;
      if (player) {
        let parent = pipOriginalParent;
        // YouTube re-rendered the parent while floated: degraded fallback —
        // the player must never be lost (plan edge 18)
        if (!parent || !parent.isConnected) {
          parent = document.querySelector('#player-container') || document.body;
        }
        try {
          if (pipOriginalNextSibling && pipOriginalNextSibling.parentNode === parent) {
            parent.insertBefore(player, pipOriginalNextSibling);
          } else {
            parent.appendChild(player);
          }
        } catch { try { document.body.appendChild(player); } catch {} }
      }
    } catch {}
    docPipWindow = null;
    pipMovedPlayer = null;
    pipOriginalParent = null;
    pipOriginalNextSibling = null;
    pipPlaceholder = null;
    try { window.dispatchEvent(new Event('resize')); } catch {}
  }

  function closeDocPip() {
    // close() needs no gesture; pagehide → restorePipPlayer does the rest
    if (docPipWindow) { try { docPipWindow.close(); } catch {} }
  }

  function togglePip(opts = {}) {
    if (docPipWindow) { closeDocPip(); return; }
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
      return;
    }
    openDocPip(opts);
  }
  // Exposed on the shared isolated-world global: the side panel's float
  // button injects a one-liner via chrome.scripting.executeScript (the
  // click's user activation propagates into the injected function, which
  // must therefore call this synchronously).
  window.__ytmTogglePip = togglePip;

  // Live panel → PiP-window opacity sync (storage.onChanged). Also mirrors
  // the strip's own slider unless the user is holding it.
  function applyPipOpacityFromSettings() {
    if (!docPipWindow || typeof cachedSettings?.pipOpacity !== 'number') return;
    try {
      const op = clampPipOpacity(cachedSettings.pipOpacity);
      const pdoc = docPipWindow.document;
      pdoc.documentElement.style.setProperty('--ytm-pip-op', String(op / 100));
      const range = pdoc.querySelector('.ytm-pip-strip input[type=range]');
      if (range && pdoc.activeElement !== range) range.value = String(op);
    } catch {}
  }

  // Auto-PiP on tab switch: Chrome invokes the registered handler WITHOUT a
  // gesture when the user switches away from an eligible playing tab (Media
  // Engagement Index + per-site permission gated — Chrome decides, we can't
  // force it). Re-asserted on SPA navigation: YouTube's own main-world
  // registration is last-write-wins between worlds (best effort).
  function syncAutoPip(settings) {
    try {
      if (settings?.pipAutoEnabled) {
        navigator.mediaSession.setActionHandler('enterpictureinpicture', async () => {
          try {
            const video = getVideoElement();
            // !docPipWindow: while OUR floating window is open, the video
            // already floats — requesting classic PiP on it would only reject
            if (video && !document.pictureInPictureElement && !docPipWindow) {
              await video.requestPictureInPicture(); // gesture-free here by spec
            }
          } catch {}
        });
      } else {
        navigator.mediaSession.setActionHandler('enterpictureinpicture', null);
      }
    } catch {} // TypeError on Chrome < 134 (unknown action) — degrade silently
  }

  // --- Shorts Tools (stage 07) ---
  // Arrow scrubbing, first-loop-boundary finish detection (auto-scroll /
  // auto-close), programmatic feed navigation, and the in-page button rail.

  // Arrow-key scrubbing — /shorts/ paths only, capture phase so we run before
  // YouTube's document-level hotkeys (Shorts binds nothing to Left/Right
  // natively today). Bails in text contexts and when any modifier is held
  // (Alt+Left = history back must keep working).
  window.addEventListener('keydown', (e) => {
    if (!isShortsPage()) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = e.target;
    if (t && (t.isContentEditable ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '') ||
        (t.closest && t.closest('input, textarea, select, [contenteditable], #contenteditable-root, tp-yt-paper-dialog')))) return;
    const video = getVideoElement();
    if (!video) return;
    e.preventDefault();
    e.stopImmediatePropagation(); // win over YouTube's own listeners
    seekBy(video, e.key === 'ArrowRight' ? SHORTS_SEEK_SECONDS : -SHORTS_SEEK_SECONDS);
  }, true);

  function seekBy(video, delta) {
    lastManualSeekAt = Date.now();
    // Clamp BELOW duration so a forward seek can't wrap the loop and
    // false-trigger the finish detector
    const max = isFinite(video.duration) ? Math.max(0, video.duration - 0.25) : Infinity;
    video.currentTime = Math.min(Math.max(0, video.currentTime + delta), max);
  }

  // First loop boundary = "finished": previous observed currentTime within
  // 0.75s of duration, new one < 0.5s, and no manual seek in the last 1.5s.
  // ACTS at most once per videoId (latch reset on SPA navigation, or released
  // when both toggles were off so a later enable still works on this Short).
  function setupShortsLoopWatch() {
    const video = getVideoElement();
    if (!video || video._ytmLoopBound) return; // Shorts reuse one <video> across items
    video._ytmLoopBound = true;
    video.addEventListener('timeupdate', () => {
      const t = video.currentTime, d = video.duration;
      if (!isShortsPage()) { prevShortTime = t; return; }
      const wrapped = isFinite(d) && d > 1 &&
        prevShortTime > d - 0.75 && t < 0.5 &&
        Date.now() - lastManualSeekAt > 1500;
      prevShortTime = t;
      if (!wrapped) return;
      const id = getCurrentVideoId();
      if (!id || id === lastLoopFiredId) return;
      // Provisional latch (blocks re-fire while the async settings check
      // runs); released when no action was taken so that enabling a toggle
      // mid-Short takes effect at the NEXT loop boundary, not only after a
      // navigation away
      lastLoopFiredId = id;
      handleShortFinished(id).then((acted) => {
        if (!acted && lastLoopFiredId === id) lastLoopFiredId = null;
      });
    });
  }

  // Returns true when an auto-behavior actually fired (the caller keeps the
  // once-per-videoId latch only in that case)
  async function handleShortFinished(videoId) {
    const s = await getSettings(); // cachedSettings, refreshed by storage.onChanged
    if (s.shortsAutoClose) {
      // Worker closes THIS tab only (sender-validated + isShortUrl-checked)
      safeSend({ type: 'CLOSE_SHORT_TAB', videoId });
      return true;
    }
    if (s.shortsAutoScroll) {
      clickShortsNav('next');
      return true;
    }
    return false;
  }

  function clickShortsNav(dir) {
    const sel = dir === 'next'
      ? '#navigation-button-down button, button[aria-label="Next video"]'
      : '#navigation-button-up button, button[aria-label="Previous video"]';
    const btn = document.querySelector(sel);
    if (btn) { btn.click(); return true; }
    // Fallback (untrusted — YouTube may ignore it; primary path is the click)
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: dir === 'next' ? 'ArrowDown' : 'ArrowUp',
      code: dir === 'next' ? 'ArrowDown' : 'ArrowUp',
      keyCode: dir === 'next' ? 40 : 38, which: dir === 'next' ? 40 : 38, bubbles: true,
    }));
    return false;
  }

  // --- In-page Shorts rail — fixed to the left viewport gutter ---

  const RAIL_ID = 'ytm-shorts-rail';

  function updateShortsFeatures() {
    if (isShortsPage()) ensureShortsRail();
    else removeShortsRail();
  }

  function injectShortsRailStyle() {
    if (document.getElementById('ytm-shorts-rail-style')) return;
    const style = document.createElement('style');
    style.id = 'ytm-shorts-rail-style';
    style.textContent = `
      #ytm-shorts-rail { position: fixed; left: 14px; top: 50%; transform: translateY(-50%);
        display: flex; flex-direction: column; gap: 10px; z-index: 2400; }
      /* Clear YouTube's left guide when it is open (the rail is body-appended
         after ytd-app, so the sibling combinator applies; if YouTube renames
         these attributes the rail degrades to the 14px gutter) */
      ytd-app[mini-guide-visible] ~ #ytm-shorts-rail { left: 86px; }
      ytd-app[guide-persistent-and-visible] ~ #ytm-shorts-rail { left: 254px; }
      #ytm-shorts-rail button { width: 40px; height: 40px; border-radius: 50%;
        border: 1px solid rgba(255,255,255,0.25); background: rgba(30,30,30,0.85);
        color: #f1f1f1; cursor: pointer; display: flex; align-items: center;
        justify-content: center; font-size: 16px; padding: 0; }
      #ytm-shorts-rail button:hover { background: rgba(60,60,60,0.95); }
      #ytm-shorts-rail button.ytm-on { border-color: #ff0000; color: #ff0000;
        background: rgba(255,0,0,0.15); }
      #ytm-shorts-rail button.ytm-ok { border-color: #2ba640; color: #2ba640; }
    `;
    document.head.appendChild(style);
  }

  function flashRailButton(btn) {
    btn.classList.add('ytm-ok');
    setTimeout(() => btn.classList.remove('ytm-ok'), 800);
  }

  // Static SVG icon strings only — never user data near innerHTML
  const RAIL_ICONS = {
    add: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    star: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    next: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>',
    autoscroll: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 11 12 17 18 11"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
    autoclose: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>',
  };

  function ensureShortsRail() {
    injectShortsRailStyle();
    const existing = document.getElementById(RAIL_ID);
    if (existing && existing.isConnected) { updateShortsRailState(); return; }
    if (existing) existing.remove();

    const rail = document.createElement('div');
    rail.id = RAIL_ID;

    const mkBtn = (id, icon, title) => {
      const b = document.createElement('button');
      b.id = id;
      b.title = title;
      b.innerHTML = RAIL_ICONS[icon]; // static SVG — allowed
      rail.appendChild(b);
      return b;
    };

    const addBtn = mkBtn('ytm-rail-add', 'add', 'Add this Short to the queue');
    addBtn.addEventListener('click', () => {
      // Contract section 4: shorts-rail adds carry source 'shorts'
      safeSend({ type: 'ADD_VIDEO', url: window.location.href, source: 'shorts' })
        .then(() => flashRailButton(addBtn));
    });

    const starBtn = mkBtn('ytm-rail-star', 'star', 'Star this Short');
    starBtn.addEventListener('click', () => {
      const videoId = getCurrentVideoId();
      if (!videoId) return;
      safeSend({ type: 'TAG_STARRED', videoId, url: window.location.href })
        .then(() => flashRailButton(starBtn));
    });

    mkBtn('ytm-rail-next', 'next', 'Next Short')
      .addEventListener('click', () => clickShortsNav('next'));

    // Toggles repaint ONLY from storage.onChanged (no optimistic class flip),
    // so the rail and the panel strip can never disagree. Mutually exclusive:
    // turning one on writes the other off in the same UPDATE_SETTINGS.
    const scrollBtn = mkBtn('ytm-rail-autoscroll', 'autoscroll', 'Auto-scroll to the next Short when this one finishes');
    scrollBtn.addEventListener('click', () => {
      const on = !cachedSettings?.shortsAutoScroll;
      safeSend({ type: 'UPDATE_SETTINGS', settings: {
        shortsAutoScroll: on, ...(on ? { shortsAutoClose: false } : {}),
      } });
    });

    const closeBtn = mkBtn('ytm-rail-autoclose', 'autoclose', 'Close this tab when the Short finishes');
    closeBtn.addEventListener('click', () => {
      const on = !cachedSettings?.shortsAutoClose;
      safeSend({ type: 'UPDATE_SETTINGS', settings: {
        shortsAutoClose: on, ...(on ? { shortsAutoScroll: false } : {}),
      } });
    });

    document.body.appendChild(rail);
    updateShortsRailState();
  }

  function removeShortsRail() {
    const rail = document.getElementById(RAIL_ID);
    if (rail) rail.remove();
  }

  function updateShortsRailState() {
    const rail = document.getElementById(RAIL_ID);
    if (!rail) return;
    rail.querySelector('#ytm-rail-autoscroll')
      ?.classList.toggle('ytm-on', !!cachedSettings?.shortsAutoScroll);
    rail.querySelector('#ytm-rail-autoclose')
      ?.classList.toggle('ytm-on', !!cachedSettings?.shortsAutoClose);
  }

  // Hide the rail in fullscreen (it would float over the video)
  document.addEventListener('fullscreenchange', () => {
    const rail = document.getElementById(RAIL_ID);
    if (rail) rail.style.display = document.fullscreenElement ? 'none' : '';
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
    // While the player is floated in Document PiP the container only holds a
    // placeholder — resize handles no-op (contract ruling 6)
    if (e.button !== 0 || resizeDrag || docPipWindow) return;
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
  // worker's own fallback sorts — sanctioned divergence from the panel's
  // channelScore ranking (contract ruling 3: suggested sort is panel-side;
  // contract section 2: worker fallback sorts treat it as addedAt).
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
        syncAutoPip(cachedSettings);            // auto-PiP toggle (stage 03)
        applyPipOpacityFromSettings();          // live panel → PiP window opacity
        updateShortsRailState();                // shorts auto-toggle paint (stage 07)
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
    getSettings().then((s) => {
      ensureInPageQueue();
      refreshInPageQueue();
      syncAutoPip(s);
      updateShortsFeatures(); // rail on /shorts/ (stage 07)
    });
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
      // Floated player: SPA navigation closes the Document PiP first — its
      // pagehide restores #movie_player before YouTube re-renders (stage 03)
      closeDocPip();
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
      // Shorts (stage 07): loop detection is per-Short — reset on navigation
      // and add/remove the rail according to the new path
      prevShortTime = 0;
      lastLoopFiredId = null;
      updateShortsFeatures();
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
