const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const extensionPath = path.resolve(__dirname, '..');
const screenshotDir = path.join(extensionPath, 'screenshots');
const args = process.argv.slice(2);
const headed = args.includes('--headed');
const keepOpen = args.includes('--keep-open');

let passed = 0;
let failed = 0;

function check(label, condition) {
  if (condition) {
    console.log('  \u2714 ' + label);
    passed++;
  } else {
    console.log('  \u2718 ' + label);
    failed++;
  }
}

async function run() {
  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }

  console.log('Extension path:', extensionPath);
  console.log('Mode:', headed ? 'headed' : 'headless');
  console.log('');

  // Launch Chromium with extension
  console.log('Launching Chromium...');
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: !headed,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  // Wait for service worker
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    console.log('Waiting for service worker...');
    sw = await context.waitForEvent('serviceworker', { timeout: 10000 });
  }
  const extensionId = sw.url().split('/')[2];
  console.log('Extension ID:', extensionId);

  // Console errors are collected from page creation onward (registering the
  // listeners after the interactions missed everything that mattered)
  const errors = [];
  function watchConsole(page, label) {
    page.on('console', m => { if (m.type() === 'error') errors.push('[' + label + '] ' + m.text()); });
    page.on('pageerror', e => errors.push('[' + label + '] ' + e.message));
  }

  // --- Test 1: Popup ---
  console.log('\n--- Test 1: Popup UI ---');
  const popup = await context.newPage();
  watchConsole(popup, 'popup');
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.setViewportSize({ width: 400, height: 600 });
  await popup.waitForTimeout(1000);

  check('Popup loads', await popup.title() !== undefined);
  check('Tab count visible', !!(await popup.$('#yt-tabs')));
  check('Duplicate count visible', !!(await popup.$('#duplicate-tabs')));
  check('Shorts count visible', !!(await popup.$('#shorts-tabs')));
  check('Volume slider present', !!(await popup.$('#volume-slider')));
  check('Speed slider present', !!(await popup.$('#speed-slider')));
  check('Open side panel button present', !!(await popup.$('#open-sidepanel')));
  check('In-page queue toggle present', !!(await popup.$('#inpage-queue-toggle')));

  await popup.screenshot({ path: path.join(screenshotDir, 'popup.png') });
  console.log('  Screenshot: screenshots/popup.png');

  // --- Test 2: Side Panel ---
  console.log('\n--- Test 2: Side Panel UI ---');
  const sidePanel = await context.newPage();
  watchConsole(sidePanel, 'sidepanel');
  await sidePanel.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  await sidePanel.setViewportSize({ width: 350, height: 900 });
  await sidePanel.waitForTimeout(1000);

  check('Side panel loads', await sidePanel.title() !== undefined);
  check('Watch time bar visible', !!(await sidePanel.$('.watch-bar')));
  check('Toggle bar present', !!(await sidePanel.$('.toggle-bar')));
  check('Collect button present', !!(await sidePanel.$('#collect-tabs')));
  check('Content tabs present', !!(await sidePanel.$('.content-tabs')));
  check('Sort buttons present', !!(await sidePanel.$('.sort-btns')));
  check('Video list container present', !!(await sidePanel.$('#video-list')));
  check('Shorts list container present', !!(await sidePanel.$('#shorts-list')));
  check('Watched section present', !!(await sidePanel.$('#watched-list')));
  check('Now playing container present', !!(await sidePanel.$('#now-playing')));
  check('Close tabs button present', !!(await sidePanel.$('#close-tabs')));
  check('Sticky top present', !!(await sidePanel.$('.sticky-top')));
  check('Scroll area present', !!(await sidePanel.$('.scroll-area')));

  // Session bar + channel chip (stage 04 list-panel)
  check('Session select present', !!(await sidePanel.$('#session-select')));
  check('Session new button present', !!(await sidePanel.$('#session-new')));
  check('Session rename button present', !!(await sidePanel.$('#session-rename')));
  check('Session merge button present', !!(await sidePanel.$('#session-merge')));
  check('Session delete button present', !!(await sidePanel.$('#session-delete')));
  const chipHidden = await sidePanel.evaluate(() => {
    const chip = document.getElementById('channel-chip');
    return chip ? getComputedStyle(chip).display === 'none' : null;
  });
  check('Channel chip present but hidden by default', chipHidden === true);

  // Analytics (stage 06): Export in the SECOND toggle-bar row + Suggest sort
  check('Export button present', !!(await sidePanel.$('#tb-export')));
  check('Export button has data-desc', !!(await sidePanel.$('#tb-export[data-desc]')));
  check('Export button lives in the secondary toggle-bar row',
    !!(await sidePanel.$('.toggle-bar--secondary #tb-export')));
  check('Suggested sort button present', !!(await sidePanel.$('.sort-btn[data-sort="suggested"]')));

  // Player (stage 02): Resize toggle in the secondary row, before Export
  check('Resize toggle present', !!(await sidePanel.$('#tb-resize')));
  check('Resize toggle has data-desc', !!(await sidePanel.$('#tb-resize[data-desc]')));
  check('Resize toggle lives in the secondary toggle-bar row before Export',
    !!(await sidePanel.$('.toggle-bar--secondary #tb-resize + #tb-export, .toggle-bar--secondary #tb-resize ~ #tb-export')));
  check('Resize toggle active by default (playerResizeEnabled true)',
    await sidePanel.evaluate(() => document.getElementById('tb-resize').classList.contains('active')));

  // Viewing modes (stage 01): slim-mode header toggle + Strip button first in
  // the secondary toggle-bar row (contract order: Strip / Resize / PiP / Export)
  check('Panel mode toggle present in header', !!(await sidePanel.$('header #panel-mode-toggle')));
  check('Strip toggle present', !!(await sidePanel.$('#tb-inpage')));
  check('Strip toggle has data-desc', !!(await sidePanel.$('#tb-inpage[data-desc]')));
  check('Strip toggle lives in the secondary toggle-bar row before Resize',
    !!(await sidePanel.$('.toggle-bar--secondary #tb-inpage + #tb-resize, .toggle-bar--secondary #tb-inpage ~ #tb-resize')));
  check('Strip toggle inactive by default (inPageQueue false)',
    await sidePanel.evaluate(() => !document.getElementById('tb-inpage').classList.contains('active')));

  await sidePanel.screenshot({ path: path.join(screenshotDir, 'sidepanel.png') });
  console.log('  Screenshot: screenshots/sidepanel.png');

  // --- Test 3: Popup Interactions ---
  console.log('\n--- Test 3: Popup Interactions ---');
  await popup.bringToFront();

  // Test volume slider (direct: value = display %)
  await popup.evaluate(() => {
    const slider = document.getElementById('volume-slider');
    slider.value = 500;
    slider.dispatchEvent(new Event('input'));
  });
  const volDisplay = await popup.textContent('#volume-value');
  check('Volume slider updates display', volDisplay === '500%');

  // Test speed slider
  await popup.evaluate(() => {
    const slider = document.getElementById('speed-slider');
    slider.value = 20;
    slider.dispatchEvent(new Event('input'));
  });
  const speedDisplay = await popup.textContent('#speed-value');
  check('Speed slider updates display', speedDisplay === '2.0x');

  // fmtSpeed regression (stage 02): off-slider-step speedLevel values (e.g.
  // a native 0.25x from YouTube's menu) render exactly, live via onChanged
  await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_settings');
    await chrome.storage.local.set({ yt_settings: { ...(r.yt_settings || {}), speedLevel: 0.25 } });
  });
  await popup.waitForTimeout(400);
  const offStepDisplay = await popup.textContent('#speed-value');
  check('Off-step speed 0.25 renders as 0.25x (got ' + offStepDisplay + ')',
    offStepDisplay === '0.25x');
  // Restore the default so later checks still see pristine settings
  await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_settings');
    await chrome.storage.local.set({ yt_settings: { ...(r.yt_settings || {}), speedLevel: 1.0 } });
  });
  await popup.waitForTimeout(300);

  await popup.screenshot({ path: path.join(screenshotDir, 'popup-interactions.png') });
  console.log('  Screenshot: screenshots/popup-interactions.png');

  // --- Test 4: Side Panel Interactions ---
  console.log('\n--- Test 4: Side Panel Interactions ---');
  await sidePanel.bringToFront();

  // Toggle intercept via button (3-state: off → close → keep)
  await sidePanel.evaluate(() => {
    document.getElementById('tb-intercept').click();
  });
  const interceptState = await sidePanel.evaluate(() => document.getElementById('tb-intercept').dataset.state);
  check('Intercept toggle works', interceptState === 'close');

  // Check empty states (videos tab is active by default)
  const emptyVideos = await sidePanel.textContent('#video-list');
  check('Empty video state shown', emptyVideos.includes('No videos'));

  await sidePanel.screenshot({ path: path.join(screenshotDir, 'sidepanel-interactions.png') });
  console.log('  Screenshot: screenshots/sidepanel-interactions.png');

  // --- Test 5: Service Worker ---
  console.log('\n--- Test 5: Service Worker ---');
  const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
  check('Manifest version is 3', manifest.manifest_version === 3);
  check('Extension name correct', manifest.name === 'YouTube Tab Manager');
  check('Side panel configured', !!manifest.side_panel);
  check('Content scripts configured', !!manifest.content_scripts?.length);

  // Test storage initialization
  const settings = await sw.evaluate(async () => {
    const result = await chrome.storage.local.get('yt_settings');
    return result.yt_settings;
  });
  check('Settings initialized', !!settings);
  check('Default volume is 100', settings?.volumeLevel === 100);
  check('Default speed is 1.0', settings?.speedLevel === 1.0);

  // Contract defaults added by the scaffolding stage
  check('Viewing-mode defaults present', settings?.inPageQueue === false && settings?.panelMode === 'full');
  check('Player defaults present', settings?.playerResizeEnabled === true
    && settings?.playerSizeDefault === null && settings?.playerSizeTheater === null);
  check('PiP defaults present', settings?.pipAutoEnabled === false
    && settings?.pipOpacity === 100 && settings?.pipSize === 'medium');
  check('Analytics/shorts defaults present', settings?.activityLogEnabled === true
    && settings?.shortsAutoScroll === false && settings?.shortsAutoClose === false);

  // Sessions storage initialized by onInstalled
  const sessions = await sw.evaluate(async () => {
    const result = await chrome.storage.local.get('yt_sessions');
    return result.yt_sessions;
  });
  check('Sessions initialized with activeId main', sessions?.activeId === 'main');
  check('Main session entry exists', Array.isArray(sessions?.list)
    && sessions.list.some(s => s.id === 'main' && s.name === 'Main'));

  // Legacy queue normalization: seed an entry missing sessionId/addCount, then
  // re-run the onInstalled migration via the worker-global helper (simulating
  // a real extension reload headless would close the popup/panel pages)
  const normalizedLegacy = await sw.evaluate(async () => {
    const legacy = {
      id: 'legacy00000', url: 'https://www.youtube.com/watch?v=legacy00000',
      title: 'Legacy', addedAt: 1, watched: false,
    };
    const before = await chrome.storage.local.get('yt_videos');
    await chrome.storage.local.set({ yt_videos: [...(before.yt_videos || []), legacy] });
    await self.normalizeLegacyVideos();
    const after = await chrome.storage.local.get('yt_videos');
    const v = (after.yt_videos || []).find(x => x.id === 'legacy00000');
    // Clean up so later tests still see an empty queue
    await chrome.storage.local.set({
      yt_videos: (after.yt_videos || []).filter(x => x.id !== 'legacy00000'),
    });
    return v;
  });
  check('Legacy video backfilled sessionId main', normalizedLegacy?.sessionId === 'main');
  check('Legacy video backfilled addCount 1', normalizedLegacy?.addCount === 1);

  // Secondary toggle-bar row scaffold: stage 06 appended #tb-export, so the
  // row is populated and the :empty auto-hide no longer applies
  const secondaryBar = await sidePanel.evaluate(() => {
    const el = document.querySelector('.toggle-bar--secondary');
    if (!el) return null;
    return { count: el.childElementCount, display: getComputedStyle(el).display };
  });
  check('Secondary toggle-bar row present', !!secondaryBar);
  check('Secondary toggle-bar visible once populated',
    secondaryBar?.count >= 1 && secondaryBar?.display !== 'none');

  // --- Test 6: Volume boost on a controlled page ---
  console.log('\n--- Test 6: Volume Boost ---');
  const BOOST_PAGE = '<!DOCTYPE html><html><head><title>b</title></head><body><video></video></body></html>';
  await context.route('https://www.youtube.com/__boost_test__', route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: BOOST_PAGE }));
  const boostPage = await context.newPage();
  watchConsole(boostPage, 'boost');
  await boostPage.goto('https://www.youtube.com/__boost_test__');
  await boostPage.waitForTimeout(1500); // content script init

  const boostTabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/__boost_test__' });
    return tabs[0]?.id;
  });
  await sw.evaluate(tabId =>
    chrome.tabs.sendMessage(tabId, { type: 'SET_VOLUME', value: 300 }), boostTabId);
  await boostPage.waitForTimeout(300);
  const boostVol = await boostPage.evaluate(() => document.querySelector('video').volume);
  check('Boost >100% pins element volume to 1 (got ' + boostVol + ')', boostVol === 1);

  await sw.evaluate(tabId =>
    chrome.tabs.sendMessage(tabId, { type: 'SET_VOLUME', value: 50 }), boostTabId);
  await boostPage.waitForTimeout(300);
  const halfVol = await boostPage.evaluate(() => document.querySelector('video').volume);
  check('Volume 50% applies after boost (got ' + halfVol + ')', halfVol === 0.5);
  await boostPage.close();

  // --- Test 7: Console Errors (collected since page creation) ---
  console.log('\n--- Test 7: Console Errors ---');
  await popup.waitForTimeout(500);

  if (errors.length > 0) {
    console.log('  Console errors found:');
    errors.forEach(e => console.log('    ' + e));
  }
  check('No console errors', errors.length === 0);

  // --- Summary ---
  console.log('\n=============================');
  console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');

  if (keepOpen) {
    console.log('\nBrowser open. Press Ctrl+C to close.');
    await new Promise(() => {});
  } else {
    await context.close();
  }

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
