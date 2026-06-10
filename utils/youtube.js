import { YOUTUBE_URL_PATTERNS } from './constants.js';

// Hostname allowlist — substring checks like url.includes('youtube.com')
// match hostile URLs (https://fakeyoutube.com.evil.tld/,
// https://evil.tld/youtube.com/watch?v=...) and would let them into the
// queue, the tab-close paths, and the side panel enablement logic.
const YOUTUBE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
]);

export function isYouTubeHost(url) {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return YOUTUBE_HOSTS.has(host) || host === 'youtu.be';
  } catch {
    return false;
  }
}

export function extractVideoId(url) {
  if (!isYouTubeHost(url)) return null;
  const shortMatch = url.match(YOUTUBE_URL_PATTERNS.SHORT);
  if (shortMatch) return shortMatch[1];
  const videoMatch = url.match(YOUTUBE_URL_PATTERNS.VIDEO);
  if (videoMatch) return videoMatch[1];
  return null;
}

export function isYouTubeUrl(url) {
  if (!isYouTubeHost(url)) return false;
  return url.includes('/watch') ||
         url.includes('youtu.be/') ||
         url.includes('/shorts/');
}

export function isShortUrl(url) {
  return isYouTubeHost(url) && url.includes('/shorts/');
}

export function getThumbnailUrl(videoId, quality = 'mqdefault') {
  return `https://img.youtube.com/vi/${videoId}/${quality}.jpg`;
}

// Returns null on any failure — callers keep their placeholder values and a
// later refresh (or the content script's VIDEO_METADATA report) can fill in
export async function fetchVideoMetadata(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const response = await fetch(oembedUrl);
    if (!response.ok) return null;
    const data = await response.json();
    return {
      title: data.title || 'Unknown Title',
      channel: data.author_name || 'Unknown Channel',
      thumbnail: getThumbnailUrl(videoId),
    };
  } catch {
    return null;
  }
}

export async function fetchVideoDetails(videoId) {
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const response = await fetch(url);
    const html = await response.text();

    let duration = 0;
    const durationMatch = html.match(/"lengthSeconds"\s*:\s*"(\d+)"/);
    if (durationMatch) {
      duration = parseInt(durationMatch[1], 10);
    }

    let uploadDate = null;
    // Try multiple patterns for upload/publish date
    const datePatterns = [
      /"uploadDate"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/,
      /"publishDate"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/,
      /"dateText"\s*:\s*\{\s*"simpleText"\s*:\s*"([^"]+)"\s*\}/,
      /"uploadDate"\s*:\s*"([^"]+)"/,
      /"publishDate"\s*:\s*"([^"]+)"/,
    ];
    for (const pattern of datePatterns) {
      const m = html.match(pattern);
      if (m) {
        // If it's a human-readable date like "Jan 15, 2024", parse it
        const raw = m[1];
        if (/^\d{4}-\d{2}/.test(raw)) {
          uploadDate = raw;
        } else {
          const parsed = new Date(raw);
          if (!isNaN(parsed.getTime())) {
            uploadDate = parsed.toISOString().split('T')[0];
          }
        }
        if (uploadDate) break;
      }
    }

    return { duration, uploadDate };
  } catch {
    return { duration: 0, uploadDate: null };
  }
}
