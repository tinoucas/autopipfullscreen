// Wrapped in a block: re-injecting the script into the same isolated world
// must not redeclare top-level constants.
{
  const TAG = "[PopOut] ";
  let popped = false;

  // After the extension is reloaded, this copy of the script is orphaned: its
  // chrome.runtime calls throw. The background injects a fresh copy.
  const alive = () => !!(chrome.runtime && chrome.runtime.id);

  // The main player only: hover previews on the home page and in search
  // results are separate players with their own <video>.
  function mainVideo() {
    return document.querySelector("#movie_player video");
  }

  function status() {
    const v = mainVideo();
    const page = /^\/(watch|live)\b/.test(location.pathname);
    return {
      playing: !!(page && v && !v.paused && !v.ended && v.readyState >= 2),
      page: location.pathname,
      video: v ? { paused: v.paused, ended: v.ended, readyState: v.readyState } : null,
    };
  }

  // Prefix the window title so a KWin rule or script can match the window.
  // If something keeps undoing it (e.g. an orphaned copy of an older version
  // of this script, still observing the title), give up instead of fighting:
  // two observers rewriting the title forever hang the page and flood the
  // browser with title updates.
  let rewrites = 0;
  let rewritesSince = 0;
  function applyTitle() {
    if (!alive()) return titleObserver.disconnect();
    const t = document.title;
    let want = t;
    if (popped && !t.startsWith(TAG)) want = TAG + t;
    else if (!popped && t.startsWith(TAG)) want = t.slice(TAG.length);
    if (want === t) return;
    const now = Date.now();
    if (now - rewritesSince > 2000) {
      rewritesSince = now;
      rewrites = 0;
    }
    if (++rewrites > 10) return;
    document.title = want;
  }
  const titleObserver = new MutationObserver(applyTitle);
  titleObserver.observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  function setPopped(value) {
    popped = value;
    document.documentElement.classList.toggle("pf-popped", value);
    applyTitle();
    // Nudge YouTube to recompute the player size.
    for (const ms of [100, 600, 1500]) {
      setTimeout(() => window.dispatchEvent(new Event("resize")), ms);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "ping") sendResponse(true);
    else if (msg.type === "status") sendResponse(status());
    else if (msg.type === "popped") {
      setPopped(msg.value);
      sendResponse(true);
    }
  });

  // Undo what an orphaned copy may have left, then ask (after a full page
  // load or a re-injection) whether this tab is popped out.
  document.documentElement.classList.remove("pf-popped");
  applyTitle();
  chrome.runtime
    .sendMessage({ type: "hello" })
    .then((r) => r && r.popped && setPopped(true))
    .catch(() => {});

  // Escape in the pop-out window sends the tab back to where it came from.
  document.addEventListener(
    "keydown",
    (e) => {
      if (popped && e.key === "Escape" && alive()) {
        e.preventDefault();
        e.stopPropagation();
        chrome.runtime.sendMessage({ type: "bringBack" }).catch(() => {});
      }
    },
    true
  );
}
