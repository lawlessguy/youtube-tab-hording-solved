/**
 * Live E2E (headed): opens real Chrome, loads a real YouTube watch page,
 * queues videos, opens the actual side panel with a trusted click, and
 * captures a desktop screenshot (screenshots/live-panel.png) showing it.
 * Run manually: node tests/test-panel-live.js
 */
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');

const extensionPath = path.resolve(__dirname, '..');
const shotPath = path.join(extensionPath, 'screenshots', 'live-panel.png');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    console.log('  ✔ ' + label);
    passed++;
  } else {
    console.log('  ✘ ' + label + (detail ? ' — ' + detail : ''));
    failed++;
  }
}

(async () => {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--start-maximized',
    ],
    viewport: null, // let the window size rule
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extensionId = sw.url().split('/')[2];

  await sw.evaluate(() => {
    self.__errors = [];
    const orig = console.error;
    console.error = (...a) => { self.__errors.push(a.map(String).join(' ')); orig(...a); };
  });

  // Real YouTube watch page
  console.log('Opening YouTube watch page...');
  const ytPage = await context.newPage();
  await ytPage.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
    waitUntil: 'domcontentloaded', timeout: 60000,
  });
  await ytPage.waitForTimeout(4000);
  const ytTabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: '*://www.youtube.com/watch*' });
    return tabs[0]?.id;
  });
  check('YouTube tab present (id ' + ytTabId + ')', typeof ytTabId === 'number');

  // Seed the queue through the real message path (broadcasts fire)
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await popup.waitForTimeout(500);
  await popup.evaluate(async () => {
    const ids = ['jNQXAC9IVRw', '9bZkp7q19f0', 'kJQP7kiw5Fk'];
    for (const id of ids) {
      await chrome.runtime.sendMessage({
        type: 'ADD_VIDEO',
        url: 'https://www.youtube.com/watch?v=' + id,
      });
    }
  });
  const queueCount = await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_videos');
    return (r.yt_videos || []).length;
  });
  check('3 videos queued via ADD_VIDEO (got ' + queueCount + ')', queueCount >= 3);

  // Open the REAL side panel for the ACTIVE YouTube tab (the real user
  // flow) via a trusted click on the background popup page. force: true
  // bypasses actionability checks (background tabs aren't rendered).
  await popup.evaluate((tabId) => {
    const btn = document.createElement('button');
    btn.id = 'live-open-panel';
    btn.textContent = 'open panel for yt tab';
    btn.addEventListener('click', () => {
      chrome.sidePanel.open({ tabId }).catch(e => { window.__openErr = e.message; });
    });
    document.body.appendChild(btn);
  }, ytTabId);

  const widthBefore = await ytPage.evaluate(() => window.innerWidth);
  await ytPage.bringToFront();
  await popup.click('#live-open-panel', { force: true });
  await ytPage.waitForTimeout(3000);

  const openErr = await popup.evaluate(() => window.__openErr || null);
  check('sidePanel.open() succeeded for YouTube tab', openErr === null, openErr);

  const panelContexts = await sw.evaluate(() =>
    chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }));
  check('SIDE_PANEL context exists', panelContexts.length > 0);

  // Pixel-level proof: an open panel takes horizontal space from the page
  const widthAfter = await ytPage.evaluate(() => window.innerWidth);
  check('Panel visibly occupies space (page width ' + widthBefore + ' → ' + widthAfter + ')',
    widthAfter <= widthBefore - 200);

  await ytPage.waitForTimeout(2500); // let metadata enrichment land in the panel

  // --- Real telemetry end-to-end (plan 06 §6 headed item) ---
  // ≥35s of real playback must yield a watch_progress event whose title and
  // channel were scraped from the live DOM, with a plausible maxPercent.
  // (Export from the genuine side-panel chrome remains a MANUAL check: the
  // side panel window is not driveable by Playwright clicks.)
  console.log('Playing the video ~45s to capture real watch telemetry...');
  await sw.evaluate(() => chrome.storage.local.set({
    yt_activity_log: { v: 1, seq: 0, events: [] },
  }));
  await ytPage.bringToFront();
  await ytPage.evaluate(() => {
    const v = document.querySelector('video');
    if (v) { v.muted = true; return v.play().catch(() => {}); }
  });
  await ytPage.waitForTimeout(45000); // one 30s flush + slack
  const wpEvent = await sw.evaluate(async () => {
    const r = await chrome.storage.local.get('yt_activity_log');
    return (r.yt_activity_log?.events || [])
      .filter(e => e.type === 'watch_progress').pop() || null;
  });
  check('watch_progress captured from real playback', !!wpEvent, JSON.stringify(wpEvent));
  check('Telemetry title scraped from the live DOM',
    typeof wpEvent?.title === 'string' && wpEvent.title.length > 0,
    JSON.stringify(wpEvent?.title ?? null));
  check('Telemetry channel scraped from the live DOM',
    typeof wpEvent?.channel === 'string' && wpEvent.channel.length > 0,
    JSON.stringify(wpEvent?.channel ?? null));
  check('Telemetry secondsWatched plausible (≥20)',
    typeof wpEvent?.secondsWatched === 'number' && wpEvent.secondsWatched >= 20,
    String(wpEvent?.secondsWatched));
  check('Telemetry maxPercent plausible (1–100)',
    typeof wpEvent?.maxPercent === 'number' &&
    wpEvent.maxPercent >= 1 && wpEvent.maxPercent <= 100,
    String(wpEvent?.maxPercent));

  // Desktop screenshot — page.screenshot can't capture browser chrome.
  // execFileSync with an argument array: no shell string interpolation; the
  // path lands in a PS single-quoted literal (backslashes are literal there).
  console.log('Capturing desktop screenshot...');
  const psScript =
    // DPI awareness first — otherwise Bounds is virtualized and the capture
    // crops off the right side of the screen (where the panel is)
    "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();' -Name U -Namespace W; " +
    '[W.U]::SetProcessDPIAware() | Out-Null; ' +
    'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ' +
    '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ' +
    '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; ' +
    '$g=[System.Drawing.Graphics]::FromImage($bmp); ' +
    '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); ' +
    "$bmp.Save('" + shotPath + "'); " +
    '$g.Dispose(); $bmp.Dispose()';
  execFileSync('powershell', ['-NoProfile', '-Command', psScript]);
  console.log('  Screenshot: screenshots/live-panel.png');

  const swErrors = await sw.evaluate(() => self.__errors);
  check('No service worker errors during the whole flow', swErrors.length === 0,
    JSON.stringify(swErrors));

  await context.close();

  console.log('\n=============================');
  console.log('Live panel: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Live panel test failed to run:', err);
  process.exit(1);
});
