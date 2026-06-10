# Status Indicators & Badges

Feature group: "indicators" — visual state markers on native YouTube thumbnails and on side-panel video cards, plus an add/move counter per queued video.

---

## 1. Scope

1. **Native-page Q/W badges (EXISTS — verify + refine only).** On YouTube pages, every recommended/listed thumbnail whose href resolves to a video in `yt_videos` gets a top-left badge: red **Q** if queued (unwatched), green **W** if watched. This is already implemented in `content/content.js` (`injectIndicatorStyles`, `setQueuedIdsFrom`, `applyThumbnailIndicators`, driven by `chrome.storage.onChanged` on `yt_videos` + the mutation-throttled `scheduleIndicatorRefresh`). Work here = verify it still passes tests, add hover tooltips, and extend anchor selectors to cover the shorts-lockup layout. **No visual redesign.**

2. **Open-as-tab indicator (NEW).** On side-panel video cards (videos tab, shorts tab, watched list), show a small top-left badge on the thumbnail when that video is currently open in any Chrome tab. Live distribution is event-driven: the service worker maintains the set of open-tab videoIds from `tabs.onCreated/onUpdated/onRemoved/onReplaced`, writes it to `chrome.storage.session` key `yt_open_tab_ids` **only when the set actually changes**, and the panel reacts via `chrome.storage.onChanged` (`area === 'session'`). No polling.

3. **Add/move count (NEW).** Each video object in `yt_videos` gains an integer `addCount`. It is set to `1` on first insert in `addVideoToQueue` and incremented on the bump-existing path (re-add / re-open / intercept of a video already in the queue). Drag-to-top does **not** count (lead decision). `COLLECT_TABS` re-adds do **not** count (see Q5). Displayed as a small "N×" chip on the card thumbnail, hidden while `addCount < 2`. Existing stored videos lack the field — migrated lazily plus a one-time normalization.

4. **Thumbnail duration overlay (EXISTS — verify only).** `.thumb-duration` bottom-right on side-panel thumbnails (`buildVideoItem` and the now-playing card). Work here = a test assertion only. **No code change.**

---

## 2. Clarifying questions & decisions

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| Q1 | Should the open-as-tab badge be clickable (focus that tab)? | **No — passive indicator** (`pointer-events: none`). | The card already has play/dblclick actions; adding a third click target on an 80×45 thumb invites misclicks. Focus-tab is a separate future feature. |
| Q2 | Do any of these indicators need a settings toggle (`yt_settings`) or toggle-bar button? | **No — always on.** | The existing Q/W badges are always-on with no setting; the new badges are tiny, passive, and informative. Avoids toggle-bar crowding and keeps the contract empty of new settings. |
| Q3 | Where exactly does the add-count chip live, and when is it hidden? | **Top-right of `.thumb-wrap`**, text `N×`; **hidden when `(addCount \|\| 1) < 2`**; capped display `9+×`. | Top-left is taken by the open-tab badge, bottom-right by duration. Absolute positioning inside the thumb means zero card-height change (CARD_HEIGHT 63 is load-bearing). Count 1 is noise — every video was added once. |
| Q4 | Does drag-to-top count as a "move to top"? | **No.** Only re-add / re-open / intercept bumps. | Lead decision (verbatim). Drag works by swapping sort-field values, so it isn't even a discrete "top" event; counting it would also fire during ordinary reorders. |
| Q5 | Does `COLLECT_TABS` bump `addCount` for videos already in the queue? | **No.** Collect passes `bumpCount: false`; only brand-new inserts from Collect get `addCount: 1`. | Collect is a periodic sweep of everything open; bumping on every sweep would inflate counts for any tab the user simply leaves open. Note: Collect still bumps `addedAt` (existing behavior, untouched). |
| Q6 | Does re-adding a video that is in the **watched** list bump its count, and does it un-watch it? | **Bump yes, un-watch no.** | `addCount` measures "times the user brought this video in"; watched state is orthogonal. Changing un-watch semantics is out of this group's scope. |
| Q7 | Which storage area for the open-tab set — `local` or `session`? | **`chrome.storage.session`**, key `yt_open_tab_ids`, worker is the sole writer. | It is ephemeral tab-tracking state — exactly the codebase's established session pattern (`recentTabs`, `extOpenedTabs`). Keeps `yt_local` churn (and the `storage.update` mutex) out of a high-frequency path; the side panel is a trusted context so it can read session storage and receives `onChanged` for it. Cleared on browser restart, which is correct: the tabs are gone (restored tabs re-fire tab events and rebuild it). |
| Q8 | Shape of `yt_open_tab_ids` — array of ids, or map videoId→tabId(s)? | **Sorted array of unique videoId strings.** | Panel only needs membership (a Set). Sorting makes the diff check (`JSON.stringify` compare) deterministic so "write only on real change" is trivial and order-churn can't cause spurious writes. If a future group needs tabIds, the key upgrades to a map — flagged for contract reconciliation. |
| Q9 | Should multiple open tabs of the same video show a count? | **No — boolean presence.** | Duplicates are already handled by the duplicate-tab tools; a count here adds shape complexity (see Q8) for near-zero value. |
| Q10 | How does the worker rebuild the set after MV3 worker restarts, without polling? | **Full recompute from `chrome.tabs.query({})` on every relevant tab event (debounced 250 ms) plus once at worker top-level.** | Tab events wake the worker, and the worker top-level runs on every wake, so the set is self-healing with no timers/polls. Recompute is O(tabs) but events are rare and the debounce coalesces bursts (window close = N onRemoved → 1 write). |
| Q11 | Which `tabs.onUpdated` changes trigger recompute? | **Only `changeInfo.url !== undefined`** (plus onCreated/onRemoved/onReplaced). | onUpdated fires for title/favicon/audible/etc. many times per page load; only URL commits can change the videoId set. This is the anti-churn requirement. |
| Q12 | Do badges appear on the Now Playing priority card and the watched list? | **Watched list and shorts list: yes** (shared `buildVideoItem`). **Now Playing: no.** | Now Playing is by definition an open tab — the badge is redundant there. Watched cards benefit: "this watched video still has a tab open". |
| Q13 | What hosts count for the open-tab scan? | Whatever `extractVideoId()` accepts (`isYouTubeHost` allowlist incl. `youtu.be`, `m.`, `music.`). | Hard constraint: hostname validation only; reuse the existing util — no new URL logic. |
| Q14 | Migration for legacy videos without `addCount`? | **Both lazy and eager:** display logic treats missing as `1` (`v.addCount \|\| 1` — chip hidden), the bump path uses `(existing.addCount \|\| 1) + 1`, and `onInstalled` runs a one-time normalization (`addCount = 1` where missing) through `storage.update`. | Lazy defaults make the code safe immediately; eager normalization keeps stored data uniform for other groups. `onInstalled` fires on extension update, so it runs exactly when new code ships. |
| Q15 | Scope of the Q/W "refine"? | **(a)** `title` tooltips on badges ("In queue (YouTube Tab Manager)" / "Watched (YouTube Tab Manager)"); **(b)** add a shorts-lockup anchor selector (`a[class*="shortsLockup"][href]`) so badges land on the new shorts shelves; **(c)** nothing else. | The mechanism (storage.onChanged + throttle) was just hardened in the audit; the only observed gap is selector coverage on newer shorts layouts. Tooltips cost one attribute and answer "what is this red Q?". |
| Q16 | Could the two new chips collide with `.thumb-duration` on an 80×45 thumb? | **No by construction:** TAB top-left, N× top-right, duration bottom-right; each ≤ ~24px wide, 12px tall. | Three fixed corners; worst case (`9+×` + a 3-char duration) still leaves the bottom-left corner and center clear. |
| Q17 | Does the open-tab set update need a full panel re-render? | Update the in-memory `openTabIds` Set, then `lastRenderKeys.clear()` + `renderVisibleCards()`. | Virtual scroll skips renders whose range key is unchanged, so the key cache must be cleared to force the visible window (≤ ~20 cards) to rebuild. Renders during drag are already deferred by `dragInProgress`. |

---

## 3. Data & message contract

### Storage keys

| Key | Area | Writer(s) | Shape |
|-----|------|-----------|-------|
| `yt_open_tab_ids` **(NEW)** | `chrome.storage.session` | service worker only (single writer, debounced, diffed — the `storage.update` mutex applies only to `local` and is not needed here) | `string[]` — sorted, de-duplicated 11-char videoIds of every open tab whose `url \|\| pendingUrl` passes `extractVideoId()`. Example: `["BADGETEST01","dQw4w9WgXcQ"]`. Absent until the first recompute. |
| `yt_videos` **(CHANGED — one new field per element)** | `chrome.storage.local` | service worker via `storage.update` (panel round-trips it through `SET_VIDEOS` on drag, preserving fields) | Each video object gains `addCount: number` (integer ≥ 1; default 1; missing ⇒ treat as 1). Full element shape after change: `{ id, url, title, channel, thumbnail, duration, addedAt, uploadedAt, isShort, watched, starred, addCount }`. |

Constants: add `OPEN_TAB_IDS: 'yt_open_tab_ids'` to `STORAGE_KEYS` in `utils/constants.js` with a comment that the side panel (plain script) inlines the literal.

### Settings keys (yt_settings)

**None.** All indicators are always-on (Q2).

### MSG types

**None.** Open-tab state flows worker → panel via `chrome.storage.session` + `onChanged`; `addCount` rides inside the existing `GET_VIDEOS` / `VIDEOS_UPDATED` flow. (The panel opening already wakes the worker, whose top-level recompute seeds `yt_open_tab_ids` — no GET-style message needed.)

### Changed internal signatures (not a wire contract, but reconciliation-relevant)

- `addVideoToQueue(url, videoId, explicitTimestamp, starred, opts = {})` in `background/service-worker.js` gains a 5th options param `{ bumpCount = true }`. Any other feature group adding parameters to this function must reconcile here.

### New files

- `tests/test-status-indicators.js` — new headless Playwright suite (see §6).

---

## 4. Implementation steps

Ordered; each step is independently committable.

### Step 1 — `utils/constants.js`

Add to `STORAGE_KEYS`:

```js
// chrome.storage.SESSION (not local) — worker is the sole writer; the side
// panel (plain script) inlines the literal 'yt_open_tab_ids'
OPEN_TAB_IDS: 'yt_open_tab_ids',
```

### Step 2 — `background/service-worker.js`: open-tab tracking

Add a new section after the `--- Tab Interception ---` block:

```js
// --- Open Tab Tracking (yt_open_tab_ids in chrome.storage.session) ---
// Event-driven: recomputed from tabs.query on tab create/navigate/remove/
// replace and once per worker wake (top-level call). Debounce coalesces
// bursts (window close = N onRemoved events → one write). Written ONLY when
// the set actually differs from what is stored — panel listens via
// storage.onChanged(area === 'session') so spurious writes would churn it.
let openTabRecomputeTimer = null;
let lastOpenTabIdsJson = null; // null = unknown (fresh worker) — read before diffing

function scheduleOpenTabRecompute() {
  if (openTabRecomputeTimer) return;
  openTabRecomputeTimer = setTimeout(() => {
    openTabRecomputeTimer = null;
    recomputeOpenTabIds().catch(() => {});
  }, 250);
}

async function recomputeOpenTabIds() {
  const tabs = await chrome.tabs.query({});
  const ids = [...new Set(
    tabs.map(t => extractVideoId(t.url || t.pendingUrl || '')).filter(Boolean)
  )].sort();
  const json = JSON.stringify(ids);
  if (lastOpenTabIdsJson === null) {
    try {
      const cur = await chrome.storage.session.get(STORAGE_KEYS.OPEN_TAB_IDS);
      lastOpenTabIdsJson = JSON.stringify(cur[STORAGE_KEYS.OPEN_TAB_IDS] ?? null);
    } catch {}
  }
  if (json !== lastOpenTabIdsJson) {
    lastOpenTabIdsJson = json;
    await chrome.storage.session.set({ [STORAGE_KEYS.OPEN_TAB_IDS]: ids });
  }
}
```

Hook points (all existing listeners; do not add new polling):

- `chrome.tabs.onCreated` listener: append `scheduleOpenTabRecompute();` (the tab's URL may still be pending — `pendingUrl` covers it, and the later `onUpdated` URL commit recomputes again).
- `chrome.tabs.onUpdated` listener: insert `scheduleOpenTabRecompute();` immediately **after** the `if (!changeInfo.url) return;` guard (so only URL changes trigger it — Q11) and before the side-panel/intercept logic.
- `chrome.tabs.onRemoved` listener: append `scheduleOpenTabRecompute();`.
- New listener: `chrome.tabs.onReplaced.addListener(() => scheduleOpenTabRecompute());` (prerender/instant swaps change tabIds without onUpdated).
- Module top level (bottom of file): `scheduleOpenTabRecompute();` — runs on every worker wake, self-healing after worker death.

### Step 3 — `background/service-worker.js`: `addCount`

In `addVideoToQueue`:

```js
async function addVideoToQueue(url, videoId, explicitTimestamp, starred, opts = {}) {
  const { bumpCount = true } = opts;
  ...
  const existing = videos.find(v => v.id === videoId);
  if (existing) {
    existing.addedAt = explicitTimestamp || Date.now();
    // "times added or moved to top" — re-add/re-open/intercept bumps;
    // COLLECT_TABS sweeps pass bumpCount:false; drag-to-top never calls this
    if (bumpCount) existing.addCount = (existing.addCount || 1) + 1;
    if (starred) existing.starred = true;
    return videos;
  }
  inserted = {
    ...,
    starred: !!starred,
    addCount: 1,
  };
```

Call sites:

- `COLLECT_TABS` handler — both loops pass the option:
  - `await addVideoToQueue(tab.url, videoId, timestamp, undefined, { bumpCount: false });`
  - `await addVideoToQueue(entry.url, entry.id, entry.timestamp, entry.starred, { bumpCount: false });`
- Intercept path (`tabs.onUpdated`) and `MSG.ADD_VIDEO`: unchanged calls — default `bumpCount: true`.

Migration — in the `chrome.runtime.onInstalled` listener, after the existing seeding block:

```js
// One-time normalization: videos stored before addCount existed get 1
await storage.update(STORAGE_KEYS.VIDEOS, (videos) => {
  if (!videos) return undefined;
  let changed = false;
  for (const v of videos) {
    if (v.addCount == null) { v.addCount = 1; changed = true; }
  }
  return changed ? videos : undefined; // undefined skips the write
});
```

### Step 4 — `sidepanel/sidepanel.js`: open-tab Set + card chips

1. Module scope (next to `cachedVideos`): `let openTabIds = new Set();`

2. New loader (next to `loadWatchTime`):

```js
// Open-tab indicator state — written by the worker to chrome.storage.SESSION
// (key inlined: plain script). Panel is a trusted context, so it can read it.
async function loadOpenTabIds() {
  try {
    const r = await chrome.storage.session.get('yt_open_tab_ids');
    openTabIds = new Set(r.yt_open_tab_ids || []);
    lastRenderKeys.clear();
    renderVisibleCards();
  } catch {}
}
```

3. Extend the **existing** `chrome.storage.onChanged` listener (the watch-time one near the bottom) — do not add a second listener:

```js
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.yt_watch_time) loadWatchTime();
  if (area === 'session' && changes.yt_open_tab_ids) {
    openTabIds = new Set(changes.yt_open_tab_ids.newValue || []);
    lastRenderKeys.clear();   // virtual scroll skips unchanged range keys (Q17)
    renderVisibleCards();     // drag-safe: dragInProgress defers internally
  }
});
```

4. In `buildVideoItem`, directly after the `.thumb-duration` append:

```js
if (openTabIds.has(v.id)) {
  thumbWrap.appendChild(el('span', {
    class: 'thumb-tab-badge', text: 'TAB', title: 'Open in a Chrome tab',
  }));
}
const addCount = v.addCount || 1; // legacy videos lack the field
if (addCount >= 2) {
  thumbWrap.appendChild(el('span', {
    class: 'thumb-addcount',
    text: (addCount > 9 ? '9+' : addCount) + '×',
    title: 'Added or moved to top ' + addCount + ' times',
  }));
}
```

(`el()` sets `title` via the property branch — no innerHTML, constraint satisfied. Now Playing card intentionally untouched — Q12.)

5. Init block (bottom of file): add `loadOpenTabIds();` alongside `loadWatchTime(); loadSettings(); loadVideos();`.

### Step 5 — `sidepanel/sidepanel.css`

Add immediately after the `.thumb-duration` rule (both badges are absolutely positioned inside `.thumb-wrap` — **card height does not change; CARD_HEIGHT 63 stays valid**):

```css
/* Open-as-tab indicator — top-left of the thumb (worker-tracked, session storage) */
.thumb-tab-badge {
  position: absolute; top: 2px; left: 2px;
  background: rgba(37, 99, 235, 0.92); /* --collect blue */
  color: #fff;
  font-size: 8px; font-weight: 700; letter-spacing: 0.3px;
  padding: 1px 3px; border-radius: 3px;
  line-height: 1.2; pointer-events: none;
}

/* Add/move count chip — top-right of the thumb; only rendered when count >= 2 */
.thumb-addcount {
  position: absolute; top: 2px; right: 2px;
  background: rgba(0, 0, 0, 0.8); color: #f1c40f;
  font-size: 9px; font-weight: 700;
  padding: 1px 3px; border-radius: 3px;
  line-height: 1.2; font-variant-numeric: tabular-nums;
  pointer-events: none;
}
```

### Step 6 — `content/content.js`: Q/W refinement (verify + refine only)

In `applyThumbnailIndicators()`:

1. Extend the anchor query:

```js
const anchors = document.querySelectorAll(
  'a.yt-lockup-view-model__content-image, ' + // new layout (2024+)
  'a#thumbnail[href], '                       + // old layout
  'a[class*="shortsLockup"][href]'              // shorts shelves (2025 layout)
);
```

(Class-substring match on YouTube's own class names is DOM targeting, not URL validation — the hostname constraint applies to URLs, and videoIds still come only from `extractVideoIdFromHref`.)

2. Add tooltips — in the create branch and the state-change branch set:

```js
badge.title = isQueued ? 'In queue (YouTube Tab Manager)' : 'Watched (YouTube Tab Manager)';
```

No other content-script changes. The existing storage.onChanged + `scheduleIndicatorRefresh` distribution is untouched.

### Step 7 — `tests/test-status-indicators.js` (new) + `package.json`

See §6 for assertions. Add to `package.json`:
- `"test:indicators-status": "node tests/test-status-indicators.js"`
- Append `&& node tests/test-status-indicators.js` to `test:all`.

---

## 5. Edge cases & failure modes

| Case | Handling |
|------|----------|
| **MV3 worker killed; tabs open/close while it sleeps** | Tab events (onCreated/onUpdated/onRemoved) wake the worker; its top-level `scheduleOpenTabRecompute()` plus the event's own call recompute from `tabs.query` — state is derived, never accumulated, so nothing is lost. `lastOpenTabIdsJson === null` after wake forces a read-before-diff so an unchanged set still writes nothing. |
| **onUpdated event storm (title/favicon/audible)** | Recompute is triggered only when `changeInfo.url` is set; the 250 ms debounce coalesces multi-event navigations into one `tabs.query`. |
| **Window with N YouTube tabs closed at once** | N onRemoved events → one debounced recompute → one storage write. |
| **Two tabs open the same video; one closes** | Set semantics: id stays until the last such tab closes (recompute sees the remaining tab). |
| **Tab still loading (`url` empty, `pendingUrl` set)** | Recompute reads `t.url || t.pendingUrl`; the URL-commit onUpdated recomputes again, so transient misses self-correct within 250 ms. |
| **Panel open before worker has ever computed the set** | Opening the panel sends `GET_VIDEOS`, which wakes the worker → top-level recompute → session write → panel's `onChanged` fires. Until then `openTabIds` is empty: badges briefly absent, never wrong. |
| **Session-storage read fails in panel (old Chrome, race)** | `loadOpenTabIds` is try/caught; feature degrades to "no badge", everything else works. |
| **Open-tab change arrives mid-drag** | `renderVisibleCards()` checks `dragInProgress` and defers via `renderPendingAfterDrag` — existing invariant preserved. |
| **Open-tab change arrives mid-scroll** | `lastRenderKeys.clear()` + render rebuilds only the visible window (≤ ~20 cards); spacers/heights unchanged so scroll position is stable. |
| **Legacy videos without `addCount`** | Display uses `v.addCount \|\| 1` (chip hidden); bump uses `(existing.addCount \|\| 1) + 1`; `onInstalled` normalizes stored data once via `storage.update` (skips write when nothing changed). |
| **Concurrent duplicate adds of the same video** | Already serialized by the `storage.update` mutex: first call inserts (`addCount: 1`), second takes the bump path (`2`). Semantically correct — the user did trigger two adds. |
| **Collect pressed repeatedly while tabs stay open** | `bumpCount: false` on both Collect loops — counts cannot inflate from sweeps (Q5). |
| **Drag-to-top** | Drag swaps sort-field values via `SET_VIDEOS` and never calls `addVideoToQueue` — no count change by construction (Q4). `SET_VIDEOS` round-trips the full objects, so `addCount` survives drags. |
| **`addCount` ≥ 10** | Chip renders `9+×`; full number in the `title` tooltip. Keeps the chip ≤ ~24px on an 80px thumb. |
| **Badge corner collisions** | Fixed corners: TAB top-left, N× top-right, duration bottom-right — disjoint by construction (Q16). |
| **Lookalike hostnames in open tabs** | `extractVideoId` → `isYouTubeHost` allowlist; hostile URLs never enter `yt_open_tab_ids`. |
| **YouTube changes thumbnail DOM again** | Q/W selector list is additive (3 selectors); failure mode is a missing badge, never breakage. Live verification path documented in §6. |
| **Worker dies during the 250 ms debounce** | The pending timeout dies with it; the next wake's top-level recompute covers the gap. Worst case: a badge is stale until the next tab event or worker wake — benign for a passive indicator. |

---

## 6. Test plan

### New: `tests/test-status-indicators.js` (headless, joins `test:all`)

Use the standard harness: `chromium.launchPersistentContext('', { channel: 'chromium', args: [--disable-extensions-except, --load-extension] })`, grab the service worker, `check(label, cond)` pass/fail counters, exit code 1 on failure (copy the skeleton from `tests/test-event-driven.js`).

1. **Open-tab set tracks tab lifecycle (worker side).**
   - `context.route('https://www.youtube.com/watch?v=OPENTABTST1', fulfill minimal HTML)` (deterministic fake-URL pattern; the committed URL is what `tabs.onUpdated` sees, so the worker tracks it like a real tab).
   - Open the page → wait ~1 s → `sw.evaluate(() => chrome.storage.session.get('yt_open_tab_ids'))` → assert it contains `OPENTABTST1`.
   - Open a second tab with the **same** URL → assert the array still has exactly one `OPENTABTST1` (Set semantics).
   - Close both tabs → wait ~1 s → assert id removed.
2. **No-churn guarantee.**
   - In `sw.evaluate`, register `let writes = 0; chrome.storage.session.onChanged.addListener(ch => { if (ch.yt_open_tab_ids) writes++; })` (store the counter on `globalThis`).
   - On the open tab, run 5 × `document.title = 'x' + i` (title-only onUpdated events) and a hash-free `history.replaceState` no-op; wait 2 s; assert the counter is 0.
3. **Panel badge reacts via storage.onChanged.**
   - Seed `yt_videos` with `OPENTABTST1` (via `sw.evaluate` + `chrome.storage.local.set`, same as test-event-driven.js).
   - Open `chrome-extension://<id>/sidepanel/sidepanel.html`; with the routed tab open, assert `.video-item[data-id="OPENTABTST1"] .thumb-tab-badge` exists.
   - Close the routed tab; wait ~1.5 s; assert the badge is gone — proves the panel updated **without reload** (event-driven). |
4. **Add-count chip rendering.**
   - Seed three videos: `addCount: 1`, `addCount: 3`, and one with **no** `addCount` field (legacy).
   - Assert: no `.thumb-addcount` on the count-1 and legacy cards; chip text `3×` on the third; `title` contains "3 times". Seed `addCount: 12` → chip text `9+×`.
5. **addCount increment semantics (worker logic).**
   - From the panel page: `chrome.runtime.sendMessage({ type: 'ADD_VIDEO', url: 'https://www.youtube.com/watch?v=COUNTTEST01' })` twice (await each); read `yt_videos` via `sw.evaluate` → assert `addCount === 2` (enrichVideo's network failure for a fake id is caught and irrelevant).
   - Then `chrome.runtime.sendMessage({ type: 'COLLECT_TABS' })` with a routed tab open at the same videoId → assert `addCount` is **still 2** (Collect does not bump).
6. **Duration overlay (verify-only item).**
   - On a seeded card with `duration: 3725`, assert `.thumb-duration` text is `1:02:05`; on the now-playing-free panel just the card check suffices.
7. **Card geometry guard.**
   - Assert `document.querySelector('.video-item').getBoundingClientRect().height + 4 === 63` (height 59 + 4 margin) so the new chips provably don't break CARD_HEIGHT.

### Existing suites

- `tests/test-event-driven.js` — already covers Q/W badge add/update/remove via storage.onChanged on a routed fake page. **Add two assertions**: badge `title` attribute is non-empty for both Q and W badges (covers the Step 6 refinement). The fake page can also gain one `<a class="shortsLockupViewModelFake" href="/shorts/BADGETEST04">` anchor inside a positioned div to assert the new shorts selector matches.
- `tests/test-extension.js` — no changes required (presence checks live in the new suite); confirm it stays green (console-error capture would catch any panel JS error from the new code).
- `tests/test-virtual-scroll.js` — run unchanged; it guards the CARD_HEIGHT/spacer invariants the chips must not disturb.

### Headed / live-only verification

- **Real-DOM selector coverage** (Q/W + shorts-lockup badges on live youtube.com): run the existing manual suite `node tests/test-indicators.js` (headed). Success = badge counts > 0 in the console summary and `screenshots/yt-indicators.png` shows badges on real recommended + shorts thumbnails. This cannot be headless: real recommendations don't render reliably in headless Chromium.
- **Open-tab badge in the real docked side panel**: extend the manual flow of `tests/test-panel-live.js` (or just verify by hand): open a video tab, open the panel, confirm the blue TAB chip on that card, close the tab, confirm it disappears within ~1 s.

---

## 7. Risks & explicitly out-of-scope

### Risks

1. **YouTube DOM churn (native badges).** The three anchor selectors (incl. the new `a[class*="shortsLockup"]`) are best-effort against an unversioned DOM. Failure mode is silent (missing badges). Mitigation: headed `test-indicators.js` run before release; selectors are additive so regressions can't break other features.
2. **`addVideoToQueue` signature change.** Another feature group touching the same function (e.g., tab-management or queue features) must reconcile the new `opts` 5th parameter — flagged for the lead's contract pass.
3. **`yt_open_tab_ids` shape lock-in.** Chosen as `string[]`. If another group needs videoId→tabId mapping (e.g., "focus the open tab"), the key's shape must change in one coordinated step; the panel code only does `new Set(arr)` so migration cost is low, but it is a cross-group contract point.
4. **Session storage write outside the mutex.** Deliberate: `utils/storage.js` serializes `local` only. Safe because the worker is the single writer of this key, writes are funneled through one debounced function, and the value is derived (recompute always overwrites with ground truth). Reviewers should not "fix" this by routing it through `storage.update` — that would couple tab-event latency to the local-storage write queue.
5. **Stale badge while worker sleeps with no tab events.** Impossible in practice (the set only changes when tab events fire, and tab events wake the worker), except a tab whose SPA navigation changes the videoId without a committed URL change — YouTube SPA navigations do commit URL changes, so onUpdated fires. Residual risk: a few hundred ms of staleness from the debounce. Accepted for a passive indicator.
6. **Render churn in the panel.** Many tab events → many session writes → many visible-window re-renders. Bounded by the worker debounce (≥250 ms between writes) and the ≤ ~20-card window; drag safety is preserved by the existing `dragInProgress` deferral.

### Explicitly out of scope

- **Click-to-focus on the open-tab badge** (and any "switch to that tab" affordance) — closest achievable alternative is a future `MSG.FOCUS_VIDEO_TAB`; not in this group (Q1).
- **Per-tab counts on the open-tab badge** (Q9) and tabId tracking in `yt_open_tab_ids` (Q8).
- **Settings toggles for any indicator** (Q2).
- **Counting drag-to-top as a move** (Q4, lead decision) and **counting Collect sweeps** (Q5).
- **Un-watching a video on re-add** (Q6) — existing behavior preserved.
- **Open-tab indicators on native YouTube thumbnails** (content script reading session storage would require lowering the session access level to untrusted contexts — a security-surface change; if ever wanted, mirror the ids into `yt_videos`-style local state instead). Spec only asks for side-panel anyway.
- **Sorting/filtering by addCount or open-tab state** — display only; sort fields are another group's surface.
- **Badges in the popup** — popup shows aggregate stats, not per-video cards.
