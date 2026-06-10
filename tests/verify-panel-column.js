/**
 * THROWAWAY live verification probe (headed) — deferred item 7e:
 * Open the REAL side panel column via the panel-gesture flow, then desktop-
 * capture (virtual screen, window activated) with the new session bar +
 * second toggle row visible in the REAL chrome (not page-mode).
 * Run: node tests/verify-panel-column.js
 */
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const extensionPath = path.resolve(__dirname, '..');
const outDir = path.join(extensionPath, 'screenshots', 'verify');

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
  if (condition) { console.log('  ✔ ' + label); passed++; }
  else { console.log('  ✘ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

function activateWindow(title) {
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      "(New-Object -ComObject WScript.Shell).AppActivate('" + title + "') | Out-Null; Start-Sleep -Milliseconds 500"]);
  } catch {}
}
function captureDesktop(file) {
  const psScript =
    "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();' -Name U -Namespace W; " +
    '[W.U]::SetProcessDPIAware() | Out-Null; ' +
    'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ' +
    '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen; ' +
    '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; ' +
    '$g=[System.Drawing.Graphics]::FromImage($bmp); ' +
    '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); ' +
    "$bmp.Save('" + file + "'); " +
    '$g.Dispose(); $bmp.Dispose()';
  execFileSync('powershell', ['-NoProfile', '-Command', psScript]);
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });

  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--start-maximized',
    ],
    viewport: null,
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extensionId = sw.url().split('/')[2];

  await sw.evaluate(() => {
    self.__errors = [];
    const orig = console.error;
    console.error = (...a) => { self.__errors.push(a.map(String).join(' ')); orig(...a); };
  });
  await sw.evaluate(async () => {
    for (let i = 0; i < 50; i++) {
      const r = await chrome.storage.local.get(['yt_settings', 'yt_videos']);
      if (r.yt_settings && r.yt_videos) return;
      await new Promise(res => setTimeout(res, 100));
    }
  });

  console.log('Opening YouTube watch page...');
  const ytPage = await context.newPage();
  await ytPage.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
    waitUntil: 'domcontentloaded', timeout: 60000,
  });
  await ytPage.waitForTimeout(4000);
  await ytPage.evaluate(() => { const v = document.querySelector('video'); if (v) v.muted = true; });
  const ytTabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: '*://www.youtube.com/watch*' });
    return tabs[0]?.id;
  });

  // Queue a few videos through the real message path
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.waitForTimeout(500);
  await popup.evaluate(async () => {
    const ids = ['jNQXAC9IVRw', '9bZkp7q19f0', 'kJQP7kiw5Fk'];
    for (const id of ids) {
      await chrome.runtime.sendMessage({
        type: 'ADD_VIDEO', url: 'https://www.youtube.com/watch?v=' + id,
      });
    }
  });

  // Trusted-gesture open of the REAL side panel for the active YouTube tab
  await popup.evaluate((tabId) => {
    const btn = document.createElement('button');
    btn.id = 'live-open-panel';
    btn.textContent = 'open panel';
    btn.addEventListener('click', () => {
      chrome.sidePanel.open({ tabId }).catch(e => { window.__openErr = e.message; });
    });
    document.body.appendChild(btn);
  }, ytTabId);

  const widthBefore = await ytPage.evaluate(() => window.innerWidth);
  await ytPage.bringToFront();
  await popup.click('#live-open-panel', { force: true });
  await ytPage.waitForTimeout(3500);

  const openErr = await popup.evaluate(() => window.__openErr || null);
  check('sidePanel.open() succeeded', openErr === null, openErr);
  const panelContexts = await sw.evaluate(() =>
    chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }));
  check('SIDE_PANEL context exists', panelContexts.length > 0);
  const widthAfter = await ytPage.evaluate(() => window.innerWidth);
  check('Panel column occupies space (' + widthBefore + ' → ' + widthAfter + ')',
    widthAfter <= widthBefore - 200);

  // Can Playwright see the panel as a page? (informational — drives DOM
  // assertions about the new UI inside the REAL chrome if it can)
  const pageUrls = context.pages().map(p => p.url());
  console.log('  Page targets: ' + JSON.stringify(pageUrls));
  const panelPage = context.pages().find(p => p.url().includes('sidepanel.html'));
  if (panelPage) {
    const ui = await panelPage.evaluate(() => ({
      sessionBar: !!document.querySelector('.session-bar') &&
        getComputedStyle(document.querySelector('.session-bar')).display !== 'none',
      sessionSelect: !!document.getElementById('session-select'),
      secondRow: !!document.querySelector('.toggle-bar--secondary'),
      secondRowButtons: [...document.querySelectorAll('.toggle-bar--secondary .tb-btn')].map(b => b.id),
    }));
    check('REAL panel column renders the session bar', ui.sessionBar, JSON.stringify(ui));
    check('REAL panel column renders the second toggle row (Strip/Resize/PiP/Export)',
      ui.secondRowButtons.join(',') === 'tb-inpage,tb-resize,tb-autopip,tb-export',
      JSON.stringify(ui.secondRowButtons));
  } else {
    console.log('  (panel not driveable as a Playwright page — relying on the desktop capture)');
  }

  await ytPage.waitForTimeout(2000); // panel data load
  await ytPage.evaluate(() => { document.title = 'YTM VERIFY PANEL'; });
  activateWindow('YTM VERIFY PANEL');
  captureDesktop(path.join(outDir, 'panel-column-desktop.png'));
  console.log('  Screenshot: screenshots/verify/panel-column-desktop.png');

  const swErrors = await sw.evaluate(() => self.__errors);
  console.log('\nSW console.error entries (' + swErrors.length + '):');
  swErrors.slice(0, 10).forEach(e => console.log('   [sw] ' + e));
  check('No service-worker console.error entries', swErrors.length === 0,
    JSON.stringify(swErrors.slice(0, 5)));

  await context.close();

  console.log('\n=============================');
  console.log('Panel column probe: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Probe failed to run:', err);
  process.exit(1);
});
