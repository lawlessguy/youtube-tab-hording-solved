/**
 * Live E2E (headed, manual): the three list-panel checks that headless
 * cannot prove (plan 04 §6 "Headed/live only"):
 *  1. Smart play across two REAL OS windows — OPEN_VIDEO for a video already
 *     open in the other window focuses THAT window (windows.update
 *     {focused:true} actually raises it) instead of opening a duplicate.
 *  2. Middle-click as a REAL pointer gesture on a panel card — auxclick →
 *     OPEN_VIDEO_NEW_TAB opens a background tab; the panel stays put.
 *  3. Real YouTube channel-name enrichment renders a clickable .channel-link
 *     whose click applies the channel filter chip.
 * Captures screenshots/stages/list-panel/live-*.png.
 * Run manually: node tests/test-sessions-live.js
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const extensionPath = path.resolve(__dirname, '..');
const stageShotDir = path.join(extensionPath, 'screenshots', 'stages', 'list-panel');
const VID = 'jNQXAC9IVRw'; // "Me at the zoo" — stable real metadata

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
  fs.mkdirSync(stageShotDir, { recursive: true });

  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--window-size=1300,850',
    ],
    viewport: null,
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extensionId = sw.url().split('/')[2];

  // Panel page in window A; queue the real video via the real message path
  // (enrichment fetches real title/channel from YouTube)
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  await panel.waitForTimeout(1000);
  await panel.evaluate((id) => chrome.runtime.sendMessage({
    type: 'ADD_VIDEO', url: 'https://www.youtube.com/watch?v=' + id,
  }), VID);
  await panel.waitForTimeout(5000); // metadata enrichment round-trip

  // --- 3 first (no extra windows yet): real channel enrichment + filter ---
  console.log('\n--- Real channel-name enrichment + filter click ---');
  const card = await panel.evaluate((id) => {
    const item = document.querySelector('.video-item[data-id="' + id + '"]');
    const chan = item?.querySelector('.channel-link');
    return item ? {
      title: item.querySelector('.video-title')?.textContent || '',
      channel: chan?.textContent || null,
    } : null;
  }, VID);
  check('Card enriched with a real title', !!card && card.title.length > 3 &&
    card.title !== 'Loading...', JSON.stringify(card));
  check('Real channel rendered as a clickable .channel-link',
    !!card && typeof card.channel === 'string' && card.channel.length > 0 &&
    card.channel !== 'Unknown', JSON.stringify(card));
  if (card?.channel) {
    await panel.click('.video-item[data-id="' + VID + '"] .channel-link');
    await panel.waitForTimeout(600);
    const chip = await panel.evaluate(() => ({
      visible: document.getElementById('channel-chip').style.display !== 'none',
      name: document.getElementById('channel-chip-name').textContent,
    }));
    check('Channel click shows the filter chip with the real name',
      chip.visible && chip.name === card.channel, JSON.stringify(chip));
    await panel.click('#channel-chip-clear');
    await panel.waitForTimeout(400);
  }
  await panel.screenshot({ path: path.join(stageShotDir, 'live-panel-channel.png') });

  // --- 1. Smart play across two real OS windows ---
  console.log('\n--- Smart play across two OS windows ---');
  const winB = await sw.evaluate(async (id) => {
    const w = await chrome.windows.create({
      url: 'https://www.youtube.com/watch?v=' + id, focused: true,
      width: 900, height: 700, left: 80, top: 40,
    });
    return w.id;
  }, VID);
  // Let window B's tab commit its URL, then give focus back to window A
  await panel.waitForTimeout(6000);
  const winA = await sw.evaluate(async (b) => {
    const wins = await chrome.windows.getAll();
    const a = wins.find(w => w.id !== b);
    await chrome.windows.update(a.id, { focused: true });
    return a.id;
  }, winB);
  await panel.waitForTimeout(800);
  const tabsBefore = await sw.evaluate(async () =>
    (await chrome.tabs.query({})).length);

  const openRes = await panel.evaluate((id) => chrome.runtime.sendMessage({
    type: 'OPEN_VIDEO', url: 'https://www.youtube.com/watch?v=' + id,
  }), VID);
  await panel.waitForTimeout(1500);
  check('OPEN_VIDEO responded {focused:true} (smart play matched the tab)',
    openRes?.focused === true, JSON.stringify(openRes));
  const focusState = await sw.evaluate(async ({ a, b }) => ({
    aFocused: (await chrome.windows.get(a)).focused,
    bFocused: (await chrome.windows.get(b)).focused,
    tabs: (await chrome.tabs.query({})).length,
  }), { a: winA, b: winB });
  check('Window B (the video\'s window) is now the focused OS window',
    focusState.bFocused === true && focusState.aFocused === false,
    JSON.stringify(focusState));
  check('No duplicate tab was opened (' + tabsBefore + ' before, ' +
    focusState.tabs + ' after)', focusState.tabs === tabsBefore);
  await panel.screenshot({ path: path.join(stageShotDir, 'live-smartplay-panel.png') });

  // --- 2. Middle-click as a real pointer gesture ---
  console.log('\n--- Real middle-click on a card ---');
  await sw.evaluate((a) => chrome.windows.update(a, { focused: true }), winA);
  await panel.bringToFront();
  await panel.waitForTimeout(500);
  const box = await panel.locator('.video-item[data-id="' + VID + '"]').boundingBox();
  check('Card visible for the pointer gesture', !!box, JSON.stringify(box));
  if (box) {
    await panel.mouse.click(box.x + box.width / 2, box.y + box.height / 2,
      { button: 'middle' });
    await panel.waitForTimeout(2500);
    const after = await sw.evaluate(async (id) => {
      const matches = await chrome.tabs.query({ url: '*://www.youtube.com/watch*' });
      const vidTabs = matches.filter(t => (t.url || '').includes(id));
      return {
        vidTabs: vidTabs.length,
        anyActive: vidTabs.some(t => t.active && t.windowId !==
          undefined && t.highlighted),
      };
    }, VID);
    check('Middle-click opened a second tab for the video (background)',
      after.vidTabs === 2, JSON.stringify(after));
    check('Panel page itself did not navigate', !panel.isClosed() &&
      (await panel.evaluate(() => location.pathname.endsWith('sidepanel.html'))));
  }

  await context.close();

  console.log('\n=============================');
  console.log('Sessions live: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Sessions live test failed to run:', err);
  process.exit(1);
});
