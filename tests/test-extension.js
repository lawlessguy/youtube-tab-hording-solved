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

  // --- Test 1: Popup ---
  console.log('\n--- Test 1: Popup UI ---');
  const popup = await context.newPage();
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

  await popup.screenshot({ path: path.join(screenshotDir, 'popup.png') });
  console.log('  Screenshot: screenshots/popup.png');

  // --- Test 2: Side Panel ---
  console.log('\n--- Test 2: Side Panel UI ---');
  const sidePanel = await context.newPage();
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

  // --- Test 6: Console Errors ---
  console.log('\n--- Test 6: Console Errors ---');
  const errors = [];
  popup.on('console', m => { if (m.type() === 'error') errors.push('[popup] ' + m.text()); });
  sidePanel.on('console', m => { if (m.type() === 'error') errors.push('[sidepanel] ' + m.text()); });
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
