# Integration Contract (AUTHORITATIVE)

This document reconciles the 7 feature build plans (01–07). **Where a build plan
conflicts with this contract, THIS CONTRACT WINS.** Every implementer must read
this file plus their own plan before writing code.

Implementation order (sequential): scaffolding → 05-indicators → 04-list-panel →
06-analytics → 02-player → 01-viewing-modes → 03-pip → 07-shorts → final integration.
Later stages MERGE into shapes established by earlier stages — never overwrite them.

---

## 1. Storage keys (utils/constants.js STORAGE_KEYS)

| Key | Area | Shape | Writer |
|---|---|---|---|
| `yt_sessions` (SESSIONS) | local | `{ activeId: string, list: [{id, name, createdAt}] }`; `'main'` entry always exists (name "Main") | worker only |
| `yt_open_tab_ids` (OPEN_TAB_IDS) | **session** | `string[]` sorted unique videoIds of open tabs | worker only, diffed + 250ms debounced, deliberately OUTSIDE the local mutex |
| `yt_activity_log` (ACTIVITY_LOG) | local | `{ v:1, seq:int, events:[...] }` cap 5000 FIFO (see plan 06 for event shape) | worker only, via storage.update |
| `yt_suggest_scores` (SUGGEST_SCORES) | local | `{ v:1, computedAtSeq, computedAt, channels:{...} }` | worker only |

`yt_videos` element shape (CHANGED — single array for ALL sessions):
`{ id, url, title, channel, thumbnail, duration, addedAt, uploadedAt, isShort, watched, starred, sessionId, addCount }`
- `sessionId` missing ⇒ treat as `'main'` (every consumer applies `v.sessionId || 'main'`).
- `addCount` missing ⇒ treat as `1`.
- The same videoId may exist once **per session**.
- onInstalled normalization (scaffolding stage) backfills both fields once.

## 2. Settings (DEFAULT_SETTINGS additions)

```
inPageQueue: false,        panelMode: 'full',          // 01
playerResizeEnabled: true, playerSizeDefault: null,    // 02
playerSizeTheater: null,
pipAutoEnabled: false,     pipOpacity: 100,            // 03
pipSize: 'medium',
activityLogEnabled: true,                              // 06
shortsAutoScroll: false,   shortsAutoClose: false,     // 07
```
- `sortBy` domain gains `'suggested'` (worker fallback sorts treat it as `addedAt`).
- `speedLevel` may now hold ANY value in [0.1, 10] (e.g. 0.25). Panel + popup
  render labels via a shared `fmtSpeed(v)` helper (≤2 decimals) and set slider
  thumbs with `Math.round(v*10)`.

## 3. Message types (MSG additions)

`SPEED_CHANGED`, `GET_SESSIONS`, `CREATE_SESSION`, `RENAME_SESSION`,
`DELETE_SESSION`, `SET_ACTIVE_SESSION`, `MERGE_SESSION`, `GET_SUGGEST_SCORES`,
`LOG_ACTIVITY_EVENT`, `CLOSE_SHORT_TAB` — request/response shapes per the owning
plans (02, 04, 04, 04, 04, 04, 04, 06, 06, 07).

**Merged message-shape changes** (cumulative — later stages extend, never replace):
- `GET_MEDIA_STATE` content response & worker passthrough FINAL shape:
  `{ paused, currentTime, duration, videoId, tabId, isShorts:boolean, url:string|null, pipActive:boolean, docPipSupported:boolean }`.
  Worker `empty` fallback includes all fields (false/null defaults). Stage 03 adds
  the pip fields; stage 07 adds isShorts/url; whichever runs into missing fields
  adds them with defaults.
- `MEDIA_CONTROL`/`MEDIA_COMMAND`: optional `seconds:number` for forward/rewind
  (default 10); action enum gains `'exitPip'` (03) and `'shortsNext'`/`'shortsPrev'` (07).
  Unknown actions respond `{success:false}` — never throw.
- `TRACK_WATCH_TIME`: request gains OPTIONAL `telemetry` object (06). All
  touchers preserve it.
- `OPEN_VIDEO`: smart-play (04) — may respond `{tabId, focused:true}`. The
  in-page queue strip (01) uses OPEN_VIDEO and therefore inherits smart play.
- `OPEN_SIDE_PANEL`: handler resolves `message.tabId ?? sender.tab?.id` (01).
- `MARK_WATCHED` (and the mark inside `SKIP_VIDEO`): marks ALL entries with that
  videoId across sessions (04).
- `VIDEOS_UPDATED`: also broadcast after DELETE_SESSION / MERGE_SESSION.

## 4. addVideoToQueue — single reconciled signature

```js
async function addVideoToQueue(url, videoId, explicitTimestamp, starred, opts = {})
// opts: { bumpCount = true, source = 'manual', sessionId = <active session, resolved inside> }
```
- Insert path: `addCount: 1`, `sessionId` = resolved active session.
- Bump-existing path (matched within the SAME session): bumps `addedAt`,
  increments `addCount` ONLY when `opts.bumpCount`.
- Call sites: intercept → `{source:'intercept'}`; COLLECT_TABS tab sweep AND
  logged-drain → `{bumpCount:false, source:'collect'}`; ADD_VIDEO message →
  `{source: message.source || 'manual'}`; shorts rail → `{source:'shorts'}`.
- Stage 05 introduces `opts` + addCount; stage 04 adds sessionId resolution;
  stage 06 adds source + the added_to_queue log event. Drag-to-top never bumps.

## 5. UI placement arbitration

**Toggle bar: a SECOND row.** Row 1 keeps the existing 6 buttons untouched.
A new `<div class="toggle-bar toggle-bar--secondary">` goes directly below row 1
(above `.toggle-desc`) and receives, in this order:
`#tb-inpage` (Strip, 01) · `#tb-resize` (Resize, 02) · `#tb-autopip` (PiP, 03) · `#tb-export` (Export, 06).
All are `.tb-btn` with mandatory `data-desc`. The scaffolding stage creates the
empty row + CSS; each stage appends its own button. The existing hover-desc
listener (`.toggle-bar [data-desc]`) matches both rows automatically. The 06
plan's "7th button in the toggle bar" and 01's "#tb-inpage after #tb-hiderecs"
are OVERRIDDEN to this second row.

Other placements as planned (no conflicts):
- Session bar (04): new row after `</header>`, above toggle-bar row 1.
- Channel chip (04): below `.filter-search-bar`.
- `#panel-mode-toggle` (01): header icon before `#refresh-metadata`.
- PiP controls row (03): third `.ctrl-row` in `.controls-bar`; `#np-pip-btn` in now-playing.
- `#shorts-tools` strip (07): after `.controls-bar`; hidden unless isShorts.
  Extend the desc-hover selector to `'.toggle-bar [data-desc], .shorts-tools [data-desc]'`.
- `#shorts-player` (07): first child of `.scroll-area`.
- Suggest sort button (06): in `.sort-btns` before `#sort-direction`, with that
  plan's CSS shrinks.
- Card chips (05): `.thumb-tab-badge` top-LEFT, `.thumb-addcount` top-RIGHT of
  `.thumb-wrap` (pointer-events:none). `.thumb-duration` stays bottom-right.
- Slim mode (01) MUST keep 05's chips visible on tiles; its hover overlay must
  not cover the top 14px of the thumb.
- In-page queue strip (01) into masthead; shorts rail (07) fixed left on /shorts/.
- Popup checkbox for inPageQueue (01) above #open-sidepanel.

## 6. Cross-feature semantic rulings

1. **Q/W badges on YouTube are session-agnostic** (union over all sessions). content.js badge code stays session-blind.
2. **In-page queue strip shows the ACTIVE session only** — it reads `yt_sessions` + `yt_videos` from storage and filters `(v.sessionId||'main') === activeId`; reacts to onChanged of BOTH keys.
3. **Suggested sort is panel-side** within the active session; drag-reorder is disabled while active.
4. **Session events**: SET_ACTIVE_SESSION/MERGE/DELETE append `session_switched`/etc. activity events (06 hooks added in stage 06 — stage 04 leaves clear single-call-site seams).
5. **Auto-close shorts** is the ONLY sanctioned active-tab close, and only for the validated sender tab (07).
6. **PiP × resize**: while the player is floated in Document PiP, resize handles no-op (player container holds a placeholder). PiP's getVideoElement extension (searches the PiP document) must keep 02's timeline-history and speed-sync working on the floated video.
7. **PiP × volume boost**: if `audioContext` exists (boost was used), Document PiP bails out to classic video PiP (03).
8. **CSS injection ordering** in content.js head: hideRecs style → resize style → anything later. Resize uses doubled-id selectors to win specificity; later styles must not `!important`-override player sizing.
9. **No `prompt()`/`confirm()` in the panel** — inline inputs + two-click confirms (04 pattern); applies to ALL groups.
10. **Slim-mode virtual scroll**: single `cardHeight()` accessor returns 63 (full) / 94 (slim); all geometry math goes through it (01). Other groups must not hardcode 63 in new code.

## 7. Tests & fixtures

- Each stage adds/extends its suite per its plan; ALL suites get a
  `package.json` script + inclusion in `test:all` (final stage reconciles).
- Shared video fixture: `tests/assets/tiny-webm.js` exporting
  `module.exports = { dataUrl: 'data:video/webm;base64,...' }` — a ~1s tiny VP8
  clip usable in fake pages (`<video src=dataUrl>`). Created by the first stage
  that needs it (02); later stages reuse it. NO ffmpeg dependency: generate it
  in-test once via a Playwright page MediaRecorder canvas capture written to the
  asset file if absent, OR embed a known-good base64 string.
- Headless tests use the established `context.route()` fake-youtube.com pattern.
  Real-YouTube/headed checks are listed per plan and run in the final
  verification phase, not by implementer stages.

## 8. Process rules for implementer stages

- Work ON BRANCH `main` in place; commit YOUR stage's changes only, message
  `Implement <group>: <one-liner>` + standard co-author trailer. Do NOT push.
- Before committing: `node --check` every touched plain-script JS file, run
  `npm test` (must be 34+/green) plus YOUR new suite plus `npm run test:races`
  (mutex regression). Fix until green. If a pre-existing suite breaks because of
  an intended contract change, update that suite minimally and say so.
- Honor every invariant in CLAUDE.md. Update CLAUDE.md ONLY in the final
  integration stage (avoid churn).
- If something in your plan proves impossible mid-build, implement the plan's
  named fallback and record it in your completion notes.
