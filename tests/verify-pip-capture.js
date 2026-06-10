/**
 * THROWAWAY live verification probe (headed) — item 4 visual supplement:
 * Float the REAL player into the Document-PiP window, dim it via the panel
 * opacity slider, and desktop-capture the VIRTUAL screen with the test
 * window activated — proving the floating window is visible over the
 * desktop (the stage test's primary-screen captures were occluded).
 * Run: node tests/verify-pip-capture.js
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
  try {
    await page.keyboard.press('m');
    await page.waitForFunction(
      () => !document.querySelector('.html5-video-player.ad-showing'),
      { timeout: 90000 });
  } catch { console.log('  (ad still showing after 90s — continuing)'); }
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) { v.muted = true; v.play().catch(() => {}); }
  });

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  await panel.setViewportSize({ width: 360, height: 900 });
  await page.bringToFront();
  await panel.waitForTimeout(4000);

  const hasBtn = await panel.$('#np-pip-btn');
  check('Now-playing card shows #np-pip-btn', !!hasBtn);
  if (!hasBtn) { await context.close(); process.exit(1); }

  await panel.bringToFront();
  await panel.click('#np-pip-btn');
  await page.waitForTimeout(2000);

  const floated = await page.evaluate(() => ({
    pipWindow: !!window.documentPictureInPicture?.window,
    placeholder: !!document.querySelector('.ytm-pip-placeholder'),
  }));
  check('Player floated into the Document-PiP window', floated.pipWindow && floated.placeholder,
    JSON.stringify(floated));

  // Dim via the panel slider so the opacity effect is visible in the capture
  await panel.evaluate(() => {
    const sl = document.getElementById('pip-opacity-slider');
    sl.value = 50;
    sl.dispatchEvent(new Event('input'));
    sl.dispatchEvent(new Event('change'));
  });
  await page.waitForTimeout(1500);
  const op = await page.evaluate(() =>
    window.documentPictureInPicture?.window?.document.documentElement.style
      .getPropertyValue('--ytm-pip-op') || null);
  check('PiP opacity driven to 0.5 by the panel slider', op === '0.5', String(op));

  await page.bringToFront();
  await page.evaluate(() => { document.title = 'YTM VERIFY PIP'; });
  activateWindow('YTM VERIFY PIP');
  captureDesktop(path.join(outDir, 'pip-floating-desktop.png'));
  console.log('  Screenshot: screenshots/verify/pip-floating-desktop.png');

  await context.close();

  console.log('\n=============================');
  console.log('PiP capture probe: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Probe failed to run:', err);
  process.exit(1);
});
