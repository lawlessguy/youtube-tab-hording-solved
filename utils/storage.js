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

// All storage writes are read-modify-write: two concurrent mutations that
// read the same snapshot silently revert each other (duplicate queue entries,
// lost watch flags). Every mutation must go through update(), which chains
// them on one queue. Keep slow work (network fetches) OUTSIDE updateFn.
// Returning undefined from updateFn skips the write.
let writeQueue = Promise.resolve();

export function update(key, updateFn) {
  const run = writeQueue.then(async () => {
    const current = await get(key);
    const updated = await updateFn(current);
    if (updated !== undefined) {
      await set(key, updated);
    }
    return updated;
  });
  writeQueue = run.then(() => {}, () => {});
  return run;
}
