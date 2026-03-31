export async function get(key) {
  const result = await chrome.storage.local.get(key);
  return result[key];
}

export async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export async function getMultiple(keys) {
  return chrome.storage.local.get(keys);
}

export async function update(key, updateFn) {
  const current = await get(key);
  const updated = updateFn(current);
  await set(key, updated);
  return updated;
}
