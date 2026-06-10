// Activity event log (yt_activity_log) + suggested-sort scoring
// (yt_suggest_scores). Imported by the SERVICE WORKER ONLY — the content
// script and side panel are plain scripts and never import this module.
//
// Mutex discipline: logActivity issues its own storage.update; callers must
// invoke it sequentially AFTER their own updates complete, never from inside
// another updateFn (the shared write queue would deadlock-by-queue).

import { STORAGE_KEYS } from './constants.js';
import * as storage from './storage.js';

export const EVENT_TYPES = new Set([
  'video_opened', 'watch_progress', 'video_completed', 'added_to_queue',
  'marked_watched', 'removed', 'skipped', 'session_switched',
]);

const MAX_EVENTS = 5000;        // FIFO cap (~1.25 MB of ~250-byte events)
const QUOTA_RETRY_KEEP = 2500;  // truncate-to size when a write hits quota
const REBUILD_THRESHOLD = 25;   // recompute scores after this many new events
const OPEN_DEDUPE_MS = 60000;   // video_opened dedupe window
const OPEN_DEDUPE_SCAN = 30;    // tail events scanned for the dedupe

// Scoring weights — defensible defaults, kept as named constants for cheap
// iteration (plan 06 §7). recency = 0.5 ^ (daysSinceLastWatch / 7).
const W_COMPLETION = 0.5;
const W_RECENCY = 0.3;
const W_COUNT = 0.2;
const RECENCY_HALF_LIFE_MS = 7 * 86400000;

// Missing/corrupt log (non-object, events not an array, seq not a finite
// number) resets to the empty schema-v1 shape — never throws.
export function normalizeLog(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.events) ||
      typeof raw.seq !== 'number' || !Number.isFinite(raw.seq)) {
    return { v: 1, seq: 0, events: [] };
  }
  return raw;
}

// YouTube rewrites watch URLs (&t=, &pp=) so one navigation can fire
// tabs.onUpdated several times — same tab+video within the window logs once.
function isDuplicateOpen(events, ev, now) {
  const start = Math.max(0, events.length - OPEN_DEDUPE_SCAN);
  for (let i = events.length - 1; i >= start; i--) {
    const e = events[i];
    if (e.type === 'video_opened' && e.videoId === ev.videoId &&
        e.tabId === ev.tabId && now - e.ts < OPEN_DEDUPE_MS) {
      return true;
    }
  }
  return false;
}

// Append one event or a batch (one update → contiguous seqs). Best-effort
// telemetry: a quota error retries ONCE on a truncated log; a second failure
// drops the batch silently — logging never blocks the feature path.
export async function logActivity(eventOrEvents) {
  const batch = (Array.isArray(eventOrEvents) ? eventOrEvents : [eventOrEvents])
    .filter(ev => ev && EVENT_TYPES.has(ev.type));
  if (batch.length === 0) return;

  let settings = null;
  try { settings = await storage.get(STORAGE_KEYS.SETTINGS); } catch {}
  if (settings && settings.activityLogEnabled === false) return;

  const append = (raw, truncateFirst) => {
    const log = normalizeLog(raw);
    if (truncateFirst && log.events.length > QUOTA_RETRY_KEEP) {
      log.events.splice(0, log.events.length - QUOTA_RETRY_KEEP);
    }
    const now = Date.now();
    let appended = 0;
    for (const ev of batch) {
      if (ev.type === 'video_opened' && isDuplicateOpen(log.events, ev, now)) continue;
      log.seq += 1; // monotonic — survives FIFO rotation
      log.events.push({ ...ev, seq: log.seq, ts: now });
      appended++;
    }
    if (appended === 0) return undefined; // every event deduped — skip write
    if (log.events.length > MAX_EVENTS) {
      log.events.splice(0, log.events.length - MAX_EVENTS);
    }
    return log;
  };

  try {
    await storage.update(STORAGE_KEYS.ACTIVITY_LOG, (raw) => append(raw, false));
  } catch {
    try {
      await storage.update(STORAGE_KEYS.ACTIVITY_LOG, (raw) => append(raw, true));
    } catch {}
  }
  // Deliberately no broadcast — nothing renders off the log; the panel's
  // throttled score refresh rides chrome.storage.onChanged for free.
}

function round4(n) { return Math.round(n * 10000) / 10000; }

// Single O(events) pass: per-channel completion/recency/watch-count
// composite. Channels keyed by trimmed+lowercased name; null/'Unknown'
// channels are skipped (un-enriched placeholders must not pollute scores).
function computeChannelStats(events, now) {
  const agg = new Map(); // key → { name, vids: Map<videoId, bestPct|null>, lastTs }
  for (const e of events) {
    if (e.type !== 'watch_progress' && e.type !== 'video_completed') continue;
    const name = (e.channel || '').trim();
    if (!name || name === 'Unknown' || !e.videoId) continue;
    const key = name.toLowerCase();
    let a = agg.get(key);
    if (!a) { a = { name, vids: new Map(), lastTs: 0 }; agg.set(key, a); }
    const pct = e.type === 'video_completed' ? 100
      : (Number.isFinite(e.maxPercent) ? Math.min(100, e.maxPercent) : null);
    const prev = a.vids.get(e.videoId);
    if (pct !== null) {
      a.vids.set(e.videoId, Math.max(prev ?? 0, pct));
    } else if (prev === undefined) {
      a.vids.set(e.videoId, null); // counts toward watchCount, not completion
    }
    if (e.ts > a.lastTs) a.lastTs = e.ts;
  }

  const channels = {};
  for (const [key, a] of agg) {
    const pcts = [...a.vids.values()].filter(p => p !== null);
    const completionRate = pcts.length
      ? pcts.reduce((s, p) => s + p, 0) / pcts.length / 100
      : 0;
    const watchCount = a.vids.size;
    const recency = a.lastTs
      ? Math.pow(0.5, (now - a.lastTs) / RECENCY_HALF_LIFE_MS)
      : 0;
    channels[key] = {
      name: a.name,
      score: round4(W_COMPLETION * completionRate + W_RECENCY * recency +
        W_COUNT * Math.min(1, watchCount / 10)),
      completionRate: round4(completionRate),
      watchCount,
      lastTs: a.lastTs,
    };
  }
  return channels;
}

// Lazy + cached: recomputes only when the log advanced REBUILD_THRESHOLD
// events past the cache, or the cache is missing/corrupt/ahead of a reset
// log (log.seq < computedAtSeq forces recompute). Only ever invoked via
// MSG.GET_SUGGEST_SCORES — never on plain panel renders.
export async function getSuggestScores() {
  const log = normalizeLog(await storage.get(STORAGE_KEYS.ACTIVITY_LOG));
  const cached = await storage.get(STORAGE_KEYS.SUGGEST_SCORES);
  if (cached && cached.v === 1 && typeof cached.computedAtSeq === 'number' &&
      log.seq >= cached.computedAtSeq &&
      log.seq - cached.computedAtSeq < REBUILD_THRESHOLD) {
    return cached;
  }
  const now = Date.now();
  const fresh = {
    v: 1,
    computedAtSeq: log.seq,
    computedAt: now,
    channels: computeChannelStats(log.events, now),
  };
  await storage.update(STORAGE_KEYS.SUGGEST_SCORES, () => fresh);
  return fresh;
}
