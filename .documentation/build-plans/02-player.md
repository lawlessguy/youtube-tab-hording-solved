# Video Player (group: player)

Features: resizable video player, timeline seek history (Ctrl-Z / Ctrl-Shift-Z), and real-time
playback-speed sync between YouTube's native speed control and the extension's speed sliders
(popup + side panel). All three live primarily in `content/content.js` (IIFE — string-literal
message types, no imports), with one new worker message handler and small slider plumbing in
`popup/popup.js` and `sidepanel/sidepanel.js`.

## 1. Scope — restate each feature precisely.

1. **Resizable video player.** On `youtube.com/watch` pages, the user can drag the edges of the
   video player to change its bounding box. Drag handles appear at the right edge, bottom edge,
   and bottom-right corner of the player (bottom edge only in theater mode, where width is
   full-bleed). Works in default and theater modes; explicitly disabled in fullscreen. The chosen
   size persists per-mode (one default-mode size, one theater-mode size) globally across videos
   and browser restarts, in `yt_settings`. Double-clicking any handle restores YouTube's native
   sizing for the current mode. A toggle-bar button in the side panel (`#tb-resize`) turns the
   whole feature on/off (default on).

2. **Timeline history (Ctrl-Z / Ctrl-Shift-Z).** On watch pages, every "real" seek (a jump of
   >= 3 seconds, with rapid scrub/arrow-key bursts coalesced into one entry) records the
   pre-seek position on an undo stack (depth 50, in-memory, per-video). Ctrl-Z seeks back to the
   previous position; Ctrl-Shift-Z (and Ctrl-Y) steps forward again. Keys are ignored while
   typing in inputs/textareas/contenteditable (search box, comments). A small transient overlay
   on the player shows the time being jumped to. History is not persisted; it resets when the
   video changes.

3. **Playback speed sync.** Changing speed in YouTube's native settings panel updates
   `yt_settings.speedLevel` within ~300 ms, which live-updates the speed slider + label in BOTH
   the popup and the side panel via `chrome.storage.onChanged` (no polling). Conversely, the
   existing extension sliders keep working as today (SET_SPEED → content script), with a
   feedback-loop guard (`lastAppliedRate`) so extension-driven `ratechange` events are never
   re-reported as native changes. Native changes are persisted only — they are NOT echoed to
   other tabs (other tabs pick the value up at their next `loadeddata` via the existing
   auto-apply path).

## 2. Clarifying questions & decisions

1. **Q: Which edges get resize handles?** A: Right edge + bottom edge + bottom-right corner in
   default mode; bottom edge only in theater mode. Rationale: theater is full-bleed width by
   design, and top/left handles would fight YouTube's left/top-anchored layout for no benefit.

2. **Q: Can default-mode width grow past the `#primary` column (over the recommendations
   sidebar)?** A: No — width drag shrinks the player below the column's natural width and can
   restore back up to it; for "wider than the column" the user switches to theater mode.
   Rationale: growing over `#secondary` requires rewriting the flexy column layout — fragile and
   already served by theater mode.

3. **Q: Is the resized box persisted per-video, per-session, or globally? Per mode?** A:
   Globally (one stored size for default mode, one for theater mode) in `yt_settings`, applied
   to every watch page. Rationale: matches how every other player preference in this extension
   works (volume, speed are global settings), and per-video sizes would surprise more than help.

4. **Q: How does the user restore native sizing?** A: Double-click any resize handle resets the
   current mode's stored size to `null`; turning the `#tb-resize` toggle off removes the
   overrides and handles entirely (stored sizes are retained, so re-enabling restores them).
   Rationale: zero extra UI; double-click-to-reset matches the existing slider-reset affordance.

5. **Q: Does resize need an enable/disable toggle, and where?** A: Yes — new `.toggle-bar`
   button `#tb-resize` in the side panel (with mandatory `data-desc`), backed by
   `playerResizeEnabled` (default `true`). Rationale: injected page UI should always have a kill
   switch in case YouTube's DOM shifts; the toggle bar is the established home for page-feature
   toggles (`tb-videoinfo`, `tb-hiderecs`).

6. **Q: Do resize and timeline history apply to Shorts?** A: No — `/watch` pages only (gated on
   `location.pathname === '/watch'`). Speed sync applies on watch + shorts (both have a real
   `<video>` whose rate the user can change). Rationale: Shorts has no resizable box or
   scrubbable timeline UI; Shorts-specific tooling is a separate feature group.

7. **Q: Min/max clamps for the resized player?** A: min 480x270 px; max `window.innerWidth - 24`
   wide and `window.innerHeight - 120` tall (leaves room for masthead/controls). Clamped again
   at apply time if the window has shrunk since the size was stored (without persisting the
   clamped value). Rationale: prevents an unrecoverable 0-px or off-screen player.

8. **Q: Native speed menu uses 0.25-step values (0.25x, 0.75x...) but the slider is 0.1-step
   (`value/10`). How are off-step values shown?** A: Store the exact rate in
   `settings.speedLevel`; slider thumb rounds to the nearest 0.1 step
   (`Math.round(speedLevel * 10)`), and the label shows the exact value with up to 2 decimals
   via a shared `fmtSpeed()` helper ("0.25x", "1.5x"). Rationale: never corrupt the real rate to
   satisfy a UI control; the label is the source of truth for the eye.

9. **Q: Does a native speed change in tab A immediately change playback in tabs B/C?** A: No.
   It persists to `speedLevel` (sliders everywhere update instantly), and other tabs adopt it on
   their next video load via the existing `loadeddata` auto-apply. Rationale: silently
   accelerating a video the user is actively watching in another tab is hostile; this also
   matches the current `speedScope: 'tab'` default semantics.

10. **Q: How is the SET_SPEED → ratechange feedback loop prevented?** A: Content script keeps
    `lastAppliedRate`; `setSpeed()` records the value before assigning `video.playbackRate`. The
    `ratechange` handler ignores events where `|playbackRate - lastAppliedRate| < 0.001`.
    Additionally the worker's `SPEED_CHANGED` handler skips the storage write (returns
    `undefined` from `update()`) when the incoming value already equals `speedLevel`, so even a
    spurious report cannot ping-pong. Rationale: two independent guards make the loop
    structurally impossible.

11. **Q: Ads often run at 1.0x — should an ad-induced `ratechange` be synced?** A: No. The
    handler bails while `.html5-video-player.ad-showing` exists, and rate-sync only arms 500 ms
    after the first `playing` event of each video (YouTube applies its own remembered session
    speed during load, which must not overwrite ours). Rationale: both are machine-driven rate
    changes, not user intent.

12. **Q: What counts as a seek for history purposes, and how are scrub bursts handled?** A: On
    the first `seeking` event of a burst, capture the pre-seek origin (a `prevTime` continuously
    refreshed by throttled `timeupdate` while not seeking); an 800 ms quiet-period timer after
    the last `seeked` finalizes the entry; it is pushed only if the net jump is >= 3 s. A new
    user seek clears the redo stack. Rationale: one stack entry per user intention, not one per
    scrub pixel; 3 s filters out frame-stepping noise while still capturing 5 s arrow-key jumps.

13. **Q: Stack depth and persistence for timeline history?** A: 50 entries, in-memory only,
    keyed to the current videoId and cleared on SPA navigation. No setting, always on.
    Rationale: it is invisible until used, conflicts with nothing (YouTube has no Ctrl-Z on
    watch pages outside text fields), and persisting it buys nothing worth a storage key.

14. **Q: How do Ctrl-Z/Ctrl-Shift-Z avoid breaking YouTube shortcuts and text editing?** A:
    `keydown` listener on `document` in capture phase; bail unless `ctrlKey && !altKey &&
    (key === 'z' || 'Z' || 'y')`; bail if `e.target.closest('input, textarea, select,
    [contenteditable], #contenteditable-root')`; only `preventDefault()`/`stopPropagation()`
    when a history entry actually exists to apply. Rationale: capture phase beats YouTube's own
    handlers, the editable guard preserves comment-box undo, and the empty-stack pass-through
    avoids eating keys for nothing.

15. **Q: Should the programmatic undo/redo seek itself be recorded?** A: No — a
    `suppressSeekRecording` flag is set before assigning `currentTime` and cleared on the next
    `seeked`. Undo pushes the current position onto the redo stack first, so redo works.
    Rationale: standard undo/redo semantics; recording our own seeks would corrupt the stack.

16. **Q: Should the popup also live-update its sliders (it's short-lived)?** A: Yes — the spec
    says popup AND side panel; the popup can sit open next to a YouTube tab. Both surfaces get a
    `chrome.storage.onChanged` listener for `yt_settings` that updates volume + speed sliders
    and labels, skipped while the user is mid-drag on that slider (pointerdown/pointerup flag).
    Rationale: one listener covers both controls for free; the drag guard stops the storage echo
    of the user's own gesture from fighting the thumb.

17. **Q: How does the resized player interact with the existing hideRecs full-width CSS?** A:
    Both target `#player-container-outer`; the resize style element is appended after the
    hideRecs one and uses a doubled-id selector (`#player-container-outer#player-container-outer`)
    so it deterministically wins specificity. With hideRecs on + a stored width, the stored
    width wins. Rationale: explicit, documented precedence beats accidental cascade order.

18. **Q: How does YouTube's own player learn the new box (video letterboxing, control bar
    width)?** A: After each style write we dispatch `window.dispatchEvent(new Event('resize'))`
    (rAF-throttled during drag); YouTube's player re-measures its container on window resize and
    re-fits the `<video>` and controls. Rationale: this is the established non-invasive
    technique; we never touch the `<video>` element's inline styles ourselves.

## 3. Data & message contract

### Storage keys

No new top-level `chrome.storage.local` keys. One existing key changes shape:

- **`yt_settings`** (existing, `STORAGE_KEYS.SETTINGS`) gains three keys and widens one:
  ```js
  {
    ...existing,
    speedLevel: 1.0,            // SEMANTIC CHANGE: may now hold any value in [0.1, 10]
                                // incl. off-slider-step values like 0.25 (was always 0.1-step)
    playerResizeEnabled: true,  // NEW — resize feature master switch
    playerSizeDefault: null,    // NEW — null = native sizing, else { w: number|null, h: number|null } (px)
    playerSizeTheater: null,    // NEW — null = native sizing, else { h: number|null } (px)
  }
  ```
  Existing installs won't have the new keys (onInstalled only seeds when settings are absent),
  so every reader treats `undefined` as the default: `playerResizeEnabled !== false`,
  `playerSizeDefault ?? null`, etc.

Timeline history is in-memory only — deliberately NO storage key.

### Settings keys (new, with defaults)

- `playerResizeEnabled` = `true`
- `playerSizeDefault` = `null`
- `playerSizeTheater` = `null`

### MSG types

- **`MSG.SPEED_CHANGED`** (NEW; content script → service worker). Reports a user-initiated
  native rate change.
  - Request: `{ type: 'SPEED_CHANGED', value: number }` (raw `video.playbackRate`)
  - Response: `{ success: true, value: number }` (clamped to [0.1, 10]); the worker persists via
    `storage.update(STORAGE_KEYS.SETTINGS, ...)`, returning `undefined` from the update fn when
    the value is unchanged (skips the write). The worker does NOT call `applyMediaControl` for
    this message (no echo to tabs).

- **`MSG.UPDATE_SETTINGS`** (existing, reused — no shape change). The content script now also
  sends it to persist player size on drag end / reset:
  `{ type: 'UPDATE_SETTINGS', settings: { playerSizeDefault: {...}|null } }` (or
  `playerSizeTheater`). Merge semantics already correct; no worker change needed.

No new broadcasts: all UI surfaces react via `chrome.storage.onChanged` on `yt_settings`.

### New files

- `tests/test-player.js` — new headless suite (speed sync, resize persistence, history keys).
- `tests/assets/tiny.webm` — ~4 s 64x64 VP8 test clip used as a seekable `<video>` source
  (generate once: `ffmpeg -f lavfi -i color=black:s=64x64:d=4 -c:v libvpx tiny.webm`; Chromium
  ships VP8, not H.264).
- `.documentation/build-plans/02-player.md` — this plan.

No new runtime source files: all player logic goes into the existing four scripts.

## 4. Implementation steps

### Step 1 — `utils/constants.js`

- Add to `MSG`: `SPEED_CHANGED: 'SPEED_CHANGED',`
- Add to `DEFAULT_SETTINGS`:
  `playerResizeEnabled: true, playerSizeDefault: null, playerSizeTheater: null,`
  (Remember: content/panel/popup are plain scripts — they use string literals, never imports.)

### Step 2 — `background/service-worker.js`

Add one case to `handleMessage()` (next to `MSG.SET_SPEED`):

```js
case MSG.SPEED_CHANGED: {
  const v = Math.min(10, Math.max(0.1, Number(message.value) || 1));
  await storage.update(STORAGE_KEYS.SETTINGS, (s = { ...DEFAULT_SETTINGS }) => {
    if (Math.abs((s.speedLevel ?? 1) - v) < 0.001) return undefined; // skip write — no echo
    s.speedLevel = v;
    return s;
  });
  return { success: true, value: v };
  // Deliberately NO applyMediaControl(): native change stays in its tab;
  // sliders update via storage.onChanged; other tabs adopt on next loadeddata.
}
```

### Step 3 — `content/content.js` — speed sync

1. Module scope (top of IIFE): `let lastAppliedRate = null; let rateSyncArmedAt = 0;
   let rateReportTimer = null;`
2. In `setSpeed(speed)`: set `lastAppliedRate = speed;` immediately before
   `video.playbackRate = speed;`.
3. New `bindRateSync(video)` (idempotent via `video._ytmRateBound` like the other binders),
   called from `bindVideoFeatures()`:
   - `video.addEventListener('playing', () => { rateSyncArmedAt = Date.now() + 500; }, { once: false })`
     — but only set it when it is currently 0 for this video (reset `rateSyncArmedAt = 0` in the
     SPA-navigation handler).
   - `video.addEventListener('ratechange', onRateChange)` where `onRateChange`:
     - bail if `!rateSyncArmedAt || Date.now() < rateSyncArmedAt` (load-time machine changes);
     - bail if `document.querySelector('.html5-video-player.ad-showing')` (ads);
     - bail if `lastAppliedRate !== null && Math.abs(video.playbackRate - lastAppliedRate) < 0.001`
       (our own SET_SPEED echo);
     - otherwise debounce 250 ms (`rateReportTimer`) then
       `safeSend({ type: 'SPEED_CHANGED', value: video.playbackRate })` and set
       `lastAppliedRate = video.playbackRate` (so repeated identical events stay quiet).

### Step 4 — `content/content.js` — timeline history

Module scope: `let seekUndo = []; let seekRedo = []; let seekPrevTime = null;
let seekOrigin = null; let seekFinalizeTimer = null; let suppressSeekRecording = false;
let seekHistoryVideoId = null;` Constants: `SEEK_MIN_JUMP = 3` (s), `SEEK_COALESCE_MS = 800`,
`SEEK_STACK_MAX = 50`.

1. `bindSeekHistory(video)` (idempotent `video._ytmSeekBound`, called from
   `bindVideoFeatures()`; all handlers no-op unless `location.pathname === '/watch'`):
   - `timeupdate`: if `!video.seeking && !suppressSeekRecording` →
     `seekPrevTime = video.currentTime;` (timeupdate fires ~4 Hz — no extra throttle needed).
   - `seeking`: if `suppressSeekRecording` return; if `seekOrigin === null` →
     `seekOrigin = seekPrevTime;` (first seek of a burst captures the origin).
   - `seeked`: if `suppressSeekRecording` → `suppressSeekRecording = false; return;`
     else restart `seekFinalizeTimer = setTimeout(finalizeSeek, SEEK_COALESCE_MS)`.
   - `finalizeSeek()`: const v = getVideoElement(); if `seekOrigin !== null && v &&
     Math.abs(v.currentTime - seekOrigin) >= SEEK_MIN_JUMP` → push `seekOrigin` on `seekUndo`
     (trim to `SEEK_STACK_MAX` from the front), clear `seekRedo`. Always reset
     `seekOrigin = null`.
2. `resetSeekHistory(videoId)` — clears both stacks, timers, `seekOrigin`, `seekPrevTime`;
   called from the SPA-navigation MutationObserver block when `getCurrentVideoId()` differs from
   `seekHistoryVideoId` (set it there too), and from `init()`.
3. Key handling — one capture-phase listener registered once at init:
   ```js
   document.addEventListener('keydown', (e) => {
     if (!e.ctrlKey || e.altKey || e.metaKey) return;
     const k = e.key.toLowerCase();
     if (k !== 'z' && k !== 'y') return;
     if (location.pathname !== '/watch') return;
     if (e.target.closest('input, textarea, select, [contenteditable], #contenteditable-root')) return;
     const video = getVideoElement();
     if (!video) return;
     const redo = k === 'y' || (k === 'z' && e.shiftKey);
     const stack = redo ? seekRedo : seekUndo;
     if (!stack.length) return;            // empty: let the key fall through
     e.preventDefault(); e.stopPropagation();
     const target = stack.pop();
     (redo ? seekUndo : seekRedo).push(video.currentTime);
     suppressSeekRecording = true;
     video.currentTime = target;
     showSeekToast(target, redo);
   }, true);
   ```
4. `showSeekToast(seconds, isRedo)` — creates/reuses `div#ytm-seek-toast` appended to
   `#movie_player` (fallback: `document.body`), `textContent` only
   (`(isRedo ? '↷ ' : '↶ ') + fmtTime(seconds)` with a tiny local mm:ss formatter),
   inline style: absolute, top 12px, left 12px, `rgba(0,0,0,0.75)` bg, `#fff`, 13px, 4px 10px
   padding, border-radius 4px, z-index 9999, pointer-events none. Cleared by a 900 ms timeout.

### Step 5 — `content/content.js` — resizable player

Constants: `RESIZE_MIN_W = 480, RESIZE_MIN_H = 270`. Style/DOM ids: `#ytm-resize-style`
(size overrides), `#ytm-resize-ui-style` (handle skin, static), `#ytm-resize-handles` (overlay).

1. **Container resolution.** `getPlayerMode()` → `'fullscreen' | 'theater' | 'default'` from
   `document.fullscreenElement` / `ytd-watch-flexy[fullscreen]` / `ytd-watch-flexy[theater]`.
   `getResizeContainer(mode)` → theater: `document.querySelector('#full-bleed-container')`;
   default: `document.querySelector('#player-container.ytd-watch-flexy, #player-container')`.
2. **`applyPlayerSize()`** — single entry point, called from: `init()` (inside the existing
   2 s `applyYouTubeUI` timeout — extend `applyYouTubeUI()` to call it), the SPA-nav handler,
   the `yt_settings` `storage.onChanged` branch (already calls `applyYouTubeUI()`), and the
   flexy attribute observer (below). Behavior:
   - If not on `/watch`, or `cachedSettings.playerResizeEnabled === false`, or mode is
     fullscreen → `removeResizeArtifacts()` (remove `#ytm-resize-style` + `#ytm-resize-handles`)
     and return. (Keep `#ytm-resize-ui-style`; it is inert without handles.)
   - Else write `#ytm-resize-style` textContent from the stored sizes (clamped to the current
     viewport at apply time, never persisting the clamp):
     ```css
     /* default mode — doubled ids beat the hideRecs !important rules */
     ytd-watch-flexy:not([theater]):not([fullscreen]) #player-container-outer#player-container-outer {
       max-width: <w>px !important;            /* only when playerSizeDefault.w != null */
     }
     ytd-watch-flexy:not([theater]):not([fullscreen]) #player-container-inner#player-container-inner {
       height: <h>px !important; padding-top: 0 !important;   /* only when .h != null */
     }
     /* theater mode */
     ytd-watch-flexy[theater]:not([fullscreen]) #full-bleed-container#full-bleed-container {
       height: <h>px !important; max-height: none !important; min-height: 0 !important;
     }
     ```
     Append the style element to `document.head` LAST (re-append on every write so it stays
     after the hideRecs style). Then `window.dispatchEvent(new Event('resize'))` so YouTube
     re-fits the video and control bar.
   - Call `injectResizeHandles(mode)`.
3. **`injectResizeHandles(mode)`** — idempotent; retries like `bindVideoFeatures` (capped,
   restarted by SPA nav) until the container exists. Ensures the container has a non-static
   `position` (set `style.position = 'relative'` only if computed static). Builds:
   ```
   div#ytm-resize-handles            (absolute, inset:0, pointer-events:none, z-index:78)
     div.ytm-resize-handle.ytm-resize-handle--e    (default mode only)
     div.ytm-resize-handle.ytm-resize-handle--s
     div.ytm-resize-handle.ytm-resize-handle--se   (default mode only)
   ```
   Handles sit OUTSIDE the player box so they never block the progress bar / controls:
   `--e`: `top:0; bottom:0; right:-8px; width:8px; cursor:ew-resize;`
   `--s`: `left:0; right:0; bottom:-8px; height:8px; cursor:ns-resize;`
   `--se`: `right:-8px; bottom:-8px; width:14px; height:14px; cursor:nwse-resize;`
   All `pointer-events:auto`. `#ytm-resize-ui-style` (injected once into `document.head`)
   skins them: transparent by default, `background: rgba(255,0,0,0.35); border-radius: 3px;`
   on `:hover` and while dragging (class `.ytm-resizing`).
4. **Drag logic** — `pointerdown` on a handle: `setPointerCapture`, record start pointer pos +
   container `getBoundingClientRect()`, add `.ytm-resizing`. `pointermove`: compute
   `newW/newH` from deltas (only the axes the handle controls), clamp
   (`RESIZE_MIN_W/H` … viewport caps from decision 7), update the in-memory pending size and
   rewrite `#ytm-resize-style` inside a `requestAnimationFrame` throttle (one style write +
   one `resize` dispatch per frame max). `pointerup`: remove class, persist once via
   `safeSend({ type: 'UPDATE_SETTINGS', settings: { playerSizeDefault: { w, h } } })`
   (or `{ playerSizeTheater: { h } }` in theater; width drags never occur there). Note the
   echo path: the worker write fires `storage.onChanged` → `applyYouTubeUI()` →
   `applyPlayerSize()` re-applies the identical CSS — harmless and idempotent.
5. **Reset** — `dblclick` on any handle: `safeSend({ type: 'UPDATE_SETTINGS', settings:
   { playerSizeDefault: null } })` (or theater key per mode), and immediately clear the
   relevant rules from `#ytm-resize-style` + dispatch `resize` for instant feedback.
6. **Mode-change observer** — one `MutationObserver` on the `ytd-watch-flexy` element with
   `{ attributes: true, attributeFilter: ['theater', 'fullscreen', 'role'] }`, plus a
   `document.addEventListener('fullscreenchange', ...)`; both just call `applyPlayerSize()`.
   Created lazily inside `injectResizeHandles` when the flexy element first appears;
   disconnect/re-attach on SPA nav. (Event-driven — no polling.)
7. **SPA navigation** — in the existing URL-change branch of the body MutationObserver, after
   the existing `setTimeout(applyYouTubeUI, 3000)` (which now reaches `applyPlayerSize`), also
   call `resetSeekHistory(...)` and `rateSyncArmedAt = 0` (steps 3–4).

### Step 6 — `sidepanel/sidepanel.html`

Add to `.toggle-bar`, after `#tb-hiderecs`:

```html
<button class="tb-btn" id="tb-resize" data-desc="Drag the edges of the YouTube player to resize it (double-click a handle to reset)">
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15,3 21,3 21,9"/><polyline points="9,21 3,21 3,15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
  <span class="tb-label">Resize</span>
</button>
```

No new CSS required — generic `.tb-btn` styles cover it.

### Step 7 — `sidepanel/sidepanel.js`

1. `toggleMap` gains `'tb-resize': 'playerResizeEnabled'`.
2. `loadSettings()` gains
   `document.getElementById('tb-resize').classList.toggle('active', s.playerResizeEnabled !== false);`
   (undefined → default true).
3. Add `function fmtSpeed(v) { return Number(v).toFixed(2).replace(/(\.\d)0$/, '$1') + 'x'; }`
   ("1.00"→"1.0x", "0.25"→"0.25x") and use it in `loadSettings()` for `#speed-value`
   (replacing `s.speedLevel.toFixed(1) + 'x'`).
4. Slider drag-guard flags: on each of `#volume-slider`/`#speed-slider`, set
   `slider.dataset.dragging = '1'` on `pointerdown` and clear it on `pointerup` and `change`.
5. Extend the existing `chrome.storage.onChanged` listener (the one handling `yt_watch_time`)
   with a `changes.yt_settings` branch:
   ```js
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
   }
   ```

### Step 8 — `popup/popup.js`

Mirror Step 7 items 3–5: add `fmtSpeed`, use it in `loadSettings()`, add the same
pointerdown/pointerup/change drag flags on both sliders, and add a new
`chrome.storage.onChanged` listener (popup currently has none) with the identical
`yt_settings` branch (minus the `tb-resize` line — the popup has no toggle bar).
`popup/popup.html` is unchanged.

### Step 9 — tests (see section 6)

`tests/test-player.js`, `tests/assets/tiny.webm`, plus three additions to
`tests/test-extension.js`. Wire `test:player` into `package.json` scripts and append to
`test:all`.

## 5. Edge cases & failure modes

1. **Fullscreen.** All resize CSS selectors exclude `[fullscreen]`; `applyPlayerSize()` removes
   handles on `fullscreenchange`/attribute flip. Native fullscreen is untouched (spec).
2. **Theater toggled mid-session (T key).** The flexy attribute observer fires →
   `applyPlayerSize()` swaps to the other mode's stored size and rebuilds handles for that
   container.
3. **SPA navigation.** Existing URL-change handler re-runs `applyYouTubeUI` (now including
   `applyPlayerSize`) after 3 s and restarts the capped handle-injection retries; seek history
   and rate-sync arming reset. Pages without a player (home, subscriptions) burn at most the
   capped retries — same pattern as `bindVideoFeatures`.
4. **YouTube DOM drift (`#player-container-inner` renamed/restructured).** Container lookup
   returns null → handles never inject, style rules match nothing → feature silently degrades
   to native sizing; nothing else breaks. The `#tb-resize` toggle is the user-facing kill
   switch.
5. **hideRecs + resize both styling `#player-container-outer`.** Resize wins via doubled-id
   specificity and last-in-head ordering (decision 17). Turning resize off restores hideRecs
   full-width behavior.
6. **Stored size larger than the current window.** Clamped at apply time to viewport caps; the
   stored value is left intact so a bigger monitor gets the original size back.
7. **Handles clipped by an `overflow:hidden` ancestor.** Outside-the-box handles could be
   invisible if YouTube clips the container. Mitigation: `--se` corner handle is placed half-in
   (`right:-8px; width:14px` overlaps 6 px inside the box, below the controls' hover zone in the
   corner). Headed test verifies all three handles are actually hover-reachable; if clipping
   appears in the wild, move all handles to inside-edge strips (documented fallback).
8. **Ad playback resets `playbackRate` to 1.** `ratechange` ignored while `.ad-showing`; when
   the ad ends YouTube restores the content rate (another machine `ratechange`) — that restore
   matches `lastAppliedRate` or arrives as a duplicate value and is deduped by the worker, so no
   bogus write occurs.
9. **YouTube's "remembered" session speed applied during load.** Rate-sync arms only 500 ms
   after the first `playing` event; load-time rate flips are never reported. Our own stored
   speed is applied on `loadeddata` (existing path) and records `lastAppliedRate`, so the last
   writer wins deterministically and is not echoed.
10. **Concurrent native rate changes in two tabs.** Both report; worker serializes through
    `storage.update`; last write wins; both sliders show the final value. Acceptable — same as
    two hands on one slider.
11. **Ctrl-Z in the comment box / search field.** Editable-target guard passes the event
    through to the browser's text undo. Empty stacks also pass the key through.
12. **Undo across a video change.** Stacks are cleared when the videoId changes, so a stale
    position can never be applied to the wrong video.
13. **Seek while paused.** `timeupdate` does not tick while paused, but `seekPrevTime` was last
    set at pause time, which IS the correct origin; subsequent burst seeks keep the first
    origin via `seekOrigin`. Correct behavior falls out naturally.
14. **`suppressSeekRecording` stuck true** (e.g., programmatic seek interrupted): also cleared
    by `resetSeekHistory()` on navigation, bounding the damage to one video.
15. **Extension reloaded / worker asleep.** All sends go through existing `safeSend()`
    (context-validity guard); `SPEED_CHANGED`/`UPDATE_SETTINGS` wake the worker like any other
    message. Player size lives in `yt_settings` (local), so nothing is lost across worker
    restarts — no `chrome.storage.session` needs arise.
16. **Slider mid-drag when a storage echo arrives.** `dataset.dragging` guard skips the
    programmatic value write, so the thumb never fights the pointer.
17. **speedLevel 0.25 vs slider step.** Thumb rounds to nearest step (shows 0.3 position),
    label shows the true "0.25x"; moving the slider afterwards snaps back to clean 0.1 steps by
    design.

## 6. Test plan

### New: `tests/test-player.js` (headless, added to `test:all` and as `npm run test:player`)

Harness: copy the established pattern — `chromium.launchPersistentContext('', { channel:
'chromium', args: [--disable-extensions-except, --load-extension] })`, grab `sw`, extension id,
and `context.route()` two fake URLs:

- `https://www.youtube.com/watch?v=PLAYERTEST1` → skeleton watch page:
  `<ytd-watch-flexy><div id="player-container-outer"><div id="player-container">
  <div id="player-container-inner"><div id="movie_player" class="html5-video-player">
  <video src="/__tiny__.webm"></video></div></div></div></div></ytd-watch-flexy>` plus a
  `#secondary` div. (Content script matches `*://*.youtube.com/*` and `location.pathname`
  is `/watch` — gates open.)
- `https://www.youtube.com/__tiny__.webm` → `route.fulfill` with `tests/assets/tiny.webm`
  bytes, `contentType: 'video/webm'`.

**Speed sync assertions:**
1. Open the fake watch page, `video.play()` via evaluate, wait 1 s (arms rate sync), then
   `video.playbackRate = 1.5` in-page. Wait 600 ms. `sw.evaluate` reads `yt_settings` →
   `speedLevel === 1.5` ("native change persisted").
2. Open `sidepanel.html` in a second page; assert `#speed-slider` value is `15` and
   `#speed-value` text is `1.5x` (initial load reflects storage).
3. From `sw.evaluate`, `chrome.storage.local` merge `speedLevel: 0.25`; wait 500 ms; assert
   panel `#speed-value` becomes `0.25x` and slider value `3` WITHOUT reload ("live update via
   storage.onChanged"). Repeat assertion on a popup page.
4. Loop guard: drive the panel slider (`slider.value = 20; dispatchEvent(change)`), wait 1 s,
   read `speedLevel` from storage 3 times 300 ms apart → all `2` (no oscillation), and in-page
   `video.playbackRate === 2`.
5. Ad guard: in-page add class `ad-showing` to `#movie_player`, set `playbackRate = 1`,
   wait 600 ms → storage `speedLevel` still `2`.

**Resize assertions (geometry only — real video re-fit needs live YouTube):**
6. On the fake watch page: `#ytm-resize-handles` exists with 3 handles; `#ytm-resize-style`
   absent while both sizes are null.
7. Playwright `mouse.move/down/move/up` drag on `.ytm-resize-handle--s` by +50 px → assert
   `#ytm-resize-style` textContent contains a `height:` rule, and after 500 ms `sw.evaluate`
   shows `yt_settings.playerSizeDefault.h` is a number ("persisted on pointerup, not during
   drag" — also assert storage was still null mid-drag).
8. `dblclick` the handle → `playerSizeDefault === null` in storage and the height rule gone.
9. Toggle off: `sw.evaluate` merge `playerResizeEnabled: false`; wait; assert
   `#ytm-resize-handles` removed and `#ytm-resize-style` removed (storage.onChanged path).
10. Console-error watch on the fake page (pattern from `test-extension.js` `watchConsole`) —
    zero errors.

**Timeline history assertions (real seeks on tiny.webm):**
11. Play, wait, `video.currentTime = 0.5` settle, then seek `0.5 → 3.5` (>= 3 s). Wait 1 s
    (coalesce timer). Dispatch real `keydown` Ctrl+Z on `document.body` via
    `page.keyboard.press('Control+z')` → assert `video.currentTime` back near 0.5 (±0.3).
12. `Control+Shift+z` → currentTime near 3.5 again ("redo").
13. Focus a `<textarea>` injected into the fake page, press Ctrl+Z → currentTime unchanged
    ("editable guard").
14. Seek 1 s jump only (below threshold), press Ctrl+Z → currentTime unchanged ("threshold").

### Additions to existing suites

- `tests/test-extension.js` (smoke): in the side-panel section add
  `check('Resize toggle present', !!(await sidePanel.$('#tb-resize')))` and
  `check('Resize toggle has data-desc', !!(await sidePanel.$('#tb-resize[data-desc]')))`.
  In the popup interactions section, after setting storage speed to 0.25 via `sw.evaluate`,
  assert `#speed-value` shows `0.25x` (fmtSpeed regression).
- `tests/test-event-driven.js`: unchanged (slider live-update is covered in test-player.js to
  keep suites focused).

### Headed / live only (manual checklist, run like `test-panel-live.js`)

On real youtube.com in `npm run test:debug`-style headed Chrome:
1. Drag right/bottom/corner handles — the actual `<video>` re-fits (window-resize dispatch
   works against the real player JS) and controls bar tracks the new width.
2. Theater mode: bottom handle only; size persists across T-key toggles and page reloads.
3. Fullscreen: no handles, native behavior, exits clean.
4. hideRecs ON + width drag: player width honors the drag, not the 100% rule.
5. Native settings-gear → Playback speed → 0.75x: popup and panel sliders/labels move within
   ~1 s; no rate flapping during a mid-roll ad.
6. Click around the real timeline, Ctrl+Z/Ctrl+Shift+Z restore positions; toast appears over
   the player; Ctrl+Z inside an active comment draft performs text undo instead.

## 7. Risks & explicitly out-of-scope

**Risks**
1. **YouTube DOM/layout drift** — the resize feature depends on `#player-container-outer/-inner`,
   `#full-bleed-container`, and `ytd-watch-flexy` attributes. Mitigated by null-safe lookup,
   silent degradation, and the `tb-resize` kill switch; expect periodic selector maintenance.
2. **`window.resize` re-fit technique** — if a future player stops re-measuring on window
   resize, the container resizes but the `<video>` letterboxes oddly. Closest fallback (not in
   this build): also nudge `#movie_player` via its documented `setSize()` API from an injected
   main-world script — noted, not planned, since it requires main-world injection.
3. **Outside-the-box handles** can be clipped by an overflow-hidden ancestor on some layouts;
   fallback is inside-edge corner-only strips (edge case 7). Verified headed before ship.
4. **`speedLevel` semantic widening** (0.25-style values) touches every consumer of the
   setting; both display sites are updated here, but other feature groups adding speed UI must
   use `fmtSpeed`-style rendering and `Math.round(v*10)` for slider thumbs.
5. **Ctrl-Z capture-phase listener** runs on every keydown on watch pages; the guard chain is
   cheap, but if YouTube ever ships its own Ctrl-Z player shortcut we will shadow it (we only
   swallow the key when our stack is non-empty, which bounds the conflict).
6. **Ad-detection class (`.ad-showing`)** is itself YouTube-owned and may drift; worst case is
   a spurious 1.0x sync during ads — annoying, not destructive, and self-corrects at ad end.

**Explicitly out-of-scope (named in source material but NOT in this plan)**
- Picture-in-Picture auto-enable, PiP transparency slider, and PiP position/size presets
  (separate feature in Features-Refined.md; PiP transparency of the native PiP window is
  platform-impossible from an extension — the closest achievable is a custom documentPiP
  window, a different project).
- Propagating a native speed change instantly to OTHER tabs' running videos (decision 9 —
  deliberate; next-video auto-apply covers it).
- Resizing the player on Shorts pages or embedded players (iframe embeds run on other origins;
  content script only matches youtube.com).
- Growing the default-mode player wider than the `#primary` column (decision 2 — theater mode
  is the supported path; true column re-layout is fragile and unplanned).
- Persisting seek history across reloads, or a seek-history UI list.
- A settings toggle for timeline history (always-on by decision 13).
