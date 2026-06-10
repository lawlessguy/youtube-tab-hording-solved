# Progress Journal

> Maintained automatically. **Current State** is rewritten each session and is the
> only section a new session needs to read. The **Journal** below is append-only,
> newest first — consult it only when history matters.

## Current State

**Project:** YouTube Tab Manager — Chrome MV3 extension that queues YouTube videos in a side panel, tracks watch time, and controls volume/speed across tabs.
**Status:** Active development — post-audit hardening complete, fully tested.
**Last session:** 2026-06-10 — Fixed all 20+ findings from a full-codebase review, then root-caused and fixed the side panel never opening.

**Where things stand:**
- All review findings fixed: AudioContext mute bug, storage write races (now serialized through a `storage.update()` mutex), media controls routing to the wrong tab, virtual scroll geometry, tab-management guards, hostname-validated URLs, and polling replaced by `storage.onChanged` events.
- Side panel opening works end-to-end — root cause was tab-scoped `sidePanel.setOptions` entries needing an explicit `path` (they don't inherit the manifest default).
- Dead code removed (~400 lines incl. unreachable Gemini categorization subsystem); CLAUDE.md rewritten with the new invariants.
- Test battery: 78 checks across 8 headless suites (`npm run test:all`) plus two manual headed tests (`test-panel-live.js`, `test-indicators.js`). All green.
- Branch `claude/modest-einstein-ktsiwj`, pushed through `8c6e7b9`. Not yet merged to `main`.

**Next up:**
- Merge the branch to `main` (or open a PR) once the user confirms the panel works in their daily Chrome.
- User to verify intercept 'close' behavior change is acceptable: foreground-opened videos are now queued but the tab stays open.

**Open decisions / blockers:**
- None.

---

## Journal

### 2026-06-10 — Full audit fix campaign + side panel root-cause
- Fixed all findings from the prior full-codebase review ("ultrareview"), one verified commit per theme:
  - **H1:** volume boost muted videos — suspended `AudioContext` (created without user activation) silences everything once `createMediaElementSource` reroutes audio; now resumed on volume changes and from the playback tick.
  - **H3:** all `chrome.storage.local` mutations serialized through a promise-queue mutex in `utils/storage.js`; network fetches moved outside critical sections. Negative control on the old code: 20 concurrent watch-time ticks recorded 1 minute, 10 concurrent adds kept 1 video.
  - **H2:** `GET_MEDIA_STATE` now returns `tabId`; media commands and Skip target the displayed tab instead of the active one.
  - **M1–M3:** `.scroll-area` is `position: relative` (virtual scroller's `offsetTop` was off by the sticky-header height); per-container render keys (watched list rebuilt every scroll frame); drags survive re-renders.
  - **M5/M6/M8:** intercept state mirrored in `chrome.storage.session` (survives MV3 worker restarts); intercept-close and duplicate-removal never close the active tab; panel enablement follows same-tab navigation.
  - **M7:** hostname allowlist (`isYouTubeHost`) replaces `url.includes('youtube.com')` everywhere — lookalike URLs can't enter the queue.
  - **M4:** polling storm removed — content scripts use `storage.onChanged` + mutation-throttled refresh; panel debounces update bursts; all-tabs media scan rate-limited to 10s.
  - Cleanup: dead Gemini subsystem, 5 dead message handlers, ~120 lines dead CSS, time-formatting bugs ("1h 60m"), speed slider min (playbackRate 0 froze video), silent-log cap.
- Then debugged "side panel won't open" reported from real Chrome through three layers: (1) awaited `setOptions` before `open()` consumes the click gesture; (2) un-awaited `setOptions` races `open()` validation; (3) **root cause:** tab-scoped options without `path` make `open()` throw "No active side panel for tabId" — the extension had always written path-less entries. Fix: always pass `path` when enabling; popup pre-enables at popup-open time so the click handler keeps the gesture.
- Verified live in headed Chrome: trusted click → panel opens on a real YouTube tab, page width shrank 2195→1816px (panel column), DPI-aware desktop screenshot captured (`screenshots/live-panel.png`), zero worker errors.
- Built 6 new test suites (races, virtual scroll, media routing, tab management, URL validation, event-driven, panel gesture) — 78 checks total; fixed the smoke suite's console-error capture which was registered too late to ever catch anything.
- Tooling lesson: PowerShell 5.1 `Get-Content`/`Set-Content` mangled UTF-8 source (mojibake) — one file restored from git; noted in CLAUDE.md.
- **Next:** merge to `main` after user confirms the panel works in daily use.

### 2026-04-05 — Virtual scrolling
- Added virtual scrolling to the side panel video lists for performance: only the visible card window (±8 buffer) is mounted; spacer divs preserve scroll height (`CARD_HEIGHT = 63`).
- **Next:** (not recorded at the time).

### 2026-03-31 — Founding + major redesign
- Initial commit: YouTube Tab Manager MV3 extension — service worker, content script, popup, side panel; queue storage in `chrome.storage.local`; Playwright smoke-test harness.
- Same-day major redesign: now-playing priority slot with media controls, 3-state tab intercept (off/close/keep), star tags via Ctrl+middle-click, Q/W thumbnail indicators on YouTube pages, full-width hide-recommendations mode with comments moved to the sidebar.
- **Next:** (not recorded at the time).
