function msg(data) { return chrome.runtime.sendMessage(data); }

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
    document.getElementById('speed-value').textContent = s.speedLevel.toFixed(1) + 'x';
    document.getElementById('speed-scope').value = s.speedScope;
  } catch {}
}

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
  document.getElementById('speed-value').textContent = (parseInt(e.target.value) / 10).toFixed(1) + 'x';
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
