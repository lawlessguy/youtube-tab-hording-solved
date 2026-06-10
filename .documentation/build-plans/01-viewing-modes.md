# Viewing Modes & Layout

Feature group: **viewing-modes** — two switchable viewing formats for the queue:
an in-page queue strip injected into the YouTube masthead, and a slim
(thumbnail-only) display mode for the existing side panel.

---

## 1. Scope

1. **In-page video queue (masthead strip).** The content script injects a
   horizontal, scrollable strip of queue thumbnails directly into the YouTube
   page's top bar (`ytd-masthead`), beside the search field. It lets the user
   browse and open queued videos without ever opening the extension side
   panel. It reads the queue from `chrome.storage.local` directly and
   re-renders on `chrome.storage.onChanged` (content scripts do not receive
   the worker's `VIDEOS_UPDATED` runtime broadcast). Left-click opens a video
   via `MSG.OPEN_VIDEO` (replace current YouTube tab); middle-click opens a
   background tab via `MSG.OPEN_VIDEO_NEW_TAB`. Toggleable; persisted in
   `yt_settings.inPageQueue` (default off).

2. **Slim side panel mode.** A panel-side display mode (`yt_settings.panelMode`,
   `'full' | 'slim'`, default `'full'`). In slim mode every video card renders
   as a thumbnail-only tile one thumbnail wide (160×90), all heavy controls
   collapse (toggle bar, sliders, sort/search, now-playing, watched section),
   and the virtual scroller switches to the slim card height. Toggled by a new
   header icon button; persisted via `MSG.UPDATE_SETTINGS`.

Out of scope for this group (other groups own them): resizable player, PiP,
sessions, channel filter, smart play, indicator/badge changes.

---

## 2. Clarifying questions & decisions

1. **Q: Does enabling the in-page queue close/disable the side panel ("no
   extension side panel")?**
   **A: No — they are independent toggles.** The spec means the in-page queue
   makes the panel *unnecessary*, not forbidden; programmatically disabling the
   panel per-tab would fight the user and complicate `setOptions` state.

2. **Q: Exactly where in the masthead does the strip live?**
   **A: Inside `ytd-masthead #container`, inserted as a sibling immediately
   after `#center` (the search box) and before `#end`.** This is the only
   stable flex row in the masthead; "beside the search field" maps directly to
   the slot between `#center` and `#end`.

3. **Q: Which videos appear in the strip, in what order?**
   **A: Unwatched, non-Shorts videos, sorted by the persisted
   `yt_settings.sortBy`/`sortDirection` (same comparator as the panel).**
   Shorts tiles would be visually identical but behave differently on open;
   keeping the strip to regular videos matches the panel's default tab and
   keeps the strip semantics simple.

4. **Q: How many tiles render? Virtualize?**
   **A: Hard cap of 30 tiles + a "+N" overflow pill; no virtualization.**
   30 64px tiles is a trivial DOM cost; virtualizing a horizontal masthead
   strip is not worth the complexity. The pill sends `MSG.OPEN_SIDE_PANEL`
   (which already exists) so the full queue is one click away.

5. **Q: What does left-click on a tile do?**
   **A: `MSG.OPEN_VIDEO` — replace the current YouTube tab (the existing
   "smart open"), exactly like the panel's play button.** Consistency with the
   panel's primary action; the worker already whitelists the tab so intercept
   doesn't re-capture it.

6. **Q: Middle-click?**
   **A: `MSG.OPEN_VIDEO_NEW_TAB` (background tab), with `preventDefault` on
   `mousedown`/`auxclick` to suppress autoscroll.** Mirrors the side panel
   card behavior and the worker already whitelists the new tab (intercept
   bypass).

7. **Q: Can the user remove a video from the strip?**
   **A: Yes — a small "×" button shown on tile hover sends
   `MSG.REMOVE_VIDEO`; the strip re-renders via `storage.onChanged`.** One
   queue-management affordance keeps the strip useful standalone without
   recreating the whole card UI.

8. **Q: Where is the in-page-queue toggle exposed?**
   **A: Two places: a new toggle-bar button `#tb-inpage` in the side panel
   (with `data-desc`, wired through the existing `toggleMap`) and a checkbox
   row in the popup (`#inpage-queue-toggle`).** The popup exposure is required
   because the whole point of the mode is not opening the panel; the
   toggle-bar button follows the established pattern for boolean settings.

9. **Q: How does the strip stay alive across YouTube SPA navigations and
   masthead re-renders?**
   **A: Re-ensure inside the existing throttled mutation callback
   (`scheduleIndicatorRefresh`, max once per 1.5 s).** The masthead normally
   persists across SPA navigation; when YouTube re-renders it, the existing
   MutationObserver already fires — no new observers, no polling loops.

10. **Q: Can the extension actually make the side panel as narrow as one
    thumbnail?**
    **A: No — Chrome gives extensions zero control over side panel width, and
    enforces a minimum (~360 px).** Decision: slim mode renders a fixed
    160 px-wide centered tile column and the *user* drags the panel to its
    minimum. This is the closest achievable form and is named in Risks.

11. **Q: What are the slim card dimensions, and how does the virtual scroller
    cope with two card heights?**
    **A: Tile = 160×90 thumbnail (16:9, matches `mqdefault`) + 4 px bottom
    margin → `SLIM_CARD_HEIGHT = 94`.** The scroller's literal `CARD_HEIGHT`
    usages are replaced by a `cardHeight()` function returning 63 or 94 by
    mode; `lastRenderKeys` is cleared and `scrollTop` reset on mode switch.
    The height+margin invariant is preserved per mode and documented in both
    files.

12. **Q: What collapses in slim mode, and what survives?**
    **A: Hidden: `.watch-bar`, `.toggle-bar`, `.toggle-desc`, `.controls-bar`,
    `.filter-search-bar`, `#now-playing`, the Watched section. Kept: the
    header icon buttons (mode toggle + refresh) and `.content-tabs`
    (Videos/Shorts switch).** Thumbnails-only is the spec; content-tabs must
    survive or Shorts become unreachable; pure CSS (`body.slim` class) keeps
    the JS untouched.

13. **Q: Do slim tiles keep any actions?**
    **A: Yes — the existing `.card-right` buttons (play/star/remove/watched)
    become a hover overlay over the thumbnail via CSS; the tile gets a
    `title` tooltip with the video title.** Zero new JS surface; `buildVideoItem`
    output is restyled, not rebuilt.

14. **Q: Does drag-to-reorder still work in slim mode?**
    **A: Yes, unchanged** — cards keep `draggable`, the drag-suppression flags
    and `setupDragDrop` are mode-agnostic. Only the drop indicator CSS gets a
    slim variant.

15. **Q: Any new message types or storage keys?**
    **A: No new MSG types and no new storage keys — only two new `yt_settings`
    keys.** One *behavioral* extension: the `OPEN_SIDE_PANEL` handler gains a
    `sender.tab?.id` fallback so the strip's "+N" pill (a content-script
    caller that doesn't know its own tabId) can open the panel. Smallest
    possible contract surface for reconciliation with other groups.

16. **Q: How does the strip look on YouTube's light theme?**
    **A: Theme-neutral styling: tiles are images with dark translucent
    badges/overlays (same approach as the existing `ytm-status-badge`), no
    background on the strip container itself.** Avoids theme detection
    entirely.

17. **Q: Does the strip appear on watch pages / fullscreen / music.youtube.com?**
    **A: Watch pages yes (masthead is there); fullscreen hides the masthead so
    the strip hides for free; music.youtube.com uses a different masthead tag
    so the selector simply never matches (named out of scope).** No special
    casing.

18. **Q: Does the now-playing 1.5 s poll keep running in slim mode?**
    **A: Yes — it is the one allowed poll and still drives the 20%-watched
    unpin rule; the card is merely hidden by CSS.** Stopping/starting the poll
    per mode adds states for no user-visible benefit.

---

## 3. Data & message contract

### Storage keys (new/changed)

| Key | Change | Shape |
|---|---|---|
| `yt_settings` | **two new fields** (no key change) | `{ ...existing, inPageQueue: boolean, panelMode: 'full' \| 'slim' }` |

No other storage keys are added or changed. The strip *reads* `yt_videos`
(existing shape: `{ id, url, title, channel, thumbnail, duration, addedAt,
uploadedAt, isShort, watched, starred }[]`) and never writes it directly.

### Settings keys (key=default)

- `inPageQueue=false` — masthead queue strip on/off.
- `panelMode='full'` — side panel display mode (`'full' | 'slim'`).

Both are added to `DEFAULT_SETTINGS` in `utils/constants.js` (worker) and
inlined as defaults in `sidepanel.js`, `popup.js`, and `content.js` (plain
scripts/IIFE — cannot import).

### MSG types

**New: none.** Reused as-is:

- `MSG.OPEN_VIDEO` — request `{ type, url }` → response `{ tabId, replaced }`.
- `MSG.OPEN_VIDEO_NEW_TAB` — request `{ type, url }` → response `{ tabId }`.
- `MSG.REMOVE_VIDEO` — request `{ type, videoId }` → response `{ success }`.
- `MSG.UPDATE_SETTINGS` — request `{ type, settings: Partial<Settings> }` →
  response: full merged settings object.
- `MSG.OPEN_SIDE_PANEL` — **changed (backward compatible)**: handler now uses
  `message.tabId ?? sender.tab?.id`. Request `{ type, tabId? }` → response
  `{ success }`. Existing popup callers are unaffected.

### New files

- `tests/test-viewing-modes.js` — new Playwright suite (see §6).

No new source files: the strip lives in `content/content.js` (IIFE), slim mode
in `sidepanel/sidepanel.js` + `sidepanel.css`, per the no-build/no-imports
constraints.

---

## 4. Implementation steps

Ordered; each step is independently verifiable.

### Step 1 — `utils/constants.js`

Add to `DEFAULT_SETTINGS`:

```js
inPageQueue: false,       // masthead queue strip
panelMode: 'full',        // 'full' | 'slim' side panel display mode
```

### Step 2 — `background/service-worker.js`

In `case MSG.OPEN_SIDE_PANEL`, change the guard to use a sender fallback:

```js
const tabId = message.tabId ?? sender.tab?.id;
if (tabId) {
  chrome.sidePanel.setOptions({ tabId, enabled: true, path: 'sidepanel/sidepanel.html' }).catch(() => {});
  await chrome.sidePanel.open({ tabId });
}
```

Keep the existing comment discipline: `setOptions` stays fire-and-forget; no
`await` lands between the user gesture and `open()` other than `open()` itself.
Nothing else in the worker changes (settings merge in `UPDATE_SETTINGS`
already spreads unknown keys through).

### Step 3 — `content/content.js` (in-page queue strip)

All inside the existing IIFE. New section `// --- In-Page Queue Strip ---`
placed after the thumbnail-indicators section.

**3a. Style injection** — `injectInPageQueueStyles()`, same pattern as
`injectIndicatorStyles()`, style id `ytm-inpage-queue-style`. Static CSS only
(allowed innerHTML/`textContent` on a `<style>`):

```css
#ytm-inpage-queue {
  display: flex; align-items: center; gap: 4px;
  flex: 1 1 0; min-width: 0; max-width: 40vw;
  margin: 0 8px; overflow-x: auto; overflow-y: hidden;
  scrollbar-width: thin;
}
#ytm-inpage-queue:empty { display: none; }
.ytm-ipq-item {
  position: relative; flex: 0 0 auto; width: 64px; height: 36px;
  border-radius: 4px; overflow: hidden; cursor: pointer;
}
.ytm-ipq-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ytm-ipq-item:hover { outline: 2px solid #f00; }
.ytm-ipq-remove {
  position: absolute; top: 0; right: 0; width: 14px; height: 14px;
  display: none; align-items: center; justify-content: center;
  background: rgba(0,0,0,.75); color: #fff; font-size: 10px; line-height: 1;
  border: none; cursor: pointer; border-radius: 0 0 0 4px;
}
.ytm-ipq-item:hover .ytm-ipq-remove { display: flex; }
.ytm-ipq-more {
  flex: 0 0 auto; height: 36px; padding: 0 8px; border-radius: 4px;
  border: none; cursor: pointer; font: 600 11px Roboto, Arial, sans-serif;
  background: rgba(0,0,0,.6); color: #fff;
}
```

**3b. Ensure/teardown** — `ensureInPageQueue()`:

- If `!cachedSettings?.inPageQueue`: remove `#ytm-inpage-queue` if present;
  return.
- Find host: `document.querySelector('ytd-masthead #container')`. If missing,
  return (no retry loop — the throttled mutation callback re-enters).
- If `#ytm-inpage-queue` already exists and is still connected under that
  host, return.
- Otherwise create `div#ytm-inpage-queue`, insert with
  `center.insertAdjacentElement('afterend', strip)` where
  `center = host.querySelector('#center')` (fallback: `host.appendChild`).
- Attach one `wheel` listener (`{ passive: false }`): if
  `Math.abs(e.deltaY) > Math.abs(e.deltaX)`, `e.preventDefault()` and add
  `e.deltaY` to `strip.scrollLeft`.
- Call `renderInPageQueueFrom(lastKnownVideos)`.

**3c. Data + render** — keep a module-level `let lastKnownVideos = []`.

- `refreshInPageQueue()` — `chrome.storage.local.get('yt_videos')` (guarded by
  `isContextValid()`), store into `lastKnownVideos`, call
  `renderInPageQueueFrom(lastKnownVideos)`.
- `renderInPageQueueFrom(videos)`:
  - no strip in DOM → return.
  - `const items = videos.filter(v => !v.watched && !v.isShort)` sorted with a
    local `sortVideosList(items, cachedSettings?.sortBy || 'addedAt',
    cachedSettings?.sortDirection || 'desc')` copy (same comparator as the
    worker — ~12 lines, inlined because the IIFE cannot import).
  - Clear via `strip.textContent = ''`; build the first 30 with
    `document.createElement` + `textContent` only (no innerHTML with video
    data):
    - `div.ytm-ipq-item` with `title = (v.title || 'Unknown') + ' — ' +
      (v.channel || '')`, `dataset.videoId = v.id`;
    - `img` with `src = v.thumbnail`, `alt = ''`, `loading = 'lazy'`,
      `draggable = false`;
    - `button.ytm-ipq-remove` with `textContent = '✕'`.
  - If `items.length > 30`, append `button.ytm-ipq-more` with
    `textContent = '+' + (items.length - 30)`.
- **Event delegation** (one set of listeners on the strip, attached in
  `ensureInPageQueue`, so per-item nodes carry no closures):
  - `click`: if target closest `.ytm-ipq-remove` →
    `safeSend({ type: 'REMOVE_VIDEO', videoId })`, `stopPropagation`; else if
    closest `.ytm-ipq-item` → `safeSend({ type: 'OPEN_VIDEO',
    url: 'https://www.youtube.com/watch?v=' + videoId })`; else if closest
    `.ytm-ipq-more` → `safeSend({ type: 'OPEN_SIDE_PANEL' })` (worker uses
    `sender.tab.id`).
  - `mousedown`: `if (e.button === 1) e.preventDefault()`.
  - `auxclick`: button 1 on `.ytm-ipq-item` →
    `safeSend({ type: 'OPEN_VIDEO_NEW_TAB', url: ... })`.

**3d. Wiring into existing event flow** (no new observers/polls):

- In the existing `chrome.storage.onChanged` listener:
  - `changes.yt_videos` branch: also `lastKnownVideos =
    changes.yt_videos.newValue || []` and `renderInPageQueueFrom(lastKnownVideos)`.
  - `changes.yt_settings` branch: after updating `cachedSettings`, call
    `ensureInPageQueue()` then `renderInPageQueueFrom(lastKnownVideos)`
    (handles toggle on/off and sort changes).
- In `scheduleIndicatorRefresh()`'s timeout body: add `ensureInPageQueue()`
  (re-attaches after masthead re-renders; throttled to 1.5 s already).
- In `init()`: `injectInPageQueueStyles();` then
  `getSettings().then(() => { ensureInPageQueue(); refreshInPageQueue(); });`.

### Step 4 — `sidepanel/sidepanel.html`

- In `<header>`, before `#refresh-metadata`, add:

```html
<button class="header-icon-btn" id="panel-mode-toggle" title="Toggle slim mode (thumbnails only)">
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><line x1="14" y1="5" x2="14" y2="19"/></svg>
</button>
```

- In `.toggle-bar`, after `#tb-hiderecs`, add (data-desc is mandatory):

```html
<button class="tb-btn" id="tb-inpage" data-desc="Show queue strip in the YouTube top bar">
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="6" rx="1"/><line x1="2" y1="14" x2="22" y2="14"/><line x1="2" y1="18" x2="14" y2="18"/></svg>
  <span class="tb-label">Strip</span>
</button>
```

(Toggle bar grows 6 → 7 buttons; `flex: 1` absorbs it. If labels clip at the
panel minimum width, shorten `tb-label`s — visual check in Step 8.)

### Step 5 — `sidepanel/sidepanel.js`

- Module scope: `let panelMode = 'full';` and
  `const SLIM_CARD_HEIGHT = 94; // .slim .video-item height (90) + margin (4)`.
- Add `function cardHeight() { return panelMode === 'slim' ? SLIM_CARD_HEIGHT : CARD_HEIGHT; }`
  and replace the four literal `CARD_HEIGHT` usages in `setVirtualHeight()`
  and `renderVirtualList()` with `cardHeight()`. Update the invariant comment:
  each mode's constant must equal that mode's `.video-item` height+margin.
- `toggleMap`: add `'tb-inpage': 'inPageQueue'` (the generic loop handles
  click → class toggle → `UPDATE_SETTINGS`).
- `loadSettings()`: add
  `document.getElementById('tb-inpage').classList.toggle('active', !!s.inPageQueue);`
  and `applyPanelMode(s.panelMode || 'full');`.
- New:

```js
function applyPanelMode(mode) {
  panelMode = mode === 'slim' ? 'slim' : 'full';
  document.body.classList.toggle('slim', panelMode === 'slim');
  document.getElementById('panel-mode-toggle').classList.toggle('active', panelMode === 'slim');
  lastRenderKeys.clear();
  document.querySelector('.scroll-area').scrollTop = 0;
  renderVisibleCards();
}
document.getElementById('panel-mode-toggle').addEventListener('click', () => {
  const next = panelMode === 'slim' ? 'full' : 'slim';
  applyPanelMode(next);
  msg({ type: 'UPDATE_SETTINGS', settings: { panelMode: next } });
});
```

- `buildVideoItem()`: add one line — `if (panelMode === 'slim') item.title =
  v.title || '';` (tooltip for the thumbnail-only tile). No other JS changes;
  slim rendering is pure CSS.
- `setVirtualHeight` height-reset branch stays as is (it only zeroes styles).

### Step 6 — `sidepanel/sidepanel.css`

Append a `/* --- Slim mode --- */` block:

```css
/* Header mode toggle active state */
#panel-mode-toggle.active { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }

/* Collapse controls — thumbnails only */
body.slim .watch-bar,
body.slim .toggle-bar,
body.slim .toggle-desc,
body.slim .controls-bar,
body.slim .filter-search-bar,
body.slim #now-playing,
body.slim .section { display: none !important; }

/* SLIM_CARD_HEIGHT invariant: height (90) + margin-bottom (4) = 94 */
body.slim .video-item {
  width: 164px;            /* 160 thumb + 2px border each side */
  height: 90px;
  padding: 0;
  margin: 0 auto 4px;
  border-radius: 6px;
}
body.slim .thumb-wrap,
body.slim .video-thumb { width: 160px; height: 86px; }
body.slim .video-thumb { border-radius: 5px; }
body.slim .video-info { display: none; }
body.slim .card-right {
  position: absolute; inset: 0;
  flex-direction: row; gap: 6px;
  background: rgba(0,0,0,0.55);
  opacity: 0; transition: opacity 0.15s;
}
body.slim .video-item:hover .card-right { opacity: 1; }
body.slim .video-item.drag-over { border-top: 2px solid var(--accent); }
body.slim .content-tab { padding: 4px 0; font-size: 11px; }
```

(86 px thumb inside a 90 px bordered card keeps the 16:9 feel while the math
stays exact: 2 px top/bottom border + 86 = 90. If design review prefers true
160×90 imagery, bump `SLIM_CARD_HEIGHT` and the CSS together — they are the
single coupled pair.)

### Step 7 — `popup/popup.html`, `popup/popup.js`, `popup/popup.css`

- `popup.html`: above the `#open-sidepanel` button add:

```html
<label class="toggle-row" id="inpage-queue-row">
  <span class="control-label">In-page queue strip</span>
  <input type="checkbox" id="inpage-queue-toggle">
</label>
```

- `popup.css`: `.toggle-row { display:flex; align-items:center;
  justify-content:space-between; padding:6px 0; cursor:pointer; }` (match
  existing dark-theme vars). Keep the native checkbox visible (no hidden
  custom toggle) so Playwright can click it without `{ force: true }`.
- `popup.js`: in the existing settings-load path set
  `inpage-queue-toggle.checked = !!settings.inPageQueue`; on `change` send
  `chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings:
  { inPageQueue: e.target.checked } })`. (Content scripts pick it up via
  `storage.onChanged` — no broadcast needed.)

### Step 8 — Tests (see §6) + `package.json`

- New `tests/test-viewing-modes.js`; add script `"test:modes": "node
  tests/test-viewing-modes.js"` and append `&& node tests/test-viewing-modes.js`
  to `test:all`.
- Extend `tests/test-extension.js` Test 2/1 with presence checks (below).
- Visual check: run `npm run test:debug`, confirm 7 toggle-bar buttons fit at
  minimum panel width and slim tiles center correctly; screenshots land in
  `screenshots/`.

---

## 5. Edge cases & failure modes

| Case | Handling |
|---|---|
| Masthead not found (`ytd-masthead #container` missing — embeds, music.youtube.com, layout experiment) | `ensureInPageQueue()` returns silently; the throttled mutation callback retries naturally. No error, no loop. |
| YouTube re-renders/replaces the masthead (SPA nav, A/B swap) | Strip node becomes disconnected; `ensureInPageQueue()` (called from the existing 1.5 s-throttled mutation callback) detects `!strip.isConnected` and re-inserts + re-renders. |
| Extension reloaded while page open (context invalidated) | All sends go through existing `safeSend()`; `isContextValid()` guards storage reads. Strip stops updating but never throws. |
| Queue empty / all watched / only Shorts | Strip renders zero items; `#ytm-inpage-queue:empty { display:none }` hides it entirely — masthead unchanged. |
| Very narrow window | `max-width: 40vw; min-width: 0` lets the strip shrink to nothing before it crushes the search box; contents scroll horizontally. |
| Fullscreen video | YouTube hides the masthead; strip hides with it. No handling needed. |
| User left-clicks a tile while watching a video in that tab | `OPEN_VIDEO` replaces the tab (panel parity). The leaving video's 20% rule has already fired from the content script if applicable; worker whitelists the tab so intercept doesn't re-capture. |
| Middle-click autoscroll | `mousedown` button-1 `preventDefault()` (same trick as the panel cards). |
| `+N` pill clicked but Chrome doesn't honor the relayed gesture | `sidePanel.open()` rejects; handler's error path returns `{ error }`; pill click is a silent no-op. Acceptable degraded behavior (documented in Risks). |
| Storage burst (Collect drains 50 logged videos → many `yt_videos` writes) | Each `onChanged` re-render rebuilds ≤31 nodes — cheap. If profiling shows churn, reuse `scheduleIndicatorRefresh`'s throttle; not pre-optimized. |
| Slim toggle while scrolled deep in the list | `applyPanelMode` clears `lastRenderKeys` and resets `scrollTop` to 0 — no misaligned virtual window from the height change. |
| Slim toggle mid-drag | Mode toggle triggers `renderVisibleCards()`, which defers via the existing `dragInProgress`/`renderPendingAfterDrag` flags — drop survives. |
| Panel opened with `panelMode:'slim'` persisted | `loadSettings()` calls `applyPanelMode('slim')` before the first paint settles; initial `loadVideos()` (already queued) renders with slim heights since `cardHeight()` reads the module flag. |
| Two panel windows / panel + popup changing settings | All writes go through `MSG.UPDATE_SETTINGS` → `storage.update()` mutex; last write wins, content scripts converge via `onChanged`. |
| `yt_settings` missing keys (pre-upgrade profile) | All readers default: `!!s.inPageQueue` → false, `s.panelMode || 'full'` → full. `UPDATE_SETTINGS` spread-merges, so old objects gain keys on first toggle. |
| Hostile lookalike host | Strip only ever runs where the manifest injects the content script (`*://*.youtube.com/*`); all tab-side URL decisions stay in the worker behind `isYouTubeHost()`. The strip builds URLs itself only from stored 11-char video ids. |

---

## 6. Test plan

### New file: `tests/test-viewing-modes.js` (headless, follows the established harness: `launchPersistentContext('', { channel: 'chromium', args: [--disable-extensions-except, --load-extension] })`, `check()` counter, exit code)

**Part A — in-page queue strip (deterministic fake masthead page).**
Route `https://www.youtube.com/__masthead_test__` via `context.route()` to:

```html
<ytd-masthead><div id="container">
  <div id="start"></div><div id="center"><input id="search"></div><div id="end"></div>
</div></ytd-masthead>
```

Also route `https://www.youtube.com/watch?v=*` to a stub page (`<html>watch</html>`)
so click-navigation is assertable offline.

1. With `inPageQueue` unset (default) → after 2.5 s, assert no
   `#ytm-inpage-queue` exists. *(default-off)*
2. `sw.evaluate` set `yt_settings { ...defaults, inPageQueue: true }` → wait
   3 s (onChanged + 1.5 s throttle) → assert strip exists, is the next element
   sibling of `#center`, and is `:empty`-hidden (no videos yet).
3. `sw.evaluate` set `yt_videos` with 2 unwatched regular videos, 1 watched,
   1 short → assert exactly 2 `.ytm-ipq-item`, in `sortBy:'addedAt' desc`
   order (compare `dataset.videoId`), each with non-empty `title` attr.
4. Set 35 unwatched videos → assert 30 tiles + `.ytm-ipq-more` with text `+5`.
5. Click the first tile (`page.click`) → `page.waitForURL('**/watch?v=*')`;
   assert the *same tab* navigated (OPEN_VIDEO replace path) and
   `sw.evaluate(chrome.tabs.query)` shows no extra tab.
6. Middle-click a tile (`page.click(sel, { button: 'middle' })`) → poll
   `sw.evaluate(chrome.tabs.query({ url: '*://www.youtube.com/watch*' }))`
   until a new *inactive* tab exists.
7. Hover tile → click `.ytm-ipq-remove` → assert `yt_videos` in storage lost
   that id and the tile count dropped (via onChanged re-render).
8. Set `inPageQueue: false` → assert strip removed from DOM.

**Part B — slim panel mode (extension page).**
Open `chrome-extension://<id>/sidepanel/sidepanel.html`, seed ~40 videos via
`sw.evaluate` storage write.

1. Assert `#panel-mode-toggle` exists; `body.slim` absent; a `.video-item`
   bounding-box height is 59 and `#video-list` style height = count×63.
2. Click `#panel-mode-toggle` → assert `body` has class `slim`;
   `.toggle-bar`, `.controls-bar`, `.filter-search-bar`, `#now-playing` are
   not visible (`offsetParent === null`); `#video-list` height = count×94;
   a rendered `.video-item` height is 90 and `.video-info` hidden.
3. Scroll `.scroll-area` to bottom → assert the last video id is rendered and
   total mounted `.video-item` count is bounded (window+buffer), i.e. virtual
   scroll still works at the slim height.
4. Persistence: read `yt_settings.panelMode === 'slim'` from storage; open a
   *second* sidepanel page → assert it loads with `body.slim` already applied.
5. Toggle back to full → `body.slim` removed, heights back to 63/59.

**Part C — settings round-trip.**
From the panel page click `#tb-inpage` → assert `yt_settings.inPageQueue`
flips in storage and the button gains `.active`. From the popup page check
`#inpage-queue-toggle` reflects it and unchecking flips storage back.

### Edits to existing suites

- `tests/test-extension.js` — Test 1 (popup): add
  `check('In-page queue toggle present', !!(await popup.$('#inpage-queue-toggle')))`.
  Test 2 (side panel): add checks for `#panel-mode-toggle` and `#tb-inpage`,
  and `check('tb-inpage has data-desc', ...)` reading the attribute. The
  existing Test 7 console-error sweep automatically covers the new code paths.
- `tests/test-virtual-scroll.js` — add one slim-mode case if the suite
  structure allows (toggle slim, assert spacer math at 94); otherwise Part B.3
  covers it.

### Headed/live only (manual, like `test-panel-live.js` / `test-indicators.js`)

- Real masthead injection: position beside the real search field across
  YouTube layouts (home, watch, search results), light + dark theme, window
  resize behavior, wheel-to-horizontal scrolling feel. Run via a new optional
  `node tests/test-viewing-modes.js --headed --keep-open` mode or by visiting
  youtube.com in `npm run test:debug`'s browser.
- The `+N` pill → side panel open (user-gesture relay can't be trusted
  headless; `test-panel-gesture.js` shows the pattern if we later automate it).
- Slim mode at Chrome's true minimum panel width (panel width is not
  scriptable; drag manually and confirm the 164 px column fits/centers).

---

## 7. Risks & explicitly out-of-scope

**Risks**

1. **Side panel width is not programmable (platform limit).** Chrome offers no
   API to set or read side panel width, and enforces a browser-defined minimum
   (~360 px). "Panel width equals a single thumbnail" is therefore not literally
   achievable. **Closest alternative (planned):** slim mode renders a fixed
   164 px tile column, centered, so the user can drag the panel to Chrome's
   minimum and see a clean single-thumbnail rail with no horizontal waste.
2. **Masthead DOM is unversioned.** `ytd-masthead #container` / `#center` can
   change in a YouTube experiment. Mitigation: feature no-ops when selectors
   miss, re-ensures on the existing throttled mutation hook, and never throws;
   selector documented in one place.
3. **Gesture relay for the `+N` pill.** `sidePanel.open()` from a
   content-script-initiated message is supported (Chrome ≥116) but
   gesture-fragile; if Chrome rejects it, the pill is a no-op. Fallback is
   acceptable (strip still fully usable); we will not add retry hacks.
4. **Two-height virtual scroller.** `CARD_HEIGHT`/`SLIM_CARD_HEIGHT` must each
   match their CSS exactly; a drift breaks hit-testing/spacers. Mitigation:
   `cardHeight()` is the only access point, invariant comments sit beside both
   the JS constants and the CSS block, and Part B.2/B.3 tests assert the math.
5. **Toggle-bar crowding.** A 7th button shrinks each flex cell ~14%; labels
   may clip at minimum panel width. Checked headed; fallback is shortening
   labels (CSS-only).
6. **Masthead vs. search-box space contention** on narrow windows — bounded by
   `max-width: 40vw; min-width: 0`, verified headed.

**Explicitly out of scope**

- music.youtube.com strip support (different masthead custom element).
- Auto-closing/disabling the side panel when the in-page queue is enabled
  (modes are independent by decision #1).
- Virtualizing or drag-reordering the masthead strip (cap + overflow pill
  instead).
- Shorts tiles in the masthead strip (regular videos only, decision #3).
- Programmatic panel resizing (impossible — see risk #1) and any
  `chrome.windows`-based fake "narrow panel window" workaround (rejected:
  conflicts with the side-panel architecture and tab-tracking invariants).
- Slim-mode redesign of the now-playing card (hidden in slim; revisit only if
  daily use demands it).
