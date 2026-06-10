/* Side Panel — now-playing priority slot, toggle bar, content tabs */

let currentSort = 'addedAt';
let sortDirection = 'desc';
let watchedCollapsed = true;
let activeTab = 'videos'; // 'videos' or 'shorts'
let searchQuery = '';
let starFilterActive = false;
let nowPlayingVideoId = null;
let lastMediaState = null;
let cachedVideos = []; // ACTIVE-SESSION videos only (see loadVideos)
// Channel filter is deliberately ephemeral (like search): cleared on panel
// reload and on session switch — never persisted
let channelFilter = null;
// Sessions: global active pointer in yt_sessions; missing video.sessionId
// reads as 'main' everywhere (contract rule)
let activeSessionId = 'main';
let sessionsCache = { activeId: 'main', list: [{ id: 'main', name: 'Main', createdAt: 0 }] };
let sessionInputMode = null; // 'new' | 'rename' | null
let confirmTimer = null;
// videoIds currently open in any Chrome tab — worker-maintained, read from
// chrome.storage.session (worker is the sole writer; see loadOpenTabIds)
let openTabIds = new Set();
// Suggested-sort scores: fetched from the worker (which lazily recomputes +
// caches); the panel additionally throttles its own requests to one per 60s.
// Never recomputed on plain renders.
let suggestScores = { channels: {} };
let lastScoreFetch = 0;

async function loadSuggestScores(force) {
  if (!force && Date.now() - lastScoreFetch < 60000) return;
  lastScoreFetch = Date.now();
  try {
    const r = await msg({ type: 'GET_SUGGEST_SCORES' });
    if (r?.channels) suggestScores = r;
  } catch {}
}

function channelScore(v) {
  const key = (v.channel || '').trim().toLowerCase();
  return suggestScores.channels[key]?.score ?? 0;
}

// Virtual scroll data — full sorted arrays (not rendered to DOM)
let dataVideos = [];
let dataShorts = [];
let dataWatched = [];
const CARD_HEIGHT = 63;      // full mode: .video-item height (59) + margin (4)
const SLIM_CARD_HEIGHT = 94; // slim mode: body.slim .video-item height (90) + margin (4)
const RENDER_BUFFER = 8; // Extra cards above/below viewport
// Panel display mode (yt_settings.panelMode). cardHeight() is the ONLY access
// point for virtual-scroll geometry (contract ruling 10) — each mode's
// constant must equal that mode's CSS height + margin exactly.
let panelMode = 'full'; // 'full' | 'slim'
function cardHeight() { return panelMode === 'slim' ? SLIM_CARD_HEIGHT : CARD_HEIGHT; }
const lastRenderKeys = new Map(); // containerId → rendered range, avoids redundant redraws

// Re-rendering while a card is being dragged destroys the dragged node and
// kills the drop, so renders are deferred until the drag ends
let dragId = null;
let dragInProgress = false;
let renderPendingAfterDrag = false;

// --- Helpers ---
// Round to whole minutes FIRST — rounding the remainder produced "1h 60m"
function fmt(min) {
  const total = Math.round(min);
  if (total < 60) return total + 'm';
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m > 0 ? h + 'h ' + m + 'm' : h + 'h';
}

function dur(sec) {
  if (!sec) return '--:--';
  sec = Math.floor(sec);
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

// speedLevel may hold ANY value in [0.1, 10] — native YouTube changes arrive
// as 0.25-step values (contract: shared fmtSpeed rendering, ≤2 decimals; the
// slider thumb rounds to the nearest 0.1 step but the label stays exact)
function fmtSpeed(v) {
  return Number(v).toFixed(2).replace(/(\.\d)0$/, '$1') + 'x';
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

// --- Open Tab Indicator State ---
// Written by the worker to chrome.storage.SESSION (key inlined: plain
// script). The panel is a trusted extension context, so it can read it.
async function loadOpenTabIds() {
  try {
    const r = await chrome.storage.session.get('yt_open_tab_ids');
    openTabIds = new Set(r.yt_open_tab_ids || []);
    lastRenderKeys.clear();
    renderVisibleCards();
  } catch {}
}

// --- Settings ---
async function loadSettings() {
  try {
    const s = await msg({ type: 'GET_SETTINGS' });
    document.getElementById('volume-slider').value = s.volumeLevel;
    document.getElementById('volume-value').textContent = s.volumeLevel + '%';
    document.getElementById('speed-slider').value = Math.round(s.speedLevel * 10);
    document.getElementById('speed-value').textContent = fmtSpeed(s.speedLevel);

    setInterceptState(s.interceptEnabled || 'off');
    document.getElementById('tb-autoplay').classList.toggle('active', !!s.autoPlayNext);
    document.getElementById('tb-videoinfo').classList.toggle('active', !!s.showVideoInfo);
    document.getElementById('tb-hiderecs').classList.toggle('active', !!s.hideRecs);
    // Existing installs lack the key (onInstalled only seeds when settings
    // are absent): undefined reads as the default true
    document.getElementById('tb-resize').classList.toggle('active', s.playerResizeEnabled !== false);
    document.getElementById('tb-inpage').classList.toggle('active', !!s.inPageQueue);
    // PiP controls (stage 03)
    document.getElementById('tb-autopip').classList.toggle('active', !!s.pipAutoEnabled);
    const pipOp = Math.min(100, Math.max(30, s.pipOpacity ?? 100));
    document.getElementById('pip-opacity-slider').value = pipOp;
    document.getElementById('pip-opacity-value').textContent = pipOp + '%';
    document.querySelectorAll('.pip-size-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.size === (s.pipSize || 'medium')));
    applyPanelMode(s.panelMode || 'full');

    currentSort = s.sortBy || 'addedAt';
    if (currentSort === 'custom') currentSort = 'addedAt'; // 'suggested' passes through
    sortDirection = s.sortDirection || 'desc';
    updateSortUI();
    if (currentSort === 'suggested') loadSuggestScores(true).then(loadVideos);
  } catch {}
}

// --- Sessions ---
async function loadSessions() {
  try {
    const s = await msg({ type: 'GET_SESSIONS' });
    if (s && Array.isArray(s.list) && s.list.length) sessionsCache = s;
  } catch {}
  activeSessionId = sessionsCache.activeId || 'main';
  renderSessionBar();
}

function renderSessionBar() {
  const select = document.getElementById('session-select');
  select.textContent = '';
  for (const s of sessionsCache.list || []) {
    select.appendChild(el('option', { value: s.id, text: s.name }));
  }
  select.value = activeSessionId;
  const isMain = activeSessionId === 'main';
  document.getElementById('session-rename').disabled = isMain;
  document.getElementById('session-merge').disabled = isMain;
  document.getElementById('session-delete').disabled = isMain;
  // Any pending two-click confirm is stale after a re-render
  document.querySelectorAll('.session-bar .confirming').forEach(b => b.classList.remove('confirming'));
}

function activeSessionName() {
  return (sessionsCache.list || []).find(s => s.id === activeSessionId)?.name || '';
}

// --- Channel Filter ---
function setChannelFilter(name) {
  channelFilter = name;
  document.getElementById('channel-chip-name').textContent = name; // user data — textContent only
  document.getElementById('channel-chip').style.display = '';
  loadVideos();
  document.querySelector('.scroll-area').scrollTop = 0;
}

function clearChannelFilter(reload = true) {
  channelFilter = null;
  document.getElementById('channel-chip').style.display = 'none';
  if (reload) loadVideos();
}

// --- Videos ---
async function loadVideos() {
  try {
    const allVideos = await msg({ type: 'GET_VIDEOS' });
    // Panel shows exactly one session; other sessions' videos stay untouched
    // in storage (SET_VIDEOS round-trips the full array)
    const sessionVideos = allVideos.filter(v => (v.sessionId || 'main') === activeSessionId);
    cachedVideos = sessionVideos;
    const unwatched = sessionVideos.filter(v => !v.watched);
    const watched = sessionVideos.filter(v => v.watched);

    let filtered = unwatched;
    if (starFilterActive) filtered = filtered.filter(v => v.starred);
    if (channelFilter) filtered = filtered.filter(v => (v.channel || '') === channelFilter);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(v =>
        (v.title || '').toLowerCase().includes(q) ||
        (v.channel || '').toLowerCase().includes(q)
      );
    }

    const regular = filtered.filter(v => !v.isShort && v.id !== nowPlayingVideoId);
    const shorts = filtered.filter(v => v.isShort && v.id !== nowPlayingVideoId);

    // Store sorted data for virtual scroll rendering
    dataVideos = sortVids(regular);
    dataShorts = sortVids(shorts);
    dataWatched = sortVids(watched);

    document.getElementById('video-count').textContent = dataVideos.length;
    document.getElementById('shorts-count').textContent = dataShorts.length;
    document.getElementById('watched-count').textContent = dataWatched.length;

    // Set container heights for virtual scroll
    setVirtualHeight('video-list', dataVideos.length);
    setVirtualHeight('shorts-list', dataShorts.length);
    setVirtualHeight('watched-list', dataWatched.length);

    document.getElementById('video-list').style.display = activeTab === 'videos' ? '' : 'none';
    document.getElementById('shorts-list').style.display = activeTab === 'shorts' ? '' : 'none';

    applyCollapsed('watched-list', '#watched-header .collapse-icon', watchedCollapsed);
    storeVisibleVideoOrder();

    // Force re-render of visible cards
    lastRenderKeys.clear();
    renderVisibleCards();
  } catch (e) { console.error('Videos error:', e); }
}

// Returns the ordered list of ALL video IDs in the active tab's data (not just DOM)
function getVisibleVideoOrder() {
  const data = activeTab === 'videos' ? dataVideos : dataShorts;
  return data.map(v => v.id);
}

function storeVisibleVideoOrder() {
  // Literal key — plain script, can't import STORAGE_KEYS.NEXT_VIDEO_ORDER
  chrome.storage.local.set({ yt_next_video_order: getVisibleVideoOrder() });
}

// --- Virtual Scroll ---
function setVirtualHeight(containerId, count) {
  const container = document.getElementById(containerId);
  if (count === 0) {
    container.style.height = '';
    container.style.position = '';
    return;
  }
  container.style.height = (count * cardHeight()) + 'px';
  container.style.position = 'relative';
}

function renderVisibleCards() {
  if (dragInProgress) {
    renderPendingAfterDrag = true;
    return;
  }

  // Render the active video/shorts list
  renderVirtualList(
    activeTab === 'videos' ? 'video-list' : 'shorts-list',
    activeTab === 'videos' ? dataVideos : dataShorts,
    false
  );

  // Render watched list if visible
  if (!watchedCollapsed) {
    renderVirtualList('watched-list', dataWatched, true);
  }
}

function renderVirtualList(containerId, data, isWatched) {
  const container = document.getElementById(containerId);
  if (container.classList.contains('collapsed')) return;

  if (!data.length) {
    const key = containerId + ':empty';
    if (lastRenderKeys.get(containerId) === key) return;
    lastRenderKeys.set(containerId, key);
    container.textContent = '';
    container.style.height = '';
    container.style.position = '';
    container.appendChild(el('div', { class: 'empty-state', text: isWatched ? 'No watched videos' : 'No videos' }));
    return;
  }

  // offsetTop is measured against .scroll-area (position: relative), which
  // puts it in the same coordinate space as scrollTop
  const scrollArea = document.querySelector('.scroll-area');
  const scrollTop = scrollArea.scrollTop;
  const viewportHeight = scrollArea.clientHeight;
  const containerTop = container.offsetTop;
  const relScroll = scrollTop - containerTop;

  const startIdx = Math.max(0, Math.floor(relScroll / cardHeight()) - RENDER_BUFFER);
  const endIdx = Math.min(data.length, Math.ceil((relScroll + viewportHeight) / cardHeight()) + RENDER_BUFFER);

  // Skip if same range is already rendered
  const key = containerId + ':' + startIdx + ':' + endIdx;
  if (lastRenderKeys.get(containerId) === key) return;
  lastRenderKeys.set(containerId, key);

  container.textContent = '';
  container.style.height = (data.length * cardHeight()) + 'px';
  container.style.position = 'relative';

  // Top spacer
  if (startIdx > 0) {
    container.appendChild(el('div', { style: { height: (startIdx * cardHeight()) + 'px', flexShrink: '0' } }));
  }

  // Render visible cards
  for (let i = startIdx; i < endIdx; i++) {
    container.appendChild(buildVideoItem(data[i], null, isWatched));
  }

  // Bottom spacer
  if (endIdx < data.length) {
    container.appendChild(el('div', { style: { height: ((data.length - endIdx) * cardHeight()) + 'px', flexShrink: '0' } }));
  }

  if (!isWatched && endIdx - startIdx > 0) setupDragDrop(container);
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
      case 'suggested': {
        va = channelScore(a); vb = channelScore(b);
        if (va === vb) { va = a.addedAt || 0; vb = b.addedAt || 0; } // stable cold-start fallback
        break;
      }
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

  // Open-as-tab indicator (top-left) -- passive, pointer-events: none in CSS.
  // Intentionally absent from the Now Playing card (it is by definition open).
  if (openTabIds.has(v.id)) {
    thumbWrap.appendChild(el('span', {
      class: 'thumb-tab-badge', text: 'TAB', title: 'Open in a Chrome tab',
    }));
  }
  // Add/move count chip (top-right) -- hidden while < 2 (every video was
  // added once); legacy videos without the field count as 1
  const addCount = v.addCount || 1;
  if (addCount >= 2) {
    thumbWrap.appendChild(el('span', {
      class: 'thumb-addcount',
      text: (addCount > 9 ? '9+' : addCount) + '\u00D7',
      title: 'Added or moved to top ' + addCount + ' times',
    }));
  }

  const playBtn = el('button', { class: 'card-play-btn', text: '\u25B6' });
  playBtn.addEventListener('click', e => { e.stopPropagation(); openVideo(v.url); });

  // Card mutations carry sessionId so a same-id entry in ANOTHER session is
  // never the one removed/updated (worker matches (id, sessionId) when sent)
  const removeBtn = el('button', { class: 'card-sm-btn', text: '\u2715' });
  removeBtn.addEventListener('click', e => {
    e.stopPropagation();
    msg({ type: 'REMOVE_VIDEO', videoId: v.id, sessionId: activeSessionId }).then(loadVideos);
  });

  let watchBtn;
  if (isWatched) {
    watchBtn = el('button', { class: 'card-sm-btn', text: '\u21A9' });
    watchBtn.addEventListener('click', e => {
      e.stopPropagation();
      msg({ type: 'UPDATE_VIDEO', videoId: v.id, sessionId: activeSessionId, updates: { watched: false } }).then(loadVideos);
    });
  } else {
    watchBtn = el('button', { class: 'card-sm-btn', text: '\u2713' });
    watchBtn.addEventListener('click', e => {
      e.stopPropagation();
      msg({ type: 'UPDATE_VIDEO', videoId: v.id, sessionId: activeSessionId, updates: { watched: true } }).then(loadVideos);
    });
  }

  const starBtn = el('button', { class: 'card-star-btn' + (v.starred ? ' starred' : ''), text: '\u2605' });
  starBtn.addEventListener('click', e => {
    e.stopPropagation();
    const newVal = !v.starred;
    msg({ type: 'UPDATE_VIDEO', videoId: v.id, sessionId: activeSessionId, updates: { starred: newVal } }).then(loadVideos);
  });

  // Channel name filters on click \u2014 but never for empty/'Unknown' placeholders
  // (filtering by a placeholder groups unrelated unenriched videos)
  let chanSpan;
  if (v.channel && v.channel !== 'Unknown') {
    chanSpan = el('span', { class: 'channel-link', title: 'Filter by ' + v.channel, text: v.channel });
    chanSpan.addEventListener('click', e => { e.stopPropagation(); setChannelFilter(v.channel); });
  } else {
    chanSpan = el('span', { text: v.channel || 'Unknown' });
  }

  const metaChildren = [
    chanSpan,
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
    // Suggested sort: drop is a no-op anyway, so don't offer the drag at all.
    // Must be a real boolean: el() assigns DOM properties, and the string
    // 'false' would coerce to draggable=true.
    draggable: !isWatched && currentSort !== 'suggested',
  }, [
    thumbWrap,
    el('div', { class: 'video-info' }, [
      el('div', { class: 'video-title', title: v.title || '', text: v.title || 'Unknown' }),
      el('div', { class: 'video-meta' }, metaChildren),
    ]),
    el('div', { class: 'card-right' }, [playBtn, el('div', { class: 'card-bottom-actions' }, [starBtn, removeBtn, watchBtn])]),
  ]);

  // Slim tiles hide .video-info — the tooltip is the only title surface
  if (panelMode === 'slim') item.title = v.title || '';

  item.addEventListener('dblclick', e => {
    // .channel-link guard is required: stopPropagation on its click handler
    // does NOT suppress this independent dblclick listener
    if (e.target.closest('select') || e.target.closest('button') || e.target.closest('.channel-link')) return;
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

// renderVideoList removed — replaced by virtual scroll (renderVirtualList)

// --- Now Playing (Active Video Priority Slot) ---
function buildNowPlayingCard(video, state) {
  const pct = state.duration > 0 ? (state.currentTime / state.duration) * 100 : 0;

  const thumbImg = el('img', { class: 'np-thumb', src: video.thumbnail, alt: '' });
  const thumbWrap = el('div', { class: 'np-thumb-wrap' }, [thumbImg]);
  if (video.duration) thumbWrap.appendChild(el('span', { class: 'thumb-duration', text: dur(video.duration) }));

  const progressFill = el('div', { class: 'np-progress-fill', style: { width: pct + '%' } });
  const timeText = el('span', { class: 'np-time', text: dur(Math.floor(state.currentTime)) + ' / ' + dur(Math.floor(state.duration)) });

  // Media buttons — commands carry the tabId of the tab being displayed so
  // the service worker controls THAT video, not whatever tab is active
  const mediaControl = action =>
    msg({ type: 'MEDIA_CONTROL', action, tabId: lastMediaState?.tabId });

  // Build SVGs via innerHTML (safe — no user data)
  const rewindBtn = el('button', { class: 'np-btn' });
  rewindBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg><span class="np-btn-label">10</span>';
  rewindBtn.addEventListener('click', () => mediaControl('rewind'));

  const playPauseBtn = el('button', { class: 'np-btn np-btn--play' });
  playPauseBtn.innerHTML = state.paused
    ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg>'
    : '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="5" y="3" width="5" height="18"/><rect x="14" y="3" width="5" height="18"/></svg>';
  playPauseBtn.addEventListener('click', async () => {
    const r = await mediaControl('playPause');
    playPauseBtn.innerHTML = r.paused
      ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><polygon points="6,3 20,12 6,21"/></svg>'
      : '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="5" y="3" width="5" height="18"/><rect x="14" y="3" width="5" height="18"/></svg>';
  });

  const forwardBtn = el('button', { class: 'np-btn' });
  forwardBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/></svg><span class="np-btn-label">10</span>';
  forwardBtn.addEventListener('click', () => mediaControl('forward'));

  const skipBtn = el('button', { class: 'np-btn np-btn--skip' });
  skipBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="5,4 15,12 5,20"/><rect x="17" y="5" width="3" height="14"/></svg>';
  skipBtn.addEventListener('click', async () => {
    await msg({
      type: 'SKIP_VIDEO',
      videoId: video.id,
      nextVideoIds: getVisibleVideoOrder(),
      tabId: lastMediaState?.tabId,
    });
    loadVideos();
  });

  // Float button (stage 03): toggles the Document-PiP floating player for
  // the DISPLAYED tab (same routing invariant as the media buttons)
  const pipBtn = el('button', {
    class: 'np-btn np-btn--pip' + (state.pipActive ? ' active' : ''),
    id: 'np-pip-btn',
    title: 'Float video (picture-in-picture)',
  });
  pipBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="14" rx="2"/><rect x="11" y="11" width="8" height="5" rx="1" fill="currentColor" stroke="none"/></svg>'; // static SVG — allowed
  pipBtn.addEventListener('click', () => {
    const tabId = lastMediaState?.tabId;
    if (!tabId) return;
    if (lastMediaState?.pipActive) {
      // Closing needs no gesture — route through the normal command path
      msg({ type: 'MEDIA_CONTROL', action: 'exitPip', tabId });
      return;
    }
    // SYNCHRONOUS injection — no awaits before it: the click's user
    // activation must propagate into the injected function (same rule as
    // the sidePanel.open() gotcha). args are computed synchronously too.
    chrome.scripting.executeScript({
      target: { tabId },
      func: (opts) => { if (window.__ytmTogglePip) window.__ytmTogglePip(opts); },
      args: [{
        opacity: parseInt(document.getElementById('pip-opacity-slider').value),
        size: document.querySelector('.pip-size-btn.active')?.dataset.size || 'medium',
      }],
    }).catch(() => {}); // stale tabId (closed between polls) — card self-corrects
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
      el('div', { class: 'np-media-btns' }, [rewindBtn, playPauseBtn, forwardBtn, skipBtn, pipBtn]),
    ]),
  ]);
}

function handleVideoUnpinned(videoId, state) {
  if (!videoId || !state) return;
  // Only apply 20% rule to videos that are in the queue (cachedVideos is
  // session-filtered, so the rule applies to active-session videos only;
  // other sessions' copies get marked via the content script's MARK_WATCHED)
  const inQueue = cachedVideos.some(v => v.id === videoId && !v.watched);
  if (inQueue) {
    const progress = state.duration > 0 ? state.currentTime / state.duration : 0;
    if (progress >= 0.2) {
      msg({ type: 'UPDATE_VIDEO', videoId, sessionId: activeSessionId, updates: { watched: true } });
    }
  }
  loadVideos();
}

async function updateNowPlaying() {
  try {
    const state = await msg({ type: 'GET_MEDIA_STATE' });
    const slot = document.getElementById('now-playing');

    // PiP row knobs only apply to the Document-PiP floating player — grey
    // them when the displayed tab affirmatively reports no support (stage 03)
    setPipRowDisabled(!!state.videoId && state.docPipSupported === false);

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
      // Float button reflects classic OR Document PiP being open (stage 03)
      const pipB = slot.querySelector('#np-pip-btn');
      if (pipB) pipB.classList.toggle('active', !!state.pipActive);
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
    lastRenderKeys.clear();
    renderVisibleCards();
    storeVisibleVideoOrder();
  });
});

// --- Panel Mode (full / slim) ---
// Slim mode is pure CSS (body.slim): cards become 160×86 thumbnail tiles and
// the heavy controls collapse. JS only swaps the virtual-scroll card height
// via cardHeight() and resets the scroller (a height change invalidates every
// cached render range and scroll offset).
function applyPanelMode(mode) {
  panelMode = mode === 'slim' ? 'slim' : 'full';
  document.body.classList.toggle('slim', panelMode === 'slim');
  document.getElementById('panel-mode-toggle').classList.toggle('active', panelMode === 'slim');
  lastRenderKeys.clear();
  document.querySelector('.scroll-area').scrollTop = 0;
  renderVisibleCards();
}

document.getElementById('panel-mode-toggle').addEventListener('click', () => {
  const next = panelMode === 'slim' ? 'full' : 'slim';
  applyPanelMode(next);
  msg({ type: 'UPDATE_SETTINGS', settings: { panelMode: next } });
});

// --- Watched Section ---
document.getElementById('watched-header').addEventListener('click', () => {
  watchedCollapsed = !watchedCollapsed;
  applyCollapsed('watched-list', '#watched-header .collapse-icon', watchedCollapsed);
  if (!watchedCollapsed) renderVisibleCards();
});

// --- Toggle Icon Bar ---
const toggleMap = {
  'tb-autoplay': 'autoPlayNext',
  'tb-videoinfo': 'showVideoInfo',
  'tb-hiderecs': 'hideRecs',
  'tb-resize': 'playerResizeEnabled',
  'tb-inpage': 'inPageQueue',
  'tb-autopip': 'pipAutoEnabled',
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

// Content scripts watch yt_settings via storage.onChanged, so saving the
// setting is enough — no broadcast needed
for (const [btnId, settingKey] of Object.entries(toggleMap)) {
  document.getElementById(btnId).addEventListener('click', e => {
    const btn = e.currentTarget;
    btn.classList.toggle('active');
    const enabled = btn.classList.contains('active');
    msg({ type: 'UPDATE_SETTINGS', settings: { [settingKey]: enabled } });
  });
}

// Hover descriptions for ALL buttons with data-desc in toggle bar
const descEl = document.getElementById('toggle-desc');
document.querySelectorAll('.toggle-bar [data-desc]').forEach(btn => {
  btn.addEventListener('mouseenter', () => { descEl.textContent = btn.dataset.desc; });
});

// Export activity log as JSON — Blob + <a download> from this extension
// document (no permissions). Reads the key directly (read-only, no mutex
// needed — consistent with the panel's direct yt_next_video_order writes).
document.getElementById('tb-export').addEventListener('click', async () => {
  const r = await chrome.storage.local.get('yt_activity_log'); // literal key — plain script
  const log = r.yt_activity_log || { v: 1, seq: 0, events: [] };
  const payload = {
    schema: 'yt_activity_log',
    schemaVersion: log.v,
    exportedAt: new Date().toISOString(),
    eventCount: log.events.length,
    seq: log.seq,
    events: log.events,
  };
  const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const d = new Date();
  const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const a = document.createElement('a');
  a.href = url;
  a.download = 'yt-activity-log-' + stamp + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000); // let the download start safely
});

// --- Drag and Drop ---
// dragId/dragInProgress live at module scope: a re-render swaps in fresh
// cards with fresh listeners, and closure-local state would orphan the drag
function setupDragDrop(container) {
  container.querySelectorAll('.video-item').forEach(item => {
    item.addEventListener('dragstart', e => {
      dragId = item.dataset.id;
      dragInProgress = true;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      container.querySelectorAll('.drag-over').forEach(x => x.classList.remove('drag-over'));
      dragId = null;
      dragInProgress = false;
      if (renderPendingAfterDrag) {
        renderPendingAfterDrag = false;
        lastRenderKeys.clear();
        renderVisibleCards();
      }
    });
    item.addEventListener('dragover', e => {
      e.preventDefault();
      if (dragId && item.dataset.id !== dragId) item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', async e => {
      e.preventDefault();
      item.classList.remove('drag-over');
      // No drag-reorder under Suggested sort: reorder works by swapping the
      // active sort field between two videos, and there is no per-video
      // "suggested" field to swap (swapping addedAt would corrupt Added sort)
      if (currentSort === 'suggested') return;
      if (!dragId || item.dataset.id === dragId) return;

      // Scope to the active session — a same-id entry in another session
      // must never be the one swapped (full array still round-trips intact)
      const videos = await msg({ type: 'GET_VIDEOS' });
      const dv = videos.find(v => v.id === dragId && (v.sessionId || 'main') === activeSessionId);
      const tv = videos.find(v => v.id === item.dataset.id && (v.sessionId || 'main') === activeSessionId);
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

document.getElementById('channel-chip-clear').addEventListener('click', () => clearChannelFilter());

// --- Session Bar ---

document.getElementById('session-select').addEventListener('change', async e => {
  const id = e.target.value;
  if (id === activeSessionId) return;
  const res = await msg({ type: 'SET_ACTIVE_SESSION', sessionId: id });
  if (res && res.success) {
    activeSessionId = id;
    renderSessionBar();
    clearChannelFilter(false); // ephemeral filter dies on session switch
    loadVideos();
    document.querySelector('.scroll-area').scrollTop = 0;
  } else {
    e.target.value = activeSessionId; // revert on rejection
  }
});

// Inline name input replaces the select while naming (prompt() is suppressed
// in extension panel documents). Enter commits, Esc/blur cancels.
function enterNameMode(mode) {
  sessionInputMode = mode;
  const input = document.getElementById('session-name-input');
  input.value = mode === 'rename' ? activeSessionName() : '';
  document.getElementById('session-select').style.display = 'none';
  input.style.display = '';
  input.focus();
  if (mode === 'rename') input.select();
}

function exitNameMode() {
  sessionInputMode = null;
  document.getElementById('session-name-input').style.display = 'none';
  document.getElementById('session-select').style.display = '';
}

document.getElementById('session-name-input').addEventListener('keydown', async e => {
  if (e.key === 'Enter') {
    const mode = sessionInputMode;
    const name = e.target.value.trim();
    exitNameMode(); // nulls sessionInputMode first so the blur below no-ops
    if (!mode || !name) return;
    if (mode === 'new') {
      await msg({ type: 'CREATE_SESSION', name });
    } else {
      await msg({ type: 'RENAME_SESSION', sessionId: activeSessionId, name });
    }
    await loadSessions();
    loadVideos();
  } else if (e.key === 'Escape') {
    exitNameMode();
  }
});
document.getElementById('session-name-input').addEventListener('blur', () => {
  if (sessionInputMode) exitNameMode();
});

document.getElementById('session-new').addEventListener('click', () => enterNameMode('new'));
document.getElementById('session-rename').addEventListener('click', () => enterNameMode('rename'));

// Two-click confirm: first click arms (.confirming, 3s timeout), second runs
function armConfirm(btn, onConfirm) {
  if (btn.classList.contains('confirming')) {
    btn.classList.remove('confirming');
    if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
    onConfirm();
    return;
  }
  document.querySelectorAll('.session-bar .confirming').forEach(b => b.classList.remove('confirming'));
  btn.classList.add('confirming');
  if (confirmTimer) clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => { btn.classList.remove('confirming'); confirmTimer = null; }, 3000);
}

document.getElementById('session-delete').addEventListener('click', e => {
  armConfirm(e.currentTarget, async () => {
    await msg({ type: 'DELETE_SESSION', sessionId: activeSessionId });
    await loadSessions();
    loadVideos();
  });
});

document.getElementById('session-merge').addEventListener('click', e => {
  armConfirm(e.currentTarget, async () => {
    await msg({ type: 'MERGE_SESSION', sourceSessionId: activeSessionId });
    await loadSessions();
    loadVideos();
  });
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
  document.getElementById('speed-value').textContent = fmtSpeed(parseInt(e.target.value) / 10);
});
document.getElementById('speed-slider').addEventListener('change', e => {
  msg({ type: 'SET_SPEED', value: parseInt(e.target.value) / 10, scope: 'tab' });
});
document.getElementById('speed-reset').addEventListener('click', () => {
  document.getElementById('speed-slider').value = 10;
  document.getElementById('speed-value').textContent = '1.0x';
  msg({ type: 'SET_SPEED', value: 1.0, scope: 'tab' });
});

// PiP (stage 03): opacity persists on change (applied live to an open
// floating window via the content script's storage.onChanged); size presets
// persist the OPEN-TIME default — live resize only works from inside the
// PiP window itself, where resizeTo() is gesture-legal
document.getElementById('pip-opacity-slider').addEventListener('input', e => {
  document.getElementById('pip-opacity-value').textContent = e.target.value + '%';
});
document.getElementById('pip-opacity-slider').addEventListener('change', e => {
  msg({ type: 'UPDATE_SETTINGS', settings: { pipOpacity: parseInt(e.target.value) } });
});
document.querySelectorAll('.pip-size-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pip-size-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    msg({ type: 'UPDATE_SETTINGS', settings: { pipSize: btn.dataset.size } });
  });
});

// PiP row enable/disable (stage 03) — greyed only when a DISPLAYED tab
// affirmatively reports no Document-PiP support (state.videoId present and
// docPipSupported false); with no tab displayed the knobs stay editable as
// open-time defaults. Tri-state cache so the DOM is only touched on change.
let pipRowDisabled = null;
function setPipRowDisabled(disabled) {
  if (pipRowDisabled === disabled) return;
  pipRowDisabled = disabled;
  document.getElementById('pip-opacity-slider').disabled = disabled;
  document.querySelectorAll('.pip-size-btn').forEach(b => { b.disabled = disabled; });
  const row = document.querySelector('.ctrl-row--pip');
  row.classList.toggle('pip-row-disabled', disabled);
  row.title = disabled
    ? 'Floating player not supported on this tab (Document picture-in-picture needs Chrome 116+)'
    : '';
}

// Mid-drag guard: while the user is on the thumb, storage echoes (including
// their own gesture's write) must not fight the pointer (stage 02)
for (const sliderId of ['volume-slider', 'speed-slider', 'pip-opacity-slider']) {
  const slider = document.getElementById(sliderId);
  slider.addEventListener('pointerdown', () => { slider.dataset.dragging = '1'; });
  slider.addEventListener('pointerup', () => { delete slider.dataset.dragging; });
  slider.addEventListener('change', () => { delete slider.dataset.dragging; });
}

// Collect tabs
document.getElementById('collect-tabs').addEventListener('click', async () => {
  await msg({ type: 'COLLECT_TABS' });
  loadVideos();
});

document.getElementById('close-tabs').addEventListener('click', async () => {
  // Close tabs matching videos in BOTH the videos and shorts data arrays
  const videoIds = [...dataVideos, ...dataShorts].map(v => v.id);
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

// Sort — Suggested refreshes scores first (forced, but the worker side is
// still cache-gated by the 25-event seq delta)
document.querySelectorAll('.sort-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    currentSort = btn.dataset.sort;
    updateSortUI();
    msg({ type: 'UPDATE_SETTINGS', settings: { sortBy: currentSort } });
    const apply = () => { loadVideos(); document.querySelector('.scroll-area').scrollTop = 0; };
    if (currentSort === 'suggested') loadSuggestScores(true).then(apply); else apply();
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

// Background updates — debounced: COLLECT_TABS and metadata enrichment emit
// VIDEOS_UPDATED in bursts, and each loadVideos() is a full re-sort + render
let loadVideosTimer = null;
function scheduleLoadVideos() {
  if (loadVideosTimer) return;
  loadVideosTimer = setTimeout(() => {
    loadVideosTimer = null;
    loadVideos();
  }, 150);
}
chrome.runtime.onMessage.addListener(m => { if (m.type === 'VIDEOS_UPDATED') scheduleLoadVideos(); });

// Watch time updates arrive via storage instead of a 5s poll; the open-tab
// set arrives the same way from the SESSION area (worker is its sole writer)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.yt_watch_time) loadWatchTime();
  // Live slider/label sync (stage 02): native YouTube speed changes (and any
  // other surface's slider) land in yt_settings — reflect them without a
  // reload, skipping a slider the user is actively dragging
  if (area === 'local' && changes.yt_settings) {
    const s = changes.yt_settings.newValue || {};
    const vs = document.getElementById('volume-slider');
    if (!vs.dataset.dragging && s.volumeLevel !== undefined) {
      vs.value = s.volumeLevel;
      document.getElementById('volume-value').textContent = s.volumeLevel + '%';
    }
    const ss = document.getElementById('speed-slider');
    if (!ss.dataset.dragging && s.speedLevel !== undefined) {
      ss.value = Math.round(s.speedLevel * 10);
      document.getElementById('speed-value').textContent = fmtSpeed(s.speedLevel);
    }
    document.getElementById('tb-resize').classList.toggle('active', s.playerResizeEnabled !== false);
    document.getElementById('tb-inpage').classList.toggle('active', !!s.inPageQueue);
    // PiP controls (stage 03): stay in lockstep with settings written from
    // the PiP window's own strip (or another panel window)
    document.getElementById('tb-autopip').classList.toggle('active', !!s.pipAutoEnabled);
    const pos = document.getElementById('pip-opacity-slider');
    if (!pos.dataset.dragging && s.pipOpacity !== undefined) {
      const op = Math.min(100, Math.max(30, s.pipOpacity));
      pos.value = op;
      document.getElementById('pip-opacity-value').textContent = op + '%';
    }
    if (s.pipSize) {
      document.querySelectorAll('.pip-size-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.size === s.pipSize));
    }
    // Another panel window (or a persisted echo of our own click): apply only
    // on a real change — the local click already applied its mode pre-write
    const mode = s.panelMode === 'slim' ? 'slim' : 'full';
    if (mode !== panelMode) applyPanelMode(mode);
  }
  // Session list/pointer changes propagate via storage — no broadcast type;
  // multi-window panels converge on the same global active session for free
  if (area === 'local' && changes.yt_sessions) {
    sessionsCache = changes.yt_sessions.newValue || sessionsCache;
    const prev = activeSessionId;
    activeSessionId = sessionsCache.activeId || 'main';
    renderSessionBar();
    if (prev !== activeSessionId) clearChannelFilter(false);
    scheduleLoadVideos();
  }
  // Activity-log appends refresh suggest scores ONLY while Suggested sort is
  // active — throttled by lastScoreFetch's 60s gate plus the worker's
  // seq-delta gate. No listener re-renders off the log otherwise (no render
  // storms during intercept bursts/Collect).
  if (area === 'local' && changes.yt_activity_log && currentSort === 'suggested') {
    loadSuggestScores().then(() => { if (currentSort === 'suggested') scheduleLoadVideos(); });
  }
  if (area === 'session' && changes.yt_open_tab_ids) {
    openTabIds = new Set(changes.yt_open_tab_ids.newValue || []);
    lastRenderKeys.clear();   // virtual scroll skips unchanged range keys
    renderVisibleCards();     // drag-safe: dragInProgress defers internally
  }
});

// --- Virtual Scroll Listener ---
let scrollRafPending = false;
document.querySelector('.scroll-area').addEventListener('scroll', () => {
  if (!scrollRafPending) {
    scrollRafPending = true;
    requestAnimationFrame(() => {
      renderVisibleCards();
      scrollRafPending = false;
    });
  }
});

// --- Init ---
loadWatchTime();
loadOpenTabIds();
loadSettings();
// Sessions FIRST so the initial render uses the correct session (a bare
// loadVideos() would flash Main's list when another session is active)
loadSessions().then(loadVideos);
updateNowPlaying();
setInterval(updateNowPlaying, 1500);
