# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Chrome Manifest V3 extension — "YouTube Tab Manager". Manages YouTube video queues in a side panel, tracks watch time, and controls volume/speed.

## Commands

- `npm test` — Run Playwright headless tests (loads extension in Chromium, screenshots to `screenshots/`)
- `npm run test:headed` — Same but visible browser
- `npm run test:debug` — Headed + browser stays open for inspection
- `npm run generate-icons` — Regenerate PNG icons from `scripts/generate-icons.js`
- Tests verify: popup elements, side panel UI, slider interactions, toggle states, service worker initialization, console errors

## Architecture

**No build step.** All files are plain JS served directly by Chrome. No bundler, no TypeScript.

### Module System

- **Service worker** (`background/service-worker.js`): ES module (`"type": "module"` in manifest). Imports from `utils/`.
- **Content script** (`content/content.js`): IIFE, self-contained. Cannot use ES imports. Communicates via `chrome.runtime.sendMessage`.
- **Popup** (`popup/popup.js`): Shows tab stats (total, duplicates, shorts) with delete actions, volume/speed sliders, side panel opener. Plain script, no `type="module"`.
- **Side panel** (`sidepanel/sidepanel.js`): Plain script (no `type="module"`). Constants are inlined, not imported.

### Message-Passing Architecture

All state lives in `chrome.storage.local`. Every UI surface (popup, side panel, content script) communicates through `chrome.runtime.sendMessage` → service worker's `handleMessage()` switch. Message types are defined in `utils/constants.js` as `MSG.*`.

Key message flows:
- Side panel → `MSG.GET_VIDEOS` → service worker reads storage → returns array
- Content script → `MSG.MARK_WATCHED` → service worker updates storage → broadcasts `VIDEOS_UPDATED`
- Side panel → `MSG.MEDIA_CONTROL` → service worker → `chrome.tabs.sendMessage` → content script controls `<video>`

### Tab Interception

New YouTube tabs are caught via `chrome.tabs.onCreated` + `chrome.tabs.onUpdated`. Extension-opened tabs are whitelisted in `extensionOpenedTabs` Set to prevent self-interception.

### Content Script YouTube Integration

- Volume >100% uses Web Audio API `GainNode` chain (lazy init on first boost)
- YouTube is a SPA — `MutationObserver` on `document.body` detects URL changes
- Upload date extracted from `<script type="application/ld+json">` structured data
- Settings auto-applied on `loadeddata` event of `<video>` element

### Side Panel Layout

- `.sticky-top` (flex-shrink: 0) — header, toggle bar, sliders, media controls, sort/filter
- `.scroll-area` (flex: 1, overflow-y: auto) — video lists, watched section
- Videos/Shorts shown via content tabs (only one visible at a time)
- DOM built with safe `el()` helper — no `innerHTML` with user data (security hook enforced)

## Key Gotchas

- `chrome.sidePanel.open()` requires user gesture context — call from popup click handlers or service worker `action.onClicked`
- Hidden checkboxes (custom toggle styling) need `{ force: true }` or `evaluate(() => el.click())` in Playwright tests
- Content script `AudioContext` for volume boost may require `audioContext.resume()` if created before user interaction
- `fetchVideoDetails()` fetches raw YouTube HTML — regex patterns for metadata must handle multiple YouTube response formats
- Drag-and-drop reorder works by swapping the active sort field value (addedAt/duration/uploadedAt) between dragged and target videos; refresh button re-fetches real values
- Side panel visibility per-tab: `chrome.sidePanel.setOptions({ tabId, enabled: boolean })`
- Volume for non-YouTube tabs uses `chrome.scripting.executeScript` (requires `scripting` permission + `<all_urls>`)
- Volume slider (0–1000) and speed slider (0–100) are scaled so both defaults (100%, 1.0x) sit at 10% of range — keep ranges proportional when modifying
- Toggle bar buttons use `data-desc` attribute for hover descriptions shown in `#toggle-desc`; any new button in `.toggle-bar` must include `data-desc`. The JS listener targets `.toggle-bar [data-desc]` — description persists after mouse leaves (no `mouseleave` reset).
- Re-opening a video already in the queue updates its `addedAt` to current time (bumps to top of "Added" sort)
- `CLOSE_YT_TABS` and `CLOSE_SHORTS_TABS` always preserve the active tab — never close what the user is watching
