# Analytics — Activity Log, Watch Telemetry, Suggested Sort, Export

Feature group: **analytics**. Target repo: YouTube Tab Manager (Chrome MV3, no build step, plain JS).

---

## 1. Scope

1. **Append-only activity event log** (`yt_activity_log` in `chrome.storage.local`): every meaningful YouTube interaction becomes an event — `video_opened`, `watch_progress`, `video_completed`, `added_to_queue`, `marked_watched`, `removed`, `skipped`, `session_switched` — each carrying `seq`, `ts`, `videoId`, `title`, `channel`, `durationSec`, `isShort`, `source`, `tabId` plus type-specific fields. Capped at **5000 events FIFO** (~1.25 MB; storage.local quota is ~10 MB). Schema-versioned (`v: 1`) so later consumers (other AIs/tools) can parse it reliably.
2. **Silent background capture**: even with Intercept OFF, every navigation to a YouTube watch/shorts URL in **any tab of any window** appends a `video_opened` event (deduped per tab+video). The existing `yt_logged_videos` key is **kept unchanged** (it is the Collect-button drain queue); the activity log is the superset "extend into the full event log" deliverable.
3. **Watch telemetry**: extend the existing content-script watch tracking (the 1 s tick → `flushWatchTime()` → `TRACK_WATCH_TIME`, and the 20 % `MARK_WATCHED` rule). The same flush now also carries per-video `secondsWatched` + `maxPercent` reached + scraped title/channel, which the worker appends as `watch_progress` events. The existing `ended` → `VIDEO_ENDED` hook additionally yields `video_completed`. **No duplicate tracking loop is added.**
4. **"Suggested" sort option**: a deterministic per-channel scoring function (completion rate + recency + watch count) computed lazily from the log, cached in `yt_suggest_scores`, invalidated by log-append batches (seq delta ≥ 25). A new `Suggest` button joins the existing sort buttons; never recomputed on plain panel renders.
5. **Export JSON**: a toggle-bar button in the side panel that downloads the full activity log as a JSON file via Blob + `<a download>` from the panel document (no new permissions). Fallbacks named in §7.

---

## 2. Clarifying questions & decisions

1. **Q: Should logging run even when Auto-Intercept is OFF, and is there a kill switch?**
   **A:** Always on by default; a `yt_settings.activityLogEnabled` key (default `true`) is honored by the worker's `logActivity()` but gets **no UI toggle in v1** (the toggle bar is at 7 buttons after Export; settable via console/future settings page). *Rationale: the spec demands continuous capture; the key future-proofs privacy control without UI clutter.*
2. **Q: Does the activity log replace `yt_logged_videos`?**
   **A:** No. `yt_logged_videos` keeps its exact semantics (drained by Collect, 200-entry cap). The activity log is append-only and never drained. *Rationale: Collect's drain behavior is load-bearing; reusing one key for two lifecycles invites data loss.*
3. **Q: What counts as a "video opened"?**
   **A:** Any `chrome.tabs.onUpdated` `changeInfo.url` that passes `extractVideoId()` (which already enforces `isYouTubeHost`), in any tab — not just recently created ones. YouTube SPA navigations update `tab.url` and fire `onUpdated`, so in-tab navigation is covered with zero content-script work. Deduped: skip if the last 30 events contain a `video_opened` for the same `tabId`+`videoId` within 60 s. *Rationale: one worker-side hook covers new tabs, SPA navs, and reloads; dedupe inside the log update needs no extra session state.*
4. **Q: Per-video or per-channel suggestion scores?**
   **A:** Per-channel aggregates; the panel maps each queue video to its channel's score. *Rationale: channel stats are stable while the queue churns; the cache never needs rewriting when videos are added/removed.*
5. **Q: What is the scoring function?**
   **A:** `score(channel) = 0.5 * completionRate + 0.3 * recency + 0.2 * min(1, watchCount / 10)` where `completionRate` = mean over that channel's videos of (best `maxPercent`/100, with `video_completed` counting as 1.0), `recency = 0.5 ^ (daysSinceLastWatch / 7)`, `watchCount` = distinct videoIds with watch events. Rounded to 4 decimals. *Rationale: deterministic given (log, now), cheap single pass over ≤ 5000 events, favors channels the user actually finishes.*
6. **Q: Where and when does scoring run?**
   **A:** In the worker, inside `getSuggestScores()` (new `utils/activity-log.js`), only when the panel asks via `MSG.GET_SUGGEST_SCORES` **and** the cache is stale (`log.seq - cache.computedAtSeq >= 25` or cache missing/older-seq). The panel additionally throttles its own requests to one per 60 s. *Rationale: meets "lazy + cached + never on every render" verbatim; worst case is one O(5000) pass per 25 appended events.*
7. **Q: Sort button label — "Suggested" doesn't fit a 350 px panel row?**
   **A:** Label `Suggest`, `title="Suggested — ranked by your watch history"`, plus shrinking `.sort-btn` padding/font slightly (§4.7). *Rationale: keeps all four sort buttons + direction + star + search on one row.*
8. **Q: What happens to drag-and-drop reorder while Suggested sort is active?**
   **A:** Disabled — the drop handler returns early when `currentSort === 'suggested'`. *Rationale: drag reorder works by swapping the active sort field between two videos; there is no per-video "suggested" field to swap, and silently swapping `addedAt` would corrupt the Added sort.*
9. **Q: The worker's `sortVideosList()` (autoplay-next / skip fallback) doesn't know 'suggested' — problem?**
   **A:** Acceptable: it falls through to `addedAt`. The panel-written `yt_next_video_order` (which reflects the suggested order whenever the panel is open) takes priority in both `SKIP_VIDEO` and `VIDEO_ENDED`. *Rationale: duplicating the scoring in the hot autoplay path buys little; documented in §7.*
10. **Q: Cap and rotation strategy?**
    **A:** 5000 events FIFO, enforced inside the same `storage.update` that appends (`events.splice(0, events.length - 5000)`), with a monotonic `seq` counter that survives rotation. If the write throws a quota error, truncate to the newest 2500 and retry once. *Rationale: 5000 × ~250 bytes ≈ 1.25 MB, comfortably inside quota even alongside other features; `seq` gives cheap cache invalidation.*
11. **Q: Export mechanism — does Blob + anchor work in a side panel page?**
    **A:** Yes (planned + verified by test): side panel documents are ordinary extension pages where `URL.createObjectURL` + programmatic `<a download>` click works; the headless test asserts a real Playwright `download` event from the panel page, and the headed live test confirms it in the actual side panel chrome. **Named fallbacks** if live verification fails: (1) add `"downloads"` permission and call `chrome.downloads.download({ url: blobUrl, filename })` from the panel; (2) zero-permission fallback: copy JSON to clipboard via `navigator.clipboard.writeText` and flash the button label to "Copied". *Rationale: the no-permission path first, ranked fallbacks ready.*
12. **Q: What does `session_switched` mean?**
    **A:** The user activates (focuses) a YouTube tab showing a **different** videoId than the last activated YouTube video tab. Logged from `chrome.tabs.onActivated` with `videoId` + `fromVideoId`. Switching to a non-YouTube tab and back to the same video logs nothing. *Rationale: captures attention switches between videos without noise from ordinary tab flipping.*
13. **Q: Events for videos we know nothing about (not in queue) — where do title/channel come from?**
    **A:** `null` is allowed on any event. `watch_progress` events carry title (from `document.title` minus the " - YouTube" suffix) and channel (existing `#channel-name a` selector) scraped opportunistically during the playback tick, so any video actually watched gets named within one flush. `video_opened` for never-played videos stays sparse. No extra network fetches for log enrichment. *Rationale: zero added fetch load; the data that matters (watched videos) is enriched for free.*
14. **Q: When is `video_completed` emitted — `ended` event, or a maxPercent threshold?**
    **A:** Only on the existing `ended` → `VIDEO_ENDED` hook (appended before the autoplay early-return, so it fires even with Autoplay off), with `maxPercent: 100`. Near-completes are recoverable analytically from `watch_progress.maxPercent`. *Rationale: one unambiguous trigger; no dedupe machinery for threshold re-crossings.*
15. **Q: Backfill the log from existing `yt_videos` / `yt_logged_videos` on first run?**
    **A:** No — the log starts empty; `onInstalled` initializes `{ v: 1, seq: 0, events: [] }`. *Rationale: synthesizing events with fake timestamps would poison the recency term of the scoring.*
16. **Q: Should `marked_watched` distinguish the 20 % auto-rule from a manual panel click?**
    **A:** Yes, via `source`: `'content'` for the auto-rule (`MSG.MARK_WATCHED`), `'manual'` for panel/skip paths. Un-marking (watched→false) is not logged (no event type for it; out of scope). *Rationale: source is exactly the field for provenance.*

---

## 3. Data & message contract

### 3.1 Storage keys (chrome.storage.local)

**NEW `STORAGE_KEYS.ACTIVITY_LOG = 'yt_activity_log'`** — written ONLY by the service worker via `storage.update`:

```js
{
  v: 1,                  // schema version
  seq: 12345,            // last assigned event seq; monotonic, survives FIFO rotation
  events: [              // ordered oldest → newest, length <= 5000
    {
      seq: 12001,        // unique increasing int
      ts: 1765432100000, // Date.now() at append
      type: 'video_opened' | 'watch_progress' | 'video_completed' |
            'added_to_queue' | 'marked_watched' | 'removed' | 'skipped' |
            'session_switched',
      videoId: 'dQw4w9WgXcQ' | null,
      title: string | null,
      channel: string | null,
      durationSec: number | null,
      isShort: boolean | undefined,
      source: 'intercept' | 'collect' | 'manual' | 'shorts' | 'browse' | 'content' | null,
      tabId: number | null,
      // type-specific (absent otherwise):
      url: string,             // video_opened, watch_progress, added_to_queue
      secondsWatched: number,  // watch_progress — whole seconds in this flush window
      maxPercent: number|null, // watch_progress (0–100 best reached); video_completed (100)
      fromVideoId: string|null,// session_switched, video-attention variant (videoId non-null)
      sessionId: string,       // session_switched, session-management variant (videoId null)
      fromSessionId: string,   // session_switched, session-management variant
      reason: 'create' | 'switch' | 'delete' | 'merge' // session_switched, session-management variant
    }
  ]
}
```

**`session_switched` has TWO variants** (reconciled post-build; consumers tell
them apart by `videoId`):
1. **Video-attention** (decision #12, `tabs.onActivated`): the user focused a
   YouTube tab showing a different video than the last focused video tab —
   carries `videoId` + `fromVideoId` (`source: 'browse'`), never
   `sessionId`/`fromSessionId`/`reason`.
2. **Session-management** (integration-contract ruling 4, added by stage 06 at
   the stage-04 seams): CREATE/SET_ACTIVE/DELETE/MERGE_SESSION — carries
   `videoId: null`, `sessionId` (the session now active / merge target),
   `fromSessionId` (previous active / deleted / merged-away session) and
   `reason` (`source: 'manual'`), never `fromVideoId`.
`source` semantics: `intercept` = tab-interception queue add; `collect` = Collect button (incl. drained `yt_logged_videos`); `manual` = explicit user action in panel/popup; `shorts` = organic navigation to a /shorts/ URL; `browse` = organic navigation to a watch URL; `content` = automatic content-script telemetry. **Note for contract reconciliation:** `browse` and `content` extend the lead's four-value enum.

**NEW `STORAGE_KEYS.SUGGEST_SCORES = 'yt_suggest_scores'`** — written ONLY by the worker; panel obtains it via `MSG.GET_SUGGEST_SCORES` (never reads the key directly, because a read can't trigger the lazy recompute):

```js
{
  v: 1,
  computedAtSeq: 12345,   // log.seq when computed; stale when log.seq - this >= 25
  computedAt: 1765432100000,
  channels: {             // key = channel name trimmed + lowercased
    'channel name lc': {
      name: 'Channel Name',      // original casing, for debugging
      score: 0.7314,             // 4-decimal deterministic composite
      completionRate: 0.85,      // mean best-maxPercent/100 across distinct videos
      watchCount: 7,             // distinct videoIds with watch events
      lastTs: 1765000000000      // newest watch event ts
    }
  }
}
```

**CHANGED `yt_settings` (`STORAGE_KEYS.SETTINGS`)**:
- NEW key `activityLogEnabled: true` (default; `false` makes `logActivity()` a no-op).
- CHANGED domain: `sortBy` may now also be `'suggested'` (existing values `'addedAt' | 'duration' | 'uploadedAt'` unchanged). The worker's `sortVideosList` treats `'suggested'` as its existing `default:` branch (addedAt) — no code change needed there.

**UNCHANGED:** `yt_videos`, `yt_watch_time`, `yt_logged_videos`, `yt_next_video_order`. **No new `chrome.storage.session` keys** (the `session_switched` cursor and dedupe need no persistence — loss across worker restarts is benign and the `video_opened` dedupe is derived from the log itself).

### 3.2 Settings keys (summary for reconciliation)

| key | default |
|---|---|
| `activityLogEnabled` | `true` |
| `sortBy` (existing, domain extended) | `'addedAt'` (unchanged) — adds `'suggested'` as a legal value |

### 3.3 Message types (add to `MSG` in `utils/constants.js`; literals inlined in sidepanel.js/content.js)

| Type | Request | Response |
|---|---|---|
| **NEW `GET_SUGGEST_SCORES`** | `{ type }` | the full `yt_suggest_scores` object (recomputed first if stale): `{ v, computedAtSeq, computedAt, channels }` |
| **NEW `LOG_ACTIVITY_EVENT`** | `{ type, event: { type: <event type>, videoId?, title?, channel?, durationSec?, isShort?, source?, url?, ... } }` — generic append hook for other UI surfaces/feature groups; `event.type` validated against the allowlist; `tabId` defaults to `sender.tab?.id` | `{ success: boolean, error? }` |
| **CHANGED `TRACK_WATCH_TIME`** | `{ type, minutes, telemetry?: { videoId, url, isShort, secondsWatched, maxPercent, durationSec, title, channel } }` — `telemetry` is optional; old senders remain valid | `{ success: true }` (unchanged) |
| `VIDEO_ENDED` (behavior change only) | unchanged `{ type, videoId? }` | unchanged — but the worker now appends a `video_completed` event **before** the `autoPlayNext` early-return |
| `MARK_WATCHED`, `REMOVE_VIDEO`, `UPDATE_VIDEO`, `SKIP_VIDEO`, `ADD_VIDEO`, `COLLECT_TABS` | request/response shapes unchanged | now also append `marked_watched` / `removed` / `skipped` / `added_to_queue` events as side effects (§4.3) |

Deliberately **no** `GET_ACTIVITY_LOG` message: the Export handler in the panel reads `chrome.storage.local.get('yt_activity_log')` directly (read-only, no mutex needed, consistent with the panel's existing direct reads/writes of `yt_next_video_order`).

### 3.4 New files

- `utils/activity-log.js` — ES module imported by the service worker only (content script and panel are plain scripts and never import it).
- `tests/test-analytics.js` — new Playwright suite.
- `.documentation/build-plans/06-analytics.md` — this plan.

`manifest.json` — **no changes** (no new permissions unless the export fallback in §7 is triggered).

---

## 4. Implementation steps

### 4.1 `utils/constants.js`

Add to `STORAGE_KEYS`: `ACTIVITY_LOG: 'yt_activity_log'`, `SUGGEST_SCORES: 'yt_suggest_scores'`.
Add to `DEFAULT_SETTINGS`: `activityLogEnabled: true`.
Add to `MSG`: `GET_SUGGEST_SCORES: 'GET_SUGGEST_SCORES'`, `LOG_ACTIVITY_EVENT: 'LOG_ACTIVITY_EVENT'`.

### 4.2 NEW `utils/activity-log.js`

```js
import { STORAGE_KEYS } from './constants.js';
import * as storage from './storage.js';

export const EVENT_TYPES = new Set([
  'video_opened', 'watch_progress', 'video_completed', 'added_to_queue',
  'marked_watched', 'removed', 'skipped', 'session_switched',
]);
const MAX_EVENTS = 5000;
const REBUILD_THRESHOLD = 25;      // recompute scores after this many new events
const OPEN_DEDUPE_MS = 60000;      // video_opened dedupe window
const OPEN_DEDUPE_SCAN = 30;       // how many tail events to scan for dedupe

export function normalizeLog(raw) { /* returns {v:1, seq:0, events:[]} if raw is missing/corrupt (non-object, non-array events, non-number seq) */ }
```

- `export async function logActivity(eventOrEvents)`:
  1. Read settings once (`storage.get(STORAGE_KEYS.SETTINGS)`); if `activityLogEnabled === false`, return.
  2. `storage.update(STORAGE_KEYS.ACTIVITY_LOG, (raw) => { const log = normalizeLog(raw); ... })` — for each input event: if `type === 'video_opened'`, scan the last `OPEN_DEDUPE_SCAN` events and **skip** when one matches same `type`+`videoId`+`tabId` within `OPEN_DEDUPE_MS`; otherwise assign `seq: ++log.seq`, `ts: Date.now()`, push. Then FIFO-rotate: `if (log.events.length > MAX_EVENTS) log.events.splice(0, log.events.length - MAX_EVENTS)`. Return `log` (return `undefined` if every event was deduped — skips the write).
  3. Wrap the update in try/catch; on a quota error, retry once inside a second `storage.update` that first truncates `events` to the newest 2500.
  4. Never broadcast (no UI renders off the log) — `chrome.storage.onChanged` fires naturally for the panel's throttled score refresh.
  5. **Mutex discipline:** `logActivity` issues its own `storage.update`; callers must call it **sequentially after** their own updates, never from inside another `updateFn` (the mutex would deadlock-by-queue).
- `export async function getSuggestScores()`:
  1. `const log = normalizeLog(await storage.get(STORAGE_KEYS.ACTIVITY_LOG));`
  2. `const cached = await storage.get(STORAGE_KEYS.SUGGEST_SCORES);` — if `cached?.v === 1 && log.seq >= cached.computedAtSeq && log.seq - cached.computedAtSeq < REBUILD_THRESHOLD`, return `cached`.
  3. Else single pass `computeChannelStats(log.events, Date.now())`, write `{ v:1, computedAtSeq: log.seq, computedAt: now, channels }` via `storage.update(STORAGE_KEYS.SUGGEST_SCORES, () => fresh)`, return it.
- `function computeChannelStats(events, now)` (module-private): per channel key (`channel.trim().toLowerCase()`, skipping empty/`'Unknown'`), track a per-videoId best-percent map (`watch_progress.maxPercent`, `video_completed` → 100), `lastTs` (max watch-event ts), then derive `completionRate` (mean of best-percents / 100), `watchCount` (map size), `recency = Math.pow(0.5, (now - lastTs) / (7 * 86400000))`, `score = round4(0.5*completionRate + 0.3*recency + 0.2*Math.min(1, watchCount/10))`.

### 4.3 `background/service-worker.js`

1. **Imports:** `import { logActivity, getSuggestScores, EVENT_TYPES } from '../utils/activity-log.js';`
2. **`onInstalled`:** after the existing key inits, add `const alog = await storage.get(STORAGE_KEYS.ACTIVITY_LOG); if (!alog) await storage.set(STORAGE_KEYS.ACTIVITY_LOG, { v: 1, seq: 0, events: [] });`
3. **`chrome.tabs.onUpdated` — silent capture.** Immediately after the existing `updateSidePanelForTab(tabId, changeInfo.url)` call (i.e. BEFORE the `isRecentlyCreated` gate, so it runs for every tab):
   ```js
   const navVideoId = extractVideoId(changeInfo.url);
   if (navVideoId) {
     logActivity({                          // fire-and-forget; mutex serializes
       type: 'video_opened', videoId: navVideoId, url: changeInfo.url,
       isShort: isShortUrl(changeInfo.url),
       source: isShortUrl(changeInfo.url) ? 'shorts' : 'browse',
       tabId,
     });
   }
   ```
   The rest of the handler (intercept logic) is unchanged except the queue-add call becomes `addVideoToQueue(changeInfo.url, videoId, undefined, undefined, 'intercept')`.
4. **`chrome.tabs.onActivated` — `session_switched`.** Add module-level `let lastActiveVideo = null; // { tabId, videoId }` near `lastPlayingTabId`. Inside the existing handler's `try`, after `updateSidePanelForTab`:
   ```js
   const vid = extractVideoId(tab.url || '');
   if (vid && lastActiveVideo?.videoId !== vid) {
     logActivity({ type: 'session_switched', videoId: vid,
       fromVideoId: lastActiveVideo?.videoId ?? null, tabId: tab.id, source: 'browse' });
     lastActiveVideo = { tabId: tab.id, videoId: vid };
   }
   ```
   Do **not** reset `lastActiveVideo` on non-YouTube activations (decision #12). Loss on worker restart is benign (one extra event max).
5. **`addVideoToQueue(url, videoId, explicitTimestamp, starred, source = 'manual')`** — add the 5th param. After the existing `broadcast(...)`, inside the `if (inserted)` block and before `enrichVideo(videoId)`:
   ```js
   logActivity({ type: 'added_to_queue', videoId, url,
     title: null, channel: null, durationSec: null,
     isShort: inserted.isShort, source, tabId: null });
   ```
   (Title/channel are still 'Loading...' at insert time — log nulls; `watch_progress` enriches later.) Duplicate-bump (existing entry) logs nothing. Call-site sources: intercept path `'intercept'` (step 3); `MSG.ADD_VIDEO` → `'manual'`; `MSG.COLLECT_TABS` (both the open-tabs loop and the drained `yt_logged_videos` loop) → `'collect'`.
6. **`MSG.TRACK_WATCH_TIME`** — keep the existing `yt_watch_time` update verbatim, then:
   ```js
   const t = message.telemetry;
   if (t?.videoId && typeof t.secondsWatched === 'number') {
     await logActivity({ type: 'watch_progress', videoId: t.videoId,
       url: t.url ?? null, title: t.title ?? null, channel: t.channel ?? null,
       durationSec: t.durationSec ?? null, isShort: !!t.isShort,
       secondsWatched: Math.round(t.secondsWatched),
       maxPercent: Number.isFinite(t.maxPercent) ? Math.min(100, Math.round(t.maxPercent)) : null,
       source: 'content', tabId: sender.tab?.id ?? null });
   }
   ```
7. **`MSG.VIDEO_ENDED`** — at the very top of the case (before the `autoPlayNext` early-return):
   ```js
   if (message.videoId) {
     const known = ((await storage.get(STORAGE_KEYS.VIDEOS)) || []).find(v => v.id === message.videoId);
     await logActivity({ type: 'video_completed', videoId: message.videoId,
       title: known?.title ?? null, channel: known?.channel ?? null,
       durationSec: known?.duration ?? null, isShort: known?.isShort,
       maxPercent: 100, source: 'content', tabId: sender.tab?.id ?? null });
   }
   ```
8. **`MSG.MARK_WATCHED`** — after the existing update, `if (changed)` also `await logActivity({ type: 'marked_watched', videoId: message.videoId, ...lookup title/channel/duration from the videos snapshot captured in the updateFn closure..., source: 'content', tabId: sender.tab?.id ?? null })` (capture the found video into a closure variable inside the existing updateFn — no second read).
9. **`MSG.UPDATE_VIDEO`** — inside the existing updateFn capture `const wasWatched = video.watched` before `Object.assign`; after the update, `if (message.updates?.watched === true && !wasWatched)` append `marked_watched` with `source: 'manual'`.
10. **`MSG.REMOVE_VIDEO`** — capture the removed video in the updateFn closure (`removed = videos.find(...)`), then `if (removed) await logActivity({ type: 'removed', videoId, title, channel, durationSec: removed.duration, isShort: removed.isShort, source: 'manual', tabId: null })`.
11. **`MSG.SKIP_VIDEO`** — after the mark-watched block: `await logActivity({ type: 'skipped', videoId: currentVideoId ?? null, source: 'manual', tabId: message.tabId ?? null })`; and when `marked` is true, also append `marked_watched` (`source: 'manual'`). Two events, one batch: pass them as an array to `logActivity([...])`.
12. **NEW case `MSG.GET_SUGGEST_SCORES`:** `return await getSuggestScores();`
13. **NEW case `MSG.LOG_ACTIVITY_EVENT`:**
    ```js
    const ev = message.event;
    if (!ev || !EVENT_TYPES.has(ev.type)) return { success: false, error: 'invalid event' };
    await logActivity({ ...ev, tabId: ev.tabId ?? sender.tab?.id ?? null });
    return { success: true };
    ```

### 4.4 `content/content.js` (extend the existing tracking — no new intervals, no imports)

1. **Module-scope trackers** next to `accumulatedSeconds`:
   ```js
   let trackedVideoId = null, trackedUrl = null, trackedTitle = null,
       trackedChannel = null, trackedDurationSec = 0, trackedMaxPercent = 0;
   ```
2. **Inside the existing 1 s tick** in `startTracking()` (after `accumulatedSeconds++; checkWatchProgress(video);`):
   ```js
   const vid = getCurrentVideoId();
   if (vid && vid !== trackedVideoId) {
     trackedVideoId = vid; trackedUrl = window.location.href;
     trackedTitle = null; trackedChannel = null;
     trackedDurationSec = 0; trackedMaxPercent = 0;
   }
   if (vid && isFinite(video.duration) && video.duration > 0) {
     trackedDurationSec = Math.round(video.duration);
     const pct = Math.min(100, Math.round((video.currentTime / video.duration) * 100));
     if (pct > trackedMaxPercent) trackedMaxPercent = pct;
   }
   if (vid && (!trackedTitle || !trackedChannel)) {
     const t = document.title.replace(/\s*-\s*YouTube\s*$/, '').trim();
     if (t && t !== 'YouTube') trackedTitle = trackedTitle || t;
     const chEl = document.querySelector('#channel-name a, ytd-channel-name a, #owner #channel-name a');
     trackedChannel = trackedChannel || chEl?.textContent?.trim() || null;
   }
   ```
   (Livestreams: `video.duration === Infinity` → `isFinite` guard leaves `durationSec` 0 and `maxPercent` 0 → worker stores `maxPercent` as sent; fine.)
3. **`flushWatchTime()`** — replace the send with:
   ```js
   function flushWatchTime() {
     if (accumulatedSeconds < 1) return;
     const payload = { type: 'TRACK_WATCH_TIME', minutes: accumulatedSeconds / 60 };
     if (trackedVideoId) {
       payload.telemetry = {
         videoId: trackedVideoId, url: trackedUrl,
         isShort: /\/shorts\//.test(trackedUrl || ''),
         secondsWatched: accumulatedSeconds,
         maxPercent: trackedMaxPercent || null,
         durationSec: trackedDurationSec || null,
         title: trackedTitle, channel: trackedChannel,
       };
     }
     safeSend(payload);
     accumulatedSeconds = 0;
   }
   ```
   Trackers are NOT reset on flush (the same video keeps accumulating `maxPercent` across flushes); they reset only on SPA navigation / video change.
4. **SPA navigation handler** (the `MutationObserver` URL-change branch): the existing order already calls `flushWatchTime()` first (flushing the OLD video's telemetry, since `trackedUrl`/`trackedVideoId` were captured during ticks); after `hasMarkedWatched = false;` add:
   ```js
   trackedVideoId = null; trackedUrl = null; trackedTitle = null;
   trackedChannel = null; trackedDurationSec = 0; trackedMaxPercent = 0;
   ```
5. No other content-script changes. `MARK_WATCHED` and `VIDEO_ENDED` senders are untouched (worker-side now logs off them).

### 4.5 `sidepanel/sidepanel.html`

1. **Suggest sort button** — in `.sort-btns`, between the "Uploaded" button and `#sort-direction`:
   ```html
   <button class="sort-btn" data-sort="suggested" title="Suggested — ranked by your watch history">Suggest</button>
   ```
2. **Export button** — 7th button in `.toggle-bar`, after `#tb-hiderecs`:
   ```html
   <button class="tb-btn tb-btn--export" id="tb-export" data-desc="Export activity log (watch history events) as a JSON file">
     <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
     <span class="tb-label">Export</span>
   </button>
   ```
   (`data-desc` is mandatory per the toggle-bar rule; the existing `.toggle-bar [data-desc]` hover listener picks it up automatically because the button is static HTML present at script load.)

### 4.6 `sidepanel/sidepanel.js` (plain script — literals, no imports)

1. **Module state** near `cachedVideos`:
   ```js
   let suggestScores = { channels: {} };
   let lastScoreFetch = 0;
   async function loadSuggestScores(force) {
     if (!force && Date.now() - lastScoreFetch < 60000) return;
     lastScoreFetch = Date.now();
     try { const r = await msg({ type: 'GET_SUGGEST_SCORES' }); if (r?.channels) suggestScores = r; } catch {}
   }
   function channelScore(v) {
     const key = (v.channel || '').trim().toLowerCase();
     return suggestScores.channels[key]?.score ?? 0;
   }
   ```
2. **`sortVids()`** — add a case before `default`:
   ```js
   case 'suggested': {
     va = channelScore(a); vb = channelScore(b);
     if (va === vb) { va = a.addedAt || 0; vb = b.addedAt || 0; } // stable cold-start fallback
     break;
   }
   ```
   Direction semantics unchanged (`desc` = best first, the default).
3. **Sort click handler** — replace the body of the existing `.sort-btn` click listener with:
   ```js
   currentSort = btn.dataset.sort;
   updateSortUI();
   msg({ type: 'UPDATE_SETTINGS', settings: { sortBy: currentSort } });
   const apply = () => { loadVideos(); document.querySelector('.scroll-area').scrollTop = 0; };
   if (currentSort === 'suggested') loadSuggestScores(true).then(apply); else apply();
   ```
4. **`loadSettings()`** — keep the `'custom' → 'addedAt'` remap; `'suggested'` passes through untouched. After `updateSortUI()`, add: `if (currentSort === 'suggested') loadSuggestScores(true).then(loadVideos);`
5. **Drag guard** — first line of the `drop` handler body (after `e.preventDefault(); item.classList.remove('drag-over');`): `if (currentSort === 'suggested') return;`
6. **Event-driven score refresh** — extend the existing `chrome.storage.onChanged` listener (the one handling `yt_watch_time`):
   ```js
   if (area === 'local' && changes.yt_activity_log && currentSort === 'suggested') {
     loadSuggestScores().then(() => { if (currentSort === 'suggested') scheduleLoadVideos(); });
   }
   ```
   (Throttled by `lastScoreFetch`'s 60 s gate plus the worker's seq-delta gate — no polling, no per-render recompute.)
7. **Export handler** — near the other toggle-bar wiring:
   ```js
   document.getElementById('tb-export').addEventListener('click', async () => {
     const r = await chrome.storage.local.get('yt_activity_log');   // literal key — plain script
     const log = r.yt_activity_log || { v: 1, seq: 0, events: [] };
     const payload = {
       schema: 'yt_activity_log', schemaVersion: log.v,
       exportedAt: new Date().toISOString(),
       eventCount: log.events.length, seq: log.seq, events: log.events,
     };
     const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
     const url = URL.createObjectURL(blob);
     const d = new Date();
     const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
     const a = document.createElement('a');
     a.href = url; a.download = 'yt-activity-log-' + stamp + '.json';
     document.body.appendChild(a); a.click(); a.remove();
     setTimeout(() => URL.revokeObjectURL(url), 10000);
   });
   ```

### 4.7 `sidepanel/sidepanel.css`

1. Fit four sort buttons in the 350 px row — change the existing `.sort-btn` rule: `padding: 2px 7px;` → `padding: 2px 5px;` and `font-size: 11px;` → `font-size: 10.5px;`. Add `min-width: 70px;` to the existing `.search-inline` rule so search can compress but stays usable. Verify with the existing `screenshots/sidepanel.png` output that nothing wraps.
2. Export button hover accent (matches the refresh button's green pattern), appended near the other `tb-btn--*` modifiers:
   ```css
   /* Export: green like refresh */
   .tb-btn--export:hover { color: #2ba640; border-color: #2ba640; background: rgba(43,166,64,0.1); }
   ```

### 4.8 Order of work

constants → activity-log.js → service-worker hooks → content.js telemetry → panel HTML/CSS → panel JS → tests. Each worker hook is independently testable via `chrome.runtime.sendMessage` from an extension page.

---

## 5. Edge cases & failure modes

| Case | Handling |
|---|---|
| Log key missing / corrupt (wrong type, events not an array, seq NaN) | `normalizeLog()` resets to `{ v:1, seq:0, events:[] }` inside the update; never throws. |
| Quota exceeded on append (`storage.set` rejects) | `logActivity` catches, retries once after truncating to newest 2500 events; on second failure, drops the batch silently (log is best-effort telemetry, never blocks the feature path). |
| `tabs.onUpdated` firing multiple times for one navigation (YouTube rewrites the URL with `&t=`, `&pp=` params) | `video_opened` dedupe: same tab+video within 60 s appended once. |
| Worker killed mid-append | `seq` assignment + push + rotation happen inside ONE `storage.update` critical section — atomic; at worst one batch is lost (fire-and-forget call sites). |
| Two events from one action (skip → `skipped` + `marked_watched`) racing | passed as an array to a single `logActivity` call → one update, contiguous seqs. |
| Content script flush during SPA nav attributes seconds to the wrong video | trackers (`trackedVideoId/Url/Title/Channel`) are captured during playback ticks, and the nav handler flushes BEFORE resetting them — telemetry always describes the old video. |
| Livestream (`video.duration === Infinity`) | `isFinite` guard: `durationSec` stays null-ish, `maxPercent` stays 0 → sent as `null`; channel stats skip null percents. |
| Shorts loop without firing `ended` | no `video_completed` for shorts is expected; `watch_progress.maxPercent` still captures completion (documented analytics caveat). |
| Channel `'Unknown'` / null (placeholder rows, un-enriched videos) | `computeChannelStats` skips them — placeholders can't pollute scores. |
| Channel-name mismatch between oembed (`author_name`) and DOM scrape | keys normalized (trim + lowercase) which fixes case/whitespace variants; true renames split stats — accepted, noted in §7. |
| Suggested sort with empty log / unknown channels | all scores 0 → tiebreak falls back to `addedAt` desc — identical to today's default order, no error states or empty UI. |
| `yt_activity_log` reset/cleared while a stale `yt_suggest_scores` exists (`log.seq < computedAtSeq`) | the freshness check requires `log.seq >= computedAtSeq` → forces recompute. |
| Panel open during heavy logging (intercept storm, Collect) | panel has NO listener that re-renders on `yt_activity_log` changes except the 60 s-throttled score refresh when Suggested is active; virtual scroll untouched. |
| Export with a huge log | 5000 events ≈ 1.25 MB string — `JSON.stringify` + Blob are instant; `revokeObjectURL` deferred 10 s so the download starts safely. |
| Export clicked twice fast | two independent blobs/anchors; both download; harmless. |
| `LOG_ACTIVITY_EVENT` with bogus type / missing event | rejected with `{ success: false }`; allowlist via `EVENT_TYPES`. |
| Extension context invalidated mid-session (reload) | content script's `safeSend` already swallows; telemetry for that window is lost (accepted). |
| `activityLogEnabled: false` | `logActivity` returns before any write; Export still works on the frozen log; Suggested sort serves stale-but-valid cache. |
| Drag-reorder attempted under Suggested sort | drop handler no-ops (decision #8); dragstart still allowed visually — acceptable since drop does nothing (optionally set `draggable=false` when building cards while `currentSort==='suggested'` — do this in `buildVideoItem` via the existing `draggable` attr expression). |
| Incognito windows | extension not enabled there by default → no capture; documented, not worked around. |

---

## 6. Test plan

### NEW `tests/test-analytics.js` (headless; harness copied from `tests/test-event-driven.js` — `launchPersistentContext('', { channel:'chromium', args:[--disable-extensions-except, --load-extension] })`, `check()` counter, exit code)

1. **Worker event pipeline** (drive via `panel.evaluate(() => chrome.runtime.sendMessage(...))` from a `chrome-extension://<id>/sidepanel/sidepanel.html` page; assert by `sw.evaluate(() => chrome.storage.local.get('yt_activity_log'))`):
   - `ADD_VIDEO` → exactly one `added_to_queue` event, `source:'manual'`, `seq===1`, `videoId` correct.
   - `TRACK_WATCH_TIME` with `telemetry:{videoId,secondsWatched:30,maxPercent:42,durationSec:600,title:'T',channel:'Chan A',url,isShort:false}` → `watch_progress` appended with those fields AND `yt_watch_time[today]` incremented by 0.5 (regression: old behavior preserved).
   - `TRACK_WATCH_TIME` with NO telemetry → watch time updates, **no** event appended (backward compat).
   - `UPDATE_VIDEO {watched:true}` → `marked_watched` (`source:'manual'`); repeating it appends nothing new (wasWatched guard).
   - `REMOVE_VIDEO` → `removed` event carrying the title/channel of the removed entry.
   - `VIDEO_ENDED {videoId}` with `autoPlayNext:false` → `video_completed` appended despite the autoplay early-return.
   - seq values strictly increasing across all of the above.
2. **Rotation & cap:** `sw.evaluate` seeds `yt_activity_log` with 5000 dummy events (seq 1–5000, seq counter 5000); send one telemetry message → assert `events.length === 5000`, `events[0].seq === 2`, `log.seq === 5001`.
3. **Silent capture + dedupe:** `context.route()` a fake `https://www.youtube.com/watch?v=OPENTEST0011` page (established fake-YouTube pattern); `page.goto` it with default settings (intercept OFF) → assert a `video_opened` event with `source:'browse'` exists (THE silent-capture acceptance check); `goto` the same URL again immediately → still exactly one event (dedupe); also assert the video was NOT added to `yt_videos` (intercept off unaffected).
4. **Suggest scoring + cache:** seed a crafted log (`Chan A`: 3 videos at `maxPercent` 95, recent ts; `Chan B`: 1 video at 10, ts 30 days old) plus a `yt_videos` queue containing one unwatched video per channel; `GET_SUGGEST_SCORES` → `channels['chan a'].score > channels['chan b'].score`; `yt_suggest_scores.computedAtSeq === log.seq`; call again → `computedAt` unchanged (cache hit, no recompute); append 1 event and call again → still cache hit (below the 25-event threshold).
5. **Panel Suggested sort:** with the §4 seed, open the panel page; `.sort-btn[data-sort="suggested"]` exists; click it → button gains `.active`; first `.video-item`'s `data-id` is Chan A's video; `sw.evaluate` reads `yt_settings.sortBy === 'suggested'`; reload the panel page → Suggested still active and ordering identical (settings restore path).
6. **Export:** `const dl = panel.waitForEvent('download'); await panel.click('#tb-export');` → `(await dl).suggestedFilename()` matches `/^yt-activity-log-\d{4}-\d{2}-\d{2}\.json$/`; read `download.path()`, `JSON.parse` → `schema === 'yt_activity_log'`, `Array.isArray(events)`, `eventCount === events.length`. This headlessly proves Blob+anchor downloads work from an extension document.
7. **No-regression console check:** `watchConsole`-style error capture (registered at page creation, per the fixed pattern in `tests/test-extension.js`) on the panel page across all interactions → zero errors.

### Existing suites — additions

- **`tests/test-extension.js`** (Test 2 block): `check('Export button present', !!(await sidePanel.$('#tb-export')))`, `check('Export button has data-desc', ...)`, `check('Suggested sort button present', !!(await sidePanel.$('.sort-btn[data-sort="suggested"]')))`. The existing screenshot will visually confirm the 4-button sort row doesn't wrap.
- **`tests/test-event-driven.js`**: one new assertion — after `sw.evaluate` writes a `yt_activity_log` change while the panel shows the default (Added) sort, the panel performs **no** `loadVideos` re-render (assert a DOM marker/`data-render-count` unchanged, or simply assert no error and unchanged first-card id) — guards the "no render storms off the log" property.
- **`tests/test-races.js`**: optional hardening — fire 20 concurrent `LOG_ACTIVITY_EVENT` messages and assert 20 events with 20 distinct contiguous seqs (mutex proof for the new key).

### Headed / live only (named, with procedure)

- **Real telemetry end-to-end:** extend the manual `tests/test-panel-live.js` run — open a real YouTube video headed, let it play ≥ 35 s (one 30 s flush), then `sw.evaluate` read the log: a `watch_progress` event exists with real `title`/`channel` scraped from the live DOM and plausible `maxPercent`. The 1 s tick needs real playing media; headless fake pages have no playable stream.
- **Export from the real side panel chrome:** the headless test downloads from a panel document opened as a tab; the true side-panel window must be verified once headed (open panel via popup gesture, click Export, confirm the file lands in the Downloads bar). If Chrome ever blocks it there, apply fallback (1) from decision #11.
- **`session_switched`:** originally listed headed-only; now ALSO covered headless in `test-analytics.js` — Playwright `page.bringToFront()` fires `chrome.tabs.onActivated`, so the video-attention variant (videoId/fromVideoId, same-video no-op) and the session-management variant (create/switch/delete/merge reasons, already-active no-op) are both asserted automatically. A headed sanity pass with real focus events remains a nice-to-have, not a gate.

---

## 7. Risks & explicitly out-of-scope

**Risks**

1. **Whole-log rewrite per append batch** — each `storage.update` on a full log reads+writes ~1.25 MB. Bounded: appends are batched (flush every 30 s, navigations, queue actions), so worst case is a few writes/minute. If profiling ever shows worker jank, the named follow-up is sharding into monthly keys — explicitly NOT in this plan.
2. **Blob+anchor in the genuine side panel window** is verified live only once (headless proves the extension-document path). Ranked fallbacks (decision #11): `"downloads"` permission + `chrome.downloads.download`, then clipboard copy. Only fallback (1) would touch `manifest.json` — flag to the lead before adding the permission.
3. **Channel-name keying** mixes oembed `author_name` and DOM-scraped names; normalization (trim+lowercase) handles casing only — a channel rename splits its stats. Accepted: scores degrade gracefully, never error.
4. **Heuristic quality of Suggested sort** — weights (0.5/0.3/0.2, 7-day half-life) are defensible defaults, not tuned. They are constants at the top of `utils/activity-log.js` for cheap iteration.
5. **Worker-side sort fallback ignores 'suggested'** — `SKIP_VIDEO`/`VIDEO_ENDED` fallback ordering uses `addedAt` when `yt_next_video_order` is empty (panel never opened this session). Accepted; mirroring scoring into the worker's sort path is the named follow-up if it bothers daily use.
6. **Contract-reconciliation flags for the lead:** (a) `source` enum extended with `'browse'`/`'content'` beyond the spec's four; (b) `TRACK_WATCH_TIME` request shape gains an optional `telemetry` object — any other group touching that message must preserve it; (c) `tabs.onUpdated` and `tabs.onActivated` gain code — groups editing those listeners must keep the capture hooks above the intercept gate; (d) generic `LOG_ACTIVITY_EVENT` exists for other groups to append events without new storage writers.
7. **storage.local shared quota** — 5000-event cap keeps analytics ≤ ~1.5 MB total (log + scores); if other groups add large keys, the quota-retry truncation in `logActivity` is the pressure-relief valve.

**Platform-impossible / out-of-scope (with closest achievable alternative)**

- **Capturing YouTube activity in Incognito or other Chrome profiles** — impossible without the user enabling the extension there; alternative: none needed, documented gap.
- **True per-second watch heatmaps / seek maps** — would need a per-second event stream (storage write amplification); alternative: `maxPercent` + `secondsWatched` per 30 s flush window, which already powers the correlations.
- **`video_completed` for looping Shorts** — `ended` doesn't fire on loops; alternative: `watch_progress.maxPercent` reaching 100 is the analytical signal.
- **Logging videos opened in embedded players on third-party sites** — content script only matches `*://*.youtube.com/*`; alternative: out of scope (would require `<all_urls>` content-script injection; rejected).
- **A settings UI for `activityLogEnabled` and scoring weights** — deferred to a future settings surface; keys exist and are honored now.
- **Automatic upload/sync of the log anywhere** — explicitly never; export is user-initiated and local-only.
- **Backfilling historical events** from `yt_videos`/`yt_watch_time` — rejected (decision #15).
