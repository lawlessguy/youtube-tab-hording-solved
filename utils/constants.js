export const STORAGE_KEYS = {
  VIDEOS: 'yt_videos',
  SETTINGS: 'yt_settings',
  WATCH_TIME: 'yt_watch_time',
  CATEGORIES: 'yt_categories',
  LOGGED_VIDEOS: 'yt_logged_videos',
};

export const DEFAULT_SETTINGS = {
  interceptEnabled: 'off',  // 'off' | 'close' | 'keep'
  volumeLevel: 100,
  volumeScope: 'tab',
  speedLevel: 1.0,
  speedScope: 'tab',
  sortBy: 'addedAt',
  sortDirection: 'desc',
  aiEnabled: false,
  geminiApiKey: '',
  autoPlayNext: false,
  autoCategorize: false,
  showVideoInfo: false,
  hideRecs: false,
};

export const DEFAULT_CATEGORIES = [{ name: 'Uncategorized', description: '' }];

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
  CLOSE_YT_TABS: 'CLOSE_YT_TABS',
  REMOVE_DUPLICATES: 'REMOVE_DUPLICATES',
  SET_VOLUME: 'SET_VOLUME',
  SET_SPEED: 'SET_SPEED',
  GET_SETTINGS: 'GET_SETTINGS',
  UPDATE_SETTINGS: 'UPDATE_SETTINGS',
  TRACK_WATCH_TIME: 'TRACK_WATCH_TIME',
  GET_WATCH_TIME: 'GET_WATCH_TIME',
  VIDEO_METADATA: 'VIDEO_METADATA',
  CATEGORIZE_AI: 'CATEGORIZE_AI',
  OPEN_SIDE_PANEL: 'OPEN_SIDE_PANEL',
  OPEN_TAB: 'OPEN_TAB',
  OPEN_VIDEO: 'OPEN_VIDEO',
  RESET_CATEGORIES: 'RESET_CATEGORIES',
  MARK_WATCHED: 'MARK_WATCHED',
  VIDEO_ENDED: 'VIDEO_ENDED',
  MEDIA_CONTROL: 'MEDIA_CONTROL',
  MEDIA_COMMAND: 'MEDIA_COMMAND',
  SKIP_VIDEO: 'SKIP_VIDEO',
  VIDEOS_UPDATED: 'VIDEOS_UPDATED',
  OPEN_VIDEO_NEW_TAB: 'OPEN_VIDEO_NEW_TAB',
  CLOSE_VISIBLE_TABS: 'CLOSE_VISIBLE_TABS',
  TAG_STARRED: 'TAG_STARRED',
  GET_QUEUED_IDS: 'GET_QUEUED_IDS',
};
