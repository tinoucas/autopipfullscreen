// Wrapped in a block: re-injecting the script into the same isolated world
// must not redeclare top-level constants.
{
  const TAG = "[PopOut] ";
  let popped = null; // unknown until the background answers "hello"

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
    if (popped === null) return; // don't touch the title before we know
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

  // relayout: the window changed size (e.g. it went fullscreen).
  function setPopped(value, relayout = false) {
    const changed = value !== document.documentElement.classList.contains("pf-popped");
    popped = value;
    document.documentElement.classList.toggle("pf-popped", value);
    applyTitle();
    if (!changed && !relayout) return;
    // Nudge YouTube to recompute the player size.
    for (const ms of [100, 600, 1500]) {
      setTimeout(() => window.dispatchEvent(new Event("resize")), ms);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "ping") sendResponse(true);
    else if (msg.type === "status") sendResponse(status());
    else if (msg.type === "popped") {
      setPopped(msg.value, true);
      sendResponse(true);
    }
  });

  // Ask (after a full page load, or a re-injection after the extension was
  // reloaded) whether this tab is popped out, then set or undo what an
  // orphaned copy may have left. Nothing is changed before the answer: the
  // "[PopOut]" title must not flicker, or the KWin rule may let go of the
  // window.
  chrome.runtime
    .sendMessage({ type: "hello" })
    .then((r) => setPopped(!!(r && r.popped)))
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
