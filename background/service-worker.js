import { STORAGE_KEYS, DEFAULT_SETTINGS, DEFAULT_SESSIONS, MSG } from '../utils/constants.js';
import * as storage from '../utils/storage.js';
import {
  extractVideoId, isYouTubeUrl, isShortUrl, isYouTubeHost,
  fetchVideoMetadata, fetchVideoDetails, getThumbnailUrl
} from '../utils/youtube.js';
import { logActivity, getSuggestScores, EVENT_TYPES } from '../utils/activity-log.js';

// Track recently created tabs for interception (tabId → createdAt) and tabs
// opened by the extension itself (tabId → whitelist expiry). Both are
// mirrored in chrome.storage.session because the MV3 worker is idle-killed:
// purely in-memory state made interception lossy across restarts. Expiry is
// checked on read — setTimeout cleanup does not survive worker death.
const RECENT_TAB_TTL = 10000;
const recentlyCreatedTabs = new Map();
const extensionOpenedTabs = new Map();
// Track the last tab that had a playing video (best-effort; loss is benign)
let lastPlayingTabId = null;
// Rate-limit the all-tabs media scan: the panel polls every 1.5s, and with
// many YouTube tabs open a full scan per poll messages every one of them
let lastFullMediaScanAt = 0;

let sessionStateReady = null;
function loadSessionState() {
  if (!sessionStateReady) {
    sessionStateReady = (async () => {
      try {
        const data = await chrome.storage.session.get(['recentTabs', 'extOpenedTabs']);
        const now = Date.now();
        for (const [id, ts] of Object.entries(data.recentTabs || {})) {
          if (now - ts < RECENT_TAB_TTL && !recentlyCreatedTabs.has(Number(id))) {
            recentlyCreatedTabs.set(Number(id), ts);
          }
        }
        for (const [id, expiry] of Object.entries(data.extOpenedTabs || {})) {
          if (expiry > now && !extensionOpenedTabs.has(Number(id))) {
            extensionOpenedTabs.set(Number(id), expiry);
          }
        }
      } catch {}
    })();
  }
  return sessionStateReady;
}

function persistSessionState() {
  const now = Date.now();
  for (const [id, ts] of recentlyCreatedTabs) {
    if (now - ts >= RECENT_TAB_TTL) recentlyCreatedTabs.delete(id);
  }
  for (const [id, expiry] of extensionOpenedTabs) {
    if (expiry <= now) extensionOpenedTabs.delete(id);
  }
  chrome.storage.session.set({
    recentTabs: Object.fromEntries(recentlyCreatedTabs),
    extOpenedTabs: Object.fromEntries(extensionOpenedTabs),
  }).catch(() => {});
}

function isRecentlyCreated(tabId) {
  const ts = recentlyCreatedTabs.get(tabId);
  return ts !== undefined && Date.now() - ts < RECENT_TAB_TTL;
}

function isExtensionOpenedTab(tabId) {
  const expiry = extensionOpenedTabs.get(tabId);
  return expiry !== undefined && expiry > Date.now();
}

async function whitelistExtensionTab(tabId, ttlMs) {
  await loadSessionState();
  extensionOpenedTabs.set(tabId, Date.now() + ttlMs);
  persistSessionState();
}

// --- Queue Sessions (yt_sessions) ---
// Contract: a video's missing sessionId reads as 'main' EVERYWHERE — onInstalled
// backfills once, but the worker can be updated mid-session without a reinstall.

function sessOf(v) { return v.sessionId || 'main'; }

function normalizeSessions(s) {
  return (s && Array.isArray(s.list) && s.list.length) ? s : structuredClone(DEFAULT_SESSIONS);
}

async function getSessions() {
  return normalizeSessions(await storage.get(STORAGE_KEYS.SESSIONS));
}

async function getActiveSessionId() {
  return (await getSessions()).activeId || 'main';
}

function newSessionId() {
  return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// --- Initialization ---

// One-time normalization of legacy queue entries (contract: sessionId missing
// ⇒ 'main', addCount missing ⇒ 1). Also initializes the array when absent.
// Goes through storage.update — never raw set — per the mutex invariant.
// Exposed on the worker global so headless tests can exercise the migration
// without simulating a full extension reinstall.
function normalizeLegacyVideos() {
  return storage.update(STORAGE_KEYS.VIDEOS, (videos) => {
    if (!videos) return [];
    let changed = false;
    const normalized = videos.map((v) => {
      if (v.sessionId != null && v.addCount != null) return v;
      changed = true;
      return { ...v, sessionId: v.sessionId ?? 'main', addCount: v.addCount ?? 1 };
    });
    return changed ? normalized : undefined;
  });
}
self.normalizeLegacyVideos = normalizeLegacyVideos;

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await storage.get(STORAGE_KEYS.SETTINGS);
  if (!settings) await storage.set(STORAGE_KEYS.SETTINGS, DEFAULT_SETTINGS);

  await normalizeLegacyVideos();

  await storage.update(STORAGE_KEYS.SESSIONS, (s) => (s ? undefined : DEFAULT_SESSIONS));

  const logged = await storage.get(STORAGE_KEYS.LOGGED_VIDEOS);
  if (!logged) await storage.set(STORAGE_KEYS.LOGGED_VIDEOS, []);

  const watchTime = await storage.get(STORAGE_KEYS.WATCH_TIME);
  if (!watchTime) await storage.set(STORAGE_KEYS.WATCH_TIME, {});

  // Activity log starts EMPTY — no backfill from yt_videos/yt_watch_time
  // (synthetic timestamps would poison the recency term of suggest scoring)
  const alog = await storage.get(STORAGE_KEYS.ACTIVITY_LOG);
  if (!alog) await storage.set(STORAGE_KEYS.ACTIVITY_LOG, { v: 1, seq: 0, events: [] });

  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
});

// --- Side Panel Visibility (hide on non-YouTube tabs) ---

function updateSidePanelForTab(tabId, url) {
  const isYouTube = isYouTubeHost(url);
  // Tab-scoped options do NOT inherit the manifest default path — open()
  // treats a path-less entry as "No active side panel for tabId" even when
  // enabled, so path must always accompany enabled: true
  const options = isYouTube
    ? { tabId, enabled: true, path: 'sidepanel/sidepanel.html' }
    : { tabId, enabled: false };
  chrome.sidePanel.setOptions(options).catch(() => {});
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    updateSidePanelForTab(tab.id, tab.url);
  } catch {}
});

// --- Tab Interception ---

chrome.tabs.onCreated.addListener(async (tab) => {
  scheduleOpenTabRecompute();
  await loadSessionState();
  recentlyCreatedTabs.set(tab.id, Date.now());
  persistSessionState();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;

  // Only URL commits can change the open-tab videoId set (anti-churn: title/
  // favicon/audible onUpdated events return above and never trigger this)
  scheduleOpenTabRecompute();

  // Keep side panel enablement in sync when a tab navigates in place
  updateSidePanelForTab(tabId, changeInfo.url);

  // Silent activity capture (stage 06): EVERY navigation to a watch/shorts
  // URL — any tab, any window, intercept on or off — appends a video_opened
  // event. Runs BEFORE the isRecentlyCreated gate so SPA navs and reloads in
  // old tabs are captured too. Same tab+video within 60s dedupes inside
  // logActivity. Fire-and-forget: the storage mutex serializes the append.
  const navVideoId = extractVideoId(changeInfo.url);
  if (navVideoId) {
    logActivity({
      type: 'video_opened',
      videoId: navVideoId,
      url: changeInfo.url,
      isShort: isShortUrl(changeInfo.url),
      source: isShortUrl(changeInfo.url) ? 'shorts' : 'browse',
      tabId,
    });
  }

  await loadSessionState();
  if (!isRecentlyCreated(tabId)) return;

  // Skip tabs opened by the extension itself
  if (isExtensionOpenedTab(tabId)) {
    extensionOpenedTabs.delete(tabId);
    recentlyCreatedTabs.delete(tabId);
    persistSessionState();
    return;
  }

  const videoId = extractVideoId(changeInfo.url);
  if (!videoId) return;

  // Always log silently for background capture
  await logVideoSilently(changeInfo.url, videoId);

  const settings = await storage.get(STORAGE_KEYS.SETTINGS);
  const mode = settings?.interceptEnabled || 'off';

  // Legacy boolean support: true → 'close', false → 'off'
  const interceptMode = mode === true ? 'close' : mode === false ? 'off' : mode;
  if (interceptMode === 'off') return;

  recentlyCreatedTabs.delete(tabId);
  persistSessionState();
  await addVideoToQueue(changeInfo.url, videoId, undefined, undefined, { source: 'intercept' });

  // Never close the tab the user is looking at — queue it but keep it open.
  // Also protects restored sessions, where every tab fires onCreated.
  if (interceptMode === 'close' && !tab.active) {
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) {
      console.error('Failed to close intercepted tab:', e);
    }
  }

  broadcast({ type: MSG.VIDEOS_UPDATED });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  scheduleOpenTabRecompute();
  await loadSessionState();
  recentlyCreatedTabs.delete(tabId);
  extensionOpenedTabs.delete(tabId);
  persistSessionState();
  if (lastPlayingTabId === tabId) lastPlayingTabId = null;
});

// Prerender/instant swaps change tabIds without an onUpdated URL commit
chrome.tabs.onReplaced.addListener(() => scheduleOpenTabRecompute());

// --- Open Tab Tracking (yt_open_tab_ids in chrome.storage.session) ---
// Event-driven: recomputed from tabs.query on tab create/navigate/remove/
// replace and once per worker wake (top-level call at the bottom of this
// file). Debounce coalesces bursts (window close = N onRemoved events → one
// write). Written ONLY when the set actually differs from what is stored —
// panel listens via storage.onChanged(area === 'session') so spurious writes
// would churn it. Deliberately OUTSIDE the storage.update mutex: that mutex
// serializes chrome.storage.LOCAL only, the worker is the single writer of
// this session key, and the value is derived (recompute always overwrites
// with ground truth) — do not route this through storage.update.

let openTabRecomputeTimer = null;
let lastOpenTabIdsJson = null; // null = unknown (fresh worker) — read before diffing

function scheduleOpenTabRecompute() {
  if (openTabRecomputeTimer) return;
  openTabRecomputeTimer = setTimeout(() => {
    openTabRecomputeTimer = null;
    recomputeOpenTabIds().catch(() => {});
  }, 250);
}

async function recomputeOpenTabIds() {
  const tabs = await chrome.tabs.query({});
  const ids = [...new Set(
    tabs.map(t => extractVideoId(t.url || t.pendingUrl || '')).filter(Boolean)
  )].sort();
  const json = JSON.stringify(ids);
  if (lastOpenTabIdsJson === null) {
    try {
      const cur = await chrome.storage.session.get(STORAGE_KEYS.OPEN_TAB_IDS);
      lastOpenTabIdsJson = JSON.stringify(cur[STORAGE_KEYS.OPEN_TAB_IDS] ?? null);
    } catch {}
  }
  if (json !== lastOpenTabIdsJson) {
    lastOpenTabIdsJson = json;
    await chrome.storage.session.set({ [STORAGE_KEYS.OPEN_TAB_IDS]: ids });
  }
}

// --- Silent Background Logging ---

const MAX_LOGGED_VIDEOS = 200;

async function logVideoSilently(url, videoId, starred) {
  await storage.update(STORAGE_KEYS.LOGGED_VIDEOS, (logged = []) => {
    const existing = logged.find(v => v.id === videoId);
    if (existing) {
      existing.timestamp = Date.now();
      if (starred) existing.starred = true; // never unstar
      return logged;
    }
    logged.push({ id: videoId, url, isShort: isShortUrl(url), timestamp: Date.now(), starred: !!starred });
    // The log only drains on Collect — cap it so it can't grow forever
    if (logged.length > MAX_LOGGED_VIDEOS) {
      logged.sort((a, b) => b.timestamp - a.timestamp);
      logged.length = MAX_LOGGED_VIDEOS;
    }
    return logged;
  });
}

// --- Video Queue ---

// opts is the reconciled extension point (integration contract §4):
// { bumpCount = true } (stage 05), { sessionId = active session, resolved
// inside } (stage 04), { source = 'manual' } (stage 06 — added_to_queue
// event provenance). The same videoId may exist once PER SESSION — the
// duplicate check is scoped to the resolved session.
async function addVideoToQueue(url, videoId, explicitTimestamp, starred, opts = {}) {
  const { bumpCount = true, source = 'manual' } = opts;
  videoId = videoId || extractVideoId(url);
  if (!videoId) return null;

  // Read (not a mutation) — fine outside the mutex; callers with many adds
  // (COLLECT_TABS) resolve once and pass opts.sessionId to skip this read
  const sessionId = opts.sessionId || await getActiveSessionId();

  // Insert a placeholder atomically (no network inside the storage lock),
  // then fill in metadata in the background. Two simultaneous adds of the
  // same video can no longer both pass the duplicate check.
  let inserted = null;
  await storage.update(STORAGE_KEYS.VIDEOS, (videos = []) => {
    const existing = videos.find(v => v.id === videoId && sessOf(v) === sessionId);
    if (existing) {
      existing.addedAt = explicitTimestamp || Date.now();
      // addCount = "times added or moved to top" — re-add/re-open/intercept
      // bumps; COLLECT_TABS sweeps pass bumpCount:false (a periodic sweep of
      // everything open must not inflate counts); drag-to-top never calls this
      if (bumpCount) existing.addCount = (existing.addCount || 1) + 1;
      if (starred) existing.starred = true;
      return videos;
    }
    inserted = {
      id: videoId,
      url,
      title: 'Loading...',
      channel: 'Unknown',
      thumbnail: getThumbnailUrl(videoId),
      duration: 0,
      addedAt: explicitTimestamp || Date.now(),
      uploadedAt: null,
      isShort: isShortUrl(url),
      watched: false,
      starred: !!starred,
      sessionId,
      addCount: 1,
    };
    videos.push(inserted);
    return videos;
  });

  broadcast({ type: MSG.VIDEOS_UPDATED });

  if (inserted) {
    // New entries only — duplicate-bump logs nothing. Title/channel are still
    // 'Loading...' placeholders at insert time, so log nulls; watch_progress
    // telemetry enriches the channel picture later for free.
    await logActivity({
      type: 'added_to_queue', videoId, url,
      title: null, channel: null, durationSec: null,
      isShort: inserted.isShort, source, tabId: null,
    });
    // Fetch title, channel, duration & upload date in background (non-blocking)
    enrichVideo(videoId);
  }

  return inserted;
}

async function enrichVideo(videoId) {
  try {
    const [metadata, details] = await Promise.all([
      fetchVideoMetadata(videoId),
      fetchVideoDetails(videoId),
    ]);
    let found = false;
    await storage.update(STORAGE_KEYS.VIDEOS, (videos = []) => {
      const video = videos.find(v => v.id === videoId);
      if (!video) return undefined; // removed in the meantime — skip write
      found = true;
      if (metadata?.title) video.title = metadata.title;
      if (metadata?.channel) video.channel = metadata.channel;
      if (details.duration) video.duration = details.duration;
      if (details.uploadDate) video.uploadedAt = details.uploadDate;
      return videos;
    });
    if (found) broadcast({ type: MSG.VIDEOS_UPDATED });
  } catch (e) {
    console.error('Failed to fetch video details:', e);
  }
}

// --- Tab Statistics ---

async function getTabStats() {
  const tabs = await chrome.tabs.query({});
  // Consider the active tab first so it is always the keeper of its videoId
  // and never lands in duplicateTabIds (closing dupes must not close the tab
  // the user is watching)
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab) {
    const idx = tabs.findIndex(t => t.id === activeTab.id);
    if (idx > 0) tabs.unshift(tabs.splice(idx, 1)[0]);
  }
  let ytTabs = 0;
  let shortsTabs = 0;
  const urlCounts = {};
  const duplicateTabIds = [];

  for (const tab of tabs) {
    if (!tab.url || !isYouTubeUrl(tab.url)) continue;
    const videoId = extractVideoId(tab.url);
    if (!videoId) continue;

    if (isShortUrl(tab.url)) {
      shortsTabs++;
    } else {
      ytTabs++;
    }

    if (urlCounts[videoId]) {
      urlCounts[videoId]++;
      duplicateTabIds.push(tab.id);
    } else {
      urlCounts[videoId] = 1;
    }
  }

  return { ytTabs, shortsTabs, duplicates: duplicateTabIds.length, duplicateTabIds };
}

// --- Watch Time ---

function getDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function getWatchTimeStats() {
  const watchTime = await storage.get(STORAGE_KEYS.WATCH_TIME) || {};
  const now = new Date();
  const todayKey = getDateKey(now);

  let today = watchTime[todayKey] || 0;
  let week = 0, month = 0, year = 0;

  for (let i = 0; i < 365; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const val = watchTime[getDateKey(d)] || 0;
    if (i < 7) week += val;
    if (i < 30) month += val;
    year += val;
  }

  return { today, week, month, year };
}

// --- Media Controls ---

async function applyMediaControl(type, value, scope) {
  let tabs;

  if (scope === 'tab') {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } else if (scope === 'window') {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabs = activeTab ? await chrome.tabs.query({ windowId: activeTab.windowId }) : [];
  } else {
    tabs = await chrome.tabs.query({});
  }

  const msgType = type === 'volume' ? MSG.SET_VOLUME : MSG.SET_SPEED;

  for (const tab of tabs) {
    if (!tab.url) continue;

    if (isYouTubeHost(tab.url)) {
      // YouTube: use content script
      try {
        await chrome.tabs.sendMessage(tab.id, { type: msgType, value });
      } catch {}
    } else if (type === 'volume') {
      // Non-YouTube: inject volume control for all audio/video elements
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (vol) => {
            document.querySelectorAll('video, audio').forEach(el => {
              el.volume = Math.min(vol / 100, 1);
            });
          },
          args: [value],
        });
      } catch {}
    }
  }
}

// --- Sort Helper ---

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

// --- Broadcast ---

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

// --- Message Handler ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(e => {
      console.error('Message handler error:', e);
      sendResponse({ error: e.message });
    });
  return true; // Keep channel open for async
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case MSG.GET_STATS: {
      const tabStats = await getTabStats();
      const watchTime = await getWatchTimeStats();
      return { ...tabStats, watchTime };
    }

    case MSG.GET_VIDEOS:
      return await storage.get(STORAGE_KEYS.VIDEOS) || [];

    case MSG.ADD_VIDEO: {
      const video = await addVideoToQueue(message.url, message.videoId,
        undefined, undefined, { source: message.source || 'manual' });
      return video;
    }

    case MSG.REMOVE_VIDEO: {
      // Optional sessionId scopes the match (panel always sends it); without
      // it, legacy all-entries-by-id behavior (content script callers)
      const matches = v => v.id === message.videoId &&
        (!message.sessionId || sessOf(v) === message.sessionId);
      // Capture the removed entry in the updateFn closure (no second read);
      // logActivity runs AFTER the update resolves — never inside updateFn
      let removed = null;
      await storage.update(STORAGE_KEYS.VIDEOS, (videos = []) => {
        removed = videos.find(matches) || null;
        return videos.filter(v => !matches(v));
      });
      if (removed) {
        await logActivity({
          type: 'removed', videoId: message.videoId,
          title: removed.title ?? null, channel: removed.channel ?? null,
          durationSec: removed.duration ?? null, isShort: removed.isShort,
          source: 'manual', tabId: null,
        });
      }
      return { success: true };
    }

    case MSG.UPDATE_VIDEO: {
      const matches = v => v.id === message.videoId &&
        (!message.sessionId || sessOf(v) === message.sessionId);
      let wasWatched = null;
      let updated = null;
      await storage.update(STORAGE_KEYS.VIDEOS, (videos = []) => {
        const video = videos.find(matches);
        if (!video) return undefined;
        wasWatched = video.watched;
        Object.assign(video, message.updates);
        updated = video;
        return videos;
      });
      // Manual mark-watched from the panel; un-marking is deliberately not
      // logged (no event type for it). wasWatched guard: re-marking an
      // already-watched entry appends nothing.
      if (message.updates?.watched === true && wasWatched === false) {
        await logActivity({
          type: 'marked_watched', videoId: message.videoId,
          title: updated?.title ?? null, channel: updated?.channel ?? null,
          durationSec: updated?.duration ?? null, isShort: updated?.isShort,
          source: 'manual', tabId: null,
        });
      }
      return { success: true };
    }

    case MSG.SET_VIDEOS: {
      await storage.update(STORAGE_KEYS.VIDEOS, () => message.videos);
      return { success: true };
    }

    case MSG.COLLECT_TABS: {
      const tabs = await chrome.tabs.query({});
      const ytTabs = tabs.filter(t => t.url && isYouTubeUrl(t.url));
      let added = 0;

      // Collect lands in the ACTIVE session — resolve once, not per tab
      const sid = await getActiveSessionId();

      // Assign timestamps so first tab gets highest value (appears first in desc sort)
      const baseTime = Date.now();
      for (let i = 0; i < ytTabs.length; i++) {
        const tab = ytTabs[i];
        const videoId = extractVideoId(tab.url);
        if (videoId) {
          const timestamp = baseTime + (ytTabs.length - i);
          const video = await addVideoToQueue(tab.url, videoId, timestamp, undefined,
            { bumpCount: false, sessionId: sid, source: 'collect' });
          if (video) added++;
        }
      }

      // Also pull from silently logged videos (carry starred flag). Drain
      // atomically so entries logged while we queue them aren't lost.
      let drained = [];
      await storage.update(STORAGE_KEYS.LOGGED_VIDEOS, (logged = []) => {
        drained = logged;
        return [];
      });
      for (const entry of drained) {
        const video = await addVideoToQueue(entry.url, entry.id, entry.timestamp, entry.starred,
          { bumpCount: false, sessionId: sid, source: 'collect' });
        if (video) added++;
      }

      return { added, tabIds: ytTabs.map(t => t.id) };
    }

    case MSG.CLOSE_VISIBLE_TABS: {
      const videoIds = new Set(message.videoIds || []);
      const tabs = await chrome.tabs.query({});
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const toClose = tabs.filter(t => {
        if (!t.url || (activeTab && t.id === activeTab.id)) return false;
        const vid = extractVideoId(t.url);
        return vid && videoIds.has(vid);
      }).map(t => t.id);
      if (toClose.length > 0) await chrome.tabs.remove(toClose);
      return { closed: toClose.length };
    }

    case MSG.REMOVE_DUPLICATES: {
      const stats = await getTabStats();
      if (stats.duplicateTabIds.length > 0) {
        await chrome.tabs.remove(stats.duplicateTabIds);
      }
      return { removed: stats.duplicateTabIds.length };
    }

    case MSG.CLOSE_SHORTS_TABS: {
      const tabs = await chrome.tabs.query({});
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const shortsTabs = tabs.filter(t =>
        t.url && isShortUrl(t.url) && (!activeTab || t.id !== activeTab.id)
      );
      if (shortsTabs.length > 0) await chrome.tabs.remove(shortsTabs.map(t => t.id));
      return { closed: shortsTabs.length };
    }

    case MSG.SET_VOLUME: {
      const settings = await storage.update(STORAGE_KEYS.SETTINGS, (s = { ...DEFAULT_SETTINGS }) => {
        s.volumeLevel = message.value;
        return s;
      });
      await applyMediaControl('volume', message.value, message.scope || settings.volumeScope);
      return { success: true };
    }

    case MSG.SET_SPEED: {
      const settings = await storage.update(STORAGE_KEYS.SETTINGS, (s = { ...DEFAULT_SETTINGS }) => {
        s.speedLevel = message.value;
        return s;
      });
      await applyMediaControl('speed', message.value, message.scope || settings.speedScope);
      return { success: true };
    }

    case MSG.SPEED_CHANGED: {
      // Native YouTube rate change reported by the content script. Persist
      // only — deliberately NO applyMediaControl(): the change stays in its
      // tab, sliders everywhere update via storage.onChanged, and other tabs
      // adopt the value at their next loadeddata auto-apply. Skipping the
      // write when the value is unchanged makes an echo loop structurally
      // impossible (second guard alongside the content script's
      // lastAppliedRate check).
      const v = Math.min(10, Math.max(0.1, Number(message.value) || 1));
      await storage.update(STORAGE_KEYS.SETTINGS, (s = { ...DEFAULT_SETTINGS }) => {
        if (Math.abs((s.speedLevel ?? 1) - v) < 0.001) return undefined; // skip write — no echo
        s.speedLevel = v;
        return s;
      });
      return { success: true, value: v };
    }

    case MSG.GET_SETTINGS:
      return await storage.get(STORAGE_KEYS.SETTINGS) || DEFAULT_SETTINGS;

    case MSG.UPDATE_SETTINGS: {
      return await storage.update(STORAGE_KEYS.SETTINGS, (current = DEFAULT_SETTINGS) =>
        ({ ...current, ...message.settings }));
    }

    case MSG.TRACK_WATCH_TIME: {
      await storage.update(STORAGE_KEYS.WATCH_TIME, (watchTime = {}) => {
        const todayKey = getDateKey(new Date());
        watchTime[todayKey] = (watchTime[todayKey] || 0) + message.minutes;
        return watchTime;
      });
      // Optional telemetry (stage 06) → watch_progress event. Old senders
      // without it stay valid and skip the log entirely.
      const t = message.telemetry;
      if (t?.videoId && typeof t.secondsWatched === 'number') {
        await logActivity({
          type: 'watch_progress', videoId: t.videoId,
          url: t.url ?? null, title: t.title ?? null, channel: t.channel ?? null,
          durationSec: t.durationSec ?? null, isShort: !!t.isShort,
          secondsWatched: Math.round(t.secondsWatched),
          maxPercent: Number.isFinite(t.maxPercent) ? Math.min(100, Math.round(t.maxPercent)) : null,
          source: 'content', tabId: sender.tab?.id ?? null,
        });
      }
      return { success: true };
    }

    case MSG.GET_WATCH_TIME:
      return await getWatchTimeStats();

    case MSG.VIDEO_METADATA: {
      const { videoId, duration, title, channel, uploadDate } = message;
      await storage.update(STORAGE_KEYS.VIDEOS, (videos = []) => {
        const video = videos.find(v => v.id === videoId);
        if (!video) return undefined;
        if (duration) video.duration = duration;
        if (title) video.title = title;
        if (channel) video.channel = channel;
        if (uploadDate) video.uploadedAt = uploadDate;
        return videos;
      });
      return { success: true };
    }

    case MSG.GET_MEDIA_STATE: {
      // Every return includes tabId so the panel can route media commands
      // back to the tab it is actually displaying. Stage 03: content-script
      // responses now also carry pipActive/docPipSupported — the queryTab
      // spread passes them through untouched, and the empty fallback mirrors
      // them with false defaults (contract section 3).
      const empty = {
        paused: true, currentTime: 0, duration: 0, videoId: null, tabId: null,
        pipActive: false, docPipSupported: false,
      };

      async function queryTab(tabId) {
        try {
          const state = await chrome.tabs.sendMessage(tabId, { type: MSG.GET_MEDIA_STATE });
          return state && state.videoId ? { ...state, tabId } : null;
        } catch { return null; }
      }

      // 1. Check active tab — if it's playing, it takes priority
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (isYouTubeHost(activeTab?.url)) {
        const state = await queryTab(activeTab.id);
        if (state && !state.paused) {
          lastPlayingTabId = activeTab.id;
          return state;
        }
      }

      // 2. Check last known playing tab — if still playing, use it
      if (lastPlayingTabId) {
        try {
          const tab = await chrome.tabs.get(lastPlayingTabId);
          if (isYouTubeHost(tab?.url)) {
            const state = await queryTab(lastPlayingTabId);
            if (state && !state.paused) {
              return state;
            }
          }
        } catch {
          lastPlayingTabId = null;
        }
      }

      // 3. Scan all YouTube tabs for any playing video — at most once per
      // 10s; once something is playing, step 2 finds it cheaply on every poll
      if (Date.now() - lastFullMediaScanAt > 10000) {
        lastFullMediaScanAt = Date.now();
        const allTabs = await chrome.tabs.query({});
        for (const t of allTabs) {
          if (!isYouTubeHost(t.url)) continue;
          const state = await queryTab(t.id);
          if (state && !state.paused) {
            lastPlayingTabId = t.id;
            return state;
          }
        }
      }

      // 4. Nothing playing — check active tab for paused state (so card shows if on a YT tab)
      if (isYouTubeHost(activeTab?.url)) {
        const state = await queryTab(activeTab.id);
        if (state) {
          return state;
        }
      }

      lastPlayingTabId = null;
      return empty;
    }

    case MSG.REFRESH_METADATA: {
      // Re-fetch ALL video details, overwriting any drag-modified values.
      // Fetch outside the storage lock, then apply to a fresh snapshot in one
      // atomic update — a long refresh must not revert removes/mark-watched
      // that happen while it runs.
      const videos = await storage.get(STORAGE_KEYS.VIDEOS) || [];
      const fetched = new Map();
      for (const video of videos) {
        try {
          const details = await fetchVideoDetails(video.id);
          const meta = await fetchVideoMetadata(video.id);
          fetched.set(video.id, { details, meta });
        } catch (e) {
          console.error('Refresh failed for', video.id, e);
        }
      }
      let refreshed = 0;
      await storage.update(STORAGE_KEYS.VIDEOS, (fresh = []) => {
        for (const video of fresh) {
          const r = fetched.get(video.id);
          if (!r) continue;
          if (r.details.duration) video.duration = r.details.duration;
          if (r.details.uploadDate) video.uploadedAt = r.details.uploadDate;
          if (r.meta?.title) video.title = r.meta.title;
          if (r.meta?.channel) video.channel = r.meta.channel;
          refreshed++;
        }
        return fresh;
      });
      broadcast({ type: MSG.VIDEOS_UPDATED });
      return { refreshed };
    }

    case MSG.OPEN_VIDEO: {
      // Smart play: if the video is already open in some tab, focus that tab
      // instead of navigating/creating one. extractVideoId rejects non-YouTube
      // hosts internally, so lookalike domains can never be focused. No
      // whitelisting needed — nothing navigates on this path.
      const targetVid = extractVideoId(message.url);
      if (targetVid) {
        const all = await chrome.tabs.query({});
        const matchTabs = all.filter(t => t.url && isYouTubeHost(t.url) && extractVideoId(t.url) === targetVid);
        if (matchTabs.length > 0) {
          // Prefer a match in the last-focused window, else the first match
          const [act] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          const pick = (act && matchTabs.find(t => t.windowId === act.windowId)) || matchTabs[0];
          await chrome.tabs.update(pick.id, { active: true });
          try { await chrome.windows.update(pick.windowId, { focused: true }); } catch {}
          return { tabId: pick.id, focused: true };
        }
      }

      // Smart open: replace current YT tab or open new tab
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (activeTab && isYouTubeHost(activeTab.url)) {
        await whitelistExtensionTab(activeTab.id, 5000);
        await chrome.tabs.update(activeTab.id, { url: message.url });
        return { tabId: activeTab.id, replaced: true };
      } else {
        const tab = await chrome.tabs.create({ url: message.url, active: true });
        await whitelistExtensionTab(tab.id, 30000);
        return { tabId: tab.id, replaced: false };
      }
    }

    case MSG.OPEN_VIDEO_NEW_TAB: {
      const tab = await chrome.tabs.create({ url: message.url, active: false });
      await whitelistExtensionTab(tab.id, 30000);
      return { tabId: tab.id };
    }

    case MSG.TAG_STARRED: {
      const vid = message.videoId;
      if (!vid) return { success: false };
      // Check queue first
      let inQueue = false;
      await storage.update(STORAGE_KEYS.VIDEOS, (videos = []) => {
        const qv = videos.find(v => v.id === vid);
        if (!qv) return undefined;
        inQueue = true;
        qv.starred = true;
        return videos;
      });
      if (inQueue) {
        broadcast({ type: MSG.VIDEOS_UPDATED });
        return { success: true };
      }
      // Check logged videos
      let inLog = false;
      await storage.update(STORAGE_KEYS.LOGGED_VIDEOS, (logged = []) => {
        const lv = logged.find(v => v.id === vid);
        if (!lv) return undefined;
        inLog = true;
        lv.starred = true;
        return logged;
      });
      // Not found anywhere — log it as starred
      if (!inLog && message.url) {
        await logVideoSilently(message.url, vid, true);
      }
      return { success: true };
    }

    case MSG.MEDIA_CONTROL: {
      // Forward media commands to the tab the panel is displaying (passed as
      // message.tabId), falling back to the active YouTube tab
      let targetId = null;
      if (message.tabId) {
        try {
          const tab = await chrome.tabs.get(message.tabId);
          if (isYouTubeHost(tab?.url)) targetId = tab.id;
        } catch {}
      }
      if (!targetId) {
        const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (isYouTubeHost(activeTab?.url)) targetId = activeTab.id;
      }
      if (targetId) {
        try {
          return await chrome.tabs.sendMessage(targetId, {
            type: MSG.MEDIA_COMMAND,
            action: message.action,
            // Optional forward/rewind override (contract: default 10 in the
            // content script when absent)
            seconds: message.seconds,
          });
        } catch {}
      }
      return { success: false, error: 'No YouTube tab found' };
    }

    case MSG.SKIP_VIDEO: {
      const currentVideoId = message.videoId;

      // Mark current as watched if it's in the queue — ALL entries with that
      // id, across sessions ("I watched it" is a fact about the video)
      let marked = false;
      const videos = await storage.update(STORAGE_KEYS.VIDEOS, (vids = []) => {
        if (currentVideoId) {
          for (const video of vids) {
            if (video.id === currentVideoId && !video.watched) {
              video.watched = true;
              marked = true;
            }
          }
        }
        return vids;
      });
      if (marked) broadcast({ type: MSG.VIDEOS_UPDATED });

      // One batch → one update → contiguous seqs (skip yields up to 2 events)
      const skipEvents = [{
        type: 'skipped', videoId: currentVideoId ?? null,
        source: 'manual', tabId: message.tabId ?? null,
      }];
      if (marked) {
        const mv = videos.find(v => v.id === currentVideoId);
        skipEvents.push({
          type: 'marked_watched', videoId: currentVideoId,
          title: mv?.title ?? null, channel: mv?.channel ?? null,
          durationSec: mv?.duration ?? null, isShort: mv?.isShort,
          source: 'manual', tabId: message.tabId ?? null,
        });
      }
      await logActivity(skipEvents);

      // Use the ordered next-video list from the side panel if provided
      let nextVideo = null;
      const nextIds = message.nextVideoIds || [];
      for (const nid of nextIds) {
        const v = videos.find(vv => vv.id === nid && !vv.watched);
        if (v) { nextVideo = v; break; }
      }

      // Fallback: use default sort if no list provided — scoped to the active
      // session so skip never jumps into a hidden session's video
      if (!nextVideo) {
        const settings = await storage.get(STORAGE_KEYS.SETTINGS) || DEFAULT_SETTINGS;
        const activeSessionId = await getActiveSessionId();
        const unwatched = videos.filter(v => !v.watched && sessOf(v) === activeSessionId);
        const sorted = sortVideosList(unwatched, settings.sortBy || 'addedAt', settings.sortDirection || 'desc');
        if (sorted.length > 0) nextVideo = sorted[0];
      }

      if (nextVideo) {
        // Navigate the tab that was playing (passed by the panel), falling
        // back to the active YouTube tab, else open a new tab — never hijack
        // an unrelated tab the user is reading
        let targetTab = null;
        if (message.tabId) {
          try {
            const tab = await chrome.tabs.get(message.tabId);
            if (isYouTubeHost(tab?.url)) targetTab = tab;
          } catch {}
        }
        if (!targetTab) {
          const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (isYouTubeHost(activeTab?.url)) targetTab = activeTab;
        }
        if (targetTab) {
          await whitelistExtensionTab(targetTab.id, 5000);
          await chrome.tabs.update(targetTab.id, { url: nextVideo.url });
          return { success: true, nextId: nextVideo.id };
        } else {
          const tab = await chrome.tabs.create({ url: nextVideo.url, active: true });
          await whitelistExtensionTab(tab.id, 30000);
          return { success: true, nextId: nextVideo.id };
        }
      }
      return { success: true, nextId: null };
    }

    case MSG.MARK_WATCHED: {
      // Content-script callers have no session context — mark EVERY entry
      // with this id, across all sessions (contract §3)
      let changed = false;
      let markedVideo = null; // captured in the updateFn closure — no second read
      await storage.update(STORAGE_KEYS.VIDEOS, (videos = []) => {
        for (const video of videos) {
          if (video.id === message.videoId && !video.watched) {
            video.watched = true;
            changed = true;
            if (!markedVideo) markedVideo = video;
          }
        }
        return changed ? videos : undefined;
      });
      if (changed) {
        broadcast({ type: MSG.VIDEOS_UPDATED });
        // source 'content' = the 20% auto-rule (manual panel marks go through
        // UPDATE_VIDEO with source 'manual')
        await logActivity({
          type: 'marked_watched', videoId: message.videoId,
          title: markedVideo?.title ?? null, channel: markedVideo?.channel ?? null,
          durationSec: markedVideo?.duration ?? null, isShort: markedVideo?.isShort,
          source: 'content', tabId: sender.tab?.id ?? null,
        });
      }
      return { success: true };
    }

    case MSG.VIDEO_ENDED: {
      // Completion is logged BEFORE the autoPlayNext early-return — the event
      // fires even with Autoplay off (stage 06, plan decision #14)
      if (message.videoId) {
        const known = ((await storage.get(STORAGE_KEYS.VIDEOS)) || [])
          .find(v => v.id === message.videoId);
        await logActivity({
          type: 'video_completed', videoId: message.videoId,
          title: known?.title ?? null, channel: known?.channel ?? null,
          durationSec: known?.duration ?? null, isShort: known?.isShort,
          maxPercent: 100, source: 'content', tabId: sender.tab?.id ?? null,
        });
      }

      const settings = await storage.get(STORAGE_KEYS.SETTINGS);
      if (!settings?.autoPlayNext) return { autoPlayed: false };

      const videos = await storage.get(STORAGE_KEYS.VIDEOS) || [];

      // Use the stored next-video order from the side panel if available
      let nextVideo = null;
      const storedOrder = await storage.get(STORAGE_KEYS.NEXT_VIDEO_ORDER);
      if (storedOrder && Array.isArray(storedOrder)) {
        for (const nid of storedOrder) {
          const v = videos.find(vv => vv.id === nid && !vv.watched);
          if (v) { nextVideo = v; break; }
        }
      }

      // Fallback — active session only (the stored panel order is already
      // session-filtered; this path must match that scoping)
      if (!nextVideo) {
        const activeSessionId = await getActiveSessionId();
        const unwatched = videos.filter(v => !v.watched && sessOf(v) === activeSessionId);
        const sorted = sortVideosList(unwatched, settings.sortBy || 'addedAt', settings.sortDirection || 'desc');
        if (sorted.length > 0) nextVideo = sorted[0];
      }

      if (nextVideo) {
        const tabId = sender.tab?.id;
        if (tabId) {
          await whitelistExtensionTab(tabId, 5000);
          await chrome.tabs.update(tabId, { url: nextVideo.url });
          return { autoPlayed: true, videoId: nextVideo.id };
        }
      }
      return { autoPlayed: false };
    }

    // --- Sessions (yt_sessions) ---
    // All session mutations go through storage.update; the module-global
    // writeQueue in utils/storage.js serializes across keys, so the ordered
    // videos-then-sessions updates in DELETE/MERGE never interleave.

    case MSG.GET_SESSIONS:
      return await getSessions();

    case MSG.CREATE_SESSION: {
      const name = (message.name || '').trim().slice(0, 40);
      if (!name) return { error: 'Empty name' };
      const session = { id: newSessionId(), name, createdAt: Date.now() };
      let fromSessionId = null;
      const updated = await storage.update(STORAGE_KEYS.SESSIONS, (s) => {
        s = normalizeSessions(s);
        fromSessionId = s.activeId || 'main';
        s.list.push(session);
        s.activeId = session.id; // creating switches to it
        return s;
      });
      // Stage 06: creating a session switches to it — one event, one call site
      await logActivity({
        type: 'session_switched', videoId: null, source: 'manual', tabId: null,
        sessionId: session.id, fromSessionId, reason: 'create',
      });
      return { session, activeId: updated.activeId };
    }

    case MSG.RENAME_SESSION: {
      if (message.sessionId === 'main') return { error: 'Cannot rename Main' };
      const name = (message.name || '').trim().slice(0, 40);
      if (!name) return { error: 'Empty name' };
      let found = false;
      await storage.update(STORAGE_KEYS.SESSIONS, (s) => {
        s = normalizeSessions(s);
        const entry = s.list.find(x => x.id === message.sessionId);
        if (!entry) return undefined;
        found = true;
        entry.name = name;
        return s;
      });
      return found ? { success: true } : { error: 'Not found' };
    }

    case MSG.SET_ACTIVE_SESSION: {
      let activeId = null;
      let fromSessionId = null;
      await storage.update(STORAGE_KEYS.SESSIONS, (s) => {
        s = normalizeSessions(s);
        if (!s.list.some(x => x.id === message.sessionId)) return undefined;
        fromSessionId = s.activeId || 'main';
        s.activeId = message.sessionId;
        activeId = s.activeId;
        return s;
      });
      if (!activeId) return { error: 'Not found' };
      // Stage 06: switching to the already-active session logs nothing
      if (fromSessionId !== activeId) {
        await logActivity({
          type: 'session_switched', videoId: null, source: 'manual', tabId: null,
          sessionId: activeId, fromSessionId, reason: 'switch',
        });
      }
      return { success: true, activeId };
    }

    case MSG.DELETE_SESSION: {
      const sid = message.sessionId;
      if (sid === 'main') return { error: 'Cannot delete Main' };
      const sessions = await getSessions();
      if (!sessions.list.some(x => x.id === sid)) return { error: 'Not found' };
      // Order is load-bearing: videos FIRST, session entry SECOND. A worker
      // death in between leaves an empty-but-listed session (visible, user
      // can delete again); the reverse would orphan invisible videos.
      let removed = 0;
      await storage.update(STORAGE_KEYS.VIDEOS, (videos = []) => {
        const kept = videos.filter(v => sessOf(v) !== sid);
        removed = videos.length - kept.length;
        return kept;
      });
      await storage.update(STORAGE_KEYS.SESSIONS, (s) => {
        s = normalizeSessions(s);
        s.list = s.list.filter(x => x.id !== sid);
        if (s.activeId === sid) s.activeId = 'main';
        return s;
      });
      // Stage 06: deletion event — the deleted session is the "from" side
      await logActivity({
        type: 'session_switched', videoId: null, source: 'manual', tabId: null,
        sessionId: sessions.activeId === sid ? 'main' : sessions.activeId,
        fromSessionId: sid, reason: 'delete',
      });
      broadcast({ type: MSG.VIDEOS_UPDATED });
      return { success: true, removedVideos: removed };
    }

    case MSG.MERGE_SESSION: {
      const sid = message.sourceSessionId;
      if (sid === 'main') return { error: 'Cannot merge Main into itself' };
      const sessions = await getSessions();
      if (!sessions.list.some(x => x.id === sid)) return { error: 'Not found' };
      // Move source videos into Main. Duplicate ids: the Main entry wins
      // (keeps its addedAt ordering), starred is OR'd, watched is AND'd
      // (unwatched in either ⇒ unwatched). Videos first, sessions second.
      let moved = 0, duplicates = 0;
      await storage.update(STORAGE_KEYS.VIDEOS, (videos = []) => {
        const mainIds = new Map(videos.filter(v => sessOf(v) === 'main').map(v => [v.id, v]));
        const out = [];
        for (const v of videos) {
          if (sessOf(v) !== sid) { out.push(v); continue; }
          const dup = mainIds.get(v.id);
          if (dup) {
            duplicates++;
            dup.starred = dup.starred || v.starred;
            dup.watched = dup.watched && v.watched;
          } else {
            moved++;
            const mv = { ...v, sessionId: 'main' };
            out.push(mv);
            mainIds.set(mv.id, mv);
          }
        }
        return out;
      });
      await storage.update(STORAGE_KEYS.SESSIONS, (s) => {
        s = normalizeSessions(s);
        s.list = s.list.filter(x => x.id !== sid);
        s.activeId = 'main';
        return s;
      });
      // Stage 06: merging always lands in Main
      await logActivity({
        type: 'session_switched', videoId: null, source: 'manual', tabId: null,
        sessionId: 'main', fromSessionId: sid, reason: 'merge',
      });
      broadcast({ type: MSG.VIDEOS_UPDATED });
      return { success: true, moved, duplicates };
    }

    // --- Analytics (stage 06) ---

    case MSG.GET_SUGGEST_SCORES:
      // Lazy + cached inside getSuggestScores — recompute only when the log
      // advanced 25+ events past the cache; never on plain panel renders
      return await getSuggestScores();

    case MSG.LOG_ACTIVITY_EVENT: {
      // Generic append hook for other UI surfaces/feature groups — type
      // validated against the allowlist; tabId defaults to the sender's tab
      const ev = message.event;
      if (!ev || !EVENT_TYPES.has(ev.type)) {
        return { success: false, error: 'invalid event' };
      }
      await logActivity({ ...ev, tabId: ev.tabId ?? sender.tab?.id ?? null });
      return { success: true };
    }

    case MSG.OPEN_SIDE_PANEL: {
      // Sender fallback (stage 01): the in-page queue strip's "+N" pill is a
      // content-script caller that doesn't know its own tabId. Existing popup
      // callers (which pass tabId explicitly) are unaffected.
      const tabId = message.tabId ?? sender.tab?.id;
      if (tabId) {
        // Re-enable (with path — see updateSidePanelForTab) in case this tab
        // was disabled as non-YouTube. MUST be fire-and-forget: this handler
        // runs synchronously off the message event and open() needs the
        // caller's user gesture — any await before it consumes the gesture.
        chrome.sidePanel.setOptions({
          tabId,
          enabled: true,
          path: 'sidepanel/sidepanel.html',
        }).catch(() => {});
        await chrome.sidePanel.open({ tabId });
      }
      return { success: true };
    }

    default:
      return { error: 'Unknown message type: ' + message.type };
  }
}

// Module top level runs on every worker wake — self-healing open-tab set
// after MV3 worker death (no polling: tab events themselves wake the worker)
scheduleOpenTabRecompute();
