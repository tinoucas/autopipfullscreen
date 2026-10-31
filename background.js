// Debug log: chrome://extensions → this extension → "service worker".
const DEBUG = true;
const log = (...a) => DEBUG && console.log("[popout]", ...a);

const YT_URL = /^https?:\/\/www\.youtube\.com\//;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// State lives in memory and is mirrored to storage.session, because MV3
// service workers can be suspended. Every event handler runs through
// serial() one after another, so there is no read-modify-write race.
const state = {
  last: {},   // windowId -> last active tabId
  popped: {}, // tabId -> { origin: windowId, index, win: windowId }
};
const ready = chrome.storage.session.get(["last", "popped"]).then((r) => {
  state.last = r.last || {};
  state.popped = r.popped || {};
});
function save() {
  return chrome.storage.session.set({ last: state.last, popped: state.popped });
}

let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(() => ready).then(fn);
  queue = run.catch((e) => log("error:", e));
  return run;
}

// --- Content script --------------------------------------------------------

async function send(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    return undefined; // no content script (not YouTube, or tab is gone)
  }
}

// Tabs that were open before the extension was (re)loaded have no working
// content script: inject it into them when needed.
async function ensureContentScript(tab) {
  if (!YT_URL.test(tab.url || "")) return false;
  if (await send(tab.id, { type: "ping" })) return true;
  log("injecting content script into tab", tab.id);
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    return true;
  } catch (e) {
    log("injection failed:", e.message);
    return false;
  }
}

async function videoStatus(tab) {
  if (!(await ensureContentScript(tab))) return null;
  return (await send(tab.id, { type: "status" })) || null;
}

// --- Displays --------------------------------------------------------------

// The smallest display; on a tie, the non-primary one. (Under Wayland,
// which display Chromium calls "primary" is a guess.)
async function pickDisplay() {
  const displays = await chrome.system.display.getInfo();
  log(
    "displays:",
    displays.map((d) => `${d.name || d.id} ${d.bounds.width}x${d.bounds.height}+${d.bounds.left}+${d.bounds.top}${d.isPrimary ? " primary" : ""}`)
  );
  if (displays.length < 2) return null;
  const area = (d) => d.bounds.width * d.bounds.height;
  return displays.reduce((a, b) =>
    area(b) < area(a) || (area(b) === area(a) && a.isPrimary) ? b : a
  );
}

// --- Pop out / bring back --------------------------------------------------

async function popOut(tab) {
  const display = await pickDisplay();
  if (!display) return log("only one display: not popping out");

  const tabId = tab.id;
  state.popped[tabId] = { origin: tab.windowId, index: tab.index, win: null };
  await save();

  // Set the "[PopOut]" title before the window exists, so a KWin rule or
  // script sees it from the start.
  await send(tabId, { type: "popped", value: true });
  await sleep(50);

  const b = display.bounds;
  let win;
  try {
    win = await chrome.windows.create({
      tabId,
      type: "normal", // must be "normal" so the tab can be moved back later
      incognito: tab.incognito,
      left: b.left,
      top: b.top,
      width: b.width,
      height: b.height,
      focused: false,
    });
  } catch (e) {
    log("windows.create failed:", e.message);
    delete state.popped[tabId];
    await save();
    await send(tabId, { type: "popped", value: false });
    return;
  }
  state.popped[tabId].win = win.id;
  await save();
  log("popped out tab", tabId, "into window", win.id, "on", display.name || display.id);

  await sleep(250); // let the window manager place it before fullscreening
  await chrome.windows.update(win.id, { state: "fullscreen" }).catch((e) => log("fullscreen failed:", e.message));
  await send(tabId, { type: "popped", value: true }); // relayout at the final size

  // Give focus back to the window you were working in.
  await chrome.windows.update(tab.windowId, { focused: true }).catch((e) => log("refocus failed:", e.message));
}

// The window to send a tab back to: where it came from, or else another
// normal window of the same kind (regular / incognito).
async function returnWindow(info, incognito) {
  try {
    await chrome.windows.get(info.origin);
    return { id: info.origin, index: info.index };
  } catch {}
  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const others = wins.filter((w) => w.id !== info.win && w.incognito === incognito);
  const w = others.find((w) => w.focused) || others[0];
  return w ? { id: w.id, index: -1 } : null;
}

async function bringBack(tabId) {
  const info = state.popped[tabId];
  if (!info) return;
  delete state.popped[tabId];
  await save();
  await send(tabId, { type: "popped", value: false });

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  const target = await returnWindow(info, tab.incognito);
  if (!target) {
    // No window to go back to: leave it here as a normal window.
    log("no window to return to; leaving tab", tabId, "where it is");
    await chrome.windows.update(tab.windowId, { state: "normal" }).catch(() => {});
    return;
  }
  const count = (await chrome.tabs.query({ windowId: target.id })).length;
  const index = target.index < 0 ? -1 : Math.min(target.index, count);
  await chrome.tabs.move(tabId, { windowId: target.id, index });
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(target.id, { focused: true });
  log("brought tab", tabId, "back to window", target.id);
}

// Toolbar button and keyboard shortcut: bring back the popped-out video if
// there is one, otherwise pop out the current tab.
async function toggle(tab) {
  if (tab && state.popped[tab.id]) return bringBack(tab.id);
  const poppedId = Object.keys(state.popped)[0];
  if (poppedId) return bringBack(Number(poppedId));
  if (tab) return popOut(tab);
}

// --- Events ----------------------------------------------------------------

chrome.tabs.onActivated.addListener(({ tabId, windowId }) =>
  serial(async () => {
    const prevId = state.last[windowId];
    state.last[windowId] = tabId;
    await save();

    if (prevId == null || prevId === tabId) return;
    if (state.popped[prevId]) return log("tab", prevId, "is already popped out");

    let prev;
    try {
      prev = await chrome.tabs.get(prevId);
    } catch {
      return log("tab", prevId, "was closed");
    }
    // Dragged into another window, or moved by popOut itself.
    if (prev.windowId !== windowId) return log("tab", prevId, "left window", windowId);

    const status = await videoStatus(prev);
    log("switched away from tab", prevId, status);
    if (status && status.playing) await popOut(prev);
  })
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return;
  if (msg.type === "bringBack") serial(() => bringBack(tabId));
  else if (msg.type === "hello") {
    // A content script just loaded: tell it whether its tab is popped out.
    serial(() => sendResponse({ popped: !!state.popped[tabId] }));
    return true;
  }
});

chrome.action.onClicked.addListener((tab) => serial(() => toggle(tab)));
chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd === "toggle-popout") serial(() => toggle(tab));
});

chrome.tabs.onRemoved.addListener((tabId) =>
  serial(async () => {
    if (state.popped[tabId]) {
      delete state.popped[tabId];
      await save();
    }
  })
);
chrome.windows.onRemoved.addListener((windowId) =>
  serial(async () => {
    if (windowId in state.last) {
      delete state.last[windowId];
      await save();
    }
  })
);
