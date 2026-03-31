/* Side Panel — now-playing priority slot, toggle bar, content tabs */

let currentSort = 'addedAt';
let sortDirection = 'desc';
let watchedCollapsed = true;
let activeTab = 'videos'; // 'videos' or 'shorts'
let searchQuery = '';
let starFilterActive = false;
let nowPlayingVideoId = null;
let lastMediaState = null;
let cachedVideos = [];

// --- Helpers ---
function fmt(min) {
  if (min < 60) return Math.round(min) + 'm';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m > 0 ? h + 'h ' + m + 'm' : h + 'h';
}

function dur(sec) {
  if (!sec) return '--:--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = n => String(n).padStart(2, '0');
  return h > 0 ? h + ':' + p(m) + ':' + p(s) : m + ':' + p(s);
}

function ago(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function el(tag, attrs, children) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k.startsWith('data-')) n.setAttribute(k, v);
      else n[k] = v;
    }
  }
  if (children) {
    for (const c of Array.isArray(children) ? children : [children]) {
      if (typeof c === 'string') n.appendChild(document.createTextNode(c));
      else if (c) n.appendChild(c);
    }
  }
  return n;
}

function msg(data) { return chrome.runtime.sendMessage(data); }
function openVideo(url) { msg({ type: 'OPEN_VIDEO', url }); }

// --- Watch Time ---
async function loadWatchTime() {
  try {
    const wt = await msg({ type: 'GET_WATCH_TIME' });
    document.getElementById('watch-today').textContent = fmt(wt.today);
    document.getElementById('watch-week').textContent = fmt(wt.week);
    document.getElementById('watch-month').textContent = fmt(wt.month);
    document.getElementById('watch-year').textContent = fmt(wt.year);
  } catch {}
}

// --- Settings ---
async function loadSettings() {
  try {
    const s = await msg({ type: 'GET_SETTINGS' });
    document.getElementById('volume-slider').value = s.volumeLevel;
    document.getElementById('volume-value').textContent = s.volumeLevel + '%';
    document.getElementById('speed-slider').value = Math.round(s.speedLevel * 10);
    document.getElementById('speed-value').textContent = s.speedLevel.toFixed(1) + 'x';

    setInterceptState(s.interceptEnabled || 'off');
    document.getElementById('tb-autoplay').classList.toggle('active', !!s.autoPlayNext);
    document.getElementById('tb-videoinfo').classList.toggle('active', !!s.showVideoInfo);
    document.getElementById('tb-hiderecs').classList.toggle('active', !!s.hideRecs);

    currentSort = s.sortBy || 'addedAt';
    if (currentSort === 'custom') currentSort = 'addedAt';
    sortDirection = s.sortDirection || 'desc';
    updateSortUI();
  } catch {}
}

// --- Videos ---
async function loadVideos() {
  try {
    const allVideos = await msg({ type: 'GET_VIDEOS' });
    cachedVideos = allVideos;
    const unwatched = allVideos.filter(v => !v.watched);
    const watched = allVideos.filter(v => v.watched);

    let filtered = unwatched;
    if (starFilterActive) filtered = filtered.filter(v => v.starred);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(v =>
        (v.title || '').toLowerCase().includes(q) ||
        (v.channel || '').toLowerCase().includes(q)
      );
    }

    // Filter out the now-playing video from the regular list
    const regular = filtered.filter(v => !v.isShort && v.id !== nowPlayingVideoId);
    const shorts = filtered.filter(v => v.isShort && v.id !== nowPlayingVideoId);

    document.getElementById('video-count').textContent = regular.length;
    document.getElementById('shorts-count').textContent = shorts.length;
    document.getElementById('watched-count').textContent = watched.length;

    renderVideoList('video-list', sortVids(regular), null, false);
    renderVideoList('shorts-list', sortVids(shorts), null, false);
    renderVideoList('watched-list', sortVids(watched), null, true);

    document.getElementById('video-list').style.display = activeTab === 'videos' ? '' : 'none';
    document.getElementById('shorts-list').style.display = activeTab === 'shorts' ? '' : 'none';

    applyCollapsed('watched-list', '#watched-header .collapse-icon', watchedCollapsed);
    storeVisibleVideoOrder();
  } catch (e) { console.error('Videos error:', e); }
}

// Returns the ordered list of video IDs as currently visible in the side panel
function getVisibleVideoOrder() {
  const listId = activeTab === 'videos' ? 'video-list' : 'shorts-list';
  return [...document.querySelectorAll('#' + listId + ' .video-item')]
    .map(item => item.dataset.id).filter(Boolean);
}

// Persist the visible order to storage so auto-play (VIDEO_ENDED) can use it
function storeVisibleVideoOrder() {
  const order = getVisibleVideoOrder();
  chrome.storage.local.set({ yt_next_video_order: order });
}

function applyCollapsed(listId, iconSel, isCollapsed) {
  document.getElementById(listId).classList.toggle('collapsed', isCollapsed);
  document.querySelector(iconSel)?.classList.toggle('collapsed', isCollapsed);
}

function sortVids(videos) {
  return [...videos].sort((a, b) => {
    let va, vb;
    switch (currentSort) {
      case 'duration': va = a.duration || 0; vb = b.duration || 0; break;
      case 'uploadedAt':
        va = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
        vb = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0; break;
      default: va = a.addedAt || 0; vb = b.addedAt || 0;
    }
    return sortDirection === 'asc' ? va - vb : vb - va;
  });
}

// --- Video Card ---
function buildVideoItem(v, _unused, isWatched) {
  const thumbImg = el('img', { class: 'video-thumb', src: v.thumbnail, alt: '', loading: 'lazy' });
  thumbImg.addEventListener('error', () => { thumbImg.style.background = '#333'; });
  const thumbWrap = el('div', { class: 'thumb-wrap' }, [thumbImg]);
  if (v.duration) thumbWrap.appendChild(el('span', { class: 'thumb-duration', text: dur(v.duration) }));

  const playBtn = el('button', { class: 'card-play-btn', text: '\u25B6' });
  playBtn.addEventListener('click', e => { e.stopPropagation(); openVideo(v.url); });

  const removeBtn = el('button', { class: 'card-sm-btn', text: '\u2715' });
  removeBtn.addEventListener('click', e => {
    e.stopPropagation();
    msg({ type: 'REMOVE_VIDEO', videoId: v.id }).then(loadVideos);
  });

  let watchBtn;
  if (isWatched) {
    watchBtn = el('button', { class: 'card-sm-btn', text: '\u21A9' });
    watchBtn.addEventListener('click', e => {
      e.stopPropagation();
      msg({ type: 'UPDATE_VIDEO', videoId: v.id, updates: { watched: false } }).then(loadVideos);
    });
  } else {
    watchBtn = el('button', { class: 'card-sm-btn', text: '\u2713' });
    watchBtn.addEventListener('click', e => {
      e.stopPropagation();
      msg({ type: 'UPDATE_VIDEO', videoId: v.id, updates: { watched: true } }).then(loadVideos);
    });
  }

  const starBtn = el('button', { class: 'card-star-btn' + (v.starred ? ' starred' : ''), text: '\u2605' });
  starBtn.addEventListener('click', e => {
    e.stopPropagation();
    const newVal = !v.starred;
    msg({ type: 'UPDATE_VIDEO', videoId: v.id, updates: { starred: newVal } }).then(loadVideos);
  });

  const metaChildren = [
    el('span', { text: v.channel || 'Unknown' }),
    el('span', { class: 'dot', text: ' ' }),
    el('span', { text: dur(v.duration) }),
    el('span', { class: 'dot', text: ' ' }),
    el('span', { text: 'Added ' + ago(v.addedAt) }),
  ];
  if (v.uploadedAt) {
    metaChildren.push(el('span', { class: 'dot', text: ' ' }));
    metaChildren.push(el('span', { text: 'Uploaded ' + fmtDate(v.uploadedAt) }));
  }

  const item = el('div', {
    class: 'video-item' + (isWatched ? ' watched' : ''),
    'data-id': v.id,
    draggable: isWatched ? 'false' : 'true',
  }, [
    thumbWrap,
    el('div', { class: 'video-info' }, [
      el('div', { class: 'video-title', title: v.title || '', text: v.title || 'Unknown' }),
      el('div', { class: 'video-meta' }, metaChildren),
    ]),
    el('div', { class: 'card-right' }, [playBtn, el('div', { class: 'card-bottom-actions' }, [starBtn, removeBtn, watchBtn])]),
  ]);

  item.addEventListener('dblclick', e => {
    if (e.target.closest('select') || e.target.closest('button')) return;
    openVideo(v.url);
  });

  // Middle-click opens in new background tab, bypassing intercept
  item.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
  item.addEventListener('auxclick', e => {
    if (e.button === 1) {
      e.preventDefault();
      msg({ type: 'OPEN_VIDEO_NEW_TAB', url: v.url });
    }
  });

  return item;
}

function renderVideoList(containerId, videos, categories, isWatched) {
  const container = document.getElementById(containerId);
  const wasCollapsed = container.classList.contains('collapsed');
  container.textContent = '';
  if (!videos.length) {
    container.appendChild(el('div', { class: 'empty-state', text: isWatched ? 'No watched videos' : 'No videos' }));
  } else {
    videos.forEach(v => container.appendChild(buildVideoItem(v, categories, isWatched)));
    if (!isWatched) setupDragDrop(container);
  }
  if (wasCollapsed) container.classList.add('collapsed');
}

// --- Now Playing (Active Video Priority Slot) ---
function buildNowPlayingCard(video, state) {
  const pct = state.duration > 0 ? (state.currentTime / state.duration) * 100 : 0;

  const thumbImg = el('img', { class: 'np-thumb', src: video.thumbnail, alt: '' });
  const thumbWrap = el('div', { class: 'np-thumb-wrap' }, [thumbImg]);
  if (video.duration) thumbWrap.appendChild(el('span', { class: 'thumb-duration', text: dur(video.duration) }));

  const progressFill = el('div', { class: 'np-progress-fill', style: { width: pct + '%' } });
  const timeText = el('span', { class: 'np-time', text: dur(Math.floor(state.currentTime)) + ' / ' + dur(Math.floor(state.duration)) });

  // Media buttons
  const rewindBtn = el('button', { class: 'np-btn' }, [
    el('svg', {}),
    el('span', { class: 'np-btn-label', text: '10' }),
  ]);
  // Build SVGs via innerHTML on a wrapper (safe — no user data)
  rewindBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg><span class="np-btn-label">10</span>';
  rewindBtn.addEventListener('click', () => msg({ type: 'MEDIA_CONTROL', action: 'rewind' }));

  const playPauseBtn = el('button', { class: 'np-btn np-btn--play' });
  playPauseBtn.innerHTML = state.paused
    ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg>'
    : '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="5" y="3" width="5" height="18"/><rect x="14" y="3" width="5" height="18"/></svg>';
  playPauseBtn.addEventListener('click', async () => {
    const r = await msg({ type: 'MEDIA_CONTROL', action: 'playPause' });
    playPauseBtn.innerHTML = r.paused
      ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg>'
      : '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="5" y="3" width="5" height="18"/><rect x="14" y="3" width="5" height="18"/></svg>';
  });

  const forwardBtn = el('button', { class: 'np-btn' });
  forwardBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/></svg><span class="np-btn-label">10</span>';
  forwardBtn.addEventListener('click', () => msg({ type: 'MEDIA_CONTROL', action: 'forward' }));

  const skipBtn = el('button', { class: 'np-btn np-btn--skip' });
  skipBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="5,4 15,12 5,20"/><rect x="17" y="5" width="3" height="14"/></svg>';
  skipBtn.addEventListener('click', async () => {
    await msg({ type: 'SKIP_VIDEO', videoId: video.id, nextVideoIds: getVisibleVideoOrder() });
    loadVideos();
  });

  return el('div', { class: 'now-playing' }, [
    el('div', { class: 'np-main' }, [
      thumbWrap,
      el('div', { class: 'np-info' }, [
        el('div', { class: 'np-title', text: video.title || 'Unknown' }),
        el('div', { class: 'np-meta' }, [
          el('span', { text: video.channel || 'Unknown' }),
          el('span', { class: 'dot', text: ' ' }),
          el('span', { text: dur(video.duration) }),
        ]),
        el('div', { class: 'np-progress' }, [
          el('div', { class: 'np-progress-bar' }, [progressFill]),
          timeText,
        ]),
      ]),
    ]),
    el('div', { class: 'np-controls' }, [
      el('div', { class: 'np-media-btns' }, [rewindBtn, playPauseBtn, forwardBtn, skipBtn]),
    ]),
  ]);
}

function handleVideoUnpinned(videoId, state) {
  if (!videoId || !state) return;
  // Only apply 20% rule to videos that are in the queue
  const inQueue = cachedVideos.some(v => v.id === videoId && !v.watched);
  if (inQueue) {
    const progress = state.duration > 0 ? state.currentTime / state.duration : 0;
    if (progress >= 0.2) {
      msg({ type: 'UPDATE_VIDEO', videoId, updates: { watched: true } });
    }
  }
  loadVideos();
}

async function updateNowPlaying() {
  try {
    const state = await msg({ type: 'GET_MEDIA_STATE' });
    const slot = document.getElementById('now-playing');

    if (!state.videoId) {
      if (nowPlayingVideoId) {
        handleVideoUnpinned(nowPlayingVideoId, lastMediaState);
        nowPlayingVideoId = null;
      }
      slot.style.display = 'none';
      lastMediaState = state;
      return;
    }

    // Find video in queue, or build a minimal object for non-queued videos
    let video = cachedVideos.find(v => v.id === state.videoId);
    if (!video) {
      video = {
        id: state.videoId,
        title: 'Now Playing',
        channel: '',
        thumbnail: 'https://i.ytimg.com/vi/' + state.videoId + '/mqdefault.jpg',
        duration: state.duration ? Math.floor(state.duration) : 0,
        url: 'https://www.youtube.com/watch?v=' + state.videoId,
        _notInQueue: true,
      };
    }

    // Video changed — handle unpin of old one
    if (nowPlayingVideoId && nowPlayingVideoId !== state.videoId) {
      handleVideoUnpinned(nowPlayingVideoId, lastMediaState);
    }

    // Build or update the card
    if (nowPlayingVideoId !== state.videoId) {
      nowPlayingVideoId = state.videoId;
      slot.textContent = '';
      slot.appendChild(buildNowPlayingCard(video, state));
      slot.style.display = '';
      loadVideos(); // Re-filter to remove from regular list
    } else {
      // Incremental update — progress, time, play/pause icon
      const fill = slot.querySelector('.np-progress-fill');
      const time = slot.querySelector('.np-time');
      const playBtn = slot.querySelector('.np-btn--play');
      if (fill && state.duration > 0) fill.style.width = ((state.currentTime / state.duration) * 100) + '%';
      if (time) time.textContent = dur(Math.floor(state.currentTime)) + ' / ' + dur(Math.floor(state.duration));
      if (playBtn) {
        playBtn.innerHTML = state.paused
          ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg>'
          : '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="5" y="3" width="5" height="18"/><rect x="14" y="3" width="5" height="18"/></svg>';
      }
    }

    lastMediaState = state;
  } catch {}
}

// --- Content Tabs (Videos / Shorts) ---
document.querySelectorAll('.content-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.content-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeTab = tab.dataset.tab;
    document.getElementById('video-list').style.display = activeTab === 'videos' ? '' : 'none';
    document.getElementById('shorts-list').style.display = activeTab === 'shorts' ? '' : 'none';
    storeVisibleVideoOrder();
  });
});

// --- Watched Section ---
document.getElementById('watched-header').addEventListener('click', () => {
  watchedCollapsed = !watchedCollapsed;
  applyCollapsed('watched-list', '#watched-header .collapse-icon', watchedCollapsed);
});

// --- Toggle Icon Bar ---
const toggleMap = {
  'tb-autoplay': 'autoPlayNext',
  'tb-videoinfo': 'showVideoInfo',
  'tb-hiderecs': 'hideRecs',
};

// Intercept: 3-state cycle (off → close → keep → off)
const interceptStates = ['off', 'close', 'keep'];
const interceptDescs = {
  off: 'Intercept OFF — videos logged silently, click Collect to add',
  close: 'Intercept ON — add to queue and close tab',
  keep: 'Intercept ON — add to queue but keep tab open',
};

function setInterceptState(state) {
  if (state === true) state = 'close';
  if (state === false) state = 'off';
  const btn = document.getElementById('tb-intercept');
  btn.classList.remove('intercept-off', 'intercept-close', 'intercept-keep');
  btn.classList.add('intercept-' + state);
  btn.dataset.state = state;
  btn.dataset.desc = interceptDescs[state];
}

document.getElementById('tb-intercept').addEventListener('click', () => {
  const btn = document.getElementById('tb-intercept');
  const current = btn.dataset.state || 'off';
  const next = interceptStates[(interceptStates.indexOf(current) + 1) % interceptStates.length];
  setInterceptState(next);
  descEl.textContent = interceptDescs[next];
  msg({ type: 'UPDATE_SETTINGS', settings: { interceptEnabled: next } });
});

for (const [btnId, settingKey] of Object.entries(toggleMap)) {
  document.getElementById(btnId).addEventListener('click', e => {
    const btn = e.currentTarget;
    btn.classList.toggle('active');
    const enabled = btn.classList.contains('active');
    msg({ type: 'UPDATE_SETTINGS', settings: { [settingKey]: enabled } });
    if (settingKey === 'showVideoInfo' || settingKey === 'hideRecs') {
      broadcastToYouTubeTabs({ type: 'YT_UI_UPDATE' });
    }
  });
}

// Hover descriptions for ALL buttons with data-desc in toggle bar
const descEl = document.getElementById('toggle-desc');
document.querySelectorAll('.toggle-bar [data-desc]').forEach(btn => {
  btn.addEventListener('mouseenter', () => { descEl.textContent = btn.dataset.desc; });
});

// --- Drag and Drop ---
function setupDragDrop(container) {
  let dragId = null;
  container.querySelectorAll('.video-item').forEach(item => {
    item.addEventListener('dragstart', e => {
      dragId = item.dataset.id;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      container.querySelectorAll('.drag-over').forEach(x => x.classList.remove('drag-over'));
      dragId = null;
    });
    item.addEventListener('dragover', e => {
      e.preventDefault();
      if (dragId && item.dataset.id !== dragId) item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', async e => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (!dragId || item.dataset.id === dragId) return;

      const videos = await msg({ type: 'GET_VIDEOS' });
      const dv = videos.find(v => v.id === dragId);
      const tv = videos.find(v => v.id === item.dataset.id);
      if (!dv || !tv) return;

      const field = currentSort === 'duration' ? 'duration' : currentSort === 'uploadedAt' ? 'uploadedAt' : 'addedAt';
      if (field === 'uploadedAt') {
        const tmp = dv.uploadedAt; dv.uploadedAt = tv.uploadedAt; tv.uploadedAt = tmp;
      } else {
        const tmp = dv[field]; dv[field] = tv[field]; tv[field] = tmp;
      }

      await msg({ type: 'SET_VIDEOS', videos });
      loadVideos();
    });
  });
}

// --- Sort UI ---
function updateSortUI() {
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === currentSort));
  document.getElementById('sort-direction').textContent = sortDirection === 'desc' ? '\u2193' : '\u2191';
}

async function broadcastToYouTubeTabs(message) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.url?.includes('youtube.com')) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  }
}

// --- Search ---
document.getElementById('search-input').addEventListener('input', e => {
  searchQuery = e.target.value.trim();
  document.getElementById('search-clear').style.display = searchQuery ? '' : 'none';
  loadVideos();
});

document.getElementById('search-clear').addEventListener('click', () => {
  document.getElementById('search-input').value = '';
  searchQuery = '';
  document.getElementById('search-clear').style.display = 'none';
  loadVideos();
});

// --- Event Listeners ---

// Volume
document.getElementById('volume-slider').addEventListener('input', e => {
  document.getElementById('volume-value').textContent = e.target.value + '%';
});
document.getElementById('volume-slider').addEventListener('change', e => {
  msg({ type: 'SET_VOLUME', value: parseInt(e.target.value), scope: 'tab' });
});
document.getElementById('volume-reset').addEventListener('click', () => {
  document.getElementById('volume-slider').value = 100;
  document.getElementById('volume-value').textContent = '100%';
  msg({ type: 'SET_VOLUME', value: 100, scope: 'tab' });
});

// Speed
document.getElementById('speed-slider').addEventListener('input', e => {
  document.getElementById('speed-value').textContent = (parseInt(e.target.value) / 10).toFixed(1) + 'x';
});
document.getElementById('speed-slider').addEventListener('change', e => {
  msg({ type: 'SET_SPEED', value: parseInt(e.target.value) / 10, scope: 'tab' });
});
document.getElementById('speed-reset').addEventListener('click', () => {
  document.getElementById('speed-slider').value = 10;
  document.getElementById('speed-value').textContent = '1.0x';
  msg({ type: 'SET_SPEED', value: 1.0, scope: 'tab' });
});

// Collect tabs
document.getElementById('collect-tabs').addEventListener('click', async () => {
  await msg({ type: 'COLLECT_TABS' });
  loadVideos();
});

document.getElementById('close-tabs').addEventListener('click', async () => {
  // Close tabs matching videos in BOTH the videos and shorts lists
  const videoIds = [
    ...document.querySelectorAll('#video-list .video-item'),
    ...document.querySelectorAll('#shorts-list .video-item'),
  ].map(item => item.dataset.id).filter(Boolean);
  if (videoIds.length > 0) {
    await msg({ type: 'CLOSE_VISIBLE_TABS', videoIds });
  }
});

// Star filter
document.getElementById('star-filter').addEventListener('click', () => {
  starFilterActive = !starFilterActive;
  document.getElementById('star-filter').classList.toggle('active', starFilterActive);
  loadVideos();
  document.querySelector('.scroll-area').scrollTop = 0;
});

// Sort
document.querySelectorAll('.sort-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentSort = btn.dataset.sort;
    updateSortUI();
    msg({ type: 'UPDATE_SETTINGS', settings: { sortBy: currentSort } });
    loadVideos();
    document.querySelector('.scroll-area').scrollTop = 0;
  });
});
document.getElementById('sort-direction').addEventListener('click', () => {
  sortDirection = sortDirection === 'desc' ? 'asc' : 'desc';
  updateSortUI();
  msg({ type: 'UPDATE_SETTINGS', settings: { sortDirection } });
  loadVideos();
  document.querySelector('.scroll-area').scrollTop = 0;
});

// Refresh
document.getElementById('refresh-metadata').addEventListener('click', async () => {
  const btn = document.getElementById('refresh-metadata');
  btn.classList.add('spinning');
  btn.disabled = true;
  await msg({ type: 'REFRESH_METADATA' });
  btn.classList.remove('spinning');
  btn.disabled = false;
  loadVideos();
});

// Background updates
chrome.runtime.onMessage.addListener(m => { if (m.type === 'VIDEOS_UPDATED') loadVideos(); });

// --- Init ---
loadWatchTime();
loadSettings();
loadVideos();
updateNowPlaying();
setInterval(loadWatchTime, 5000);
setInterval(updateNowPlaying, 1500);
