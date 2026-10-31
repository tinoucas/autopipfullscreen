// State lives in storage.session because MV3 service workers can be suspended.
const LAST_KEY = "lastActive"; // { windowId: tabId } – last active tab per window
const POPPED_KEY = "popped";   // { tabId: { origin: windowId, win: windowId } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getState(key) {
  const r = await chrome.storage.session.get(key);
  return r[key] || {};
}
async function setState(key, val) {
  await chrome.storage.session.set({ [key]: val });
}

async function isPlaying(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: "isPlaying" });
    return !!(res && res.playing);
  } catch {
    return false; // not a YouTube tab, or tab is gone
  }
}

// Prefer the non-primary display; otherwise the smallest one.
async function pickDisplay() {
  const displays = await chrome.system.display.getInfo();
  if (displays.length < 2) return null;
  const area = (d) => d.bounds.width * d.bounds.height;
  return (
    displays.find((d) => !d.isPrimary) ||
    displays.reduce((a, b) => (area(a) <= area(b) ? a : b))
  );
}

async function popOut(tabId, originWindowId) {
  const display = await pickDisplay();
  if (!display) return; // only one screen: do nothing

  const b = display.workArea || display.bounds;
  const win = await chrome.windows.create({
    tabId,
    type: "normal", // must be "normal" so the tab can be moved back later
    left: b.left,
    top: b.top,
    width: b.width,
    height: b.height,
    focused: false,
  });

  const popped = await getState(POPPED_KEY);
  popped[tabId] = { origin: originWindowId, win: win.id };
  await setState(POPPED_KEY, popped);

  chrome.tabs.sendMessage(tabId, { type: "popped", value: true }).catch(() => {});

  await sleep(250); // let the window manager place it before fullscreening
  try {
    await chrome.windows.update(win.id, { state: "fullscreen" });
  } catch {}

  // Give focus back to the window you were working in.
  try {
    await chrome.windows.update(originWindowId, { focused: true });
  } catch {}
}

async function bringBack(tabId) {
  const popped = await getState(POPPED_KEY);
  const info = popped[tabId];
  if (!info) return;
  delete popped[tabId];
  await setState(POPPED_KEY, popped);

  chrome.tabs.sendMessage(tabId, { type: "popped", value: false }).catch(() => {});

  try {
    await chrome.windows.get(info.origin);
    await chrome.tabs.move(tabId, { windowId: info.origin, index: -1 });
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(info.origin, { focused: true });
  } catch {
    // Original window is gone: just leave fullscreen where it is.
    try {
      await chrome.windows.update(info.win, { state: "normal" });
    } catch {}
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const last = await getState(LAST_KEY);
  const prevTabId = last[windowId];
  last[windowId] = tabId;
  await setState(LAST_KEY, last);

  if (prevTabId == null || prevTabId === tabId) return;

  const popped = await getState(POPPED_KEY);
  if (popped[prevTabId]) return;

  if (await isPlaying(prevTabId)) await popOut(prevTabId, windowId);
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === "bringBack" && sender.tab) bringBack(sender.tab.id);
});

// Toolbar button: manually pop out the current tab, or bring it back.
chrome.action.onClicked.addListener(async (tab) => {
  const popped = await getState(POPPED_KEY);
  if (popped[tab.id]) bringBack(tab.id);
  else popOut(tab.id, tab.windowId);
});

// Housekeeping
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const popped = await getState(POPPED_KEY);
  if (popped[tabId]) {
    delete popped[tabId];
    await setState(POPPED_KEY, popped);
  }
});
chrome.windows.onRemoved.addListener(async (windowId) => {
  const last = await getState(LAST_KEY);
  if (windowId in last) {
    delete last[windowId];
    await setState(LAST_KEY, last);
  }
});
