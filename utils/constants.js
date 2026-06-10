export const STORAGE_KEYS = {
  VIDEOS: 'yt_videos',
  SETTINGS: 'yt_settings',
  WATCH_TIME: 'yt_watch_time',
  LOGGED_VIDEOS: 'yt_logged_videos',
  // Written by the side panel (plain script — inlines the literal), read by
  // the worker for autoplay-next ordering
  NEXT_VIDEO_ORDER: 'yt_next_video_order',
  // Session groups: { activeId, list: [{id, name, createdAt}] } — worker only
  SESSIONS: 'yt_sessions',
  // chrome.storage.SESSION area (not local): sorted unique videoIds of open
  // tabs — worker only, diffed + debounced, deliberately outside the mutex
  OPEN_TAB_IDS: 'yt_open_tab_ids',
  // { v:1, seq, events:[...] } capped 5000 FIFO — worker only, via storage.update
  ACTIVITY_LOG: 'yt_activity_log',
  // { v:1, computedAtSeq, computedAt, channels:{...} } — worker only
  SUGGEST_SCORES: 'yt_suggest_scores',
};

// 'main' session always exists; videos missing sessionId belong to it
export const DEFAULT_SESSIONS = {
  activeId: 'main',
  list: [{ id: 'main', name: 'Main', createdAt: 0 }],
};

export const DEFAULT_SETTINGS = {
  interceptEnabled: 'off',  // 'off' | 'close' | 'keep'
  volumeLevel: 100,
  volumeScope: 'tab',
  speedLevel: 1.0,
  speedScope: 'tab',
  sortBy: 'addedAt',        // also: 'suggested' (fallback sorts treat as addedAt)
  sortDirection: 'desc',
  autoPlayNext: false,
  showVideoInfo: false,
  hideRecs: false,
  inPageQueue: false,        // 01: queue strip injected into YouTube masthead
  panelMode: 'full',         // 01: 'full' | 'slim'
  playerResizeEnabled: true, // 02: drag-resize handles on the YouTube player
  playerSizeDefault: null,   // 02: persisted size for default view mode
  playerSizeTheater: null,   // 02: persisted size for theater view mode
  pipAutoEnabled: false,     // 03: auto picture-in-picture on tab switch
  pipOpacity: 100,           // 03
  pipSize: 'medium',         // 03: 'small' | 'medium' | 'large'
  activityLogEnabled: true,  // 06
  shortsAutoScroll: false,   // 07
  shortsAutoClose: false,    // 07
};

// Matched only after the hostname has been validated (utils/youtube.js)
export const YOUTUBE_URL_PATTERNS = {
  VIDEO: /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  SHORT: /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
};

export const MSG = {
  GET_STATS: 'GET_STATS',
  GET_VIDEOS: 'GET_VIDEOS',
  ADD_VIDEO: 'ADD_VIDEO',
  REMOVE_VIDEO: 'REMOVE_VIDEO',
  UPDATE_VIDEO: 'UPDATE_VIDEO',
  SET_VIDEOS: 'SET_VIDEOS',
  COLLECT_TABS: 'COLLECT_TABS',
  CLOSE_VISIBLE_TABS: 'CLOSE_VISIBLE_TABS',
  CLOSE_SHORTS_TABS: 'CLOSE_SHORTS_TABS',
  REMOVE_DUPLICATES: 'REMOVE_DUPLICATES',
  SET_VOLUME: 'SET_VOLUME',
  SET_SPEED: 'SET_SPEED',
  GET_SETTINGS: 'GET_SETTINGS',
  UPDATE_SETTINGS: 'UPDATE_SETTINGS',
  TRACK_WATCH_TIME: 'TRACK_WATCH_TIME',
  GET_WATCH_TIME: 'GET_WATCH_TIME',
  VIDEO_METADATA: 'VIDEO_METADATA',
  REFRESH_METADATA: 'REFRESH_METADATA',
  GET_MEDIA_STATE: 'GET_MEDIA_STATE',
  OPEN_SIDE_PANEL: 'OPEN_SIDE_PANEL',
  OPEN_VIDEO: 'OPEN_VIDEO',
  OPEN_VIDEO_NEW_TAB: 'OPEN_VIDEO_NEW_TAB',
  MARK_WATCHED: 'MARK_WATCHED',
  VIDEO_ENDED: 'VIDEO_ENDED',
  MEDIA_CONTROL: 'MEDIA_CONTROL',
  MEDIA_COMMAND: 'MEDIA_COMMAND',
  SKIP_VIDEO: 'SKIP_VIDEO',
  VIDEOS_UPDATED: 'VIDEOS_UPDATED',
  TAG_STARRED: 'TAG_STARRED',
  SPEED_CHANGED: 'SPEED_CHANGED',           // 02
  GET_SESSIONS: 'GET_SESSIONS',             // 04
  CREATE_SESSION: 'CREATE_SESSION',         // 04
  RENAME_SESSION: 'RENAME_SESSION',         // 04
  DELETE_SESSION: 'DELETE_SESSION',         // 04
  SET_ACTIVE_SESSION: 'SET_ACTIVE_SESSION', // 04
  MERGE_SESSION: 'MERGE_SESSION',           // 04
  GET_SUGGEST_SCORES: 'GET_SUGGEST_SCORES', // 06
  LOG_ACTIVITY_EVENT: 'LOG_ACTIVITY_EVENT', // 06
  CLOSE_SHORT_TAB: 'CLOSE_SHORT_TAB',       // 07
};
