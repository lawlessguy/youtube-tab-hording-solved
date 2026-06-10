import { STORAGE_KEYS, DEFAULT_SETTINGS, DEFAULT_CATEGORIES, MSG } from '../utils/constants.js';
import * as storage from '../utils/storage.js';
import {
  extractVideoId, isYouTubeUrl, isShortUrl,
  fetchVideoMetadata, fetchVideoDetails, getThumbnailUrl
} from '../utils/youtube.js';

// Track recently created tabs for interception
const recentlyCreatedTabs = new Map();
// Tabs opened by the extension itself (whitelist from interception)
const extensionOpenedTabs = new Set();
// Track the last tab that had a playing video
let lastPlayingTabId = null;

// --- Initialization ---

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await storage.get(STORAGE_KEYS.SETTINGS);
  if (!settings) await storage.set(STORAGE_KEYS.SETTINGS, DEFAULT_SETTINGS);

  const categories = await storage.get(STORAGE_KEYS.CATEGORIES);
  if (!categories) {
    await storage.set(STORAGE_KEYS.CATEGORIES, DEFAULT_CATEGORIES);
  } else if (categories.length > 0 && typeof categories[0] === 'string') {
    // Migrate from string[] to {name, description}[]
    await storage.set(STORAGE_KEYS.CATEGORIES, categories.map(c => ({ name: c, description: '' })));
  }

  const videos = await storage.get(STORAGE_KEYS.VIDEOS);
  if (!videos) await storage.set(STORAGE_KEYS.VIDEOS, []);

  const logged = await storage.get(STORAGE_KEYS.LOGGED_VIDEOS);
  if (!logged) await storage.set(STORAGE_KEYS.LOGGED_VIDEOS, []);

  const watchTime = await storage.get(STORAGE_KEYS.WATCH_TIME);
  if (!watchTime) await storage.set(STORAGE_KEYS.WATCH_TIME, {});

  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
});

// --- Side Panel Visibility (hide on non-YouTube tabs) ---

function updateSidePanelForTab(tabId, url) {
  const isYouTube = url && url.includes('youtube.com');
  chrome.sidePanel.setOptions({ tabId, enabled: isYouTube }).catch(() => {});
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    updateSidePanelForTab(tab.id, tab.url);
  } catch {}
});

// --- Tab Interception ---

chrome.tabs.onCreated.addListener((tab) => {
  recentlyCreatedTabs.set(tab.id, Date.now());
  setTimeout(() => recentlyCreatedTabs.delete(tab.id), 10000);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  if (!recentlyCreatedTabs.has(tabId)) return;

  // Skip tabs opened by the extension itself
  if (extensionOpenedTabs.has(tabId)) {
    extensionOpenedTabs.delete(tabId);
    recentlyCreatedTabs.delete(tabId);
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
  await addVideoToQueue(changeInfo.url, videoId);

  if (interceptMode === 'close') {
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) {
      console.error('Failed to close intercepted tab:', e);
    }
  }

  broadcast({ type: MSG.VIDEOS_UPDATED });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  recentlyCreatedTabs.delete(tabId);
  if (lastPlayingTabId === tabId) lastPlayingTabId = null;
});

// --- Silent Background Logging ---

async function logVideoSilently(url, videoId, starred) {
  await storage.update(STORAGE_KEYS.LOGGED_VIDEOS, (logged = []) => {
    const existing = logged.find(v => v.id === videoId);
    if (existing) {
      existing.timestamp = Date.now();
      if (starred) existing.starred = true; // never unstar
      return logged;
    }
    logged.push({ id: videoId, url, isShort: isShortUrl(url), timestamp: Date.now(), starred: !!starred });
    return logged;
  });
}

// --- Video Queue ---

async function addVideoToQueue(url, videoId, explicitTimestamp, starred) {
  videoId = videoId || extractVideoId(url);
  if (!videoId) return null;

  // Insert a placeholder atomically (no network inside the storage lock),
  // then fill in metadata in the background. Two simultaneous adds of the
  // same video can no longer both pass the duplicate check.
  let inserted = null;
  await storage.update(STORAGE_KEYS.VIDEOS, (videos = []) => {
    const existing = videos.find(v => v.id === videoId);
    if (existing) {
      existing.addedAt = explicitTimestamp || Date.now();
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
      category: 'Uncategorized',
      watched: false,
      starred: !!starred,
    };
    videos.push(inserted);
    return videos;
  });

  broadcast({ type: MSG.VIDEOS_UPDATED });

  if (inserted) {
    // Fetch title, channel, duration & upload date in background (non-blocking)
    enrichVideo(videoId);
    // Auto-categorize if AI is configured and user has custom categories
    autoCategorizeSingle(videoId);
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

    if (tab.url.includes('youtube.com')) {
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

// --- AI Categorization ---

async function autoCategorizeSingle(videoId) {
  try {
    const settings = await storage.get(STORAGE_KEYS.SETTINGS);
    if (!settings?.autoCategorize) return;
    if (!settings?.geminiApiKey) return;

    const categories = await storage.get(STORAGE_KEYS.CATEGORIES) || [];
    if (categories.length <= 1) return; // Only "Uncategorized"

    const videos = await storage.get(STORAGE_KEYS.VIDEOS) || [];
    const video = videos.find(v => v.id === videoId);
    if (!video) return;

    const category = await categorizeWithGemini(video, categories, settings.geminiApiKey);
    if (category && category !== 'Uncategorized') {
      const freshVideos = await storage.get(STORAGE_KEYS.VIDEOS) || [];
      const idx = freshVideos.findIndex(v => v.id === videoId);
      if (idx !== -1) {
        freshVideos[idx].category = category;
        await storage.set(STORAGE_KEYS.VIDEOS, freshVideos);
        broadcast({ type: MSG.VIDEOS_UPDATED });
      }
    }
  } catch (e) {
    console.error('Auto-categorize failed:', e);
  }
}

async function categorizeWithGemini(video, categories, apiKey) {
  // Categories are now {name, description} objects
  const catNames = categories.map(c => c.name || c).filter(n => n !== 'Uncategorized');
  const catList = categories
    .filter(c => (c.name || c) !== 'Uncategorized')
    .map(c => {
      const name = c.name || c;
      const desc = c.description;
      return desc ? `- ${name}: ${desc}` : `- ${name}`;
    })
    .join('\n');

  const prompt = `Categorize this YouTube video into one of these categories:
${catList}

Video title: "${video.title}"
Channel: "${video.channel}"

Make your best guess. Respond with ONLY the exact category name, nothing else.`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );

  if (!response.ok) throw new Error('Gemini API error: ' + response.status);

  const data = await response.json();
  const result = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

  if (result && catNames.includes(result)) return result;

  // Fuzzy match (case-insensitive)
  const lower = result?.toLowerCase();
  const match = catNames.find(n => n.toLowerCase() === lower);
  return match || 'Uncategorized';
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
      const video = await addVideoToQueue(message.url, message.videoId);
      return video;
    }

    case MSG.REMOVE_VIDEO: {
      await storage.update(STORAGE_KEYS.VIDEOS, (videos = []) =>
        videos.filter(v => v.id !== message.videoId));
      return { success: true };
    }

    case MSG.UPDATE_VIDEO: {
      await storage.update(STORAGE_KEYS.VIDEOS, (videos = []) => {
        const video = videos.find(v => v.id === message.videoId);
        if (!video) return undefined;
        Object.assign(video, message.updates);
        return videos;
      });
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

      // Assign timestamps so first tab gets highest value (appears first in desc sort)
      const baseTime = Date.now();
      for (let i = 0; i < ytTabs.length; i++) {
        const tab = ytTabs[i];
        const videoId = extractVideoId(tab.url);
        if (videoId) {
          const timestamp = baseTime + (ytTabs.length - i);
          const video = await addVideoToQueue(tab.url, videoId, timestamp);
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
        const video = await addVideoToQueue(entry.url, entry.id, entry.timestamp, entry.starred);
        if (video) added++;
      }

      return { added, tabIds: ytTabs.map(t => t.id) };
    }

    case MSG.CLOSE_YT_TABS: {
      const tabIds = message.tabIds || [];
      // Preserve the currently active YouTube tab
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const toClose = activeTab ? tabIds.filter(id => id !== activeTab.id) : tabIds;
      if (toClose.length > 0) await chrome.tabs.remove(toClose);
      return { closed: toClose.length };
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

    case 'CLOSE_SHORTS_TABS': {
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

    case MSG.CATEGORIZE_AI: {
      const settings = await storage.get(STORAGE_KEYS.SETTINGS) || {};
      if (!settings.geminiApiKey) return { error: 'No API key — add your Gemini key below' };

      const categories = await storage.get(STORAGE_KEYS.CATEGORIES) || DEFAULT_CATEGORIES;
      const customCats = categories.filter(c => (c.name || c) !== 'Uncategorized');
      if (customCats.length === 0) return { error: 'Create categories first (use + button)' };

      const videos = await storage.get(STORAGE_KEYS.VIDEOS) || [];
      const toCategorize = videos.filter(v => !v.watched);
      if (toCategorize.length === 0) return { error: 'No videos to categorize' };

      if (message.videoId) {
        // Single video
        const video = videos.find(v => v.id === message.videoId);
        if (!video) return { error: 'Video not found' };
        try {
          const category = await categorizeWithGemini(video, categories, settings.geminiApiKey);
          const idx = videos.findIndex(v => v.id === message.videoId);
          if (idx !== -1) {
            videos[idx].category = category;
            await storage.set(STORAGE_KEYS.VIDEOS, videos);
          }
          return { category };
        } catch (e) {
          return { error: e.message };
        }
      } else {
        // All unwatched videos
        let categorized = 0;
        let lastError = null;
        for (const video of toCategorize) {
          try {
            const category = await categorizeWithGemini(video, categories, settings.geminiApiKey);
            const idx = videos.findIndex(v => v.id === video.id);
            if (idx !== -1 && category) {
              videos[idx].category = category;
              categorized++;
            }
          } catch (e) {
            lastError = e.message;
            console.error('AI categorize failed for', video.id, e);
          }
        }
        await storage.set(STORAGE_KEYS.VIDEOS, videos);
        broadcast({ type: MSG.VIDEOS_UPDATED });
        if (categorized === 0 && lastError) {
          return { error: lastError, categorized: 0 };
        }
        return { categorized };
      }
    }

    case 'GET_MEDIA_STATE': {
      // Every return includes tabId so the panel can route media commands
      // back to the tab it is actually displaying
      const empty = { paused: true, currentTime: 0, duration: 0, videoId: null, tabId: null };

      async function queryTab(tabId) {
        try {
          const state = await chrome.tabs.sendMessage(tabId, { type: 'GET_MEDIA_STATE' });
          return state && state.videoId ? { ...state, tabId } : null;
        } catch { return null; }
      }

      // 1. Check active tab — if it's playing, it takes priority
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (activeTab?.url?.includes('youtube.com')) {
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
          if (tab?.url?.includes('youtube.com')) {
            const state = await queryTab(lastPlayingTabId);
            if (state && !state.paused) {
              return state;
            }
          }
        } catch {
          lastPlayingTabId = null;
        }
      }

      // 3. Scan all YouTube tabs for any playing video
      const allTabs = await chrome.tabs.query({});
      for (const t of allTabs) {
        if (!t.url?.includes('youtube.com')) continue;
        const state = await queryTab(t.id);
        if (state && !state.paused) {
          lastPlayingTabId = t.id;
          return state;
        }
      }

      // 4. Nothing playing — check active tab for paused state (so card shows if on a YT tab)
      if (activeTab?.url?.includes('youtube.com')) {
        const state = await queryTab(activeTab.id);
        if (state) {
          return state;
        }
      }

      lastPlayingTabId = null;
      return empty;
    }

    case 'REFRESH_METADATA': {
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
      // Smart open: replace current YT tab or open new tab
      const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (activeTab && activeTab.url && activeTab.url.includes('youtube.com')) {
        extensionOpenedTabs.add(activeTab.id);
        setTimeout(() => extensionOpenedTabs.delete(activeTab.id), 5000);
        await chrome.tabs.update(activeTab.id, { url: message.url });
        return { tabId: activeTab.id, replaced: true };
      } else {
        const tab = await chrome.tabs.create({ url: message.url, active: true });
        extensionOpenedTabs.add(tab.id);
        setTimeout(() => extensionOpenedTabs.delete(tab.id), 30000);
        return { tabId: tab.id, replaced: false };
      }
    }

    case MSG.OPEN_VIDEO_NEW_TAB: {
      const tab = await chrome.tabs.create({ url: message.url, active: false });
      extensionOpenedTabs.add(tab.id);
      setTimeout(() => extensionOpenedTabs.delete(tab.id), 30000);
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

    case MSG.GET_QUEUED_IDS: {
      const videos = await storage.get(STORAGE_KEYS.VIDEOS) || [];
      const queued = videos.filter(v => !v.watched).map(v => v.id);
      const watched = videos.filter(v => v.watched).map(v => v.id);
      return { ids: queued, watched };
    }

    case MSG.RESET_CATEGORIES: {
      const videos = await storage.get(STORAGE_KEYS.VIDEOS) || [];
      videos.forEach(v => { v.category = 'Uncategorized'; });
      await storage.set(STORAGE_KEYS.VIDEOS, videos);
      broadcast({ type: MSG.VIDEOS_UPDATED });
      return { success: true, reset: videos.length };
    }

    case MSG.MEDIA_CONTROL: {
      // Forward media commands to the tab the panel is displaying (passed as
      // message.tabId), falling back to the active YouTube tab
      let targetId = null;
      if (message.tabId) {
        try {
          const tab = await chrome.tabs.get(message.tabId);
          if (tab?.url?.includes('youtube.com')) targetId = tab.id;
        } catch {}
      }
      if (!targetId) {
        const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (activeTab?.url?.includes('youtube.com')) targetId = activeTab.id;
      }
      if (targetId) {
        try {
          return await chrome.tabs.sendMessage(targetId, {
            type: MSG.MEDIA_COMMAND,
            action: message.action,
          });
        } catch {}
      }
      return { success: false, error: 'No YouTube tab found' };
    }

    case MSG.SKIP_VIDEO: {
      const currentVideoId = message.videoId;

      // Mark current as watched if it's in the queue
      let marked = false;
      const videos = await storage.update(STORAGE_KEYS.VIDEOS, (vids = []) => {
        if (currentVideoId) {
          const video = vids.find(v => v.id === currentVideoId);
          if (video && !video.watched) {
            video.watched = true;
            marked = true;
          }
        }
        return vids;
      });
      if (marked) broadcast({ type: MSG.VIDEOS_UPDATED });

      // Use the ordered next-video list from the side panel if provided
      let nextVideo = null;
      const nextIds = message.nextVideoIds || [];
      for (const nid of nextIds) {
        const v = videos.find(vv => vv.id === nid && !vv.watched);
        if (v) { nextVideo = v; break; }
      }

      // Fallback: use default sort if no list provided
      if (!nextVideo) {
        const settings = await storage.get(STORAGE_KEYS.SETTINGS) || DEFAULT_SETTINGS;
        const unwatched = videos.filter(v => !v.watched);
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
            if (tab?.url?.includes('youtube.com')) targetTab = tab;
          } catch {}
        }
        if (!targetTab) {
          const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (activeTab?.url?.includes('youtube.com')) targetTab = activeTab;
        }
        if (targetTab) {
          extensionOpenedTabs.add(targetTab.id);
          setTimeout(() => extensionOpenedTabs.delete(targetTab.id), 5000);
          await chrome.tabs.update(targetTab.id, { url: nextVideo.url });
          return { success: true, nextId: nextVideo.id };
        } else {
          const tab = await chrome.tabs.create({ url: nextVideo.url, active: true });
          extensionOpenedTabs.add(tab.id);
          setTimeout(() => extensionOpenedTabs.delete(tab.id), 30000);
          return { success: true, nextId: nextVideo.id };
        }
      }
      return { success: true, nextId: null };
    }

    case MSG.MARK_WATCHED: {
      let changed = false;
      await storage.update(STORAGE_KEYS.VIDEOS, (videos = []) => {
        const video = videos.find(v => v.id === message.videoId);
        if (!video || video.watched) return undefined;
        video.watched = true;
        changed = true;
        return videos;
      });
      if (changed) broadcast({ type: MSG.VIDEOS_UPDATED });
      return { success: true };
    }

    case MSG.VIDEO_ENDED: {
      const settings = await storage.get(STORAGE_KEYS.SETTINGS);
      if (!settings?.autoPlayNext) return { autoPlayed: false };

      const videos = await storage.get(STORAGE_KEYS.VIDEOS) || [];

      // Use the stored next-video order from the side panel if available
      let nextVideo = null;
      const storedOrder = await storage.get('yt_next_video_order');
      if (storedOrder && Array.isArray(storedOrder)) {
        for (const nid of storedOrder) {
          const v = videos.find(vv => vv.id === nid && !vv.watched);
          if (v) { nextVideo = v; break; }
        }
      }

      // Fallback
      if (!nextVideo) {
        const unwatched = videos.filter(v => !v.watched);
        const sorted = sortVideosList(unwatched, settings.sortBy || 'addedAt', settings.sortDirection || 'desc');
        if (sorted.length > 0) nextVideo = sorted[0];
      }

      if (nextVideo) {
        const tabId = sender.tab?.id;
        if (tabId) {
          extensionOpenedTabs.add(tabId);
          setTimeout(() => extensionOpenedTabs.delete(tabId), 5000);
          await chrome.tabs.update(tabId, { url: nextVideo.url });
          return { autoPlayed: true, videoId: nextVideo.id };
        }
      }
      return { autoPlayed: false };
    }

    case MSG.OPEN_TAB: {
      const tab = await chrome.tabs.create({ url: message.url });
      extensionOpenedTabs.add(tab.id);
      setTimeout(() => extensionOpenedTabs.delete(tab.id), 30000);
      return { tabId: tab.id };
    }

    case MSG.OPEN_SIDE_PANEL: {
      if (message.tabId) {
        await chrome.sidePanel.open({ tabId: message.tabId });
      }
      return { success: true };
    }

    default:
      return { error: 'Unknown message type: ' + message.type };
  }
}
