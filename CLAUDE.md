# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Chrome Manifest V3 extension — "YouTube Tab Manager". Manages YouTube video queues in a side panel, tracks watch time, and controls volume/speed.

## Commands

- `npm test` — Run Playwright headless smoke tests (loads extension in Chromium, screenshots to `screenshots/`)
- `npm run test:headed` — Same but visible browser
- `npm run test:debug` — Headed + browser stays open for inspection
- `npm run generate-icons` — Regenerate PNG icons from `scripts/generate-icons.js`
- Targeted suites (all headless, run with `node tests/<file>`):
  - `test-races.js` — concurrent storage mutation correctness (lost updates, duplicate queue entries)
  - `test-virtual-scroll.js` — side panel virtual scroller (bounded DOM, correct window, node reuse)
  - `test-media-routing.js` — GET_MEDIA_STATE tabId + MEDIA_CONTROL routing (live YouTube page)
  - `test-tab-management.js` — duplicate removal, panel enablement, intercept guards (live tabs)
  - `test-url-validation.js` — hostile lookalike URLs stay out of queue/stats
  - `test-event-driven.js` — storage.onChanged badge/watch-time propagation (routed fake YouTube page)
  - `test-indicators.js` — manual headed test for thumbnail badges on real YouTube

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

Key flows:
- Side panel → `MSG.GET_VIDEOS` → service worker reads storage → returns array
- Content script → `MSG.MARK_WATCHED` → service worker updates storage → broadcasts `VIDEOS_UPDATED` (panel debounces these — enrichment fires them in bursts)
- Side panel → `MSG.MEDIA_CONTROL` (+ `tabId` from the last `GET_MEDIA_STATE`) → service worker → `chrome.tabs.sendMessage` to THAT tab → content script controls `<video>`
- Settings/queue changes propagate to content scripts via `chrome.storage.onChanged` — there is deliberately no polling and no `YT_UI_UPDATE`-style broadcast

### Tab Interception

New YouTube tabs are caught via `chrome.tabs.onCreated` + `chrome.tabs.onUpdated`. Extension-opened tabs are whitelisted to prevent self-interception. Both maps (`recentlyCreatedTabs`, `extensionOpenedTabs`) are TTL-based and mirrored in `chrome.storage.session` so an idle-killed worker doesn't lose them — never rely on `setTimeout` for cleanup in the worker; it dies with it. Intercept 'close' mode never closes the ACTIVE tab (queues it and keeps it open).

### Content Script YouTube Integration

- Volume >100% uses Web Audio API `GainNode` chain (lazy init on first boost)
- YouTube is a SPA — `MutationObserver` on `document.body` detects URL changes; the same observer drives a 1.5s-throttled thumbnail-badge/hideRecs refresh (no intervals on idle pages)
- Video-feature binding retries are capped (15 × 1s) and restarted by the SPA navigation handler — no infinite init loops on pages without a `<video>`
- Upload date extracted from `<script type="application/ld+json">` structured data
- Settings auto-applied on `loadeddata` event of `<video>` element
- A video is marked watched at 20% progress

### Side Panel Layout

- `.sticky-top` (flex-shrink: 0) — header, toggle bar, sliders, sort/filter, content tabs (media controls live in the now-playing card inside the scroll area)
- `.scroll-area` (flex: 1, overflow-y: auto, **position: relative — load-bearing**: the virtual scroller measures card windows via `offsetTop`, which must be relative to this scroll container)
- Video lists are virtualized: `CARD_HEIGHT = 63` must equal `.video-item` height (59px) + margin-bottom (4px); change them together
- Videos/Shorts shown via content tabs (only one visible at a time)
- DOM built with safe `el()` helper — no `innerHTML` with user data (security hook enforced)
- Re-renders are suppressed while a card drag is in progress (a rebuild destroys the dragged node and orphans the drop)

## Key Gotchas

- `chrome.sidePanel.open()` requires user gesture context — call from popup click handlers or service worker `action.onClicked`
- Hidden checkboxes (custom toggle styling) need `{ force: true }` or `evaluate(() => el.click())` in Playwright tests
- The volume-boost `AudioContext` reroutes ALL audio through itself via `createMediaElementSource` — if it is suspended (created without user activation) the video is silent at any volume. `resumeAudioContext()` is called on every volume change and from the tracking tick; keep that invariant when touching the boost path
- URL checks must validate hostnames via `isYouTubeHost()` (utils/youtube.js) — substring checks like `url.includes('youtube.com')` match hostile lookalike URLs
- `fetchVideoDetails()` fetches raw YouTube HTML — regex patterns for metadata must handle multiple YouTube response formats; `fetchVideoMetadata()` returns `null` on failure (callers keep placeholders)
- Drag-and-drop reorder works by swapping the active sort field value (addedAt/duration/uploadedAt) between dragged and target videos; refresh button re-fetches real values
- Side panel visibility per-tab: `chrome.sidePanel.setOptions({ tabId, enabled: boolean })` — kept in sync on activation AND same-tab navigation; the popup's open button re-enables before opening
- Volume for non-YouTube tabs uses `chrome.scripting.executeScript` (requires `scripting` permission + `<all_urls>`)
- Volume slider (0–1000) and speed slider (1–100) are scaled so both defaults (100%, 1.0x) sit at 10% of range — keep ranges proportional when modifying (speed min is 1: `playbackRate = 0` freezes the video)
- Toggle bar buttons use `data-desc` attribute for hover descriptions shown in `#toggle-desc`; any new button in `.toggle-bar` must include `data-desc`. The JS listener targets `.toggle-bar [data-desc]` — description persists after mouse leaves (no `mouseleave` reset).
- Re-opening a video already in the queue updates its `addedAt` to current time (bumps to top of "Added" sort)
- Every tab-closing path (`CLOSE_SHORTS_TABS`, `CLOSE_VISIBLE_TABS`, `REMOVE_DUPLICATES`, intercept 'close') preserves the active tab — never close what the user is watching
- PowerShell 5.1 `Get-Content`/`Set-Content` mangles this repo's UTF-8 files (em-dashes/arrows become mojibake) — use proper editing tools, not shell pipelines, for source edits
