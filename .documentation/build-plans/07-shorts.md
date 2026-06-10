# YouTube Shorts Tools

Feature group "shorts" for YouTube Tab Manager (Chrome MV3, no build step). This plan is
self-contained: an engineer with only this file + the repo can implement it.

Repo paths referenced below are relative to the extension root
(`C:/Users/thoma/Documents/1Design/1Custom-Software/.chrome-extensions/main-youtube-extension`).

---

## 1. Scope — restate each feature precisely

1. **Arrow-key scrubbing on Shorts pages.** On any `youtube.com/shorts/<id>` page,
   `ArrowLeft` / `ArrowRight` seek the playing `<video>` element −5s / +5s. The handler must
   NOT fire while typing in inputs, the comment box, search, or any contenteditable, and must
   not break native YouTube key handling (Shorts currently binds nothing to Left/Right —
   verified live as part of the test plan; Up/Down/Space/K remain untouched).

2. **Watch Shorts inside the extension side panel.** A player slot in the side panel embeds
   `https://www.youtube.com/embed/<VIDEO_ID>` (autoplay) in an iframe. Opened from a new
   button on Shorts-list cards (and from the Shorts tools strip for the currently displayed
   Short). Has a close button and prev/next navigation through the panel's Shorts list, in the
   list's current sort order. Embedding-disabled Shorts show an error card with an
   "Open in tab" fallback.

3. **Context-aware panel.** The side panel learns the displayed tab is a Short via the
   existing 1.5 s `GET_MEDIA_STATE` poll (response extended with `isShorts` + `url`). When
   true, a Shorts tools strip appears in the sticky header (prev/next Short, open-in-panel,
   auto-scroll toggle, auto-close toggle) and the now-playing card's media buttons adapt
   (±5 s seek instead of ±10 s, "next Short" instead of queue-skip).

4. **In-page rail.** On `/shorts/` pages the content script injects a slim vertical button
   rail into the empty space at the left of the Shorts player: add-to-queue, star, next Short,
   auto-scroll toggle, auto-close toggle.

5. **Auto-behavior toggles** (persisted in `yt_settings`, mutually exclusive in the UI):
   - **Auto-scroll** (`shortsAutoScroll`): when the current Short finishes its first playthrough
     (Shorts loop, so "finished" = first loop boundary), navigate to the next Short the way
     YouTube expects (click its next-video navigation button).
   - **Auto-close** (`shortsAutoClose`): when the current Short finishes, the content script
     notifies the worker, which closes **that specific Shorts tab**. This is the one explicit,
     sanctioned exception to the "never close the active tab" rule — the worker closes only
     the sender's own tab, after re-validating the setting and that the tab URL is a Short.

---

## 2. Clarifying questions & decisions

1. **Q: Should arrow scrubbing be a user-facing toggle?**
   **A: No — always on, scoped to `/shorts/` paths only.** It conflicts with nothing native
   today; a settings key without a real need is sprawl (revisit if YouTube ever binds
   Left/Right on Shorts).

2. **Q: Seek step — fixed 5 s or configurable?**
   **A: Fixed constant `SHORTS_SEEK_SECONDS = 5` in content.js.** Shorts are ≤ 180 s; spec
   says 5 s; a slider would be over-engineering.

3. **Q: How aggressively do we suppress scrubbing in text contexts?**
   **A: Bail when the event target is `INPUT`/`TEXTAREA`/`SELECT`, `isContentEditable`, or
   inside `#contenteditable-root`/`tp-yt-paper-dialog`, or any modifier key is held.**
   Modifier passthrough keeps browser shortcuts (Alt+Left = history back) working.

4. **Q: Can auto-scroll and auto-close both be on?**
   **A: No — mutually exclusive, enforced at the UI layer** (turning one on writes the other
   off in the same `UPDATE_SETTINGS`). They are contradictory end-of-Short behaviors; as
   defense-in-depth, the content script checks auto-close first if storage ever holds both.

5. **Q: What counts as "finished" for a looping Short?**
   **A: First loop boundary: a `timeupdate` where the previous observed `currentTime` was
   within 0.75 s of `duration` and the new one is < 0.5 s; plus the `ended` event as a
   fallback (non-looping edge). Fires at most once per videoId**, and is suppressed for 1.5 s
   after any manual seek (our scrub or media-command seek) so a seek-to-start is not a false
   "finish".

6. **Q: Auto-close fires while the tab is focused — is that allowed?**
   **A: Yes — this is the documented feature exception.** The worker closes only
   `sender.tab.id`, re-validates `shortsAutoClose === true` from storage, and re-validates
   `isShortUrl(tab.url)` before `chrome.tabs.remove`. It can never close an arbitrary tab.

7. **Q: Auto-closing the last tab of a window closes the window — special-case it?**
   **A: No.** That is standard Chrome behavior for tab-closing features; special-casing
   (open a newtab first) is surprising and adds tab churn. Documented as a known behavior.

8. **Q: How do we navigate to the next Short programmatically?**
   **A: Click YouTube's own navigation button**
   (`#navigation-button-down button, button[aria-label="Next video"]`), which other
   extensions rely on and which works with untrusted `.click()`. Fallback: dispatch a
   synthetic `ArrowDown` keydown on `document` — kept only as a fallback because synthetic
   key events are `isTrusted:false` and YouTube may ignore them. Selector verified in the
   headed test (Section 6).

9. **Q: How do we handle embedding-disabled Shorts in the panel player?**
   **A: Pre-flight check in the panel itself**: `fetch('https://www.youtube.com/embed/<id>')`
   (extension pages have `<all_urls>` host permission, so no CORS issue) and regex for
   `"playableInEmbed":false` / `"status":"UNPLAYABLE"`. Fail-open (treat as embeddable) on
   network error. On not-embeddable: error card with an "Open in tab" button. Doing the fetch
   in the panel (not the worker) keeps the contract smaller and makes the error path
   deterministically testable (the panel's `fetch` can be stubbed in Playwright); it is a
   stateless read, so it does not violate the "state flows through the worker" rule.

10. **Q: Can the panel player auto-advance / mark watched when the embedded Short ends?**
    **A: Best-effort only, via the embed's raw postMessage protocol** (`enablejsapi=1` +
    `{event:'listening'}` handshake; listen for `onStateChange` info `0`). The official
    IFrame API script cannot load (extension-page CSP is `script-src 'self'`). On `ended`:
    mark the video watched (`UPDATE_VIDEO`) and advance to the next Short in the panel list.
    If the protocol breaks, everything else still works — the player just doesn't advance.

11. **Q: Should opening the panel player pause the tab that is currently playing?**
    **A: Yes, once, at open time** — if `lastMediaState` shows a playing video, send the
    existing `MEDIA_CONTROL`/`playPause` to its `tabId`. Avoids double audio without
    babysitting the tab afterwards.

12. **Q: "Swap the right-side panel buttons" — hide the standard controls entirely on Shorts
    tabs?**
    **A: No hard swap.** Volume/speed/sort/search stay useful on Shorts. We *add* the
    Shorts strip (hidden otherwise) and *adapt* the now-playing buttons. Less jarring, honors
    the intent (Shorts tools appear contextually) without destroying muscle memory.

13. **Q: Where do the auto toggles live — the main `.toggle-bar` or the Shorts strip?**
    **A: The Shorts strip** (`#shorts-tools`), because they are meaningless off-Shorts and the
    toggle-bar is already 6 buttons wide. Strip buttons reuse the `data-desc` hover-description
    mechanism (listener selector extended to cover the strip). They are *also* mirrored on
    the in-page rail; both write through `UPDATE_SETTINGS` and both repaint from
    `storage.onChanged`, so they can never disagree.

14. **Q: Rail — anchor to the player element or fix to the screen edge?**
    **A: Fixed to the left viewport edge, vertically centered.** Anchoring to YouTube's
    player DOM (`ytd-reel-video-renderer[is-active]`) is brittle and needs resize/observer
    plumbing. The fixed rail sits in the guaranteed-empty left gutter, is ~40 px wide,
    hides itself in fullscreen, and is removed entirely off `/shorts/`.

15. **Q: Does the new per-card button break the virtual-scroll geometry?**
    **A: No — it must not.** The panel-play button is a 4th `.card-sm-btn` inside the existing
    `.card-bottom-actions` row (fixed 20 px tall); card height stays 59 px + 4 px margin =
    `CARD_HEIGHT 63`. A test asserts `offsetHeight === 59` on a Shorts card.

16. **Q: Does rail add-to-queue need duplicate handling?**
    **A: No new logic** — it sends the existing `ADD_VIDEO`, whose worker path already bumps
    `addedAt` on duplicates (documented "bump to top" behavior). Button flashes green for
    feedback.

---

## 3. Data & message contract

### Storage keys
**No new top-level `chrome.storage.local` keys. No `chrome.storage.session` keys needed**
(auto-close uses `sender.tab.id` at message time — nothing must survive a worker restart).

Changed key:
- `yt_settings` (existing object) gains two booleans:
  ```js
  {
    ...existing,
    shortsAutoScroll: false,  // auto-navigate to next Short on first loop boundary
    shortsAutoClose:  false,  // close the Shorts tab on first loop boundary
  }
  ```
  All mutations go through the worker's `UPDATE_SETTINGS` handler, which already uses
  `storage.update()`.

### Settings keys (defaults added to `DEFAULT_SETTINGS` in `utils/constants.js`)
- `shortsAutoScroll = false`
- `shortsAutoClose = false`

### MSG types (`utils/constants.js`; content script & panel inline the literals)
New:
- `MSG.CLOSE_SHORT_TAB = 'CLOSE_SHORT_TAB'`
  - Request (content script → worker, only when a Short finishes and `shortsAutoClose` is on):
    `{ type: 'CLOSE_SHORT_TAB', videoId: string }`
  - Worker behavior: requires `sender.tab.id`; re-reads settings and requires
    `shortsAutoClose === true`; `chrome.tabs.get(senderTabId)` and requires
    `isShortUrl(tab.url)`; then `chrome.tabs.remove(senderTabId)`.
  - Response: `{ closed: boolean, reason?: 'no-sender-tab'|'disabled'|'gone'|'not-short'|'remove-failed' }`

Changed (shape extensions, backward compatible):
- `MSG.GET_MEDIA_STATE` — content-script response (and therefore the worker's pass-through
  `{...state, tabId}`) gains:
  `{ ..., isShorts: boolean, url: string|null }`
  The worker's `empty` fallback object gains `isShorts: false, url: null`.
- `MSG.MEDIA_CONTROL` (panel → worker) / `MSG.MEDIA_COMMAND` (worker → content):
  - New optional field `seconds: number` honored by `forward`/`rewind` (default `10`).
  - New actions: `'shortsNext'`, `'shortsPrev'` — content script clicks YouTube's Shorts
    navigation buttons. Response `{ success: boolean, paused?: boolean }` (success `false`
    when not on a `/shorts/` page or no nav button found).

No new message is needed for the embed pre-flight (panel fetches directly — decision #9).

### New files
- `tests/test-shorts.js` — Playwright suite (Section 6).
- `.documentation/build-plans/07-shorts.md` — this plan.

No new source files: content script stays a single IIFE (`content/content.js`), panel stays
a single plain script (`sidepanel/sidepanel.js`), all styles in `sidepanel/sidepanel.css` or
injected `<style>` blocks (existing content-script pattern).

---

## 4. Implementation steps (file-by-file, in order)

### 4.1 `utils/constants.js`
- Add to `MSG`: `CLOSE_SHORT_TAB: 'CLOSE_SHORT_TAB'`.
- Add to `DEFAULT_SETTINGS`: `shortsAutoScroll: false, shortsAutoClose: false`.

### 4.2 `background/service-worker.js`
- In `handleMessage`:
  - **`MSG.MEDIA_CONTROL`**: include `seconds: message.seconds` in the forwarded
    `MEDIA_COMMAND` payload (one-line change to the existing `chrome.tabs.sendMessage` call).
  - **`MSG.GET_MEDIA_STATE`**: extend the `empty` constant:
    `{ paused: true, currentTime: 0, duration: 0, videoId: null, tabId: null, isShorts: false, url: null }`.
    (No other change — the handler already spreads the content script's response.)
  - **New `case MSG.CLOSE_SHORT_TAB:`** (place after `MSG.VIDEO_ENDED`):
    ```js
    case MSG.CLOSE_SHORT_TAB: {
      // Explicit feature exception to "never close the active tab": auto-close
      // closes ONLY the sender's own Shorts tab, re-validated here.
      const tabId = sender.tab?.id;
      if (!tabId) return { closed: false, reason: 'no-sender-tab' };
      const settings = await storage.get(STORAGE_KEYS.SETTINGS);
      if (!settings?.shortsAutoClose) return { closed: false, reason: 'disabled' };
      let tab;
      try { tab = await chrome.tabs.get(tabId); } catch { return { closed: false, reason: 'gone' }; }
      if (!isShortUrl(tab.url)) return { closed: false, reason: 'not-short' };
      try { await chrome.tabs.remove(tabId); return { closed: true }; }
      catch { return { closed: false, reason: 'remove-failed' }; }
    }
    ```
    (`isShortUrl` is already imported from `utils/youtube.js`; it hostname-validates first.)

### 4.3 `content/content.js` (all inside the existing IIFE)

**State + helpers** (near the top, by the existing module-level lets):
```js
const SHORTS_SEEK_SECONDS = 5;
let lastManualSeekAt = 0;   // suppress loop-detect right after a seek
let prevShortTime = 0;      // last observed currentTime on the shorts <video>
let lastLoopFiredId = null; // finish fires once per videoId
function isShortsPage() { return location.pathname.startsWith('/shorts/'); }
```

**(a) Arrow-key scrubbing** — register once at module level (next to the `auxclick` listener):
```js
window.addEventListener('keydown', (e) => {
  if (!isShortsPage()) return;
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const t = e.target;
  if (t && (t.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '') ||
      (t.closest && t.closest('input, textarea, select, [contenteditable], #contenteditable-root, tp-yt-paper-dialog')))) return;
  const video = getVideoElement();
  if (!video) return;
  e.preventDefault();
  e.stopImmediatePropagation(); // win over YouTube's document-level hotkeys
  seekBy(video, e.key === 'ArrowRight' ? SHORTS_SEEK_SECONDS : -SHORTS_SEEK_SECONDS);
}, true); // capture phase: runs before YouTube's listeners
```
```js
function seekBy(video, delta) {
  lastManualSeekAt = Date.now();
  // clamp BELOW duration so a forward seek can't wrap the loop and
  // false-trigger the finish detector
  const max = isFinite(video.duration) ? Math.max(0, video.duration - 0.25) : Infinity;
  video.currentTime = Math.min(Math.max(0, video.currentTime + delta), max);
}
```

**(b) Loop-boundary "finished" detection** — new `setupShortsLoopWatch()` called from
`bindVideoFeatures()` (alongside `setupEndedListener()`):
```js
function setupShortsLoopWatch() {
  const video = getVideoElement();
  if (!video || video._ytmLoopBound) return; // Shorts reuse one <video> across items
  video._ytmLoopBound = true;
  video.addEventListener('timeupdate', () => {
    const t = video.currentTime, d = video.duration;
    if (!isShortsPage()) { prevShortTime = t; return; }
    const wrapped = isFinite(d) && d > 1 &&
      prevShortTime > d - 0.75 && t < 0.5 &&
      Date.now() - lastManualSeekAt > 1500;
    prevShortTime = t;
    if (!wrapped) return;
    const id = getCurrentVideoId();
    if (!id || id === lastLoopFiredId) return;
    lastLoopFiredId = id;
    handleShortFinished(id);
  });
}
```
Also extend the existing `ended` handler in `setupEndedListener()`: after sending
`VIDEO_ENDED`, add — `if (isShortsPage() && videoId && videoId !== lastLoopFiredId) { lastLoopFiredId = videoId; handleShortFinished(videoId); }`.

```js
async function handleShortFinished(videoId) {
  const s = await getSettings();      // cachedSettings, refreshed by storage.onChanged
  if (s.shortsAutoClose) {
    safeSend({ type: 'CLOSE_SHORT_TAB', videoId });  // worker closes THIS tab
  } else if (s.shortsAutoScroll) {
    clickShortsNav('next');
  }
}
```

**(c) Programmatic Shorts navigation:**
```js
function clickShortsNav(dir) {
  const sel = dir === 'next'
    ? '#navigation-button-down button, button[aria-label="Next video"]'
    : '#navigation-button-up button, button[aria-label="Previous video"]';
  const btn = document.querySelector(sel);
  if (btn) { btn.click(); return true; }
  // Fallback (untrusted — YouTube may ignore it; primary path is the click)
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: dir === 'next' ? 'ArrowDown' : 'ArrowUp',
    code: dir === 'next' ? 'ArrowDown' : 'ArrowUp',
    keyCode: dir === 'next' ? 40 : 38, which: dir === 'next' ? 40 : 38, bubbles: true,
  }));
  return false;
}
```

**(d) Message listener extensions** (inside the existing `chrome.runtime.onMessage` switch):
- `GET_MEDIA_STATE` response: add `isShorts: isShortsPage(), url: window.location.href`.
- `MEDIA_COMMAND`:
  - `forward`: `video.currentTime = Math.min(video.currentTime + (message.seconds || 10), isFinite(video.duration) ? video.duration - 0.25 : Infinity); lastManualSeekAt = Date.now();`
  - `rewind`: symmetric with `(message.seconds || 10)`.
  - New `case 'shortsNext': sendResponse({ success: isShortsPage() && clickShortsNav('next') }); break;` and the
    `shortsPrev` twin. (Place before the existing `sendResponse({ success: true, paused })` —
    return early for these two actions.)

**(e) In-page rail** — new functions, all DOM via `document.createElement` (static SVG
`innerHTML` allowed, never user data):
```js
const RAIL_ID = 'ytm-shorts-rail';
function updateShortsFeatures() { isShortsPage() ? ensureShortsRail() : removeShortsRail(); }
function ensureShortsRail() { /* inject style tag + build rail if absent */ }
function removeShortsRail() { document.getElementById(RAIL_ID)?.remove(); }
function updateShortsRailState() { /* toggle .ytm-on on the two toggle buttons from cachedSettings */ }
```
Rail structure (id `ytm-shorts-rail`), buttons top-to-bottom, each a 40 px circle with a
`title` tooltip:
1. `#ytm-rail-add` "Add to queue" → `safeSend({ type: 'ADD_VIDEO', url: location.href })`,
   flash `.ytm-ok` for 800 ms on response.
2. `#ytm-rail-star` "Star this Short" → `safeSend({ type: 'TAG_STARRED', videoId: getCurrentVideoId(), url: location.href })`, same flash.
3. `#ytm-rail-next` "Next Short" → `clickShortsNav('next')`.
4. `#ytm-rail-autoscroll` "Auto-scroll when finished" (toggle) →
   `safeSend({ type: 'UPDATE_SETTINGS', settings: { shortsAutoScroll: !on, ...( !on ? { shortsAutoClose: false } : {}) } })`.
5. `#ytm-rail-autoclose` "Close tab when finished" (toggle) → symmetric exclusion.

Injected style (id `ytm-shorts-rail-style`):
```css
#ytm-shorts-rail { position: fixed; left: 14px; top: 50%; transform: translateY(-50%);
  display: flex; flex-direction: column; gap: 10px; z-index: 2400; }
#ytm-shorts-rail button { width: 40px; height: 40px; border-radius: 50%;
  border: 1px solid rgba(255,255,255,0.25); background: rgba(30,30,30,0.85);
  color: #f1f1f1; cursor: pointer; display: flex; align-items: center;
  justify-content: center; font-size: 16px; }
#ytm-shorts-rail button:hover { background: rgba(60,60,60,0.95); }
#ytm-shorts-rail button.ytm-on { border-color: #ff0000; color: #ff0000;
  background: rgba(255,0,0,0.15); }
#ytm-shorts-rail button.ytm-ok { border-color: #2ba640; color: #2ba640; }
```
Hide in fullscreen: `document.addEventListener('fullscreenchange', () => { const r = document.getElementById(RAIL_ID); if (r) r.style.display = document.fullscreenElement ? 'none' : ''; });`

**(f) Hooks:**
- `init()`: add `updateShortsFeatures();` and call `setupShortsLoopWatch()` via the existing
  `bindVideoFeatures()` (add the call there).
- SPA navigation handler (the `MutationObserver` URL-change branch): add
  `prevShortTime = 0; lastLoopFiredId = null; updateShortsFeatures();`.
- `storage.onChanged` (`yt_settings` branch): after updating `cachedSettings`, call
  `updateShortsRailState();`.

### 4.4 `sidepanel/sidepanel.html`
- Insert after the `.controls-bar` div (inside `.sticky-top`):
```html
<!-- Shorts tools (visible only when the displayed tab is a Short) -->
<div class="shorts-tools" id="shorts-tools" style="display:none">
  <button class="st-btn" id="st-prev" data-desc="Previous Short in the active tab">
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18,15 12,9 6,15"/></svg>
    <span class="tb-label">Prev</span>
  </button>
  <button class="st-btn" id="st-next" data-desc="Next Short in the active tab">
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6,9 12,15 18,9"/></svg>
    <span class="tb-label">Next</span>
  </button>
  <button class="st-btn" id="st-open-panel" data-desc="Watch this Short inside the panel">
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><polygon points="10,8 16,12 10,16" fill="currentColor"/></svg>
    <span class="tb-label">Panel</span>
  </button>
  <button class="st-btn st-toggle" id="st-autoscroll" data-desc="Auto-scroll to the next Short when it finishes">
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6,9 12,15 18,9"/><line x1="12" y1="3" x2="12" y2="13"/></svg>
    <span class="tb-label">Auto-next</span>
  </button>
  <button class="st-btn st-toggle" id="st-autoclose" data-desc="Close the Shorts tab when it finishes">
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>
    <span class="tb-label">Auto-close</span>
  </button>
</div>
```
- Insert as the FIRST child of `.scroll-area` (above `#now-playing`):
```html
<div id="shorts-player" style="display:none"></div>
```

### 4.5 `sidepanel/sidepanel.css`
```css
/* Shorts tools strip */
.shorts-tools { display: flex; gap: 4px; padding: 5px 0; border-bottom: 1px solid var(--border); }
.st-btn { flex: 1; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 2px; padding: 4px 2px; border-radius: 6px;
  border: 1px solid var(--border); background: var(--bg-card); color: var(--text2);
  cursor: pointer; transition: all 0.15s; min-height: 32px; }
.st-btn:hover { color: var(--text); border-color: #555; background: var(--bg-hover); }
.st-btn.active { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }

/* In-panel Shorts player */
#shorts-player { margin-bottom: 6px; }
.sp-card { background: var(--bg-card); border: 1px solid var(--accent);
  border-radius: var(--r); padding: 8px; box-shadow: 0 0 8px rgba(255,0,0,0.08); }
.sp-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.sp-title { flex: 1; font-size: 12px; font-weight: 600; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
.sp-head .card-sm-btn { flex-shrink: 0; }
.sp-frame-wrap { display: flex; justify-content: center; }
.sp-frame-wrap iframe { width: 264px; height: 470px; border: 0; border-radius: 8px; background: #000; }
.sp-error { width: 264px; height: 470px; border-radius: 8px; background: #000;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 10px; color: var(--text2); font-size: 12px; text-align: center; padding: 12px; box-sizing: border-box; }
.sp-nav { display: flex; align-items: center; justify-content: center; gap: 8px;
  padding-top: 6px; margin-top: 6px; border-top: 1px solid var(--border); }
.sp-pos { font-size: 10px; color: var(--text2); font-variant-numeric: tabular-nums; }
.sp-nav .np-btn[disabled] { opacity: 0.35; cursor: default; }

/* Per-card open-in-panel button (shorts only) — must not change the 59px card height */
.card-panel-btn { font-size: 9px; }
```

### 4.6 `sidepanel/sidepanel.js`

**State (module top):**
```js
let shortsPlayerVideoId = null;
const embedCache = new Map(); // videoId -> boolean (per-panel-session)
let panelSettings = {};       // mirror of yt_settings for shorts toggles
```

**(a) `updateNowPlaying()`** — after `lastMediaState = state` paths, add a single call
`updateShortsToolsVisibility(state)`:
```js
function updateShortsToolsVisibility(state) {
  document.getElementById('shorts-tools').style.display = state?.isShorts ? '' : 'none';
}
```
(Also call it with the `empty` state branch so the strip hides when nothing is displayed.)

**(b) `buildNowPlayingCard(video, state)`** — Shorts variant:
- `const seekSecs = state.isShorts ? 5 : 10;`
- `mediaControl` helper gains seconds: `const mediaControl = (action) => msg({ type: 'MEDIA_CONTROL', action, seconds: seekSecs, tabId: lastMediaState?.tabId });`
- Rewind/forward `.np-btn-label` text becomes `String(seekSecs)`.
- Skip button: when `state.isShorts`, clicking sends `mediaControl('shortsNext')` instead of
  `SKIP_VIDEO` (queue-skip semantics don't apply to the Shorts feed).

**(c) Shorts strip handlers** (module level, after the toggle-bar wiring):
```js
document.getElementById('st-prev').addEventListener('click', () =>
  msg({ type: 'MEDIA_CONTROL', action: 'shortsPrev', tabId: lastMediaState?.tabId }));
document.getElementById('st-next').addEventListener('click', () =>
  msg({ type: 'MEDIA_CONTROL', action: 'shortsNext', tabId: lastMediaState?.tabId }));
document.getElementById('st-open-panel').addEventListener('click', () => {
  if (lastMediaState?.videoId) openShortsPlayer(lastMediaState.videoId);
});
document.getElementById('st-autoscroll').addEventListener('click', () => {
  const on = !panelSettings.shortsAutoScroll;
  msg({ type: 'UPDATE_SETTINGS', settings: { shortsAutoScroll: on, ...(on ? { shortsAutoClose: false } : {}) } });
});
document.getElementById('st-autoclose').addEventListener('click', () => {
  const on = !panelSettings.shortsAutoClose;
  msg({ type: 'UPDATE_SETTINGS', settings: { shortsAutoClose: on, ...(on ? { shortsAutoScroll: false } : {}) } });
});
function syncShortsToggles() {
  document.getElementById('st-autoscroll').classList.toggle('active', !!panelSettings.shortsAutoScroll);
  document.getElementById('st-autoclose').classList.toggle('active', !!panelSettings.shortsAutoClose);
}
```
- In `loadSettings()`: `panelSettings = s; syncShortsToggles();`
- New `chrome.storage.onChanged` branch (extend the existing listener that watches
  `yt_watch_time`): `if (changes.yt_settings) { panelSettings = changes.yt_settings.newValue || {}; syncShortsToggles(); }`
  (Buttons repaint only from storage — no optimistic class toggling, so panel and rail never
  disagree.)
- Hover descriptions: change the existing selector
  `document.querySelectorAll('.toggle-bar [data-desc]')` to
  `document.querySelectorAll('.toggle-bar [data-desc], .shorts-tools [data-desc]')`.

**(d) Per-card button** — in `buildVideoItem(v, _unused, isWatched)`, where
`card-bottom-actions` is assembled:
```js
const bottomBtns = [starBtn, removeBtn, watchBtn];
if (v.isShort) {
  const panelBtn = el('button', { class: 'card-sm-btn card-panel-btn', text: '⧉', title: 'Watch in panel' });
  panelBtn.addEventListener('click', e => { e.stopPropagation(); openShortsPlayer(v.id); });
  bottomBtns.push(panelBtn);
}
```

**(e) Panel player:**
```js
function checkEmbeddable(videoId) {            // panel-side pre-flight (decision #9)
  if (embedCache.has(videoId)) return Promise.resolve(embedCache.get(videoId));
  return fetch('https://www.youtube.com/embed/' + videoId)
    .then(r => r.ok ? r.text() : '')
    .then(html => {
      let ok = true;
      if (/"status"\s*:\s*"UNPLAYABLE"/.test(html)) ok = false;
      const m = html.match(/"playableInEmbed"\s*:\s*(true|false)/);
      if (m) ok = m[1] === 'true';
      embedCache.set(videoId, ok);
      return ok;
    })
    .catch(() => true); // fail-open: show the iframe, worst case it errors visibly
}

async function openShortsPlayer(videoId) { /* build with el(), never innerHTML with user data */ }
function closeShortsPlayer() { /* clear container, hide, shortsPlayerVideoId = null */ }
```
`openShortsPlayer` steps:
1. `shortsPlayerVideoId = videoId`; look up the video in `cachedVideos` for the title
   (fallback `'Short'`).
2. Render `.sp-card` skeleton into `#shorts-player` (header: `.sp-title`, an open-in-tab
   `card-sm-btn` (`↗`, sends `OPEN_VIDEO` with `https://www.youtube.com/shorts/<id>`),
   and `#sp-close` (`✕`, calls `closeShortsPlayer`)); show the container.
3. If the displayed tab is playing (`lastMediaState && !lastMediaState.paused`), send
   `MEDIA_CONTROL`/`playPause` to `lastMediaState.tabId` once (avoid double audio).
4. `const ok = await checkEmbeddable(videoId);` if the player was closed/switched meanwhile
   (`shortsPlayerVideoId !== videoId`) abort.
5. If `ok`: append iframe —
   ```js
   el('iframe', {
     src: 'https://www.youtube.com/embed/' + videoId
        + '?autoplay=1&playsinline=1&rel=0&enablejsapi=1&origin='
        + encodeURIComponent(location.origin),
     allow: 'autoplay; encrypted-media; picture-in-picture',
   })
   ```
   On iframe `load`, send the jsapi handshake:
   `iframe.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 'ytm' }), 'https://www.youtube.com');`
6. Else: append `.sp-error` with text "This Short can't be embedded." and an
   "Open in tab" button (sends `OPEN_VIDEO`).
7. Footer `.sp-nav`: `#sp-prev` / `#sp-next` (`np-btn` styling) navigate by index within
   `dataShorts` (`dataShorts.findIndex(v => v.id === shortsPlayerVideoId)`); disabled at the
   ends; `.sp-pos` shows `"(idx+1) / dataShorts.length"`. Navigation = `openShortsPlayer(nextId)`.
8. After open AND after close: `lastRenderKeys.clear(); renderVisibleCards();` — the player
   changes every list's `offsetTop`, so cached virtual-scroll render keys are stale.

**(f) Embed ended-bridge** (module level):
```js
window.addEventListener('message', (e) => {
  if (e.origin !== 'https://www.youtube.com' || !shortsPlayerVideoId) return;
  let data; try { data = JSON.parse(e.data); } catch { return; }
  if (data.event === 'onStateChange' && data.info === 0) {        // ended
    const endedId = shortsPlayerVideoId;
    if (cachedVideos.some(v => v.id === endedId && !v.watched)) {
      msg({ type: 'UPDATE_VIDEO', videoId: endedId, updates: { watched: true } });
    }
    const idx = dataShorts.findIndex(v => v.id === endedId);
    const next = idx >= 0 ? dataShorts[idx + 1] : null;
    next ? openShortsPlayer(next.id) : closeShortsPlayer();
  }
});
```
(Best-effort: if YouTube changes the protocol, nothing happens — player still works manually.)

### 4.7 `tests/test-extension.js` (smoke additions only)
In "Test 2: Side Panel UI" add:
```js
check('Shorts tools strip present', !!(await sidePanel.$('#shorts-tools')));
check('Shorts player slot present', !!(await sidePanel.$('#shorts-player')));
```

### 4.8 `package.json`
- Add script `"test:shorts": "node tests/test-shorts.js"`.
- Append `&& node tests/test-shorts.js` to `test:all`.

### 4.9 `tests/test-shorts.js` (new — see Section 6 for the assertion list)

---

## 5. Edge cases & failure modes

| Case | Handling |
|---|---|
| User types in Shorts comment box / search and presses Left/Right | keydown guard bails on INPUT/TEXTAREA/SELECT/contenteditable/`#contenteditable-root` targets and on any modifier key. |
| YouTube later binds Left/Right on Shorts | Our capture-phase `stopImmediatePropagation` wins (we'd mask the native feature) — documented risk; revisit if YouTube ships one. |
| ArrowRight seeks past the end of a looping Short | `seekBy` clamps to `duration - 0.25`, so a manual seek can never wrap the loop and false-fire "finished"; additionally any wrap within 1.5 s of a manual seek is ignored. |
| User manually seeks backward near the start | Loop detector requires the *previous* `timeupdate` to be within 0.75 s of `duration` — an ordinary back-seek from mid-video does not qualify. |
| Shorts `<video>` element is reused across feed items | Loop watcher binds once per element (`_ytmLoopBound`) and resolves `getCurrentVideoId()` at fire time; `lastLoopFiredId` + SPA-nav reset give once-per-Short semantics. |
| `duration` is `NaN`/0 before metadata loads | Detector requires `isFinite(d) && d > 1`; scrub clamps only when duration is finite. |
| Both auto toggles somehow true in storage | Content checks `shortsAutoClose` first (close wins); UI writes are mutually exclusive so this state cannot be produced by the extension. |
| Auto-close target tab already gone / last tab in window | `tabs.get` failure → `{ closed:false, reason:'gone' }`; closing the last tab closes the window — accepted standard behavior (decision #7). |
| Malicious/buggy message claiming CLOSE_SHORT_TAB | Worker only ever closes `sender.tab.id`, only when settings allow, only when that tab's URL passes `isShortUrl` (hostname-validated). A message without `sender.tab` (e.g. from the panel) is refused. |
| Auto-scroll: nav button missing (YouTube DOM change) | `clickShortsNav` returns false after attempting the synthetic-key fallback; no crash, no loop (fires once per videoId). Headed test pins the selector. |
| `VIDEO_ENDED`-driven autoplay-next colliding with Shorts auto-behaviors | `ended` rarely fires on looping Shorts; when it does, the existing `VIDEO_ENDED` flow only acts if `autoPlayNext` is on, and `handleShortFinished` still honors the once-per-id guard. Acceptable overlap; the queue-autoplay navigating a Shorts tab is pre-existing behavior. |
| Embed-disabled Short in panel player | Pre-flight regex on the embed page HTML → `.sp-error` card with "Open in tab". Pre-flight fail-open on network error (iframe shows YouTube's own error UI at worst, with our Open-in-tab button still in the header). |
| Embed pre-flight slow / player switched meanwhile | `openShortsPlayer` re-checks `shortsPlayerVideoId === videoId` after the await and aborts stale renders. |
| Iframe autoplay blocked | `allow="autoplay; encrypted-media; picture-in-picture"` + the open is always user-gesture-initiated. If Chrome still blocks, the user clicks the embed's play button — degraded, not broken. |
| Double audio (tab Short + panel Short) | Panel pauses the displayed tab once at player open if it was playing. If the user un-pauses the tab afterwards, that's their choice — we don't babysit. |
| Panel player breaks virtual-scroll geometry | Player lives *above* the lists inside `.scroll-area`; `renderVirtualList` reads `container.offsetTop` per render, and we `lastRenderKeys.clear() + renderVisibleCards()` on open/close so cached ranges can't go stale. `CARD_HEIGHT` untouched (player is not a card). |
| 4th card button overflowing the 59 px card | Buttons are fixed 20 px tall in an existing flex row; test asserts `offsetHeight === 59` on a Shorts card. |
| `isShorts` reflects the *displayed* (priority) tab, not necessarily the focused tab | Accepted: GET_MEDIA_STATE's priority order (active-playing → last-playing → scan) is the panel's established "displayed tab" notion; strip and now-playing stay consistent with each other. Documented in Section 7. |
| Rail overlaps YouTube UI at narrow windows / fullscreen | Rail is 40 px at the far-left gutter (Shorts player is centered, gutter exists at all desktop widths); hidden entirely on `fullscreenchange`; removed off `/shorts/`. |
| Worker idle-death | No new in-memory worker state: auto-close reads settings from storage and acts on `sender.tab.id` synchronously within one message; nothing to persist in `chrome.storage.session`. |
| Extension reload while content script alive | All sends go through existing `safeSend`/`isContextValid` guards. |

---

## 6. Test plan

### New file: `tests/test-shorts.js` (headless, in `test:all`)
Pattern: `chromium.launchPersistentContext('', { channel:'chromium', args:[--disable-extensions-except, --load-extension] })`,
`context.route()` on fake `www.youtube.com` URLs, `check(label, cond)` tally, exit code 1 on failure.

Fixture: a base64-encoded ~1 s silent looping WebM embedded as a constant in the test file
(generated once at authoring time, e.g. `ffmpeg -f lavfi -i color=c=black:s=64x64:d=1 -an tiny.webm`,
then base64). The fake Shorts page is routed at `https://www.youtube.com/shorts/SHRTTEST001`:
```html
<video muted autoplay loop src="data:video/webm;base64,..."></video>
<input id="fake-comment">
<button id="navigation-button-down" onclick="window.__navClicked=true"></button>
```
(11-char ids must match `[a-zA-Z0-9_-]{11}` — use e.g. `SHRTTEST001`.)

**A. Arrow scrubbing (content script, fake Shorts page):**
1. Wait for `video.readyState >= 2` and `duration > 0`.
2. Pause the video via page evaluate (stable currentTime), set `currentTime = 0.1`.
3. `page.keyboard.press('ArrowRight')` (trusted input) → assert `currentTime >= duration - 0.3`
   (5 s clamps to `duration - 0.25`).
4. `page.keyboard.press('ArrowLeft')` → assert `currentTime === 0` (clamped at 0).
5. Focus `#fake-comment`, press `ArrowRight` → assert `currentTime` unchanged (input guard).
6. Hold-modifier check: dispatch via `page.keyboard.press('Alt+ArrowRight')` → unchanged.

**B. Loop-finish → auto-scroll (fake page, deterministic):**
1. `sw.evaluate` set `yt_settings.shortsAutoScroll = true` (merge, via `chrome.storage.local`).
2. Let the looping 1 s video play ≥ 2 s → content detects the wrap and clicks
   `#navigation-button-down` → assert `window.__navClicked === true` in the page.

**C. Loop-finish → auto-close (end-to-end):**
1. Fresh fake Shorts tab; `sw.evaluate` set `shortsAutoClose: true, shortsAutoScroll: false`.
2. Wait ≤ 5 s for the tab to disappear (`sw.evaluate` → `chrome.tabs.query` for the URL) →
   assert closed.
3. Negative control: third fake Shorts tab with `shortsAutoClose: false` → still open after 3 s.
4. Guard check: with `shortsAutoClose: false`, `CLOSE_SHORT_TAB` results in
   `{ closed:false }` (covered implicitly by 3).

**D. GET_MEDIA_STATE extension + context-aware strip:**
1. With the fake Shorts tab open and playing, open
   `chrome-extension://<id>/sidepanel/sidepanel.html` as a page.
2. Within 2 polls (≤ 3.5 s): assert `#shorts-tools` is visible
   (`getComputedStyle(...).display !== 'none'`), and the now-playing seek-button label text
   is `'5'`.
3. Close the fake tab → strip hides within 2 polls.

**E. Panel player (headless, deterministic):**
1. Seed `yt_videos` via `sw.evaluate` with two Shorts entries
   (`isShort: true`, ids `SHRTTEST001`, `SHRTTEST002`) and one regular video.
2. Open the panel page with `page.addInitScript` that stubs `window.fetch` for
   `'/embed/SHRTTEST001'` → resolves HTML containing `"playableInEmbed":true`, and for
   `'/embed/SHRTTEST002'` → HTML containing `"status":"UNPLAYABLE"` (makes the pre-flight
   deterministic without network).
3. Click the Shorts content tab → assert each Shorts card has `.card-panel-btn` and the
   regular video card does NOT; assert a Shorts card `offsetHeight === 59` (CARD_HEIGHT
   invariant).
4. Click `.card-panel-btn` on SHRTTEST001 → `#shorts-player` visible, contains an `iframe`
   whose `src` includes `/embed/SHRTTEST001`, `autoplay=1`, and `enablejsapi=1`.
5. Click `#sp-next` → iframe src now `/embed/SHRTTEST002`… which is the UNPLAYABLE one →
   assert `.sp-error` is rendered instead of an iframe, with an "Open in tab" button.
6. Click `#sp-close` → `#shorts-player` hidden, no iframe in DOM.
7. Toggle `#st-autoscroll` then `#st-autoclose` → assert via `sw.evaluate` that
   `yt_settings.shortsAutoClose === true && yt_settings.shortsAutoScroll === false`
   (mutual exclusion), and both buttons' `.active` classes match after the
   `storage.onChanged` round-trip.

**F. In-page rail (fake Shorts page):**
1. Assert `#ytm-shorts-rail` exists with 5 buttons on the Shorts page.
2. Click `#ytm-rail-add` → `sw.evaluate` reads `yt_videos` → entry with id `SHRTTEST001`,
   `isShort: true` exists.
3. Set `yt_settings.shortsAutoScroll = true` via storage → rail auto-scroll button gains
   `.ytm-on` (event-driven, no polling).
4. Navigate the tab (same tab) to a routed fake `/watch?v=...` page → rail removed.

**G. Console errors:** register the `watchConsole` pattern from `test-extension.js` on every
page opened; final check `errors.length === 0`.

### Existing file changes
- `tests/test-extension.js`: two presence checks (Section 4.7) — keeps the smoke suite
  authoritative for "panel renders".

### Headed / live-only verification (manual, `--headed`, real youtube.com — pattern of
`tests/test-panel-live.js`)
These cannot be proven against routed fake pages:
1. **Native key audit:** on a real Short, confirm Left/Right do nothing natively (devtools:
   no seek before installing), then with the extension confirm ±5 s scrub and that Up/Down/
   Space/K/M still work (we only swallow Left/Right outside inputs).
2. **Nav selector:** confirm `#navigation-button-down button` exists on current YouTube and
   `.click()` advances the feed (auto-scroll end-to-end on a real looping Short).
3. **Auto-close on a real Short** (real loop boundary timing).
4. **Panel iframe playback:** embed actually autoplays with audio inside the side panel
   (real `chrome.sidePanel`, not a page-mode panel); jsapi `ended` → auto-advance + watched
   flag.
5. **Embed-disabled Short:** open a known embed-disabled Short in the panel → error card.
6. **Rail aesthetics:** no overlap with YouTube chrome at 1280–2560 px widths; hidden in
   fullscreen; readable on light Shorts frames.

---

## 7. Risks & explicitly out-of-scope

**Risks**
1. **YouTube DOM/selector churn** (`#navigation-button-down`, `button[aria-label="Next video"]`):
   auto-scroll silently degrades to the untrusted-key fallback, which YouTube may ignore.
   Mitigation: selector pinned by headed test; failure mode is "nothing happens", never a crash.
2. **Embed restrictions:** a large share of Shorts (music content especially) disable
   embedding — the panel player will show the error card often. This is a platform limit;
   the pre-flight + Open-in-tab keeps UX honest.
3. **jsapi postMessage protocol is undocumented:** ended-detection/auto-advance in the panel
   player may break without notice; designed fail-soft (manual prev/next always works).
4. **Capture-phase Left/Right swallow** could mask a *future* native Shorts binding.
5. **`isTrusted:false` events:** any path relying on synthetic keyboard input is best-effort
   only; primary paths use element `.click()` which YouTube handles.
6. **Headless media timing:** loop-boundary tests depend on muted autoplay of a data-URI WebM
   in headless Chromium — known to work, but flaky CI would move tests B/C to the headed set.
7. **`isShorts` reflects the displayed tab** (GET_MEDIA_STATE priority: active-playing →
   last-playing → 10 s scan), which can differ from the focused tab when the focused Shorts
   tab is paused and another tab is playing. Accepted: the strip always matches the tab the
   panel's now-playing card controls, which is the consistent mental model.
8. **Auto-close closing the window** when the Short is the last tab — accepted (decision #7).

**Explicitly out-of-scope (platform-impossible, with closest achievable alternative)**
- **Watch-time tracking / 20%-watched rule / progress bar for the in-panel player:** the
  embed iframe is cross-origin; we cannot read `currentTime`. Closest: jsapi bridge marks
  watched on `ended` only.
- **Loading the official YouTube IFrame API in the panel:** blocked by extension-page CSP
  (`script-src 'self'`, no remote code in MV3). Closest: the raw postMessage handshake above.
- **Trusted keyboard/scroll injection into YouTube** (e.g. truly emulating ArrowDown):
  extensions cannot produce trusted input events; `chrome.debugger` could, but attaching the
  debugger banner to the user's tab is unacceptable UX. Closest: clicking YouTube's own
  navigation button.
- **Embedding the real `youtube.com/shorts/...` page in the panel:** watch/shorts pages send
  `X-Frame-Options: SAMEORIGIN`; MV3 cannot strip response headers for frames via
  `declarativeNetRequest` reliably for this case and it would be hostile anyway. Closest:
  `/embed/<id>` endpoint (designed for framing).
- **Auto-scrolling the *page feed* from the panel player:** the panel player and the tab feed
  are independent surfaces by design; "next" in the panel walks the extension's own Shorts
  queue, not YouTube's feed.
- **Per-Short scrub-amount configuration, Shorts-specific volume/speed profiles:** not in
  spec; existing global volume/speed already apply to Shorts pages via the content script.
