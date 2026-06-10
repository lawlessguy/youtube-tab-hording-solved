# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Chrome Manifest V3 extension — "YouTube Tab Manager". Manages YouTube video queues in a side panel, tracks watch time, and controls volume/speed.

## Commands

- `npm test` — Run Playwright headless smoke tests (loads extension in Chromium, screenshots to `screenshots/`)
- `npm run test:all` — Full headless chain: smoke + all 14 targeted suites below
- `npm run test:headed` — Smoke tests with visible browser; `test:debug` keeps it open
- `npm run generate-icons` — Regenerate PNG icons from `scripts/generate-icons.js`
- Targeted headless suites (npm script in parentheses):
  - `test-races.js` (`test:races`) — concurrent storage mutation correctness (lost updates, duplicate queue entries)
  - `test-virtual-scroll.js` (`test:scroll`) — side panel virtual scroller (bounded DOM, correct window, node reuse)
  - `test-media-routing.js` (`test:media`) — GET_MEDIA_STATE tabId + MEDIA_CONTROL routing (live YouTube page)
  - `test-tab-management.js` (`test:tabs`) — duplicate removal, panel enablement, intercept guards, middle-click survival
  - `test-url-validation.js` (`test:urls`) — hostile lookalike URLs stay out of queue/stats
  - `test-event-driven.js` (`test:events`) — storage.onChanged badge/watch-time propagation (routed fake YouTube page)
  - `test-panel-gesture.js` (`test:gesture`) — side panel opens from a trusted click with zero worker errors
  - `test-status-indicators.js` (`test:indicators-status`) — open-tab TAB chips, addCount chips, card geometry guard
  - `test-sessions.js` (`test:sessions`) — session CRUD/merge/switch, per-session queues, channel filter, smart play
  - `test-analytics.js` (`test:analytics`) — activity log shape/rotation/capture, suggested sort, export
  - `test-player.js` (`test:player`) — speed sync, drag-resizable player, timeline seek history
  - `test-viewing-modes.js` (`test:modes`) — in-page masthead queue strip + slim panel mode
  - `test-pip.js` (`test:pip`) — PiP controls row, auto-PiP wiring, Document-PiP fallback rules
  - `test-shorts.js` (`test:shorts`) — shorts tools strip, left rail, in-panel player, auto-scroll/auto-close
- Headed/manual live checks against real YouTube (NOT in `test:all`): `test:panel-live` (includes real watch-telemetry capture), `test:sessions-live` (two-OS-window smart play, real middle-click, real channel enrichment), `test:player-live`, `test:viewing-live` (home + watch + dark search), `test:pip-live`, `test:shorts-live` (includes the real embed onStateChange bridge), plus `node tests/test-indicators.js`

## Architecture

**No build step.** All files are plain JS served directly by Chrome. No bundler, no TypeScript.

### Module System

- **Service worker** (`background/service-worker.js`): ES module (`"type": "module"` in manifest). Imports from `utils/`.
- **Content script** (`content/content.js`): IIFE, self-contained. Cannot use ES imports. Communicates via `chrome.runtime.sendMessage` and reads `chrome.storage.local` directly.
- **Popup** (`popup/popup.js`): Shows tab stats (total, duplicates, shorts) with delete actions, volume/speed sliders, side panel opener. Plain script, no `type="module"`.
- **Side panel** (`sidepanel/sidepanel.js`): Plain script (no `type="module"`). Constants are inlined, not imported.

### Message-Passing & Storage Architecture

All state lives in `chrome.storage.local`. UI surfaces communicate through `chrome.runtime.sendMessage` → service worker's `handleMessage()` switch. Message types are defined in `utils/constants.js` as `MSG.*`; storage keys as `STORAGE_KEYS.*`.

**Every storage mutation MUST go through `storage.update(key, fn)`** (utils/storage.js) — it serializes read-modify-writes on a single queue. Raw get-then-set races with concurrent writers and silently loses updates (this was a real bug class: duplicate queue entries on session restore, lost watch minutes). Keep network fetches OUTSIDE the update callback; returning `undefined` from the callback skips the write.

**Sessions model:** `yt_videos` is ONE array for ALL sessions. Each element carries `sessionId` (missing ⇒ `'main'` — every consumer applies `v.sessionId || 'main'`) and `addCount` (missing ⇒ 1). The same videoId may exist once PER session; the duplicate check in `addVideoToQueue` is session-scoped. `yt_sessions` (`{activeId, list:[{id,name,createdAt}]}`) is worker-written only and the `'main'` entry always exists. `MARK_WATCHED` (and the mark inside `SKIP_VIDEO`) marks ALL entries with that videoId across sessions. Q/W badges on YouTube are session-agnostic (union over all sessions); the panel and the in-page queue strip show the ACTIVE session only.

**Queue inserts** all go through `addVideoToQueue(url, videoId, explicitTimestamp, starred, opts)` with `opts = { bumpCount=true, source='manual', sessionId=<active> }`. The bump-existing path (same session) updates `addedAt` and increments `addCount` only when `bumpCount`; COLLECT_TABS passes `bumpCount:false`. `source` feeds the `added_to_queue` activity event.

**Open-tab ids:** `yt_open_tab_ids` lives in `chrome.storage.session` — sorted unique videoIds of open tabs. Worker-only writer, recomputed event-driven from `tabs.query` (tab create/navigate/remove/replace + worker wake) with a 250ms debounce, written only when the set actually differs. Deliberately OUTSIDE the storage.update mutex (that mutex serializes local only; this value is derived ground truth) — do not route it through storage.update. The panel reacts via `storage.onChanged(area === 'session')`.

**Activity log:** `yt_activity_log` (`{v:1, seq, events[]}`, 5000-event FIFO cap, `seq` monotonic across rotation) is appended worker-side via `logActivity()` in `utils/activity-log.js` — best-effort, issues its own storage.update, must be called sequentially AFTER a caller's own update completes, never from inside an update callback. Suggested-sort scores are cached in `yt_suggest_scores` keyed to `computedAtSeq` (stale seq forces recompute). Logging is always on; the kill switch is `yt_settings.activityLogEnabled = false` (no UI toggle in v1 — set it from a console/future settings page). `session_switched` has TWO variants distinguished by `videoId`: video-attention (`tabs.onActivated`, `videoId`+`fromVideoId`) and session-management (create/switch/delete/merge, `videoId:null` + `sessionId`/`fromSessionId`/`reason`) — see plan 06 §3.1.

Key flows:
- Side panel → `MSG.GET_VIDEOS` → service worker reads storage → returns array
- Content script → `MSG.MARK_WATCHED` → service worker updates storage → broadcasts `VIDEOS_UPDATED` (panel debounces these — enrichment fires them in bursts)
- Side panel → `MSG.MEDIA_CONTROL` (+ `tabId` from the last `GET_MEDIA_STATE`) → service worker → `chrome.tabs.sendMessage` to THAT tab → content script controls `<video>`
- `GET_MEDIA_STATE` final shape (content response, worker passthrough AND the worker's empty fallback — every field, false/null defaults): `{ paused, currentTime, duration, videoId, tabId, isShorts, url, pipActive, docPipSupported }`. Extend it, never trim it.
- Settings/queue changes propagate to content scripts via `chrome.storage.onChanged` — there is deliberately no polling and no `YT_UI_UPDATE`-style broadcast

### Tab Interception

New YouTube tabs are caught via `chrome.tabs.onCreated` + `chrome.tabs.onUpdated`. Extension-opened tabs are whitelisted to prevent self-interception. Both maps (`recentlyCreatedTabs`, `extensionOpenedTabs`) are TTL-based and mirrored in `chrome.storage.session` so an idle-killed worker doesn't lose them — never rely on `setTimeout` for cleanup in the worker; it dies with it. Intercept 'close' mode never closes the ACTIVE tab (queues it and keeps it open).

### Content Script YouTube Integration

- Volume >100% uses Web Audio API `GainNode` chain (lazy init on first boost)
- YouTube is a SPA — `MutationObserver` on `document.body` detects URL changes; the same observer drives a 1.5s-throttled thumbnail-badge/hideRecs refresh (no intervals on idle pages)
- Video-feature binding retries are capped (15 × 1s) and restarted by the SPA navigation handler — no infinite init loops on pages without a `<video>`
- Upload date extracted from `<script type="application/ld+json">` structured data
- Settings auto-applied on `loadeddata` event of `<video>` element
- Injected surfaces beyond badges: in-page queue strip in the masthead (`inPageQueue`, active session only, reacts to `onChanged` of `yt_sessions` + `yt_videos`), drag-resize handles on the player (`playerResizeEnabled`), shorts left rail on `/shorts/` pages
- A video is marked watched at 20% progress

### Side Panel Layout

- `.sticky-top` (flex-shrink: 0) — header, session bar, toggle bars, sliders, shorts tools, sort/filter, channel chip, content tabs (media controls live in the now-playing card inside the scroll area)
- Toggle bar has TWO rows: row 1 (Collect/Close/Intercept/Autoplay/Info/Hide) and `.toggle-bar--secondary` (`#tb-inpage` Strip · `#tb-resize` Resize · `#tb-autopip` PiP · `#tb-export` Export) — new buttons go in row 2, in that established order
- `.scroll-area` (flex: 1, overflow-y: auto, **position: relative — load-bearing**: the virtual scroller measures card windows via `offsetTop`, which must be relative to this scroll container)
- `#shorts-player` must stay the FIRST child of `.scroll-area` (scroller re-measures offsetTop under it); `#shorts-tools` strip sits after `.controls-bar` and is hidden unless the displayed tab is a Short
- Video lists are virtualized: ALL geometry math goes through the `cardHeight()` accessor — 63 in full mode (59px `.video-item` + 4px margin), 94 in slim (90 + 4). Never hardcode 63 in new code; change CSS heights and the constants together
- Slim mode (`panelMode: 'slim'`, `body.slim`) hides most of `.sticky-top` (including the `.shorts-tools` strip) and shows thumbnail-only tiles — the TAB/addCount chips must stay visible (hover overlay must not cover the top 14px of the thumb). Deliberate visibility exceptions in slim: session bar, content-tabs, `.channel-chip` (an active filter's only indicator) and `#shorts-player` (content, not a control)
- Card chips: `.thumb-tab-badge` top-LEFT, `.thumb-addcount` top-RIGHT (both pointer-events:none), `.thumb-duration` bottom-right
- Videos/Shorts shown via content tabs (only one visible at a time)
- DOM built with safe `el()` helper — no `innerHTML` with user data (security hook enforced)
- Re-renders are suppressed while a card drag is in progress (a rebuild destroys the dragged node and orphans the drop)
- **No `prompt()`/`confirm()` in the panel** — use inline inputs + two-click confirms (session bar pattern)

## Key Gotchas

- `chrome.sidePanel.open()` requires user gesture context, and the gesture does NOT survive an awaited extension-API call placed before it in the handler — the popup pre-enables the panel at popup-open time so the click handler can call `open()` with at most the `tabs.query` await
- Tab-scoped `sidePanel.setOptions` entries do NOT inherit the manifest default path: `{ tabId, enabled: true }` without `path` makes `open()` throw "No active side panel for tabId". Always pass `path: 'sidepanel/sidepanel.html'` when enabling per-tab
- Hidden checkboxes (custom toggle styling) need `{ force: true }` or `evaluate(() => el.click())` in Playwright tests
- The volume-boost `AudioContext` reroutes ALL audio through itself via `createMediaElementSource` — if it is suspended (created without user activation) the video is silent at any volume. `resumeAudioContext()` is called on every volume change and from the tracking tick; keep that invariant when touching the boost path
- URL checks must validate hostnames via `isYouTubeHost()` (utils/youtube.js) — substring checks like `url.includes('youtube.com')` match hostile lookalike URLs
- `fetchVideoDetails()` fetches raw YouTube HTML — regex patterns for metadata must handle multiple YouTube response formats; `fetchVideoMetadata()` returns `null` on failure (callers keep placeholders)
- Drag-and-drop reorder works by swapping the active sort field value (addedAt/duration/uploadedAt) between dragged and target videos; refresh button re-fetches real values
- Side panel visibility per-tab: `chrome.sidePanel.setOptions({ tabId, enabled: boolean })` — kept in sync on activation AND same-tab navigation; the popup's open button re-enables before opening
- Volume for non-YouTube tabs uses `chrome.scripting.executeScript` (requires `scripting` permission + `<all_urls>`)
- Volume slider (0–1000) and speed slider (1–100) are scaled so both defaults (100%, 1.0x) sit at 10% of range — keep ranges proportional when modifying (speed min is 1: `playbackRate = 0` freezes the video)
- `speedLevel` may hold ANY value in [0.1, 10] (YouTube's own menu, arrow-key steps). Panel + popup render labels via the shared `fmtSpeed(v)` helper (≤2 decimals) and set slider thumbs with `Math.round(v*10)`; content broadcasts external changes via `SPEED_CHANGED`
- Toggle bar buttons use `data-desc` attribute for hover descriptions shown in `#toggle-desc`; any new button in either `.toggle-bar` row or `.shorts-tools` must include `data-desc`. The JS listener targets `.toggle-bar [data-desc], .shorts-tools [data-desc]` — description persists after mouse leaves (no `mouseleave` reset).
- Re-opening a video already in the queue (same session) updates its `addedAt` to current time (bumps to top of "Added" sort) and increments `addCount`
- Every tab-closing path (`CLOSE_SHORTS_TABS`, `CLOSE_VISIBLE_TABS`, `REMOVE_DUPLICATES`, intercept 'close') preserves the active tab — never close what the user is watching. The ONE sanctioned exception: shorts auto-close (`CLOSE_SHORT_TAB`) closes the validated SENDER tab when its Short ends, and only while `shortsAutoClose` is enabled
- `sortBy: 'suggested'` is computed panel-side from `GET_SUGGEST_SCORES` (worker fallback sorts treat it as `addedAt`); drag-reorder is disabled while it is active
- Document PiP bails out to classic video PiP whenever `audioContext` exists — the volume-boost `createMediaElementSource` chain silences a video moved into another document. While the player floats in Doc-PiP the resize handles no-op (the on-page container holds a placeholder), and `getVideoElement()` searches the PiP document so timeline-history/speed-sync keep working on the floated video
- Auto-PiP (`pipAutoEnabled`) rides MediaSession `enterpictureinpicture` — Chrome decides eligibility and shows its own prompt on first use; the call is gesture-free only inside that handler. It opens the CLASSIC (native) PiP window, which nothing can style: the opacity slider and S/M/L presets apply ONLY to the manually-invoked Document-PiP Float window (design-sanctioned, plan 03 §7; disclosed in the tooltips — keep that disclosure when editing them)
- Content-script `<head>` CSS injection order is load-bearing: hideRecs style → resize style → anything later. Resize wins specificity with doubled-id selectors; later styles must not `!important`-override player sizing
- The in-panel Shorts embed needs TWO non-obvious pieces to work against real YouTube: (1) the raw widget protocol emits `onStateChange` only after the parent posts the `addEventListener` command (the `listening` handshake alone is NOT enough); (2) real embeds error `153: Video player configuration error` without an HTTP Referer, which extension pages never send — the worker installs a session DNR rule (id 153153, `declarativeNetRequestWithHostAccess`) setting Referer to the extension's own origin for `/embed/` sub_frames initiated by this extension only. Don't remove either without re-running `test:shorts-live`
- PowerShell 5.1 `Get-Content`/`Set-Content` mangles this repo's UTF-8 files (em-dashes/arrows become mojibake) — use proper editing tools, not shell pipelines, for source edits

<!-- progress-journal -->
## Progress Journal (PROGRESS.md)

This project keeps a development journal in `PROGRESS.md` at the project root.

- **At the start of every session:** read the **Current State** section of
  `PROGRESS.md` before doing anything else. Do not read the full journal unless
  a question about project history comes up.
- **At the end of every working session** (or when the user says they're done,
  or before compacting/ending): append one dated entry to the top of the
  **Journal** section (newest first) covering what was done, decisions made,
  and what's next — then rewrite **Current State** to reflect the new reality.
- Journal entries are append-only; never edit or delete past entries.
- Keep Current State under ~25 lines. It must let a fresh session get oriented
  in under a minute.
