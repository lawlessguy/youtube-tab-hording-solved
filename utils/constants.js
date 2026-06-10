export const STORAGE_KEYS = {
  VIDEOS: 'yt_videos',
  SETTINGS: 'yt_settings',
  WATCH_TIME: 'yt_watch_time',
  LOGGED_VIDEOS: 'yt_logged_videos',
  // Written by the side panel (plain script — inlines the literal), read by
  // the worker for autoplay-next ordering
  NEXT_VIDEO_ORDER: 'yt_next_video_order',
};

export const DEFAULT_SETTINGS = {
  interceptEnabled: 'off',  // 'off' | 'close' | 'keep'
  volumeLevel: 100,
  volumeScope: 'tab',
  speedLevel: 1.0,
  speedScope: 'tab',
  sortBy: 'addedAt',
  sortDirection: 'desc',
  autoPlayNext: false,
  showVideoInfo: false,
  hideRecs: false,
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
};
