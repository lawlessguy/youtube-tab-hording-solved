function msg(data) { return chrome.runtime.sendMessage(data); }

// speedLevel may hold ANY value in [0.1, 10] — native YouTube changes arrive
// as 0.25-step values (contract: shared fmtSpeed rendering, ≤2 decimals; the
// slider thumb rounds to the nearest 0.1 step but the label stays exact)
function fmtSpeed(v) {
  return Number(v).toFixed(2).replace(/(\.\d)0$/, '$1') + 'x';
}

// --- Stats ---
async function loadStats() {
  try {
    const stats = await msg({ type: 'GET_STATS' });
    document.getElementById('yt-tabs').textContent = stats.ytTabs;
    document.getElementById('duplicate-tabs').textContent = stats.duplicates;
    document.getElementById('shorts-tabs').textContent = stats.shortsTabs;
  } catch {}
}

// --- Settings ---
async function loadSettings() {
  try {
    const s = await msg({ type: 'GET_SETTINGS' });
    document.getElementById('volume-slider').value = s.volumeLevel;
    document.getElementById('volume-value').textContent = s.volumeLevel + '%';
    document.getElementById('volume-scope').value = s.volumeScope;
    document.getElementById('speed-slider').value = Math.round(s.speedLevel * 10);
    document.getElementById('speed-value').textContent = fmtSpeed(s.speedLevel);
    document.getElementById('speed-scope').value = s.speedScope;
    document.getElementById('inpage-queue-toggle').checked = !!s.inPageQueue;
  } catch {}
}

// --- In-Page Queue Strip toggle (stage 01) ---
// Content scripts watch yt_settings via storage.onChanged — saving is enough
document.getElementById('inpage-queue-toggle').addEventListener('change', e => {
  msg({ type: 'UPDATE_SETTINGS', settings: { inPageQueue: e.target.checked } });
});

// --- Volume ---
document.getElementById('volume-slider').addEventListener('input', e => {
  document.getElementById('volume-value').textContent = e.target.value + '%';
});
document.getElementById('volume-slider').addEventListener('change', e => {
  msg({ type: 'SET_VOLUME', value: parseInt(e.target.value), scope: document.getElementById('volume-scope').value });
});
document.getElementById('volume-scope').addEventListener('change', e => {
  msg({ type: 'UPDATE_SETTINGS', settings: { volumeScope: e.target.value } });
});
document.getElementById('volume-reset').addEventListener('click', () => {
  document.getElementById('volume-slider').value = 100;
  document.getElementById('volume-value').textContent = '100%';
  msg({ type: 'SET_VOLUME', value: 100, scope: document.getElementById('volume-scope').value });
});

// --- Speed ---
document.getElementById('speed-slider').addEventListener('input', e => {
  document.getElementById('speed-value').textContent = fmtSpeed(parseInt(e.target.value) / 10);
});
document.getElementById('speed-slider').addEventListener('change', e => {
  msg({ type: 'SET_SPEED', value: parseInt(e.target.value) / 10, scope: document.getElementById('speed-scope').value });
});
document.getElementById('speed-scope').addEventListener('change', e => {
  msg({ type: 'UPDATE_SETTINGS', settings: { speedScope: e.target.value } });
});
document.getElementById('speed-reset').addEventListener('click', () => {
  document.getElementById('speed-slider').value = 10;
  document.getElementById('speed-value').textContent = '1.0x';
  msg({ type: 'SET_SPEED', value: 1.0, scope: document.getElementById('speed-scope').value });
});

// Mid-drag guard: while the user is on the thumb, storage echoes (including
// their own gesture's write) must not fight the pointer (stage 02)
for (const sliderId of ['volume-slider', 'speed-slider']) {
  const slider = document.getElementById(sliderId);
  slider.addEventListener('pointerdown', () => { slider.dataset.dragging = '1'; });
  slider.addEventListener('pointerup', () => { delete slider.dataset.dragging; });
  slider.addEventListener('change', () => { delete slider.dataset.dragging; });
}

// Live slider/label sync (stage 02): the popup can sit open next to a YouTube
// tab — native speed-menu changes land in yt_settings and must reflect here
// without a reload (no polling; storage.onChanged only)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.yt_settings) return;
  const s = changes.yt_settings.newValue || {};
  const vs = document.getElementById('volume-slider');
  if (!vs.dataset.dragging && s.volumeLevel !== undefined) {
    vs.value = s.volumeLevel;
    document.getElementById('volume-value').textContent = s.volumeLevel + '%';
  }
  const ss = document.getElementById('speed-slider');
  if (!ss.dataset.dragging && s.speedLevel !== undefined) {
    ss.value = Math.round(s.speedLevel * 10);
    document.getElementById('speed-value').textContent = fmtSpeed(s.speedLevel);
  }
  // Keep the strip checkbox honest while the panel/another surface toggles it
  if (s.inPageQueue !== undefined) {
    document.getElementById('inpage-queue-toggle').checked = !!s.inPageQueue;
  }
});

// --- Stat Actions ---
document.getElementById('remove-duplicates').addEventListener('click', async () => {
  await msg({ type: 'REMOVE_DUPLICATES' });
  loadStats();
});

document.getElementById('close-shorts').addEventListener('click', async () => {
  await msg({ type: 'CLOSE_SHORTS_TABS' });
  loadStats();
});

// --- Open Side Panel ---
// Pre-enable the panel for the active tab the moment the popup opens. The
// click handler must call open() with the user gesture intact: awaiting
// setOptions inside the handler consumes the gesture ("may only be called in
// response to a user gesture"), while firing it un-awaited races open()'s
// validation ("No active side panel for tabId"). Enabling up-front, long
// before the click, avoids both.
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      // path is required: a tab-scoped entry without it makes open() throw
      // "No active side panel for tabId" even when enabled
      await chrome.sidePanel.setOptions({
        tabId: tab.id,
        enabled: true,
        path: 'sidepanel/sidepanel.html',
      });
    }
  } catch {}
})();

document.getElementById('open-sidepanel').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await chrome.sidePanel.open({ tabId: tab.id });
  } catch {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await msg({ type: 'OPEN_SIDE_PANEL', tabId: tab?.id });
  }
  window.close();
});

// --- Init ---
loadStats();
loadSettings();
