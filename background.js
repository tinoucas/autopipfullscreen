// Log: right-click the toolbar button → "Show pop-out log" (log.html), or
// chrome://extensions → this extension → "service worker".
const LOG_MAX = 500;
let logLines = [];
let logSaving = null;
const fmt = (a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a));
function log(...a) {
  console.log("[popout]", ...a);
  const t = new Date().toTimeString().slice(0, 8);
  logLines.push(`${t} ${a.map(fmt).join(" ")}`);
  if (logLines.length > LOG_MAX) logLines = logLines.slice(-LOG_MAX);
  // Save at most twice a second.
  logSaving ||= sleep(500).then(() => {
    logSaving = null;
    return chrome.storage.session.set({ log: logLines });
  });
}

const YT_URL = /^https?:\/\/www\.youtube\.com\//;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// State lives in memory and is mirrored to storage.session, because MV3
// service workers can be suspended. Every event handler runs through
// serial() one after another, so there is no read-modify-write race.
const state = {
  last: {},   // windowId -> last active tabId
  popped: {}, // tabId -> { origin, win, placeholder, title, favIconUrl, url, since }
};
const ready = chrome.storage.session.get(["last", "popped", "log"]).then((r) => {
  state.last = r.last || {};
  state.popped = r.popped || {};
  logLines = [...(r.log || []), ...logLines];
});
function save() {
  return chrome.storage.session.set({ last: state.last, popped: state.popped });
}

// A browser call that never answers must not block every later event, so
// the queue moves on after a while (the late handler still finishes).
const STUCK_MS = 10000;
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(() => ready).then(fn);
  const done = run.catch((e) => log("error:", e && e.message, e));
  queue = new Promise((resolve) => {
    const timer = setTimeout(() => {
      log("a handler is still running after", STUCK_MS, "ms; moving on");
      resolve();
    }, STUCK_MS);
    done.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  return run;
}

// Logs a browser call that fails or takes long; never throws.
async function step(name, promise) {
  const t0 = Date.now();
  const slow = setTimeout(() => log(name, "has not returned after 3 s"), 3000);
  try {
    const r = await promise;
    if (Date.now() - t0 > 3000) log(name, "returned after", Date.now() - t0, "ms");
    return r;
  } catch (e) {
    log(name, "failed:", e.message);
    return undefined;
  } finally {
    clearTimeout(slow);
  }
}

// After a reload or a restart, the tab active in each window has not been
// "activated" yet: record it, so that switching away from it counts.
async function seedLastActive() {
  await ready;
  for (const t of await chrome.tabs.query({ active: true })) {
    if (!(t.windowId in state.last)) state.last[t.windowId] = t.id;
  }
  await save();
}
chrome.runtime.onInstalled.addListener(() => {
  serial(seedLastActive);
  chrome.contextMenus.create({ id: "show-log", title: "Show pop-out log", contexts: ["action"] }, () => void chrome.runtime.lastError);
});
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "show-log") chrome.tabs.create({ url: chrome.runtime.getURL("log.html") });
});
chrome.runtime.onStartup.addListener(() => serial(seedLastActive));

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

async function getDisplays() {
  const displays = await chrome.system.display.getInfo();
  log(
    "displays:",
    displays.map((d) => `${d.name || d.id} ${d.bounds.width}x${d.bounds.height}+${d.bounds.left}+${d.bounds.top}${d.isPrimary ? " primary" : ""}`)
  );
  return displays;
}

// The display a window is on (by its centre), else the primary one. Under
// Wayland, Chromium does not know where its windows are: then the primary.
function displayOf(win, displays) {
  const x = win.left + win.width / 2;
  const y = win.top + win.height / 2;
  const inside = (b) => x >= b.left && x < b.left + b.width && y >= b.top && y < b.top + b.height;
  return displays.find((d) => inside(d.bounds)) || displays.find((d) => d.isPrimary) || displays[0];
}

// Where the pop-out window first appears: small, in the bottom-right corner
// of the current screen, like a picture-in-picture window. A KWin script or
// rule then moves it to the other screen and maximizes it (see README).
// Under Wayland, the compositor decides the position anyway.
function initialBounds(display) {
  const wa = display.workArea;
  const margin = 24;
  const width = Math.min(wa.width - 2 * margin, Math.max(480, Math.round(wa.width * 0.3)));
  const height = Math.min(wa.height - 2 * margin, Math.round((width * 9) / 16) + 90); // 16:9 video + tab strip and toolbar
  return {
    left: wa.left + wa.width - width - margin,
    top: wa.top + wa.height - height - margin,
    width,
    height,
  };
}

// --- Pop out / bring back --------------------------------------------------

// While a video is popped out, a stand-in tab (placeholder.html) keeps its
// place in the original window: switching to it brings the video back, and
// closing it closes the video.
const TAG = "[PopOut] ";
const stripTag = (t) => (t && t.startsWith(TAG) ? t.slice(TAG.length) : t || "");
// A placeholder activated this soon after the pop-out was activated by the
// pop-out itself (the popped-out tab was the active one), not by you.
const SETTLE_MS = 2000;

function ownerOf(placeholderId) {
  for (const [id, info] of Object.entries(state.popped)) {
    if (info.placeholder === placeholderId) return Number(id);
  }
  return null;
}

async function popOut(tab) {
  const displays = await getDisplays();
  if (displays.length < 2) return log("only one display: not popping out");

  const tabId = tab.id;
  tab = await chrome.tabs.get(tabId);
  const display = displayOf(await chrome.windows.get(tab.windowId), displays);
  const info = {
    origin: tab.windowId,
    win: null,
    placeholder: null,
    title: stripTag(tab.title),
    favIconUrl: tab.favIconUrl || "",
    url: tab.url,
    since: Date.now(),
  };
  const ph = await chrome.tabs.create({
    windowId: tab.windowId,
    index: tab.index + 1,
    active: false,
    url:
      chrome.runtime.getURL("placeholder.html") +
      "?" +
      new URLSearchParams({ tab: tabId, title: info.title, icon: info.favIconUrl, url: tab.url }),
  });
  info.placeholder = ph.id;
  state.popped[tabId] = info;
  await save();

  // Set the "[PopOut]" title before the window exists, so a KWin rule or
  // script sees it from the start.
  await send(tabId, { type: "popped", value: true });
  await sleep(50);

  const b = initialBounds(display);
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
    await chrome.tabs.remove(ph.id).catch(() => {});
    await send(tabId, { type: "popped", value: false });
    return;
  }
  info.win = win.id;
  // Popped out from the toolbar or the shortcut: the tab was the active one,
  // so show its stand-in now rather than whatever neighbour Chromium picks.
  if (tab.active) await chrome.tabs.update(ph.id, { active: true }).catch(() => {});
  info.since = Date.now();
  await save();
  log("popped out tab", tabId, "into window", win.id, "placeholder", ph.id, "asked for", `${b.width}x${b.height}+${b.left}+${b.top}`, "on", display.name || display.id);

  // Outside the queue: window-manager work that may be slow.
  placeWindow(tabId, win.id, tab.windowId);
}

// Once the pop-out window is maximized (by a KWin rule or script, or by
// you), make it fullscreen there: no tab strip or toolbar, only the video.
// Another extension adding a tab to the window drops it out of fullscreen
// (Static New Tab pins one in every window): soon after we fullscreened it,
// do it again. Later, leaving fullscreen (F11) is up to you.
const REFULLSCREEN_MS = 5000;

async function fullscreenIfMaximized(tabId) {
  const info = state.popped[tabId];
  if (!info || info.win == null) return;
  const w = await step("get window", chrome.windows.get(info.win));
  if (!w || w.state !== "maximized") return;
  if (info.fullscreenAt && Date.now() - info.fullscreenAt > REFULLSCREEN_MS) return;
  log(info.fullscreenAt ? "pop-out window left fullscreen; fullscreen again" : "pop-out window maximized: fullscreen");
  info.fullscreenAt = Date.now();
  await save();
  await step("fullscreen", chrome.windows.update(info.win, { state: "fullscreen" }));
  await send(tabId, { type: "popped", value: true }); // relayout at the final size
  // Put automatically: give focus back to the window you were working in.
  if (Date.now() - info.since < REFULLSCREEN_MS) await step("refocus", chrome.windows.update(info.origin, { focused: true }));
}

chrome.windows.onBoundsChanged.addListener((win) => {
  serial(async () => {
    for (const [id, info] of Object.entries(state.popped)) {
      if (info.win === win.id) fullscreenIfMaximized(Number(id)); // outside the queue
    }
  });
});

async function placeWindow(tabId, winId, originId) {
  // Give focus back to the window you were working in (focused: false is
  // not always honoured).
  await step("refocus", chrome.windows.update(originId, { focused: true }));
  // In case a maximize came before we knew the window.
  for (let i = 0; i < 6 && state.popped[tabId]; i++) {
    await sleep(500);
    await fullscreenIfMaximized(tabId);
  }
  const w = await step("get window", chrome.windows.get(winId, { populate: true }));
  if (w) {
    log("pop-out window:", w.state, `${w.width}x${w.height}+${w.left}+${w.top}`, w.focused ? "focused" : "not focused",
      "tabs:", w.tabs.map((t) => (t.pinned ? "pinned " : "") + (t.url || t.pendingUrl).slice(0, 60)));
  }
}

// After the video left its pop-out window, close that window if nothing
// worth keeping is left in it: only New Tab or extension pages (e.g. the
// tab Static New Tab pins in every window).
const DISPOSABLE = /^(chrome|edge|brave|vivaldi):\/\/(newtab|new-tab-page)\b|^about:blank|^chrome-extension:/;
async function closeLeftover(winId) {
  if (winId == null) return;
  let tabs;
  try {
    tabs = await chrome.tabs.query({ windowId: winId });
  } catch {
    return; // already closed
  }
  if (!tabs.length) return;
  if (tabs.every((t) => DISPOSABLE.test(t.pendingUrl || t.url || ""))) {
    await step("close pop-out window", chrome.windows.remove(winId));
  } else {
    log("keeping pop-out window", winId, "with", tabs.length, "tab(s)");
  }
}

// Where to send a tab back to: the place of its stand-in, or else the focused
// (or any) other normal window of the same kind (regular / incognito).
async function returnPlace(info, incognito) {
  if (info.placeholder != null) {
    try {
      const ph = await chrome.tabs.get(info.placeholder);
      return { windowId: ph.windowId, index: ph.index };
    } catch {}
  }
  const wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const others = wins.filter((w) => w.id !== info.win && w.incognito === incognito);
  const w = others.find((w) => w.focused) || others[0];
  return w ? { windowId: w.id, index: -1 } : null;
}

// Returns an error message, or null when the video is back.
async function bringBack(tabId) {
  const info = state.popped[tabId];
  if (!info) return log("bring back: tab", tabId, "is not popped out"), "This video is not popped out.";
  log("bringing back tab", tabId);

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    delete state.popped[tabId];
    await save();
    if (info.placeholder != null) await step("remove placeholder", chrome.tabs.remove(info.placeholder));
    return "The video's tab is gone.";
  }
  const place = await returnPlace(info, tab.incognito);
  if (!place) {
    // No window to go back to: leave it here as a normal window.
    log("no window to return to; leaving tab", tabId, "where it is");
    delete state.popped[tabId];
    await save();
    await send(tabId, { type: "popped", value: false });
    await step("leave fullscreen", chrome.windows.update(tab.windowId, { state: "normal" }));
    return null;
  }

  // Leave fullscreen first: moving a tab out of a fullscreen window can fail.
  if (tab.windowId !== place.windowId) {
    await step("leave fullscreen", chrome.windows.update(tab.windowId, { state: "normal" }));
  }
  let error = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await chrome.tabs.move(tabId, place);
      error = null;
      break;
    } catch (e) {
      error = e.message;
      log("move back, attempt", attempt, "failed:", error);
      await sleep(300);
    }
  }
  if (error) {
    // Still popped out: say why on the stand-in, and allow another try.
    info.error = `Couldn't move the tab back: ${error}`;
    await save();
    return info.error;
  }

  // Forget the pop-out before removing the stand-in, or removing it would
  // close the video.
  delete state.popped[tabId];
  await save();
  await send(tabId, { type: "popped", value: false });
  await step("activate", chrome.tabs.update(tabId, { active: true }));
  if (info.placeholder != null) await step("remove placeholder", chrome.tabs.remove(info.placeholder));
  if (tab.windowId !== place.windowId) await closeLeftover(tab.windowId);
  await step("focus", chrome.windows.update(place.windowId, { focused: true }));
  log("brought tab", tabId, "back to window", place.windowId);
  return null;
}

// Toolbar button and keyboard shortcut: bring back the popped-out video if
// there is one, otherwise pop out the current tab.
async function toggle(tab) {
  if (tab && state.popped[tab.id]) return bringBack(tab.id);
  const owner = tab && ownerOf(tab.id);
  if (owner != null) return bringBack(owner);
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

    // Switched to the stand-in of a popped-out video: bring the video back.
    const owner = ownerOf(tabId);
    if (owner != null) {
      if (Date.now() - state.popped[owner].since > SETTLE_MS) {
        log("placeholder", tabId, "activated");
        return bringBack(owner);
      }
      log("placeholder", tabId, "activated by the pop-out itself");
    }

    if (prevId == null) return log("activated tab", tabId, "in window", windowId, "(no previous tab recorded)");
    if (prevId === tabId) return;
    log("activated tab", tabId, "in window", windowId, "after tab", prevId);
    if (state.popped[prevId]) return log("tab", prevId, "is already popped out");

    let prev;
    try {
      prev = await chrome.tabs.get(prevId);
    } catch {
      return log("tab", prevId, "was closed");
    }
    // Dragged into another window, or moved by popOut itself.
    if (prev.windowId !== windowId) return log("tab", prevId, "left window", windowId);
    // Already switched back to it.
    if (prev.active) return;

    const status = await videoStatus(prev);
    log("switched away from tab", prevId, status);
    if (status && status.playing) await popOut(prev);
  })
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab && sender.tab.id;
  if (msg.type === "bringBack") {
    // From the video's content script (Escape), or from its stand-in.
    const id = msg.tabId != null ? msg.tabId : tabId;
    if (id == null) return;
    serial(() => bringBack(id)).then(
      (error) => sendResponse({ error }),
      (e) => sendResponse({ error: e.message })
    );
    return true;
  } else if (msg.type === "hello" && tabId != null) {
    // A content script just loaded: tell it whether its tab is popped out.
    serial(() => sendResponse({ popped: !!state.popped[tabId] }));
    return true;
  }
});

chrome.action.onClicked.addListener((tab) => serial(() => toggle(tab)));
chrome.commands.onCommand.addListener((cmd, tab) => {
  if (cmd === "toggle-popout") serial(() => toggle(tab));
});

// Keep the stand-in's title and icon in sync (e.g. autoplay of the next video).
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!(change.title || change.favIconUrl)) return;
  serial(async () => {
    const info = state.popped[tabId];
    if (!info) return;
    if (change.title) info.title = stripTag(change.title);
    if (change.favIconUrl) info.favIconUrl = change.favIconUrl;
    await save();
  });
});

chrome.tabs.onRemoved.addListener((tabId, { isWindowClosing }) =>
  serial(async () => {
    const info = state.popped[tabId];
    if (info) {
      // The video was closed (e.g. its window): its stand-in goes too.
      delete state.popped[tabId];
      await save();
      if (info.placeholder != null) await chrome.tabs.remove(info.placeholder).catch(() => {});
      if (!isWindowClosing) await closeLeftover(info.win);
      return;
    }
    const owner = ownerOf(tabId);
    if (owner == null) return;
    if (isWindowClosing) {
      // Its window was closed: keep the video; it comes back elsewhere.
      state.popped[owner].placeholder = null;
      await save();
    } else {
      // The stand-in tab was closed: close the video too.
      log("placeholder", tabId, "closed: closing tab", owner);
      const win = state.popped[owner].win;
      delete state.popped[owner];
      await save();
      await step("close video", chrome.tabs.remove(owner));
      await closeLeftover(win);
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
