import { YOUTUBE_URL_PATTERNS } from './constants.js';

export function extractVideoId(url) {
  if (!url) return null;
  const shortMatch = url.match(YOUTUBE_URL_PATTERNS.SHORT);
  if (shortMatch) return shortMatch[1];
  const videoMatch = url.match(YOUTUBE_URL_PATTERNS.VIDEO);
  if (videoMatch) return videoMatch[1];
  return null;
}

export function isYouTubeUrl(url) {
  if (!url) return false;
  return url.includes('youtube.com/watch') ||
         url.includes('youtu.be/') ||
         url.includes('youtube.com/shorts/');
}

export function isShortUrl(url) {
  if (!url) return false;
  return url.includes('youtube.com/shorts/');
}

export function getThumbnailUrl(videoId, quality = 'mqdefault') {
  return `https://img.youtube.com/vi/${videoId}/${quality}.jpg`;
}

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
    return {
      title: 'Unknown Title',
      channel: 'Unknown Channel',
      thumbnail: getThumbnailUrl(videoId),
    };
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

export function formatDuration(seconds) {
  if (!seconds || seconds === 0) return '--:--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatWatchTime(minutes) {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}
