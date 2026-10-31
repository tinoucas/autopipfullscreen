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

// Sites: YouTube always, plus the ones you chose (right-click the toolbar
// button → "Pop out videos on <site>"), stored as domains ("twitch.tv"),
// each covering its subdomains (www.twitch.tv, player.vimeo.com).
const YOUTUBE_HOST = "www.youtube.com";
const hostOf = (url) => {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.hostname : null;
  } catch {
    return null;
  }
};
const siteOf = (url) => {
  const h = hostOf(url);
  return h && h.replace(/^www\./, "");
};
const sitePattern = (domain) => `*://*.${domain}/*`;
const isYouTube = (url) => hostOf(url) === YOUTUBE_HOST;
function siteEnabled(url) {
  const h = hostOf(url);
  if (!h) return false;
  return h === YOUTUBE_HOST || state.sites.some((d) => h === d || h.endsWith("." + d));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// State lives in memory and is mirrored to storage, because MV3 service
// workers can be suspended. Every event handler runs through serial() one
// after another, so there is no read-modify-write race.
// The pop-outs are kept in storage.local: unlike storage.session, it
// survives reloading or upgrading the extension, which closes the stand-in
// tabs (Chromium closes an extension's pages) but not the popped-out videos.
const state = {
  last: {},   // windowId -> last active tabId
  popped: {}, // tabId -> { origin, index, win, placeholder, title, url, since, video }
  sites: [],  // domains you chose, besides YouTube
};
const ready = Promise.all([chrome.storage.session.get(["last", "log"]), chrome.storage.local.get(["popped", "sites"])]).then(
  ([r, l]) => {
    state.last = r.last || {};
    state.popped = l.popped || {};
    state.sites = l.sites || [];
    logLines = [...(r.log || []), ...logLines];
  }
);
function save() {
  return Promise.all([
    chrome.storage.session.set({ last: state.last }),
    chrome.storage.local.set({ popped: state.popped, sites: state.sites }),
  ]);
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

// A click on a tab activates it while the mouse button is still down, and
// until it is released (the click might become a tab drag) Chromium refuses
// to change tabs: "Tabs cannot be edited right now (user may be dragging a
// tab)". Retry until it accepts, for up to 10 s.
async function whenEditable(name, fn) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!/cannot be edited right now/.test(e.message) || i >= 100) throw e;
      if (i === 0) log(name + ": tabs can't be edited right now (mouse button down on a tab?); waiting");
      await sleep(100);
    }
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
  serial(syncSites); // dynamic content scripts don't survive an update
  serial(recoverPopOuts);
  const menu = (item) => chrome.contextMenus.create({ contexts: ["action"], ...item }, () => void chrome.runtime.lastError);
  menu({ id: "site", type: "checkbox", title: "Pop out videos on this site", enabled: false });
  menu({ id: "show-log", title: "Show pop-out log" });
});
chrome.runtime.onStartup.addListener(() =>
  serial(async () => {
    // Tabs from the previous browser session are gone (or have new ids).
    state.popped = {};
    await save();
    await seedLastActive();
    await syncSites();
  })
);

// --- Sites you choose --------------------------------------------------------

// The content script runs on YouTube (manifest) and, registered here, in
// every frame of the sites you chose (a video may be in a frame from a
// subdomain, e.g. player.vimeo.com).
async function syncSites() {
  // Drop sites whose access was taken away (e.g. in chrome://extensions).
  const kept = [];
  for (const d of state.sites) {
    if (await chrome.permissions.contains({ origins: [sitePattern(d)] })) kept.push(d);
    else log("no access to", d, "any more: dropping it");
  }
  state.sites = kept;
  await save();
  await chrome.scripting.unregisterContentScripts({ ids: ["sites"] }).catch(() => {});
  if (state.sites.length) {
    await chrome.scripting.registerContentScripts([
      {
        id: "sites",
        matches: state.sites.map(sitePattern),
        js: ["content.js"],
        css: ["content.css"],
        allFrames: true,
        runAt: "document_idle",
        persistAcrossSessions: true,
      },
    ]);
  }
  log("sites:", ["youtube.com", ...state.sites]);
}

async function setSite(domain, on) {
  state.sites = state.sites.filter((d) => d !== domain);
  if (on) state.sites.push(domain);
  await save();
  if (!on) await chrome.permissions.remove({ origins: [sitePattern(domain)] }).catch(() => {});
  await syncSites();
}

// The menu entry follows the current tab's site.
async function updateSiteMenu(tab) {
  const d = tab && siteOf(tab.url);
  const item = !d
    ? { title: "Pop out videos on this site", checked: false, enabled: false }
    : isYouTube(tab.url)
      ? { title: "Pop out videos on youtube.com (always)", checked: true, enabled: false }
      : { title: `Pop out videos on ${d}`, checked: state.sites.includes(d), enabled: true };
  await chrome.contextMenus.update("site", item).catch(() => {});
}
async function updateSiteMenuForWindow(windowId) {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  await ready;
  await updateSiteMenu(tab);
}
chrome.windows.onFocusChanged.addListener((windowId) => updateSiteMenuForWindow(windowId).catch(() => {}));
chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  if (change.url && tab.active) ready.then(() => updateSiteMenu(tab)).catch(() => {});
});
chrome.permissions.onRemoved.addListener(() => serial(syncSites));

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "show-log") chrome.tabs.create({ url: chrome.runtime.getURL("log.html") });
  if (info.menuItemId !== "site" || !tab) return;
  const d = siteOf(tab.url);
  if (!d || isYouTube(tab.url)) return;
  if (!info.checked) {
    serial(() => setSite(d, false)).then(() => updateSiteMenu(tab));
    return;
  }
  // Right away, while the click still counts as yours: Helium asks you.
  chrome.permissions.request({ origins: [sitePattern(d)] }).then(
    (granted) =>
      serial(async () => {
        if (granted) await setSite(d, true);
        else log("access to", d, "refused");
        await updateSiteMenu(tab);
      }),
    (e) => log("permission request failed:", e.message)
  );
});

// --- Content script --------------------------------------------------------

// To every frame of the tab, or to one.
async function send(tabId, msg, frameId) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg, frameId == null ? undefined : { frameId });
  } catch {
    return undefined; // no content script (not YouTube, or tab is gone)
  }
}

// Tabs that were open before the extension was (re)loaded have no working
// content script, nor tabs of a site you just chose: inject it into them
// when needed. any: also on other sites, when you pop out a tab yourself
// (the toolbar button or the shortcut grant access to that tab).
async function ensureContentScript(tab, any = false) {
  const url = tab.url || "";
  if (!hostOf(url) || !(any || siteEnabled(url))) return false;
  if (await send(tab.id, { type: "ping" }, 0)) return true;
  log("injecting content script into tab", tab.id);
  const target = { tabId: tab.id, allFrames: !isYouTube(url) };
  try {
    await chrome.scripting.insertCSS({ target, files: ["content.css"] });
    await chrome.scripting.executeScript({ target, files: ["content.js"] });
    return true;
  } catch (e) {
    log("injection failed:", e.message);
    return false;
  }
}

// The frame with the video to pop out: the biggest one playing (with sound,
// on other sites than YouTube), else (any) the biggest one.
async function videoStatus(tab, any = false) {
  if (!(await ensureContentScript(tab, any))) return null;
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: !isYouTube(tab.url) },
      func: () => (globalThis.popoutStatus ? globalThis.popoutStatus() : null),
    });
  } catch (e) {
    log("status failed:", e.message);
    return null;
  }
  const frames = results.filter((r) => r.result).map((r) => ({ frameId: r.frameId, ...r.result }));
  const byArea = (a, b) => b.area - a.area;
  return (
    frames.filter((f) => f.playing).sort(byArea)[0] ||
    (any && frames.filter((f) => f.hasVideo).sort(byArea)[0]) ||
    frames.find((f) => f.top) ||
    null
  );
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
// of the current screen, like a picture-in-picture window. A KWin rule then
// moves it to the other screen (see README).
// Under Wayland, the compositor decides the position anyway.
function initialBounds(display) {
  const wa = display.workArea;
  const margin = 24;
  const width = Math.min(wa.width - 2 * margin, Math.max(480, Math.round(wa.width * 0.3)));
  const height = Math.min(wa.height - 2 * margin, Math.round((width * 9) / 16) + 40); // 16:9 video + the popup's address bar
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

// auto: because you switched away from it (not the toolbar or shortcut).
function createStandIn(tabId, info, windowId, index) {
  return whenEditable("create stand-in", () =>
    chrome.tabs.create({
      windowId,
      index,
      active: false,
      url:
        chrome.runtime.getURL("placeholder.html") +
        "?" +
        new URLSearchParams({ tab: tabId, title: info.title, url: info.url }),
    })
  );
}

// After the extension was reloaded or upgraded: the popped-out videos are
// still there, but Chromium closed their stand-in tabs, and their content
// scripts are orphaned. Put the stand-ins back where they were, and
// reconnect the videos.
async function recoverPopOuts() {
  for (const [id, info] of Object.entries(state.popped)) {
    const tabId = Number(id);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.windowId !== info.win) {
      delete state.popped[id];
      continue;
    }
    if (!(info.placeholder != null && (await chrome.tabs.get(info.placeholder).catch(() => null)))) {
      info.placeholder = null;
      if (await chrome.windows.get(info.origin).catch(() => null)) {
        const count = (await chrome.tabs.query({ windowId: info.origin })).length;
        const ph = await createStandIn(tabId, info, info.origin, Math.min(info.index ?? count, count)).catch((e) => log("stand-in:", e.message));
        if (ph) info.placeholder = ph.id;
      }
    }
    info.since = Date.now() - SETTLE_MS; // its stand-in may be switched to right away
    log("recovered pop-out of tab", tabId, "stand-in", info.placeholder);
    await ensureContentScript(tab, true);
    await send(tabId, { type: "popped", value: true }); // the frame with a big video takes it
  }
  await save();
}

// Keep track of where each stand-in is, to put it back there if needed.
chrome.tabs.onMoved.addListener((tabId, { windowId, toIndex }) =>
  serial(async () => {
    const owner = ownerOf(tabId);
    if (owner == null) return;
    Object.assign(state.popped[owner], { origin: windowId, index: toIndex });
    await save();
  })
);
chrome.tabs.onAttached.addListener((tabId, { newWindowId, newPosition }) =>
  serial(async () => {
    const owner = ownerOf(tabId);
    if (owner == null) return;
    Object.assign(state.popped[owner], { origin: newWindowId, index: newPosition });
    await save();
  })
);

// auto: because you switched away from it, with status (videoStatus) saying
// which frame has the video.
async function popOut(tab, auto = false, status = null) {
  const displays = await getDisplays();
  if (displays.length < 2) return log("only one display: not popping out");

  const tabId = tab.id;
  tab = await chrome.tabs.get(tabId);
  if (!status) {
    status = await videoStatus(tab, true);
    log("popping out tab", tabId, "by hand:", status);
  }
  const display = displayOf(await chrome.windows.get(tab.windowId), displays);
  const info = {
    origin: tab.windowId,
    win: null,
    placeholder: null,
    title: stripTag(tab.title),
    url: tab.url,
    since: Date.now(),
    video: status ? status.token : undefined, // the frame with the video
  };
  const ph = await createStandIn(tabId, info, tab.windowId, tab.index + 1);
  if (auto) {
    // While we waited, you may have come back to the tab, or dragged it away.
    const now = await chrome.tabs.get(tabId).catch(() => null);
    if (!now || now.active || now.windowId !== tab.windowId) {
      log("tab", tabId, "is active again or moved: not popping out");
      await whenEditable("remove stand-in", () => chrome.tabs.remove(ph.id)).catch(() => {});
      return;
    }
    if (now.index !== tab.index) {
      await whenEditable("move stand-in", () => chrome.tabs.move(ph.id, { index: now.index + 1 })).catch(() => {});
      tab = now;
    }
  }
  info.placeholder = ph.id;
  info.index = tab.index;
  state.popped[tabId] = info;
  await save();

  // Set the "[PopOut]" title before the window exists, so a KWin rule sees
  // it from the start.
  await send(tabId, { type: "popped", value: true, video: info.video });
  await sleep(50);

  const b = initialBounds(display);
  let win;
  try {
    win = await whenEditable("create window", () =>
      chrome.windows.create({
        tabId,
        // A popup: no tab strip or toolbar (only a thin read-only address
        // bar, which fullscreen hides too), and other extensions leave it
        // alone (Static New Tab pins its tab in normal windows only).
        type: "popup",
        incognito: tab.incognito,
        left: b.left,
        top: b.top,
        width: b.width,
        height: b.height,
        focused: false,
      })
    );
  } catch (e) {
    log("windows.create failed:", e.message);
    delete state.popped[tabId];
    await save();
    await whenEditable("remove stand-in", () => chrome.tabs.remove(ph.id)).catch(() => {});
    await send(tabId, { type: "popped", value: false });
    return;
  }
  info.win = win.id;
  // Popped out from the toolbar or the shortcut: the tab was the active one,
  // so show its stand-in now rather than whatever neighbour Chromium picks.
  if (tab.active) await whenEditable("show stand-in", () => chrome.tabs.update(ph.id, { active: true })).catch(() => {});
  info.since = Date.now();
  await save();
  log("popped out tab", tabId, "into window", win.id, "placeholder", ph.id, "asked for", `${b.width}x${b.height}+${b.left}+${b.top}`, "on", display.name || display.id);

  // Outside the queue: window-manager work that may be slow.
  placeWindow(tabId, win.id, tab.windowId);
}

// Once the pop-out window is maximized (by a KWin rule, or by you), make it fullscreen there: no tab strip or toolbar, only the video.
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
  await send(tabId, { type: "popped", value: true, video: info.video }); // relayout at the final size
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

// For this long after it appears, the pop-out window must not keep the
// focus: you are still working in your window (e.g. you just pressed Ctrl+T
// and are typing an address), and keys typed into YouTube are shortcuts.
const KEEP_FOCUS_MS = 3000;

async function placeWindow(tabId, winId, originId) {
  const start = Date.now();
  let refocused = 0;
  while (state.popped[tabId] && Date.now() - start < KEEP_FOCUS_MS) {
    // Give focus back whenever the pop-out has it: the window manager may
    // focus it only once it is shown (or fullscreened), after we asked
    // for focused: false.
    const w = await step("get window", chrome.windows.get(winId));
    if (!w) return;
    if (w.focused || refocused === 0) {
      if (w.focused) log("pop-out window took the focus: giving it back");
      refocused++;
      await step("refocus", chrome.windows.update(originId, { focused: true }));
    }
    // In case a maximize came before we knew the window.
    await fullscreenIfMaximized(tabId);
    await sleep(150);
  }
  const w = await step("get window", chrome.windows.get(winId, { populate: true }));
  if (w) {
    log("pop-out window:", w.state, `${w.width}x${w.height}+${w.left}+${w.top}`, w.focused ? "focused" : "not focused",
      "tabs:", w.tabs.map((t) => (t.pinned ? "pinned " : "") + (t.url || t.pendingUrl).slice(0, 60)));
    if (w.focused) log("the pop-out window still has the focus: see README, Focus stealing prevention");
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
    if (info.placeholder != null) await step("remove placeholder", whenEditable("remove placeholder", () => chrome.tabs.remove(info.placeholder)));
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
  try {
    await whenEditable("move back", () => chrome.tabs.move(tabId, place));
  } catch (e) {
    error = e.message;
    log("move back failed:", error);
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
  await step("activate", whenEditable("activate", () => chrome.tabs.update(tabId, { active: true })));
  if (info.placeholder != null) await step("remove placeholder", whenEditable("remove placeholder", () => chrome.tabs.remove(info.placeholder)));
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
    chrome.tabs.get(tabId).then(updateSiteMenu, () => {});

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
    if (status && status.playing) await popOut(prev, true, status);
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

// Keep the stand-in's title in sync (e.g. autoplay of the next video).
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.title) return;
  serial(async () => {
    const info = state.popped[tabId];
    if (!info) return;
    info.title = stripTag(change.title);
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
      if (info.placeholder != null) await step("remove placeholder", whenEditable("remove placeholder", () => chrome.tabs.remove(info.placeholder)));
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
      await step("close video", whenEditable("close video", () => chrome.tabs.remove(owner)));
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
