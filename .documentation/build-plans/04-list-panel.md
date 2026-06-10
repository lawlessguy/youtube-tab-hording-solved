# Video List & Side Panel (Sessions, Channel Filter, Smart Play, Middle-Click)

## 1. Scope — restate each feature precisely.

1. **Sessions** — The user can create multiple named queue "sessions" (e.g. "Main", "Research", "Music"). The side panel shows exactly one session at a time (the *active* session): its Videos tab, Shorts tab, counts, and Watched section are all scoped to it. A compact session switcher lives in the panel header area with actions: **new**, **rename**, **switch**, **merge into Main**, **delete**. Merging moves a session's videos into the Main session (resolving duplicate video ids) and removes the source session. Existing single-queue data migrates transparently into a permanent "Main" session.
2. **Channel filter** — The channel name on each video card in the side panel becomes clickable. Clicking it filters the lists to only that channel's videos (within the active session). An active channel filter is shown as a dismissible chip near the search bar. The filter combines with search text and the star filter using AND semantics.
3. **Smart play** — When the user double-clicks a video card (or presses its play button), and that video is already open in some Chrome tab, the extension activates that existing tab (and focuses its window) instead of navigating the current tab / opening a new one. Only when no tab already has the video does the existing OPEN_VIDEO behavior run (replace current YouTube tab, else open new tab).
4. **Middle-click navigation + intercept bypass** — Middle-clicking a card opens the video in a new background tab; if Auto-Intercept is on (`close` or `keep`), those tabs are NOT intercepted (not queued, not auto-closed). **This already exists** (`auxclick` → `MSG.OPEN_VIDEO_NEW_TAB` → `whitelistExtensionTab(tab.id, 30000)` → `isExtensionOpenedTab` early-return in `tabs.onUpdated`). Scope here is verification plus a permanent regression test — no rebuild.

## 2. Clarifying questions & decisions

1. **Q: Storage model — one `yt_videos` array with a `sessionId` per video, or one array per session?**
   **A: One `yt_videos` array; each video object gains `sessionId` (missing ⇒ `'main'`).**
   Rationale: every existing mutation site (`addVideoToQueue`, `UPDATE_VIDEO`, `REMOVE_VIDEO`, `SET_VIDEOS` round-trip from drag-drop, `REFRESH_METADATA`, badge code reading `yt_videos`) keeps working through the one `storage.update()` mutex with zero key proliferation; migration is a lazy default instead of a data move.

2. **Q: Is the active session global or per-window/per-panel?**
   **A: Global — a single `activeId` pointer in `yt_sessions`.**
   Rationale: the worker needs one unambiguous answer for COLLECT_TABS, intercept adds, and VIDEO_ENDED next-pick; per-window pointers would require window→session maps in `storage.session` for marginal benefit.

3. **Q: Which session do the Q/W thumbnail badges on YouTube pages reflect?**
   **A: The union of all sessions (any session containing the id shows the badge).**
   Rationale: a badge means "already captured — don't re-add"; that is true regardless of session, and it means `content/content.js` needs **zero changes** (it already reads raw `yt_videos` and matches by id).

4. **Q: Where does COLLECT_TABS put videos?**
   **A: Into the active session.**
   Rationale: matches the lead's directive and the user's mental model ("collect into what I'm looking at"); silently-logged drained videos go to the active session too.

5. **Q: Is merge a move or a copy, and what happens to the source session?**
   **A: Move; the source session is deleted after a successful merge.** Merge target is always Main (no arbitrary-target UI).
   Rationale: the spec says "merge a session's videos into the main session"; copy would create cross-session duplicate ids with confusing watched/star divergence. One fixed target keeps the UI to a single button.

6. **Q: How are duplicate video ids resolved on merge?**
   **A: The Main (target) entry wins and the source entry is dropped, except `starred` is OR'd and `watched: false` wins (unwatched in either ⇒ unwatched).**
   Rationale: target-wins preserves Main's curated `addedAt` ordering; star/unwatched union avoids silently losing user intent.

7. **Q: What happens to a session's videos on delete?**
   **A: They are permanently removed, behind a two-click inline confirm (no `confirm()` dialog — blocked in extension panels). Merge-into-Main is the "keep the videos" path. Main cannot be deleted or renamed.**
   Rationale: simplest coherent semantics; an "orphan to main on delete" rule would make delete and merge nearly identical.

8. **Q: Can the same videoId exist in two sessions, and how do id-keyed messages behave?**
   **A: Yes (one entry per session). Panel-originated `UPDATE_VIDEO` / `REMOVE_VIDEO` carry `sessionId` and match `(id, sessionId)`. Content-script-originated `MARK_WATCHED` (and SKIP's watched-marking) have no session context and mark **all** entries with that id watched.**
   Rationale: "I watched this video" is a fact about the video, not the session; panel actions must stay scoped so removing from one session doesn't nuke another.

9. **Q: Does smart play apply only to double-click, or also to the card's ▶ button?**
   **A: Both — it is implemented inside the worker's `OPEN_VIDEO` handler, which both gestures already share.**
   Rationale: one code path, consistent UX; a user who truly wants a duplicate tab still has middle-click.

10. **Q: If multiple tabs have the video open, which one is focused?**
    **A: Prefer a match in the last-focused window; otherwise the first match from `chrome.tabs.query({})`.**
    Rationale: cheapest deterministic rule that almost always picks the tab the user remembers opening.

11. **Q: Is the channel filter persisted (in `yt_settings`) like sort, or ephemeral like search?**
    **A: Ephemeral — module-level variable, cleared on panel reload and on session switch.**
    Rationale: it mirrors the existing search box (also ephemeral); persisting a filter that hides everything across restarts is a "where did my videos go" trap.

12. **Q: Does the channel filter apply to the Watched section?**
    **A: No — same as the existing search and star filters, which only filter the unwatched lists.**
    Rationale: symmetry with established behavior; the Watched section stays a complete history.

13. **Q: How do channel clicks coexist with the card's dblclick-to-play?**
    **A: The channel `<span>` gets its own `click` handler with `stopPropagation()`, and the card's `dblclick` handler adds a `e.target.closest('.channel-link')` early-return guard (alongside the existing `select`/`button` guards).**
    Rationale: `stopPropagation` on `click` does not suppress an independent `dblclick` listener — the explicit guard is required.

14. **Q: Clicking "Unknown" channel placeholders?**
    **A: If `v.channel` is falsy or `'Unknown'`, the span is rendered without the `channel-link` class/handler (plain text, not clickable).**
    Rationale: filtering by a placeholder groups unrelated unenriched videos — meaningless.

15. **Q: Any new `yt_settings` keys (e.g. a smart-play toggle)?**
    **A: None.** Smart play is always-on; session state lives in its own `yt_sessions` key (it is data, not a preference); channel filter is ephemeral.
    Rationale: fewer settings, no settings-migration concerns, honors "prefer simple".

16. **Q: Which session feeds Autoplay-next (`VIDEO_ENDED`) and Skip?**
    **A: The active session.** The panel-provided orders (`yt_next_video_order`, `nextVideoIds`) are already session-filtered because the panel only lists active-session videos; the worker's *fallback* sort must additionally filter `(v.sessionId||'main') === activeId`.
    Rationale: autoplay jumping into a hidden session would look like random playback.

17. **Q: How do new/rename get text input — `window.prompt()`?**
    **A: No. `prompt()`/`confirm()` are suppressed in extension panel documents. Use an inline `<input>` that temporarily replaces the session `<select>` (Enter commits, Esc/blur cancels), and a two-click confirm pattern (`.confirming` class, 3s timeout) for delete/merge.**
    Rationale: works everywhere, trivially testable in Playwright.

18. **Q: Does middle-click need any new code?**
    **A: No — verify the existing chain and pin it with a regression test in `tests/test-tab-management.js` (intercept `close` ON + `OPEN_VIDEO_NEW_TAB` ⇒ tab survives, queue unchanged).**
    Rationale: lead's explicit directive; the 30s whitelist TTL covers slow loads.

19. **Q: Do sessions need a new broadcast message?**
    **A: No — panel(s) react to `chrome.storage.onChanged` for `yt_sessions` (the established event-driven pattern); video moves during merge/delete already emit `VIDEOS_UPDATED`.**
    Rationale: no new polling, no new broadcast type, multi-window panels stay in sync for free.

20. **Q: Does GET_VIDEOS change shape?**
    **A: No — it still returns the full array (now with `sessionId` on each item); the panel filters client-side.**
    Rationale: keeps drag-drop's read-modify-`SET_VIDEOS` round-trip lossless (other sessions' videos pass through untouched).

## 3. Data & message contract

### Storage keys (`chrome.storage.local`)

| Key | Status | Shape |
|---|---|---|
| `yt_sessions` (`STORAGE_KEYS.SESSIONS`) | **NEW** | `{ activeId: string, list: [{ id: string, name: string, createdAt: number }] }` — `list[0]` is always `{ id: 'main', name: 'Main', createdAt: 0 }`. New session ids: `'s_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)`. Default value exported as `DEFAULT_SESSIONS` from `utils/constants.js` (inlined as a literal in `sidepanel.js`). |
| `yt_videos` | **CHANGED** | Each video object gains `sessionId: string`. Full shape: `{ id, url, title, channel, thumbnail, duration, addedAt, uploadedAt, isShort, watched, starred, sessionId }`. **Compatibility rule (load-bearing, everywhere):** a missing `sessionId` is read as `'main'` — all filters use `(v.sessionId \|\| 'main')`. One-time backfill in `onInstalled`. |
| `yt_next_video_order` | unchanged | Already session-correct: the panel writes only the active session's visible order. |
| `yt_settings`, `yt_watch_time`, `yt_logged_videos` | unchanged | (Logged videos have no session; they enter the active session when drained by Collect.) |

### Settings keys (`yt_settings`)

**None added.**

### MSG types (add to `MSG` in `utils/constants.js`; literals inlined in `sidepanel.js`)

| Type | Request | Response |
|---|---|---|
| `GET_SESSIONS` | `{ type }` | `{ activeId, list }` (the `yt_sessions` value, defaulted if missing) |
| `CREATE_SESSION` | `{ type, name }` | `{ session: {id,name,createdAt}, activeId }` — creates, **and switches to it** (`activeId` = new id). Empty/whitespace name ⇒ `{ error }`. Name trimmed, max 40 chars. |
| `RENAME_SESSION` | `{ type, sessionId, name }` | `{ success: true }` or `{ error }` (`'main'` and unknown ids rejected) |
| `DELETE_SESSION` | `{ type, sessionId }` | `{ success: true, removedVideos: n }` or `{ error }` — removes that session's videos from `yt_videos` first, then the session entry; if it was active, `activeId` → `'main'`. `'main'` rejected. |
| `SET_ACTIVE_SESSION` | `{ type, sessionId }` | `{ success: true, activeId }` or `{ error }` for unknown id |
| `MERGE_SESSION` | `{ type, sourceSessionId }` | `{ success: true, moved: n, duplicates: n }` or `{ error }` — moves source videos to `'main'` (dup rule: Main entry wins; `starred` OR'd; `watched` AND'd), then deletes the source session; `activeId` → `'main'`. `'main'` as source rejected. |

### Changed message semantics (no new types)

- `OPEN_VIDEO` `{ type, url }` → response gains a variant: `{ tabId, focused: true }` when an existing tab with the same videoId was activated (smart play); otherwise unchanged `{ tabId, replaced: boolean }`.
- `UPDATE_VIDEO` / `REMOVE_VIDEO` → request gains **optional** `sessionId`; when present the worker matches `v.id === videoId && (v.sessionId||'main') === sessionId`; when absent, legacy first-match-by-id (content script callers unchanged).
- `MARK_WATCHED` → now sets `watched: true` on **every** entry with that id (all sessions). Same for the watched-marking inside `SKIP_VIDEO`.
- `VIDEO_ENDED` / `SKIP_VIDEO` fallback next-pick → filtered to the active session.
- `ADD_VIDEO`, `COLLECT_TABS`, intercept adds → inserted videos carry the active session's id.
- `VIDEOS_UPDATED` broadcast: also emitted after `DELETE_SESSION` (videos removed) and `MERGE_SESSION` (videos moved). Session-list/pointer changes propagate via `storage.onChanged` on `yt_sessions` — **no new broadcast type**.

### New files

- `tests/test-sessions.js` — sessions + channel filter + smart play suite (added to `test:all` in `package.json`).

No other new source files — all changes land in existing files (no build step, plain JS).

## 4. Implementation steps

### Step 1 — `utils/constants.js`

1. Add to `STORAGE_KEYS`: `SESSIONS: 'yt_sessions',` (with the standard comment that the side panel inlines the literal).
2. Add export:
   ```js
   export const DEFAULT_SESSIONS = {
     activeId: 'main',
     list: [{ id: 'main', name: 'Main', createdAt: 0 }],
   };
   ```
3. Add to `MSG`: `GET_SESSIONS`, `CREATE_SESSION`, `RENAME_SESSION`, `DELETE_SESSION`, `SET_ACTIVE_SESSION`, `MERGE_SESSION` (values identical to the key names).

### Step 2 — `background/service-worker.js`

1. **Imports**: add `DEFAULT_SESSIONS` to the constants import.
2. **Helpers** (place after `whitelistExtensionTab`):
   ```js
   function sessOf(v) { return v.sessionId || 'main'; }
   async function getSessions() {
     const s = await storage.get(STORAGE_KEYS.SESSIONS);
     return (s && Array.isArray(s.list) && s.list.length) ? s : structuredClone(DEFAULT_SESSIONS);
   }
   async function getActiveSessionId() { return (await getSessions()).activeId || 'main'; }
   function newSessionId() { return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
   ```
3. **`onInstalled` migration** (append inside the existing listener, before `setPanelBehavior`):
   ```js
   const sessions = await storage.get(STORAGE_KEYS.SESSIONS);
   if (!sessions) await storage.set(STORAGE_KEYS.SESSIONS, DEFAULT_SESSIONS);
   await storage.update(STORAGE_KEYS.VIDEOS, (videos = []) =>
     videos.map(v => v.sessionId ? v : { ...v, sessionId: 'main' }));
   ```
   (Defensive `sessOf()` fallback still applied everywhere — `onInstalled` does not fire on every worker restart.)
4. **`addVideoToQueue(url, videoId, explicitTimestamp, starred, sessionId)`**: add the 5th param. Before the `storage.update` call: `sessionId = sessionId || await getActiveSessionId();` (a read — fine outside the mutex). Inside the update fn: duplicate check becomes `videos.find(v => v.id === videoId && sessOf(v) === sessionId)`; the `inserted` object gains `sessionId`. Existing callers (`tabs.onUpdated` intercept, `ADD_VIDEO`, `COLLECT_TABS` drain loop) need no change — they fall through to the active session. **`COLLECT_TABS` optimization:** resolve `const sid = await getActiveSessionId();` once before its loops and pass it, so 30 tabs don't do 30 session reads.
5. **`UPDATE_VIDEO` / `REMOVE_VIDEO` handlers**: introduce a shared matcher:
   ```js
   const matches = v => v.id === message.videoId &&
     (!message.sessionId || sessOf(v) === message.sessionId);
   ```
   `REMOVE_VIDEO`: `videos.filter(v => !matches(v))` (note: without `sessionId` this removes all entries with the id — acceptable legacy behavior; the panel always sends `sessionId`). `UPDATE_VIDEO`: `videos.find(matches)`.
6. **`MARK_WATCHED`**: change find-one to for-each — set `watched = true` on every entry with the id; `changed` if any flipped. Same loop inside **`SKIP_VIDEO`**'s marking block.
7. **`SKIP_VIDEO` and `VIDEO_ENDED` fallbacks**: where they compute `const unwatched = videos.filter(v => !v.watched)`, add `&& sessOf(v) === activeId` with `const activeId = await getActiveSessionId();` fetched just above (read-only, outside update callbacks).
8. **Smart play — `OPEN_VIDEO` handler**: insert at the top of the case, before the existing replace/create logic:
   ```js
   const targetVid = extractVideoId(message.url);
   if (targetVid) {
     const all = await chrome.tabs.query({});
     const matchTabs = all.filter(t => t.url && isYouTubeHost(t.url) && extractVideoId(t.url) === targetVid);
     if (matchTabs.length > 0) {
       const [act] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
       const pick = (act && matchTabs.find(t => t.windowId === act.windowId)) || matchTabs[0];
       await chrome.tabs.update(pick.id, { active: true });
       try { await chrome.windows.update(pick.windowId, { focused: true }); } catch {}
       return { tabId: pick.id, focused: true };
     }
   }
   ```
   No whitelisting needed — nothing navigates. `extractVideoId` already rejects non-YouTube hosts (uses `isYouTubeHost` internally), satisfying the hostname-validation constraint.
9. **Session handlers** — add six cases to `handleMessage`. All `yt_sessions` mutations go through `storage.update(STORAGE_KEYS.SESSIONS, ...)`; video moves/removals are **separate, ordered** `storage.update(STORAGE_KEYS.VIDEOS, ...)` calls (the module-global `writeQueue` in `utils/storage.js` serializes across keys, so there is no interleaving):
   - `GET_SESSIONS`: `return await getSessions();`
   - `CREATE_SESSION`: validate `name = (message.name||'').trim().slice(0,40)`; empty ⇒ `{error:'Empty name'}`. `update(SESSIONS, s => { s = normalize(s); s.list.push({id:newSessionId(), name, createdAt:Date.now()}); s.activeId = newId; return s; })`; return `{ session, activeId }`. (`normalize` = fall back to `DEFAULT_SESSIONS` clone if missing/corrupt — same logic as `getSessions`, reused inside the update fn on the raw `current` value.)
   - `RENAME_SESSION`: reject `'main'`; find in list, set `name`; `{success:true}` / `{error:'Not found'}`.
   - `SET_ACTIVE_SESSION`: reject unknown ids; set `activeId`; `{success:true, activeId}`.
   - `DELETE_SESSION`: reject `'main'` and unknown. **Order: videos first, sessions second** (a worker death in between leaves an empty-but-listed session — benign; the reverse would orphan invisible videos):
     ```js
     let removed = 0;
     await storage.update(STORAGE_KEYS.VIDEOS, (videos = []) => {
       const kept = videos.filter(v => sessOf(v) !== message.sessionId);
       removed = videos.length - kept.length;
       return kept;
     });
     await storage.update(STORAGE_KEYS.SESSIONS, s => { /* normalize; remove entry; if activeId===sessionId → 'main'; return s */ });
     broadcast({ type: MSG.VIDEOS_UPDATED });
     return { success: true, removedVideos: removed };
     ```
   - `MERGE_SESSION`: reject `'main'` source and unknown ids. Videos first:
     ```js
     let moved = 0, duplicates = 0;
     await storage.update(STORAGE_KEYS.VIDEOS, (videos = []) => {
       const mainIds = new Map(videos.filter(v => sessOf(v) === 'main').map(v => [v.id, v]));
       const out = [];
       for (const v of videos) {
         if (sessOf(v) !== message.sourceSessionId) { out.push(v); continue; }
         const dup = mainIds.get(v.id);
         if (dup) { duplicates++; dup.starred = dup.starred || v.starred; dup.watched = dup.watched && v.watched; }
         else { moved++; const mv = { ...v, sessionId: 'main' }; out.push(mv); mainIds.set(mv.id, mv); }
       }
       return out;
     });
     ```
     then the sessions update (remove source entry, `activeId = 'main'`), then `broadcast({ type: MSG.VIDEOS_UPDATED })`; return `{ success:true, moved, duplicates }`.

### Step 3 — `sidepanel/sidepanel.html`

1. Insert the **session bar** immediately after `</header>` (still inside `.sticky-top`, above `.toggle-bar`):
   ```html
   <!-- Session Switcher -->
   <div class="session-bar">
     <select id="session-select" class="session-select" title="Active session"></select>
     <input type="text" id="session-name-input" class="session-name-input" style="display:none" maxlength="40" spellcheck="false">
     <button class="session-btn" id="session-new" title="New session">+</button>
     <button class="session-btn" id="session-rename" title="Rename session">&#9998;</button>
     <button class="session-btn" id="session-merge" title="Merge this session into Main">&#8689;</button>
     <button class="session-btn session-btn--danger" id="session-delete" title="Delete session and its videos">&#10005;</button>
   </div>
   ```
   (These buttons are not in `.toggle-bar`, so the `data-desc` rule does not apply; `title` tooltips are used. Two-click confirm feedback is text swap + `.confirming` class.)
2. Insert the **channel chip** row directly after the closing `</div>` of `.filter-search-bar` (still in `.sticky-top`, before `.content-tabs`):
   ```html
   <!-- Channel filter chip (hidden unless a channel filter is active) -->
   <div class="channel-chip" id="channel-chip" style="display:none">
     <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
     <span class="channel-chip-name" id="channel-chip-name"></span>
     <button class="search-clear" id="channel-chip-clear" title="Clear channel filter">
       <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
     </button>
   </div>
   ```
   Chip name is set exclusively via `textContent` (user data — never innerHTML).

### Step 4 — `sidepanel/sidepanel.css`

Append:
```css
/* Session Switcher */
.session-bar { display: flex; align-items: center; gap: 4px; padding: 6px 0 0; }
.session-select, .session-name-input {
  flex: 1; min-width: 0; background: var(--bg-card); color: var(--text);
  border: 1px solid var(--border); border-radius: 4px; font-size: 11px;
  padding: 3px 4px; font-family: inherit; outline: none;
}
.session-select:hover { border-color: #555; }
.session-name-input:focus { border-color: var(--accent); }
.session-btn {
  background: none; border: 1px solid var(--border); color: var(--text2);
  border-radius: 4px; width: 24px; height: 22px; font-size: 11px; cursor: pointer;
  display: flex; align-items: center; justify-content: center; transition: all 0.15s; flex-shrink: 0;
}
.session-btn:hover { color: var(--text); background: var(--bg-hover); border-color: #555; }
.session-btn:disabled { opacity: 0.35; cursor: default; }
.session-btn--danger:hover { color: var(--danger); border-color: var(--danger); }
.session-btn.confirming { color: #fff; background: var(--danger); border-color: var(--danger); }
#session-merge.confirming { background: var(--collect); border-color: var(--collect); }

/* Channel filter chip */
.channel-chip {
  display: flex; align-items: center; gap: 5px; margin-bottom: 5px;
  padding: 3px 7px; border: 1px solid var(--accent); border-radius: 10px;
  background: var(--accent-dim); color: var(--text); font-size: 11px;
}
.channel-chip-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }

/* Clickable channel on cards */
.channel-link { cursor: pointer; }
.channel-link:hover { color: var(--text); text-decoration: underline; }
```
**Invariant check:** card geometry (`.video-item` height 59px + 4px margin = `CARD_HEIGHT` 63) is untouched. The session bar and chip live in `.sticky-top`, so `.scroll-area` internal offsets used by the virtual scroller are unaffected.

### Step 5 — `sidepanel/sidepanel.js`

1. **State** (top of file): `let channelFilter = null;` `let activeSessionId = 'main';` `let sessionsCache = { activeId: 'main', list: [{ id: 'main', name: 'Main', createdAt: 0 }] };` `let sessionInputMode = null; // 'new' | 'rename' | null` `let confirmTimer = null;`
2. **`loadSessions()`** (place near `loadSettings`): `sessionsCache = await msg({ type: 'GET_SESSIONS' });` → `activeSessionId = sessionsCache.activeId || 'main';` → `renderSessionBar()`.
3. **`renderSessionBar()`**: clear `#session-select` (`textContent = ''`), append one `el('option', { value: s.id, text: s.name })` per session, set `.value = activeSessionId`. Set `disabled = (activeSessionId === 'main')` on `#session-rename`, `#session-merge`, `#session-delete`. Reset any `.confirming` state.
4. **Select change**: `#session-select` `change` → `await msg({ type: 'SET_ACTIVE_SESSION', sessionId: select.value })` → `activeSessionId = value; clearChannelFilter(false); loadVideos(); document.querySelector('.scroll-area').scrollTop = 0;`.
5. **Inline name input** — `enterNameMode(mode)`: hides `#session-select`, shows `#session-name-input` (prefill current name for `'rename'`, empty for `'new'`), focuses it. `keydown`: Enter → commit (`CREATE_SESSION` or `RENAME_SESSION` with `sessionId: activeSessionId`), then `exitNameMode(); loadSessions(); loadVideos();`. Escape or `blur` → `exitNameMode()` (cancel). `#session-new` click → `enterNameMode('new')`; `#session-rename` click → `enterNameMode('rename')`.
6. **Two-click confirm** — `armConfirm(btn, onConfirm)`: first click adds `.confirming` and sets a 3s timeout that disarms; second click while armed disarms and runs `onConfirm`. Wire `#session-delete` → `msg({ type: 'DELETE_SESSION', sessionId: activeSessionId })` then `loadSessions(); loadVideos();`. Wire `#session-merge` → `msg({ type: 'MERGE_SESSION', sourceSessionId: activeSessionId })` then same reload.
7. **Session filtering in `loadVideos()`**: after `const allVideos = await msg({ type: 'GET_VIDEOS' });` insert:
   ```js
   const sessionVideos = allVideos.filter(v => (v.sessionId || 'main') === activeSessionId);
   cachedVideos = sessionVideos;
   ```
   and use `sessionVideos` for the watched/unwatched splits. Add the channel filter to the chain after the star filter: `if (channelFilter) filtered = filtered.filter(v => (v.channel || '') === channelFilter);`.
8. **Channel filter functions**: `setChannelFilter(name)` → set var, `#channel-chip-name`.textContent = name, show chip, `loadVideos()`, scroll-area `scrollTop = 0`. `clearChannelFilter(reload = true)` → null the var, hide chip, optional `loadVideos()`. Wire `#channel-chip-clear` click → `clearChannelFilter()`.
9. **`buildVideoItem` changes**:
   - Replace `metaChildren[0]`: when `v.channel && v.channel !== 'Unknown'`, build `const chanSpan = el('span', { class: 'channel-link', title: 'Filter by ' + v.channel, text: v.channel }); chanSpan.addEventListener('click', e => { e.stopPropagation(); setChannelFilter(v.channel); });` else keep the plain span.
   - In the `dblclick` handler, extend the guard: `if (e.target.closest('select') || e.target.closest('button') || e.target.closest('.channel-link')) return;` (smart play itself needs no panel change — `openVideo(v.url)` already routes through `OPEN_VIDEO`).
   - `removeBtn`, `watchBtn`, `starBtn` messages: add `sessionId: activeSessionId` to the `REMOVE_VIDEO` / `UPDATE_VIDEO` payloads.
10. **Drag-drop scope**: in the `drop` handler, change both finds to `videos.find(v => v.id === X && (v.sessionId || 'main') === activeSessionId)` so a same-id entry in another session is never swapped. `SET_VIDEOS` still round-trips the full array (other sessions pass through untouched).
11. **`handleVideoUnpinned`**: change the `inQueue` check to use `cachedVideos` as-is (already session-filtered — document with a one-line comment that the 20%-rule applies to active-session videos only) but send the resulting `UPDATE_VIDEO` **without** `sessionId`… no — keep it scoped: include `sessionId: activeSessionId`. Watched-on-finish for other sessions is covered by the content script's `MARK_WATCHED`/`VIDEO_ENDED` paths.
12. **Storage listener**: extend the existing `chrome.storage.onChanged` handler:
    ```js
    if (area === 'local' && changes.yt_sessions) {
      sessionsCache = changes.yt_sessions.newValue || sessionsCache;
      const prev = activeSessionId;
      activeSessionId = sessionsCache.activeId || 'main';
      renderSessionBar();
      if (prev !== activeSessionId) { clearChannelFilter(false); }
      scheduleLoadVideos();
    }
    ```
13. **Init**: add `loadSessions().then(loadVideos)` — replace the bare `loadVideos()` call in the init block so the first render uses the correct session (otherwise a non-main active session would flash Main's list).

### Step 6 — `tests/test-sessions.js` (new) and test updates

See Section 6.

### Step 7 — `package.json` + `CLAUDE.md`

- Add `"test:sessions": "node tests/test-sessions.js"` and append `&& node tests/test-sessions.js` to `test:all`.
- CLAUDE.md gotchas to append: missing `sessionId` reads as `'main'`; session mutations order videos-update before sessions-update; Q/W badges are session-agnostic by design; `prompt()`/`confirm()` unavailable in the panel (inline input + two-click confirm).

## 5. Edge cases & failure modes

| Case | Handling |
|---|---|
| Existing installs: videos without `sessionId`, no `yt_sessions` key | `onInstalled` backfills + seeds; every read path also applies `(v.sessionId \|\| 'main')` and `getSessions()` defaults, so behavior is correct even before/without migration (e.g. worker updated mid-session). |
| `yt_sessions` corrupt (not an object / empty list) | `getSessions()` and the in-update `normalize` fall back to a `DEFAULT_SESSIONS` clone; next write repairs the key. |
| Deleting the active session | Worker sets `activeId = 'main'` in the same sessions update; panel follows via `storage.onChanged`. |
| Worker dies between the two updates of DELETE/MERGE | Order is videos-first: worst case is an empty (delete) or emptied-but-listed (merge) source session, visible and harmless; user can delete it again. Orphaned-invisible-videos is impossible by construction. |
| Same videoId in two sessions | Allowed. Panel mutations carry `sessionId` (scoped); content-script `MARK_WATCHED` marks all entries (a watched video is watched everywhere); badges are id-based (union) so unchanged. |
| Merge with duplicate ids | Main entry wins; `starred` OR'd, `watched` AND'd; response reports `moved`/`duplicates`. |
| Intercept/Collect while a non-main session is active | Videos land in the active session (decided behavior); switching back to Main shows it unchanged. |
| Autoplay/Skip with non-main active session | Panel-supplied orders are already filtered; worker fallback filters by `getActiveSessionId()` — playback never jumps to a hidden session's video. |
| `CLOSE_VISIBLE_TABS` | Already correct: panel sends ids from the session-filtered `dataVideos`/`dataShorts`. Worker still never closes the active tab. |
| Channel filter hides everything (0 results) | Existing empty-state path renders "No videos"; the visible chip explains why; clear restores. |
| Channel renamed upstream / enrichment changes `v.channel` while filtered | Filter is an exact string match against current data; a `VIDEOS_UPDATED` reload naturally drops/keeps cards. Ephemeral filter means no stale persisted state. |
| Click vs double-click on channel name | `dblclick` guard `closest('.channel-link')` prevents play; `stopPropagation` on click keeps card handlers inert. Two rapid clicks on the channel just re-apply the same filter (idempotent). |
| Channel is `'Unknown'`/empty | Span rendered non-clickable — no placeholder filtering. |
| Smart play: video open in a minimized/other window | `tabs.update {active:true}` + `windows.update {focused:true}` (wrapped in try/catch — focus can be refused; tab activation still succeeded). |
| Smart play: multiple matching tabs | Prefer last-focused window's match, else first. |
| Smart play: matching tab is mid-navigation (`tab.url` not yet the watch URL) | Falls through to normal OPEN_VIDEO — acceptable rare duplicate; no crash. |
| Smart play: the matched tab is the tab the panel's gesture came from | `tabs.update` on the already-active tab is a no-op; returns `{focused:true}` — fine. |
| Smart play must not bypass hostname validation | Matching uses `extractVideoId(t.url)` which internally requires `isYouTubeHost` — lookalike hosts can't be focused. |
| Middle-click bypass with slow-loading tab | Existing 30s whitelist TTL (`whitelistExtensionTab(tab.id, 30000)`) covers it; TTL maps live in `chrome.storage.session` so a worker restart mid-load doesn't lose the bypass. |
| Two panels open (two windows) | Active session is global; both panels converge via `storage.onChanged(yt_sessions)`; no polling added. |
| Virtual scroll during session switch / filter change | Both paths call `loadVideos()` which clears `lastRenderKeys` and resets heights; `CARD_HEIGHT` untouched; renders still suppressed during drag (`dragInProgress` path unchanged). |
| Rename to empty string | Worker rejects (`{error}`); panel input simply exits name mode without change. |
| Session select keyboard/UI overflow | Long names ellipsize (`min-width: 0` + native select truncation); names capped at 40 chars on write. |

## 6. Test plan

### New: `tests/test-sessions.js` (headless, follows the `check()`/`launchPersistentContext` pattern of `test-event-driven.js`)

Setup: launch with `--load-extension`, get `sw` + `extensionId`, open `chrome-extension://${extensionId}/sidepanel/sidepanel.html` as `panel` (viewport 350×900). All extension messages are sent via `panel.evaluate(() => chrome.runtime.sendMessage({...}))` (the SW cannot message itself).

1. **Session bar boots** — `#session-select` exists; exactly one option `Main`; `#session-rename/#session-merge/#session-delete` are `disabled` on Main.
2. **CREATE_SESSION** — send `{type:'CREATE_SESSION', name:'Research'}`; assert response `{session.id, activeId === session.id}`; after ≤1s, select has 2 options and `select.value` is the new id (storage.onChanged drove the panel).
3. **Session-scoped lists** — seed `yt_videos` via `sw.evaluate(chrome.storage.local.set)` with 3 videos `sessionId:'main'`, 2 with the new session's id, 1 legacy video with **no** `sessionId`; assert `#video-count` shows 2 (active = Research); send `SET_ACTIVE_SESSION main`; assert count becomes 4 (3 + legacy fallback) — this also pins the missing-`sessionId`→main rule.
4. **Rename via inline input** — click `#session-rename` is disabled on Main → switch to Research, click `#session-rename`, assert `#session-name-input` visible, fill `'Deep Work'`, press Enter; assert option text updated and `yt_sessions.list` reflects it.
5. **MERGE_SESSION** — add one duplicate id to both Main and Research (Research copy `starred:true`, Main copy `starred:false`); send `MERGE_SESSION {sourceSessionId}`; assert `{moved, duplicates:1}`, `yt_videos` has no Research-session entries, the dup kept Main's `addedAt` but `starred === true`, session list back to 1 entry, `activeId === 'main'`.
6. **DELETE_SESSION** — create a session with 2 seeded videos; two-click `#session-delete` (`click(); click();`) or send the message directly; assert videos gone from `yt_videos`, select back to Main, `removedVideos === 2`. Also assert `DELETE_SESSION {sessionId:'main'}` returns `{error}`.
7. **Channel filter** — seed 4 videos in Main with channels `A,A,B,Unknown`; wait for render; `panel.click('.channel-link >> nth=0')` (channel A); assert `#video-count === 2`, `#channel-chip` visible with name `A`; type `q` into search matching only one A-video title → assert AND semantics (`count === 1`); click `#channel-chip-clear` → count back to 4. Assert the `Unknown` card's channel span has **no** `.channel-link` class.
8. **Channel click does not play** — record `chrome.tabs.query` count before/after the channel click; unchanged (no OPEN_VIDEO fired).
9. **Smart play** — `context.route('https://www.youtube.com/watch?v=SMARTPLAY01', fulfill stub HTML)`; open it in a `context.newPage()`; from `panel`, send `OPEN_VIDEO {url:'https://www.youtube.com/watch?v=SMARTPLAY01'}`; assert response `{focused:true}` and `tabId` equals the stub tab's id (via `chrome.tabs.query` for that URL) and `context.pages().length` did not grow. Then send `OPEN_VIDEO` for `SMARTPLAY02` (no open tab) and assert legacy `{replaced}`/new-tab behavior still returns (regression on the fall-through).
10. **VIDEO_ENDED session scoping** — seed Main + a second session, set second active, set `yt_next_video_order: []`, enable `autoPlayNext`; from a routed fake watch page's content-script context this is heavy — instead assert at the worker level by seeding and sending `VIDEO_ENDED` from a routed `www.youtube.com` page (same technique as `test-event-driven.js`); assert the navigated-to URL belongs to the active session's only unwatched video.

### Updates to existing suites

- **`tests/test-extension.js`** (smoke): add static checks — `#session-select`, `#session-new`, `#session-rename`, `#session-merge`, `#session-delete`, `#channel-chip` present (chip hidden by default: `display:none`); screenshot now includes the session bar (visual diff via `screenshots/sidepanel.png`).
- **`tests/test-tab-management.js`** (middle-click bypass regression — the "verify, don't rebuild" deliverable): with `interceptEnabled:'close'`, route `https://www.youtube.com/watch?v=MIDCLICK001`; seed one card in the panel and dispatch `new MouseEvent('auxclick', {button:1, bubbles:true})` on `.video-item` (or, as a fallback assertion at the message layer, send `OPEN_VIDEO_NEW_TAB` directly); wait 2.5s (interception window is 10s TTL but resolution is immediate on `onUpdated`); assert (a) the tab still exists, (b) `yt_videos` did NOT gain `MIDCLICK001` (bypass = no queue add), (c) `yt_logged_videos` also unchanged by this path. Reset intercept to `'off'` afterward.
- **`tests/test-races.js`**: add one check — 10 concurrent `CREATE_SESSION` calls produce 10 distinct sessions and a valid `activeId` (exercises the sessions key under the mutex).

### Headed/live only (manual, via `tests/test-panel-live.js` pattern)

- `chrome.windows.update({focused:true})` actually raising a second OS window (headless has no real window focus) — verify smart play across two windows by eye.
- Real YouTube channel names rendering/click feel on live cards, and session switcher ergonomics in the real 320–400px side panel (not an emulated page).
- Middle-click as a real pointer gesture (Playwright `mouse.click(x, y, {button:'middle'})` on a headed panel page) — the headless suite only covers the synthetic-event and message layers.

## 7. Risks & explicitly out-of-scope

**Risks**

1. **Contract reconciliation:** other feature groups (badges/indicators, analytics, shorts) read `yt_videos` by id. The `sessionId` field and the "missing ⇒ main" rule must be propagated to their plans; the "badges = union of sessions" decision must be ratified or those groups will need session-aware filtering in `content.js`.
2. **`SET_VIDEOS` full-array round-trip:** drag-drop still replaces the entire `yt_videos` array from a panel snapshot. The panel reads-then-writes quickly and the mutex serializes the write, but a concurrent worker insert between the panel's `GET_VIDEOS` and `SET_VIDEOS` can still be dropped (pre-existing risk, now slightly wider because the array carries all sessions). Mitigation candidate (out of scope here): a `REORDER_VIDEOS {idA,idB,field}` message that swaps inside one `storage.update`.
3. **Global active session vs. multi-window users:** a user with two windows on different "projects" cannot have different active sessions per window. Accepted simplification; revisit only on real demand (would need `chrome.storage.session` window-map).
4. **Smart play URL staleness:** `tabs.query` sees committed URLs; a tab still navigating to the target video won't match and a duplicate open can occur. Rare and self-healing; not worth a pending-navigation tracker.
5. **`windows.update({focused:true})` is best-effort:** some platforms/window states refuse focus steal; wrapped in try/catch so tab activation still wins.
6. **Storage growth:** sessions multiply queue size in one key. `chrome.storage.local` (10MB) holds tens of thousands of video objects — not a practical limit, but noted for the analytics group which shares the budget.

**Explicitly out of scope (named, with closest achievable alternative where platform-limited)**

- **Per-window active sessions** — platform-feasible but deliberately excluded (see Risk 3); alternative: global pointer.
- **Native `prompt()`/`confirm()` dialogs for session naming/deletion** — suppressed in extension panel documents; alternative implemented: inline input + two-click confirm.
- **Merge into arbitrary targets / copy-merge / session reordering / session colors-icons** — spec only requires merge-into-Main as a move.
- **"Open as tab" indicator on side-panel thumbnails** (Features-Refined "Status Indicators & Badges") — belongs to the badges group; smart play's tab lookup is a natural helper for it later, but no indicator is built here.
- **Session-scoped watch-time stats** — watch time stays global (`yt_watch_time` untouched).
- **Persisting the channel filter across panel reloads** — intentionally ephemeral (decision #11).
- **Exporting/importing sessions** — analytics/backup territory, not list-panel.
