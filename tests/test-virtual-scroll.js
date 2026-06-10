/**
 * Test: virtual scroll correctness in the side panel
 * Seeds 100 queued + 30 watched videos, then verifies:
 *  - rendered DOM stays bounded (not all cards mounted)
 *  - the right cards are rendered at a deep scroll position
 *  - re-rendering is skipped when the visible range is unchanged
 *    (watched list previously rebuilt on every scroll frame)
 */
const { chromium } = require('playwright');
const path = require('path');

const extensionPath = path.resolve(__dirname, '..');

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
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const extensionId = sw.url().split('/')[2];

  // Seed: 100 queued videos (addedAt descending by index so the default
  // sort renders VID00000000, VID00000001, ... top to bottom) + 30 watched
  await sw.evaluate(() => {
    const base = Date.now();
    const videos = [];
    for (let i = 0; i < 100; i++) {
      videos.push({
        id: 'VID' + String(i).padStart(8, '0'),
        url: 'https://www.youtube.com/watch?v=VID' + String(i).padStart(8, '0'),
        title: 'Video ' + i,
        channel: 'Chan',
        thumbnail: '',
        duration: 100,
        addedAt: base - i * 1000,
        uploadedAt: null,
        isShort: false,
        category: 'Uncategorized',
        watched: false,
        starred: false,
      });
    }
    for (let i = 0; i < 30; i++) {
      videos.push({
        id: 'WAT' + String(i).padStart(8, '0'),
        url: 'https://www.youtube.com/watch?v=WAT' + String(i).padStart(8, '0'),
        title: 'Watched ' + i,
        channel: 'Chan',
        thumbnail: '',
        duration: 100,
        addedAt: base - (1000 + i) * 1000,
        uploadedAt: null,
        isShort: false,
        category: 'Uncategorized',
        watched: true,
        starred: false,
      });
    }
    return chrome.storage.local.set({ yt_videos: videos });
  });

  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel/sidepanel.html`);
  await panel.setViewportSize({ width: 350, height: 700 });
  await panel.waitForTimeout(800);

  console.log('\n--- Bounded rendering ---');
  const initial = await panel.evaluate(() => ({
    rendered: document.querySelectorAll('#video-list .video-item').length,
    count: document.getElementById('video-count').textContent,
    listHeight: document.getElementById('video-list').style.height,
  }));
  check('Count shows 100 (got ' + initial.count + ')', initial.count === '100');
  check('Virtual height is 6300px (got ' + initial.listHeight + ')', initial.listHeight === '6300px');
  check('DOM bounded: ' + initial.rendered + ' of 100 cards mounted',
    initial.rendered > 0 && initial.rendered < 45);

  console.log('\n--- Correct window at deep scroll ---');
  const deep = await panel.evaluate(async () => {
    const sa = document.querySelector('.scroll-area');
    const list = document.getElementById('video-list');
    // Scroll so that item 50 sits at the top of the viewport
    sa.scrollTop = list.offsetTop + 50 * 63;
    sa.dispatchEvent(new Event('scroll'));
    await new Promise(r => setTimeout(r, 150));
    const ids = [...document.querySelectorAll('#video-list .video-item')]
      .map(n => n.dataset.id);
    return {
      rendered: ids.length,
      hasItem50: ids.includes('VID' + String(50).padStart(8, '0')),
      hasItem55: ids.includes('VID' + String(55).padStart(8, '0')),
      hasItem0: ids.includes('VID' + String(0).padStart(8, '0')),
      first: ids[0],
      last: ids[ids.length - 1],
    };
  });
  check('Item 50 rendered at deep scroll', deep.hasItem50, 'window ' + deep.first + '…' + deep.last);
  check('Item 55 (mid-viewport) rendered', deep.hasItem55);
  check('Item 0 not rendered (out of window)', !deep.hasItem0);
  check('DOM still bounded (' + deep.rendered + ' cards)', deep.rendered < 45);

  console.log('\n--- No rebuild when range unchanged ---');
  const stable = await panel.evaluate(async () => {
    const sa = document.querySelector('.scroll-area');
    // Expand the watched section
    document.getElementById('watched-header').click();
    await new Promise(r => setTimeout(r, 100));
    sa.scrollTop = sa.scrollHeight; // bottom — watched list visible
    sa.dispatchEvent(new Event('scroll'));
    await new Promise(r => setTimeout(r, 150));
    const watchedItem = document.querySelector('#watched-list .video-item');
    if (!watchedItem) return { error: 'no watched cards rendered' };
    watchedItem.__marker = true;
    // Same-range scroll: +1px keeps start/end indexes identical
    sa.scrollTop = sa.scrollTop - 1;
    sa.dispatchEvent(new Event('scroll'));
    await new Promise(r => setTimeout(r, 150));
    const again = document.querySelector('#watched-list .video-item');
    return {
      watchedRendered: document.querySelectorAll('#watched-list .video-item').length,
      sameNode: again ? again.__marker === true : false,
    };
  });
  check('Watched cards rendered when expanded (' + stable.watchedRendered + ')',
    !stable.error && stable.watchedRendered > 0 && stable.watchedRendered <= 30,
    stable.error);
  check('Same-range scroll reuses DOM nodes (no rebuild)', stable.sameNode === true);

  await context.close();

  console.log('\n=============================');
  console.log('Virtual scroll: ' + passed + ' passed, ' + failed + ' failed');
  console.log('=============================');
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => {
  console.error('Virtual scroll test failed to run:', err);
  process.exit(1);
});
