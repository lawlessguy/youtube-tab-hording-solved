/**
 * Live E2E (headed, MANUAL): PiP stage (03) against REAL youtube.com.
 * Run manually: node tests/test-pip-live.js   (do NOT add to test:all)
 *
 * Verifies what headless cannot (trusted gestures + real always-on-top
 * PiP window compositing):
 *  - a trusted click on the panel's #np-pip-btn floats the REAL player:
 *    #movie_player leaves the main document, .ytm-pip-placeholder appears,
 *    documentPictureInPicture.window holds .ytm-pip-wrap
 *  - panel opacity slider live-drives the PiP document's --ytm-pip-op
 *  - strip 'L' click resizes the live window (gesture-legal inside the
 *    PiP window; Chrome may clamp — tolerance allowed)
 *  - clicking #np-pip-btn again (exitPip path) restores #movie_player,
 *    removes the placeholder, and playback survives the move-back
 *  - DPI-aware desktop capture shows the floating window over the browser
 *    (screenshots/stages/pip/live-*.png)
 *
 * AUTO-PIP MANUAL CHECKLIST (cannot be scripted — Media Engagement Index
 * and Chrome's per-site "Automatically enter picture-in-picture" permission
 * cannot be faked in a fresh profile):
 *   1. In your real Chrome profile with the extension loaded, enable the
 *      PiP toggle (#tb-autopip) in the side panel.
 *   2. Play any YouTube video (audible, not paused).
 *   3. Switch to another tab → Chrome shows a one-time permission prompt;
 *      accept it → the video pops into classic PiP.
 *   4. Switch back to the YouTube tab → Chrome dismisses the PiP window.
 *   5. Disable the toggle → switching tabs no longer triggers PiP.
 */
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const extensionPath = path.resolve(__dirname, '..');
const stageShotDir = path.join(extensionPath, 'screenshots', 'stages', 'pip');

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

// DPI-aware desktop capture (browser chrome + PiP window are outside the
// page) — same pattern as test-panel-live.js
function captureDesktop(file) {
  const psScript =
    "Add-Type -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();' -Name U -Namespace W; " +
    '[W.U]::SetProcessDPIAware() | Out-Null; ' +
    'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ' +
    '$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; ' +
    '$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; ' +
    '$g=[System.Drawing.Graphics]::FromImage($bmp); ' +
    '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); ' +
    "$bmp.Save('" + file + "'); " +
    '$g.Dispose(); $bmp.Dispose()';
  execFileSync('powershell', ['-NoProfile', '-Command', psScript]);
}

(async () => {
  fs.mkdirSync(stageShotDir, { recursive: true });

  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--window-size=1500,950',
    ],
    viewport: { width: 1480, height: 880 },
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extensionId = sw.url().split('/')[2];

  console.log('Opening real YouTube watch page...');
  const page = await context.newPage();
  await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
    waitUntil: 'domcontentloaded', timeout: 60000,
  });
  await page.waitForTimeout(3000);

  // Consent dialog (region-dependent)
  try {
    const consentBtn = await page.$('button[aria-label*="Accept"], button[aria-label*="Reject"]');
    if (consentBtn) { await consentBtn.click(); await page.waitForTimeout(2500); }
  } catch {}

  // Mute + wait out preroll ads (the PiP move must target the real video)
  try {
    await page.keyboard.press('m');
    await page.waitForFunction(
      () => !document.querySelector('.html5-video-player.ad-showing'),
      { timeout: 90000 });
  } catch { console.log('  (ad still showing after 90s — continuing)'); }
  await page.waitForTimeout(3000);
  await page.evaluate(() => document.querySelector('video')?.play());

  // Panel opened as a regular extension tab — trusted clicks there carry the
  // SAME user activation into chrome.scripting.executeScript as the real
  // side panel surface does (identical document + permissions)
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  await panel.setViewportSize({ width: 360, height: 900 });
  await page.bringToFront(); // keep the watch tab "active" for media routing
  await panel.waitForTimeout(4000); // ≥1 now-playing poll

  const hasBtn = await panel.$('#np-pip-btn');
  check('Now-playing card shows #np-pip-btn', !!hasBtn);
  if (!hasBtn) {
    console.log('  Cannot continue without the float button (is the video playing?)');
    await context.close();
    process.exit(1);
  }

  // A PiP window opens as a new page target in the persistent context
  const pipPagePromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);

  // --- Float: trusted click (headed clicks carry activation) ---
  await panel.bringToFront();
  await panel.click('#np-pip-btn');
  const pipPage = await pipPagePromise;
  await page.waitForTimeout(1500);

  const floatedState = await page.evaluate(() => ({
    playerInMain: !!document.getElementById('movie_player'),
    placeholder: !!document.querySelector('.ytm-pip-placeholder'),
  }));
  check('#movie_player left the main document', floatedState.playerInMain === false);
  check('.ytm-pip-placeholder present', floatedState.placeholder === true);

  const pipDocState = await page.evaluate(() => {
    const w = window.documentPictureInPicture?.window || null;
    if (!w) return null;
    return {
      wrap: !!w.document.querySelector('.ytm-pip-wrap'),
      strip: !!w.document.querySelector('.ytm-pip-strip'),
      player: !!w.document.getElementById('movie_player'),
      width: w.innerWidth,
      op: w.document.documentElement.style.getPropertyValue('--ytm-pip-op'),
    };
  });
  check('documentPictureInPicture.window is non-null', !!pipDocState);
  check('PiP document holds .ytm-pip-wrap + strip + #movie_player',
    !!pipDocState && pipDocState.wrap && pipDocState.strip && pipDocState.player,
    JSON.stringify(pipDocState));

  captureDesktop(path.join(stageShotDir, 'live-floating-window.png'));
  console.log('  Screenshot: screenshots/stages/pip/live-floating-window.png');

  // --- Panel opacity slider live-drives --ytm-pip-op ---
  await panel.evaluate(() => {
    const sl = document.getElementById('pip-opacity-slider');
    sl.value = 50;
    sl.dispatchEvent(new Event('input'));
    sl.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(1200); // UPDATE_SETTINGS → storage.onChanged → re-apply
  const opAfter = await page.evaluate(() =>
    window.documentPictureInPicture?.window?.document.documentElement.style
      .getPropertyValue('--ytm-pip-op') || null);
  check('Panel slider 50 → PiP --ytm-pip-op 0.5 (got "' + opAfter + '")', opAfter === '0.5');
  captureDesktop(path.join(stageShotDir, 'live-floating-dimmed.png'));
  console.log('  Screenshot: screenshots/stages/pip/live-floating-dimmed.png');

  // --- Strip 'L' click resizes the live window (trusted click if the PiP
  // window surfaced as a Playwright page; otherwise skipped, not failed) ---
  if (pipPage) {
    const widthBefore = pipDocState?.width || 0;
    try {
      await pipPage.bringToFront();
      // Hover the body so the strip fades in, then click the L button (the
      // 3rd button is L: [S, M, L, ↩] — match by exact text)
      await pipPage.hover('body');
      await pipPage.click('.ytm-pip-strip button:text-is("L")', { timeout: 5000 });
      await pipPage.waitForTimeout(800);
      const widthAfterResize = await pipPage.evaluate(() => window.innerWidth);
      check('Strip L grew the window (' + widthBefore + ' → ' + widthAfterResize + ', clamping allowed)',
        widthAfterResize > widthBefore + 40);
      const sizeSetting = await sw.evaluate(async () =>
        (await chrome.storage.local.get('yt_settings')).yt_settings?.pipSize);
      check('Strip L persisted pipSize large (got ' + sizeSetting + ')', sizeSetting === 'large');
    } catch (e) {
      console.log('  (strip click skipped: ' + e.message + ')');
    }
  } else {
    console.log('  (PiP window did not surface as a Playwright page — strip click skipped)');
  }

  // --- Exit: second click takes the exitPip path; playback must survive ---
  await panel.bringToFront();
  await panel.waitForTimeout(2000); // let the poll mark the button active
  check('Float button shows active while floating', await panel.evaluate(() =>
    document.getElementById('np-pip-btn')?.classList.contains('active') === true));
  await panel.click('#np-pip-btn');
  await page.waitForTimeout(2000);

  const restoredState = await page.evaluate(() => ({
    playerBack: !!document.getElementById('movie_player'),
    placeholderGone: !document.querySelector('.ytm-pip-placeholder'),
    pipWindow: window.documentPictureInPicture?.window || null,
    paused: document.querySelector('video')?.paused,
  }));
  check('#movie_player restored to the main document', restoredState.playerBack === true);
  check('Placeholder removed', restoredState.placeholderGone === true);
  check('PiP window closed', restoredState.pipWindow === null);
  // The load-bearing assertion for the move-back pattern:
  check('Playback survived the move-back (paused=' + restoredState.paused + ')',
    restoredState.paused === false);

  await page.bringToFront();
  await page.waitForTimeout(500);
  captureDesktop(path.join(stageShotDir, 'live-restored.png'));
  console.log('  Screenshot: screenshots/stages/pip/live-restored.png');

  await context.close();

  console.log('\n=============================');
  console.log('PiP live: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('PiP live test failed to run:', err);
  process.exit(1);
});
