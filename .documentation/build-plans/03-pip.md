# Picture in Picture

Feature group: auto-PiP on tab switch, floating-player transparency slider, and quick
size/position presets. Planned against verified Chrome platform behavior (June 2026,
stable Chrome ≥ 142).

**Platform facts this plan is built on (research-verified):**

1. `video.requestPictureInPicture()` and `documentPictureInPicture.requestWindow()` both
   require transient user activation; calling them from `visibilitychange` or any
   non-gesture context rejects with `NotAllowedError`.
2. **Exception:** Chrome invokes a registered MediaSession
   `navigator.mediaSession.setActionHandler('enterpictureinpicture', cb)` callback
   *without* a gesture when the user switches tabs away from eligible playing media, and
   the callback is allowed to open video PiP **or** Document PiP gesture-free. Shipped for
   media-playback sites in Chrome 134 (Chrome 120 for camera/mic apps). Eligibility is
   Chrome-gated: top-frame media, audible within last 2 s, has audio focus, playing,
   Safe-Browsing-clean URL, and the user's **Media Engagement Index** threshold exceeded.
   Since Chrome 142, Chrome can also auto-PiP *browser-initiated* (no handler) on sites
   like YouTube, showing a one-time permission prompt; a registered handler **takes
   precedence** over the browser-initiated transition.
3. The **classic** PiP window cannot be styled, moved, resized, or made transparent by the
   page. Transparency/size/position presets are impossible there.
4. **Document Picture-in-Picture** (Chrome 116+) gives an always-on-top window whose DOM
   and CSS we fully control: an opacity slider dimming the *content* works; `width`/`height`
   can be set at open time via `requestWindow({width, height})` (Chrome may clamp);
   `resizeTo()/resizeBy()` work only with a transient activation *inside the PiP window*
   (one resize per activation); **window position can never be set programmatically**
   (Chrome remembers the user's last drag position). The window auto-closes when the
   opener document unloads (tab close / full navigation). At most one Document PiP window
   exists browser-wide — opening a second closes the first.
5. **Gesture propagation through extensions (proof: Google's own MV3
   "Picture-in-Picture Extension", GoogleChromeLabs):** a user gesture on extension UI
   (action click — and by the same mechanism, a click inside our side panel page) carries
   user activation into a script injected with `chrome.scripting.executeScript`, where
   `requestPictureInPicture()` succeeds. Their auto-PiP also registers the
   `enterpictureinpicture` handler from a plain **isolated-world content script** —
   confirming MediaSession registration works from our content script.
6. **Move-back-on-close pattern** (Chrome Document-PiP docs): append the player element to
   `pipWindow.document.body`, listen for `pagehide` on the PiP window, and re-insert the
   element at its original DOM position. For YouTube specifically, move the whole
   `#movie_player` container (never the bare `<video>` — YouTube's controls/layout live on
   the container) and dispatch `window.dispatchEvent(new Event('resize'))` on the *main*
   window after every move/resize so YouTube re-measures its player.

---

## 1. Scope

Restated precisely, with the platform-honest interpretation:

1. **Auto-PiP** — When the tab whose video is playing loses focus (user switches to
   another tab), the video pops into a picture-in-picture window automatically. Achieved
   by registering the MediaSession `enterpictureinpicture` action handler from the content
   script (opt-in toggle). Chrome decides final eligibility (Media Engagement Index +
   per-site "Automatically enter picture-in-picture" permission). Triggering on window
   minimize or OS-level occlusion is **not controllable by us** — Chrome 142+ may do it
   natively (`contentoccluded` reason), and we inherit whatever Chrome offers. Auto-PiP
   opens the **classic** video PiP window (zero-risk to the page; see Q2).
2. **Transparency slider** — A 30–100 % opacity slider for the **floating player**
   (Document PiP window content). Lives in the side panel controls area and is mirrored
   inside the floating window's own control strip. Hovering the floating window always
   restores full opacity. True OS-window transparency is impossible (named out-of-scope).
3. **Preset size buttons** — S / M / L (320×180, 480×270, 640×360) presets. From the side
   panel they set the size used **at open time**; inside the floating window's strip they
   resize the live window (gesture-legal there). **Position presets are
   platform-impossible** and out of scope; the documented alternative is that Chrome
   remembers the last position the user dragged the PiP window to.
4. **Floating player ("Float")** — the carrier feature for 2 & 3: a button on the
   now-playing card opens a Document-PiP floating player for the displayed tab by moving
   `#movie_player` into the PiP window, with a control strip (opacity, S/M/L, restore),
   and moves it back intact on close.

## 2. Clarifying questions & decisions

1. **Q: "Not open / visible on screen" — does auto-PiP cover window minimize and app
   occlusion, or only tab switches?**
   **A:** Tab-switch is what the web platform exposes (`enterpictureinpicture` handler
   invocation); minimize/occlusion triggers are Chrome-internal (142+ browser-initiated)
   and not scriptable.
   *Rationale: no API exists for occlusion-triggered PiP from a page/extension; promising
   it would be dishonest.*

2. **Q: Should auto-PiP open the classic video PiP or our Document-PiP floating player?**
   **A:** Classic video PiP (`video.requestPictureInPicture()`), exactly Google's
   reference pattern.
   *Rationale: auto-entry must never risk breaking the page; DOM surgery (moving
   `#movie_player`) belongs behind an explicit user action only.*

3. **Q: Default state of the auto-PiP toggle?**
   **A:** Off (`pipAutoEnabled: false`).
   *Rationale: first auto-entry triggers a Chrome permission prompt and depends on MEI;
   opt-in matches the extension's other off-by-default page-mutating toggles.*

4. **Q: Is the transparency real window transparency?**
   **A:** No — CSS opacity on the floating window's content (video dims toward the
   window's dark `#0f0f0f` background), floor 30 % so the window can't become invisible;
   hover restores 100 %.
   *Rationale: platform limit; content dimming is the closest achievable and hover-restore
   keeps it usable.*

5. **Q: Where do the opacity slider and size presets live?**
   **A:** Both places: a third compact `.ctrl-row` in the side panel `.controls-bar`
   (persists defaults; opacity applies live to an open window via `storage.onChanged`),
   and mirrored controls in the floating window's hover strip (where `resizeTo()` is
   gesture-legal).
   *Rationale: panel-only size buttons could not resize an open window (gesture must be in
   the PiP window) — mirroring is the only way "quickly set size" works live.*

6. **Q: Which sizes?**
   **A:** S 320×180, M 480×270, L 640×360 (16:9, matches YouTube thumbnails/players);
   Chrome may clamp — accept clamped values silently.
   *Rationale: three is enough for "quick presets"; arbitrary sizing already exists by
   dragging the window edge.*

7. **Q: Which tab does the Float button target?**
   **A:** `lastMediaState.tabId` — the tab the now-playing card is displaying (same
   routing fix as media controls, H2 in PROGRESS.md). Button only exists on the
   now-playing card, which only renders when a `videoId`/`tabId` is known.
   *Rationale: consistency with the established "control the displayed tab, not the active
   tab" invariant.*

8. **Q: How does a side-panel click satisfy the page's user-activation requirement?**
   **A:** The click handler calls `chrome.scripting.executeScript` **synchronously** (no
   awaits before it — same discipline as the `sidePanel.open()` gotcha); activation
   propagates into the injected function (Google PiP extension proof), which calls
   `window.__ytmTogglePip(opts)` — a function content.js exposes on the shared
   isolated-world global.
   *Rationale: proven mechanism; routing through the worker adds an unverified
   gesture-preservation hop for zero benefit, and the panel already holds the manifest's
   `scripting` permission and tabId.*

9. **Q: Shorts pages?**
   **A:** Float falls back to classic video PiP on `/shorts/` URLs (no strip, no opacity).
   *Rationale: the Shorts player DOM (`#shorts-player`) differs structurally; moving it is
   high-breakage/low-value. Classic PiP still gives the floating video.*

10. **Q: What happens to the queue's media controls / watch-time tracking while the
    player is floated?**
    **A:** They keep working: `getVideoElement()` is extended to also search the open PiP
    window's document. Volume/speed/play-pause/skip and the 1 s watch tick all operate on
    the floated `<video>`.
    *Rationale: the video element merely changed documents; all messaging still lands in
    the same content script.*

11. **Q: Interaction with the >100 % volume-boost `GainNode` chain?**
    **A:** If `audioContext` already exists for the page (boost was ever engaged), Float
    uses **classic PiP** instead of Document PiP; while a Document PiP is open, `setVolume`
    clamps boost requests to 100 % (no `initAudioBoost` on a cross-document element).
    *Rationale: a `MediaElementAudioSourceNode` belongs to the opener document's
    AudioContext; adopting the element into another document risks silencing audio
    (the same class of bug as the H1 mute fix). Avoid, don't gamble.*

12. **Q: What if YouTube SPA-navigates while the player is floated?**
    **A:** The content script's existing URL-change MutationObserver closes the Document
    PiP (restore runs via `pagehide`). Skip/autoplay-next use `chrome.tabs.update` (full
    navigation), which auto-closes the PiP window anyway.
    *Rationale: simplest behavior that can never strand a moved player; user re-floats in
    one click.*

13. **Q: Persisted where?**
    **A:** All three knobs in `yt_settings` (`pipAutoEnabled`, `pipOpacity`, `pipSize`) via
    the existing `UPDATE_SETTINGS` handler and `storage.update()` mutex; all surfaces sync
    via `storage.onChanged`. No new storage keys.
    *Rationale: matches every existing toggle; event-driven, no polling.*

14. **Q: Popup parity?**
    **A:** No popup changes. PiP is queue-centric; the side panel is its home.
    *Rationale: scope discipline; popup is a stats/slider surface.*

15. **Q: How does the panel know PiP is active (button state)?**
    **A:** The content script's `GET_MEDIA_STATE` response gains `pipActive` and
    `docPipSupported`; this rides the existing, explicitly-allowed 1.5 s panel poll. No
    new polling, no new broadcast.
    *Rationale: the data already flows on that channel every 1.5 s.*

16. **Q: Old Chrome / unsupported contexts?**
    **A:** Feature-detect everything: `setActionHandler('enterpictureinpicture')` wrapped
    in try/catch (throws `TypeError` on pre-134); `window.documentPictureInPicture`
    undefined → classic fallback; `requestPictureInPicture` rejection → caught warn.
    Panel pip-row controls get `disabled` + explanatory `title` when the displayed tab
    reports `docPipSupported: false`.
    *Rationale: graceful degradation everywhere, never a thrown error in console (tests
    assert zero console errors).*

## 3. Data & message contract

### Storage keys

No new top-level keys. One changed value shape:

- **`yt_settings`** (existing, `STORAGE_KEYS.SETTINGS`) gains three fields:
  ```js
  {
    ...existing fields,
    pipAutoEnabled: false,   // boolean — register enterpictureinpicture handler
    pipOpacity: 100,         // integer 30–100, floating-player content opacity %
    pipSize: 'medium',       // 'small' | 'medium' | 'large' — Document PiP open size
  }
  ```

### Settings keys (new, with defaults)

| key | default | meaning |
|---|---|---|
| `pipAutoEnabled` | `false` | auto-PiP on tab switch (MediaSession handler registered) |
| `pipOpacity` | `100` | floating player content opacity, 30–100 |
| `pipSize` | `'medium'` | floating player preset size at open |

### MSG types

**No new `MSG.*` constants.** Two *changed shapes* (must be reconciled with other groups):

- **`MSG.GET_MEDIA_STATE`** — content-script response (and therefore the worker's
  passthrough, which spreads `{...state, tabId}`) gains:
  ```js
  {
    paused, currentTime, duration, videoId,        // existing
    pipActive: boolean,        // classic PiP element OR our Document PiP window open
    docPipSupported: boolean,  // typeof window.documentPictureInPicture !== 'undefined'
  }
  ```
  Worker code change required: **none** (it already spreads the state object).
- **`MSG.MEDIA_COMMAND`** — `action` enum gains `'exitPip'` (closes Document PiP if open,
  else `document.exitPictureInPicture()`; responds `{ success: true }`, no-op-safe). The
  side panel reaches it through the existing `MSG.MEDIA_CONTROL` → worker →
  `MSG.MEDIA_COMMAND` forwarding path. Worker code change required: **none** (action is
  passed through verbatim).

Reused as-is: `MSG.UPDATE_SETTINGS` (panel controls and the PiP-window strip both persist
through it), `MSG.GET_SETTINGS`.

### Isolated-world function contract (content.js global, not a message)

- `window.__ytmTogglePip(opts)` — defined by content.js inside its IIFE on the
  isolated-world global; called by the panel-injected trigger (same isolated world).
  `opts = { opacity: number, size: 'small'|'medium'|'large' }`. Opens Document PiP
  (or classic fallback per Q9/Q11/Q16); if already open, closes it. Must be invoked
  while transient activation is live.

### Manifest

No changes. (`scripting`, `*://*.youtube.com/*` host permission, and the content script
registration already cover everything.)

### New files

- `tests/test-pip.js` — headless contract/UI suite (added to `npm run test:all` chain).
- `tests/test-pip-live.js` — manual headed verification (same role as `test-panel-live.js`).

No new source files: PiP logic lives in `content/content.js` (the single IIFE content
script, per architecture) and `sidepanel/sidepanel.{html,css,js}`.

## 4. Implementation steps

Implement in this order. **Step 0 is a deliberate spike**: the two empirical risks
(Document-PiP availability in the isolated world; gesture propagation from a side-panel
click) are each verifiable in minutes on a real YouTube tab before investing in polish.

### Step 0 — Live spike (throwaway, headed)

In a headed run with the extension loaded, on a real watch page, from the panel inject
`func: () => typeof window.documentPictureInPicture` and log. Then wire a temporary panel
button that injects `documentPictureInPicture.requestWindow({width:320,height:180}).then(w => w.close())`.
Confirms: (a) API exists in isolated world, (b) activation propagates. If (a) fails, the
trigger and the whole `__ytmTogglePip` body move to `world: 'MAIN'` injection with
`window.postMessage` back to content.js for settings persistence — note this in the code
if taken; the rest of the plan is unchanged.

### Step 1 — `utils/constants.js`

Add to `DEFAULT_SETTINGS`:

```js
  pipAutoEnabled: false,
  pipOpacity: 100,
  pipSize: 'medium',
```

(`MSG` unchanged.)

### Step 2 — `content/content.js` (new "Picture in Picture" section, after the
Message Listener section)

State (module scope inside the IIFE):

```js
let docPipWindow = null;          // Document PiP Window object, or null
let pipOriginalParent = null;     // restore anchor (same pattern as comments-move)
let pipOriginalNextSibling = null;
let pipPlaceholder = null;
const PIP_SIZES = { small: [320, 180], medium: [480, 270], large: [640, 360] };
```

Functions:

- `getPlayerContainer()` — `document.getElementById('movie_player')`; returns null on
  shorts/non-watch pages.
- **Change `getVideoElement()`** to:
  ```js
  function getVideoElement() {
    if (docPipWindow) {
      const v = docPipWindow.document.querySelector('video');
      if (v) return v;
    }
    return document.querySelector('video');
  }
  ```
  This single change keeps volume/speed/media-commands/watch-tracking working while
  floated.
- **Guard `initAudioBoost`/`setVolume`**: in `setVolume`, if `docPipWindow` and
  `percent > 100`, clamp to 100 (`percent = 100`) before proceeding (no boost init on a
  cross-document element — Q11).
- `openClassicPip()` — `const v = getVideoElement(); if (v) v.requestPictureInPicture().catch(() => {});`
  plus a one-time `leavepictureinpicture` listener (no state needed beyond
  `document.pictureInPictureElement` checks).
- `async openDocPip(opts)`:
  1. Bail to `openClassicPip()` when: `!window.documentPictureInPicture`, or
     `audioContext !== null` (boost engaged, Q11), or URL matches `/shorts/`, or
     `!getPlayerContainer()`.
  2. `if (document.fullscreenElement) document.exitFullscreen().catch(() => {});`
     (fire-and-forget, do not await — activation must not be spent waiting).
  3. `const [w, h] = PIP_SIZES[opts.size] || PIP_SIZES.medium;`
     `docPipWindow = await window.documentPictureInPicture.requestWindow({ width: w, height: h });`
     Wrap the await in try/catch → on `NotAllowedError`/anything, `docPipWindow = null`,
     `console.warn('[YT Tab Manager] PiP open failed:', e)` and return.
  4. Save `pipOriginalParent = player.parentElement`,
     `pipOriginalNextSibling = player.nextSibling`.
  5. Build PiP document: `<style>` element with a **static** CSS string (static
     `textContent`, no user data):
     ```css
     body { margin:0; background:#0f0f0f; overflow:hidden;
            font-family:'Segoe UI',system-ui,sans-serif; }
     .ytm-pip-wrap { position:fixed; inset:0; opacity:var(--ytm-pip-op,1);
                     transition:opacity .2s; }
     .ytm-pip-wrap:hover { opacity:1 !important; }
     #movie_player { width:100% !important; height:100% !important; }
     #movie_player video { width:100% !important; height:100% !important; }
     .ytm-pip-strip { position:fixed; left:0; right:0; bottom:0; display:flex;
                      align-items:center; gap:8px; padding:6px 10px;
                      background:rgba(15,15,15,.92); opacity:0;
                      transition:opacity .2s; z-index:9999; }
     body:hover .ytm-pip-strip { opacity:1; }
     .ytm-pip-strip input[type=range] { flex:1; }
     .ytm-pip-strip button { background:#1a1a1a; border:1px solid #2a2a2a;
                             color:#aaa; border-radius:4px; padding:2px 8px;
                             font-size:11px; cursor:pointer; }
     .ytm-pip-strip button:hover { color:#f1f1f1; border-color:#555; }
     ```
  6. Create `.ytm-pip-wrap` div (via `docPipWindow.document.createElement`), append the
     `#movie_player` element into it, append wrap to `docPipWindow.document.body`. Set
     `docPipWindow.document.documentElement.style.setProperty('--ytm-pip-op', String((opts.opacity ?? 100) / 100))`.
  7. Build `.ytm-pip-strip` (all `createElement`/`textContent` — no innerHTML with
     anything dynamic): range input `min=30 max=100 step=5 value=opts.opacity`; three
     buttons `S` `M` `L`; one button `↩` (restore). Listeners:
     - range `input` → set `--ytm-pip-op`; debounce 300 ms →
       `safeSend({ type: 'UPDATE_SETTINGS', settings: { pipOpacity: Number(value) } })`.
     - S/M/L `click` → `docPipWindow.resizeTo(w, h)` (gesture is in the PiP window —
       legal) + `safeSend(UPDATE_SETTINGS, { pipSize })`.
     - `↩` `click` → `docPipWindow.close()`.
  8. Insert placeholder into the main page at the player's old spot:
     `pipPlaceholder = document.createElement('div')`, class `ytm-pip-placeholder`,
     `textContent = 'Playing in floating window — click to restore'`, click →
     `docPipWindow?.close()`. Style via a static injected `<style>` (id
     `ytm-pip-page-style`): dark card, 100 % width, `aspect-ratio:16/9`, centered text.
  9. `docPipWindow.addEventListener('pagehide', restorePipPlayer)` and
     `docPipWindow.addEventListener('resize', () => window.dispatchEvent(new Event('resize')))`.
  10. `window.dispatchEvent(new Event('resize'))` so YouTube re-measures.
- `restorePipPlayer()` (runs on `pagehide`, i.e. every close path):
  re-insert the player at `pipOriginalParent`/`pipOriginalNextSibling` (exact pattern of
  the existing `restoreLayout()` comments logic), remove `pipPlaceholder`, null out all
  pip state, `window.dispatchEvent(new Event('resize'))`. Wrapped in try/catch — it can
  run while the opener document is itself unloading.
- `closeDocPip()` — `if (docPipWindow) docPipWindow.close();` (close triggers `pagehide`
  → restore; no gesture required to close).
- `togglePip(opts)` / `window.__ytmTogglePip = togglePip`:
  ```js
  function togglePip(opts = {}) {
    if (docPipWindow) { closeDocPip(); return; }
    if (document.pictureInPictureElement) { document.exitPictureInPicture().catch(() => {}); return; }
    openDocPip(opts);
  }
  ```
- `syncAutoPip(settings)`:
  ```js
  function syncAutoPip(settings) {
    try {
      if (settings?.pipAutoEnabled) {
        navigator.mediaSession.setActionHandler('enterpictureinpicture', async () => {
          const video = getVideoElement();
          if (video && !document.pictureInPictureElement) {
            await video.requestPictureInPicture();   // gesture-free here by spec
          }
        });
      } else {
        navigator.mediaSession.setActionHandler('enterpictureinpicture', null);
      }
    } catch {} // TypeError on Chrome < 134 (unknown action) — degrade silently
  }
  ```
  Call sites: `init()` (`getSettings().then(syncAutoPip)`), the existing
  `storage.onChanged` `yt_settings` branch, and `bindVideoFeatures()` (re-asserts our
  handler after each SPA navigation in case YouTube's main-world code re-registered —
  last-write-wins, best effort).

Message-listener changes (existing switch):

- `GET_MEDIA_STATE` response adds:
  ```js
  pipActive: !!docPipWindow || !!document.pictureInPictureElement,
  docPipSupported: typeof window.documentPictureInPicture !== 'undefined',
  ```
- `MEDIA_COMMAND` gains `case 'exitPip':` → `closeDocPip()`; else if
  `document.pictureInPictureElement` → `document.exitPictureInPicture().catch(() => {})`;
  `sendResponse({ success: true })` (note: this case must not require `video` — move it
  above the `if (!video)` guard or handle before the guard).

SPA-navigation hook: inside the existing URL-change branch of the MutationObserver
callback, add `closeDocPip();` (before the comments-reset lines).

`storage.onChanged` `yt_settings` branch additions: `syncAutoPip(cachedSettings)` and, if
`docPipWindow`, re-apply `--ytm-pip-op` from `cachedSettings.pipOpacity` (live panel →
window opacity sync).

### Step 3 — `sidepanel/sidepanel.html`

1. New toggle-bar button, placed **last** in `.toggle-bar` (after `#tb-hiderecs`; other
   feature groups are also appending here — final order reconciled by the lead):
   ```html
   <button class="tb-btn" id="tb-autopip" data-desc="Auto popup-player when you switch tabs (Chrome decides eligibility; first use shows a Chrome prompt)">
     <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="14" rx="2"/><rect x="11" y="11" width="8" height="5" rx="1" fill="currentColor" stroke="none"/></svg>
     <span class="tb-label">PiP</span>
   </button>
   ```
   (`data-desc` is mandatory — hookable constraint.)
2. Third row in `.controls-bar`, after the speed row:
   ```html
   <div class="ctrl-row ctrl-row--pip">
     <span class="ctrl-icon" title="Floating player">
       <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="14" rx="2"/><rect x="11" y="11" width="8" height="5" rx="1" fill="currentColor" stroke="none"/></svg>
     </span>
     <input type="range" id="pip-opacity-slider" min="30" max="100" value="100" step="5" class="slider" title="Floating player opacity">
     <span class="ctrl-val" id="pip-opacity-value">100%</span>
     <span class="pip-size-btns">
       <button class="pip-size-btn" id="pip-size-small" data-size="small" title="Open floating player at 320×180 (applies on next open)">S</button>
       <button class="pip-size-btn active" id="pip-size-medium" data-size="medium" title="Open floating player at 480×270 (applies on next open)">M</button>
       <button class="pip-size-btn" id="pip-size-large" data-size="large" title="Open floating player at 640×360 (applies on next open)">L</button>
     </span>
   </div>
   ```

### Step 4 — `sidepanel/sidepanel.css`

```css
/* PiP row */
.pip-size-btns { display: flex; gap: 3px; flex-shrink: 0; }
.pip-size-btn {
  background: var(--bg-card); border: 1px solid var(--border); color: var(--text2);
  border-radius: 4px; padding: 2px 6px; font-size: 10px; font-weight: 600;
  cursor: pointer; transition: all 0.15s;
}
.pip-size-btn:hover { color: var(--text); border-color: #555; }
.pip-size-btn.active { color: var(--text); border-color: var(--accent); background: var(--accent-dim); }
.ctrl-row--pip .ctrl-val { min-width: 34px; }

/* Now-playing float button — blue family to distinguish from red media controls */
.np-btn--pip { border-color: var(--collect); }
.np-btn--pip:hover { background: var(--collect-dim); color: var(--text); }
.np-btn--pip.active { color: var(--collect); background: var(--collect-dim); }
```

No `.video-item`/`CARD_HEIGHT` geometry is touched (virtual-scroll invariant safe); the
new row lives in `.sticky-top`.

### Step 5 — `sidepanel/sidepanel.js`

1. Inline constants near the top (plain script — cannot import):
   ```js
   const PIP_SIZES = { small: [320, 180], medium: [480, 270], large: [640, 360] };
   ```
2. `toggleMap` gains `'tb-autopip': 'pipAutoEnabled'` — the generic toggle wiring and
   `UPDATE_SETTINGS` persistence come for free.
3. `loadSettings()` additions:
   ```js
   document.getElementById('tb-autopip').classList.toggle('active', !!s.pipAutoEnabled);
   const op = Math.min(100, Math.max(30, s.pipOpacity ?? 100));
   document.getElementById('pip-opacity-slider').value = op;
   document.getElementById('pip-opacity-value').textContent = op + '%';
   document.querySelectorAll('.pip-size-btn').forEach(b =>
     b.classList.toggle('active', b.dataset.size === (s.pipSize || 'medium')));
   ```
4. Listeners (with the other control listeners):
   ```js
   document.getElementById('pip-opacity-slider').addEventListener('input', e => {
     document.getElementById('pip-opacity-value').textContent = e.target.value + '%';
   });
   document.getElementById('pip-opacity-slider').addEventListener('change', e => {
     msg({ type: 'UPDATE_SETTINGS', settings: { pipOpacity: parseInt(e.target.value) } });
   });
   document.querySelectorAll('.pip-size-btn').forEach(btn => {
     btn.addEventListener('click', () => {
       document.querySelectorAll('.pip-size-btn').forEach(b => b.classList.remove('active'));
       btn.classList.add('active');
       msg({ type: 'UPDATE_SETTINGS', settings: { pipSize: btn.dataset.size } });
     });
   });
   ```
5. Cross-surface sync — extend the existing `chrome.storage.onChanged` listener (the one
   handling `yt_watch_time`) with a `changes.yt_settings` branch that re-applies the three
   pip control states (skip the opacity slider while it is `document.activeElement` to
   avoid fighting a drag). This catches changes made from the PiP-window strip.
6. `buildNowPlayingCard()` — add after `skipBtn`:
   ```js
   const pipBtn = el('button', { class: 'np-btn np-btn--pip', id: 'np-pip-btn', title: 'Float video (picture-in-picture)' });
   pipBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="14" rx="2"/><rect x="11" y="11" width="8" height="5" rx="1" fill="currentColor" stroke="none"/></svg>'; // static SVG — allowed
   pipBtn.addEventListener('click', () => {
     const tabId = lastMediaState?.tabId;
     if (!tabId) return;
     if (lastMediaState?.pipActive) {
       msg({ type: 'MEDIA_CONTROL', action: 'exitPip', tabId });
       return;
     }
     // SYNCHRONOUS injection — no awaits before it, the click's activation must
     // propagate into the injected function (same rule as sidePanel.open()).
     chrome.scripting.executeScript({
       target: { tabId },
       func: (opts) => { if (window.__ytmTogglePip) window.__ytmTogglePip(opts); },
       args: [{
         opacity: parseInt(document.getElementById('pip-opacity-slider').value),
         size: document.querySelector('.pip-size-btn.active')?.dataset.size || 'medium',
       }],
     }).catch(() => {});
   });
   ```
   and include `pipBtn` in the `np-media-btns` children array.
   Note: `args` values are computed synchronously before the call — fine.
7. `updateNowPlaying()` incremental branch — alongside the play/pause icon update:
   ```js
   const pipB = slot.querySelector('#np-pip-btn');
   if (pipB) pipB.classList.toggle('active', !!state.pipActive);
   ```

### Step 6 — `background/service-worker.js`

**No code changes.** Verified passthroughs: `GET_MEDIA_STATE`'s `queryTab` returns
`{ ...state, tabId }` (new fields flow through), and `MEDIA_CONTROL` forwards
`message.action` verbatim to `MEDIA_COMMAND`. Add a one-line comment near `queryTab`
noting the response now carries `pipActive`/`docPipSupported` from the content script.

### Step 7 — Tests

See section 6. `tests/test-pip.js` (headless) + `tests/test-pip-live.js` (manual headed);
two presence checks appended to `tests/test-extension.js` Test 2.

## 5. Edge cases & failure modes

| # | Case | Handling |
|---|---|---|
| 1 | `requestWindow`/`requestPictureInPicture` called without activation (e.g. test, stale gesture) | try/catch → `console.warn`, state stays null; panel button state self-corrects on next 1.5 s poll. |
| 2 | `documentPictureInPicture` undefined (Chrome < 116, or isolated-world gap per Step 0) | `openDocPip` falls back to `openClassicPip()`; panel pip-row controls disabled with explanatory `title` when displayed tab reports `docPipSupported: false`. |
| 3 | Volume boost (`audioContext` exists) | Float uses classic PiP (Q11); while a Doc-PiP is open, `setVolume` clamps >100 % to 100. Prevents the cross-document `MediaElementSource` mute. |
| 4 | Shorts page | classic PiP fallback (Q9). |
| 5 | Fullscreen active when Float clicked | fire-and-forget `exitFullscreen()` then open; never await before `requestWindow`. |
| 6 | SPA navigation while floated | URL-change observer calls `closeDocPip()` → `pagehide` → player restored before YouTube re-renders the watch page. |
| 7 | Tab closed / full navigation (skip, autoplay-next via `tabs.update`) while floated | Chrome auto-closes the PiP window; `restorePipPlayer` runs during opener unload inside try/catch (harmless if the document is dying). |
| 8 | Second Doc-PiP opened from another tab | Chrome closes the first automatically; its `pagehide` restores that tab's player. One floating window max — by platform design. |
| 9 | User closes PiP window via native ✕ or "back to tab" | same `pagehide` restore path; `window.dispatchEvent(new Event('resize'))` re-flows YouTube; panel button un-highlights on next poll. |
| 10 | Media controls / watch tracking while floated | `getVideoElement()` searches the PiP document first — play/pause/seek/skip/volume/speed/watch-tick all keep working. |
| 11 | Stale `tabId` on panel button (tab closed between polls) | `executeScript` rejects → `.catch(() => {})`; card disappears on next poll. |
| 12 | Chrome < 134: `setActionHandler('enterpictureinpicture')` throws `TypeError` | try/catch in `syncAutoPip` — toggle still persists, silently inert. |
| 13 | YouTube registers its own `enterpictureinpicture` handler (main world, last-write-wins) | best-effort re-registration on every SPA nav (`bindVideoFeatures`) and settings change; documented as non-guaranteed. |
| 14 | Auto-PiP never fires (MEI threshold unmet / user denied the Chrome prompt / video muted or paused) | expected platform gating; `data-desc` text says "Chrome decides eligibility". No extension-side error. |
| 15 | Chrome clamps `requestWindow` width/height | accept clamped size; presets are best-effort. |
| 16 | Panel opacity slider moved while no PiP open | persists to settings only; applied at next open. While open: content.js `storage.onChanged` re-applies live. |
| 17 | `exitPip` command when nothing is open | no-op, `{ success: true }` — must not hit the `if (!video)` early-return in the `MEDIA_COMMAND` handler. |
| 18 | Restore target missing (YouTube re-rendered the parent while floated) | `restorePipPlayer` falls back: if `pipOriginalParent` is disconnected, append player to `#player-container` or `document.body` and dispatch resize — degraded but never lost; covered in headed test. |

## 6. Test plan

### `tests/test-extension.js` (extend Test 2 — Side Panel UI)

- `check('PiP opacity slider present', !!(await sidePanel.$('#pip-opacity-slider')))`
- `check('Auto-PiP toggle present with data-desc', !!(await sidePanel.$('#tb-autopip[data-desc]')))`

### `tests/test-pip.js` (new, modeled on `test-event-driven.js`; headless)

Harness: `chromium.launchPersistentContext('', { channel: 'chromium', args: [--disable-extensions-except, --load-extension] })`,
fake pages via `context.route()` on `https://www.youtube.com/...` URLs.

1. **Panel controls round-trip**
   - Open `chrome-extension://<id>/sidepanel/sidepanel.html`.
   - Set `#pip-opacity-slider` to 60, dispatch `input` → `#pip-opacity-value === '60%'`;
     dispatch `change` → read `yt_settings.pipOpacity === 60` via `sw.evaluate`.
   - Click `#pip-size-large` → has `.active`, siblings don't; `yt_settings.pipSize === 'large'`.
   - Click `#tb-autopip` → `.active` present; `yt_settings.pipAutoEnabled === true`.
   - Reload panel page → all three states restored from settings (`loadSettings` path).
2. **Content-script contract on a fake watch page**
   - Route `https://www.youtube.com/watch?v=PIPTEST0001` →
     `<div id="movie_player" style="position:relative"><video></video></div>` (real watch
     URL pattern so `getCurrentVideoId()` works). Wait ~2.5 s for init.
   - From `sw.evaluate`: `chrome.tabs.sendMessage(tabId, { type: 'GET_MEDIA_STATE' })` →
     assert `videoId === 'PIPTEST0001'`, `pipActive === false`,
     `typeof docPipSupported === 'boolean'`.
   - `chrome.tabs.sendMessage(tabId, { type: 'MEDIA_COMMAND', action: 'exitPip' })` →
     `{ success: true }` (graceful no-op).
3. **Gesture-less toggle degrades safely** (negative control)
   - `sw.evaluate`: `chrome.scripting.executeScript({ target: { tabId }, func: () => { window.__ytmTogglePip && window.__ytmTogglePip({ opacity: 80, size: 'small' }); } })`
     (no user gesture in headless) → subsequent `GET_MEDIA_STATE` still
     `pipActive === false`; **zero page console errors** (console captured from page
     creation, per the fixed smoke-suite pattern).
4. **Auto-PiP registration smoke**
   - With the fake page open, `chrome.storage.local.set` `yt_settings.pipAutoEnabled: true`
     → wait 500 ms → no console errors (registration path ran via `storage.onChanged`);
     flip to `false` → no errors (unregistration).
5. **Settings sync into panel** — write `yt_settings.pipOpacity: 45` from `sw.evaluate`
   → panel `#pip-opacity-value` becomes `45%` without reload (storage.onChanged branch).

### Headed/live only (`tests/test-pip-live.js`, manual — like `test-panel-live.js`)

These cannot be verified headless (no real PiP windows / trusted-gesture +
always-on-top compositing):

- Real watch page playing; trusted Playwright click on `#np-pip-btn` (headed clicks carry
  activation): assert main document no longer contains `#movie_player`, contains
  `.ytm-pip-placeholder`; via MAIN-world `page.evaluate`, assert
  `documentPictureInPicture.window` is non-null and
  `documentPictureInPicture.window.document.querySelector('.ytm-pip-wrap')` exists.
- Move panel opacity slider to 50 → assert the PiP document's `--ytm-pip-op` is `0.5`.
- Click `L` inside the strip → `pipWindow.innerWidth` grows (allow clamping tolerance).
- Click `#np-pip-btn` again (exitPip path) → `#movie_player` back in main document,
  placeholder gone, `video.paused === false` within 2 s (playback survived the move —
  the load-bearing assertion for the move-back pattern).
- Skip button while floated → tab navigates, PiP window auto-closed, player present on
  the new watch page.
- **Auto-PiP**: manual checklist only (MEI cannot be faked): in the user's real profile,
  enable `#tb-autopip`, play a video, switch tabs → PiP appears (accept Chrome's one-time
  prompt); switch back → Chrome dismisses it. Document in the test file header.

## 7. Risks & explicitly out-of-scope

**Risks**

1. **Document-PiP availability in the isolated world** — strongly expected (window-level
   web API, same as `requestPictureInPicture` which Google's extension uses from the
   isolated world) but not 100 % confirmed; Step 0 spike resolves it in minutes; fallback
   design (MAIN-world injection + `postMessage`) is pre-named and contained to content.js
   + the trigger.
2. **YouTube DOM churn** — `#movie_player` move/restore relies on YouTube's current watch
   DOM; a redesign degrades Float to classic PiP (the bail-out path), never breaks the
   queue. Periodic selector maintenance expected (same posture as `hideRecs`).
3. **Handler precedence races** — if YouTube ships its own `enterpictureinpicture`
   handler, last-write-wins between worlds makes our auto-PiP best-effort; mitigated by
   re-registering on SPA nav; worst case = YouTube's/Chrome 142's native auto-PiP behavior,
   which is an acceptable outcome.
4. **Auto-PiP is Chrome-gated** (MEI + per-site permission + audibility rules): the toggle
   cannot *force* PiP; user-visible copy must set that expectation (data-desc does).
5. **Volume-boost interplay**: cross-document moves with a live `MediaElementSource` risk
   muting; designed around (classic-PiP bail-out + boost clamp) rather than fixed, since
   `createMediaElementSource` is irreversible.
6. **Toggle-bar crowding** (reconciliation): groups 01 (`tb-inpage`), 02 (`tb-resize`),
   06 (`tb-export`) also append `.toggle-bar` buttons; at 9–10 buttons the 9 px labels
   will truncate — the lead should arbitrate a two-row bar or icon-only overflow before
   implementation.
7. **Headless test blindness**: real PiP behavior is headed-only; CI-style coverage is
   contracts + graceful-degradation negatives, so regressions in the live move-back path
   surface only via `test-pip-live.js` — keep it in the manual pre-merge checklist.

**Explicitly out-of-scope (platform-impossible, with closest alternative)**

- **PiP window position presets** — no API can set/move a PiP window (classic or
  Document). Closest achievable: Chrome persists the user's last dragged position across
  sessions; documented in the size-preset tooltips.
- **True window transparency** — the OS window (classic or Document PiP) cannot be made
  transparent; we ship content dimming toward a dark background with hover-restore.
- **Styling/resizing the classic auto-PiP window** — impossible; transparency/size apply
  only to the Document-PiP floating player.
- **Auto-PiP on window minimize / OS occlusion** — not scriptable; Chrome 142+ may do it
  natively on its own terms.
- **Auto-entering the Document-PiP floating player on tab switch** — technically allowed
  inside the handler but rejected by design (Q2): automatic DOM surgery on YouTube is too
  invasive for a background trigger.
- **Forcing auto-PiP for low-engagement profiles** — MEI gating is browser policy; no
  extension override exists.
