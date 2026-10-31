// Runs on YouTube (top frame), and in every frame of the sites you chose
// (right-click the toolbar button → "Pop out videos on <site>").
//
// Wrapped in a block: re-injecting the script into the same isolated world
// must not redeclare top-level constants.
{
  const TAG = "[PopOut] ";
  const TOP = window.top === window;
  const YOUTUBE = location.hostname === "www.youtube.com";
  // Tells the background which frame is which (the video may be in a frame).
  const token = Math.random().toString(36).slice(2);
  let popped = null; // unknown until the background answers "hello"

  // After the extension is reloaded, this copy of the script is orphaned: its
  // chrome.runtime calls throw. The background injects a fresh copy.
  const alive = () => !!(chrome.runtime && chrome.runtime.id);
  const html = document.documentElement;
  const area = (el) => {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  };

  // --- Is a video playing? ---------------------------------------------------

  // YouTube: the main player only (hover previews on the home page and in
  // search results are separate players with their own <video>).
  function youtubeStatus() {
    const v = document.querySelector("#movie_player video");
    const page = /^\/(watch|live)\b/.test(location.pathname);
    return {
      playing: !!(page && v && !v.paused && !v.ended && v.readyState >= 2),
      hasVideo: !!v,
      area: v ? area(v) : 0,
      page: location.pathname,
      video: v ? { paused: v.paused, ended: v.ended, readyState: v.readyState } : null,
    };
  }

  // Elsewhere: a video big enough to be the one you watch, playing with
  // sound (muted autoplay previews, e.g. on Twitch's home page, don't count).
  const MIN_W = 320;
  const MIN_H = 180;
  function bigVideos() {
    return [...document.querySelectorAll("video")]
      .filter((v) => {
        const r = v.getBoundingClientRect();
        return r.width >= MIN_W && r.height >= MIN_H;
      })
      .sort((a, b) => area(b) - area(a));
  }
  const audible = (v) => !v.paused && !v.ended && v.readyState >= 2 && !v.muted && v.volume > 0;
  function pickVideo() {
    const vids = bigVideos();
    return vids.find(audible) || vids[0] || null;
  }
  function genericStatus() {
    const v = pickVideo();
    return {
      playing: !!(v && audible(v)),
      hasVideo: !!v,
      area: v ? area(v) : 0,
      page: location.host + location.pathname,
      video: v ? { paused: v.paused, muted: v.muted, readyState: v.readyState, size: `${v.clientWidth}x${v.clientHeight}` } : null,
    };
  }

  function status() {
    return { ...(YOUTUBE ? youtubeStatus() : genericStatus()), token, top: TOP };
  }
  // The background reads this in every frame (scripting.executeScript).
  globalThis.popoutStatus = status;

  // --- Filling the window (other sites) ----------------------------------------

  // Known player boxes, used when they are about the video's size.
  const KNOWN_PLAYERS = [
    '[data-a-target="video-player"]', // Twitch
    ".vp-player-layout", // Vimeo
  ].join(",");

  // The player box: the outermost element around the video that is about its
  // size (room for a control bar under it, at most). It holds the site's own
  // controls, drawn over the video; the next one up has the page around.
  function playerOf(video) {
    const vr = video.getBoundingClientRect();
    const near = (el) => {
      const r = el.getBoundingClientRect();
      return r.width <= vr.width + 16 && r.height <= vr.height + 72;
    };
    const known = video.parentElement && video.parentElement.closest(KNOWN_PLAYERS);
    if (known && near(known)) return known;
    let box = video;
    for (let el = video.parentElement; el && el !== document.body && el !== html; el = el.parentElement) {
      if (!near(el)) break;
      box = el;
    }
    return box;
  }

  const MARKS = ["data-pf-player", "data-pf-between", "data-pf-video", "data-pf-ancestor"];
  function unmark() {
    for (const el of document.querySelectorAll(MARKS.map((m) => `[${m}]`).join(","))) {
      for (const m of MARKS) el.removeAttribute(m);
    }
  }
  // player covers the window (content.css), the elements between it and the
  // video fill it, and its ancestors lose what would trap a fixed element.
  function markPlayer(player, video) {
    unmark();
    player.setAttribute("data-pf-player", "");
    if (video && video !== player) {
      video.setAttribute("data-pf-video", "");
      for (let el = video.parentElement; el && el !== player; el = el.parentElement) el.setAttribute("data-pf-between", "");
    }
    for (let el = player.parentElement; el; el = el.parentElement) el.setAttribute("data-pf-ancestor", "");
    // In a frame: the frame itself must cover the page around it.
    if (!TOP) parent.postMessage({ popoutVideoFrame: true }, "*");
  }
  function markVideo(video) {
    markPlayer(playerOf(video), video);
  }
  // A frame of ours holds the video: cover the page with that frame.
  window.addEventListener("message", (e) => {
    if (!e.data || e.data.popoutVideoFrame !== true || !alive()) return;
    const frame = [...document.querySelectorAll("iframe, frame")].find((f) => f.contentWindow === e.source);
    if (frame) markPlayer(frame, null);
  });

  // --- Popped out or not -----------------------------------------------------

  // Prefix the window title so a KWin rule can match the window.
  // If something keeps undoing it (e.g. an orphaned copy of an older version
  // of this script, still observing the title), give up instead of fighting:
  // two observers rewriting the title forever hang the page and flood the
  // browser with title updates.
  let rewrites = 0;
  let rewritesSince = 0;
  function applyTitle() {
    if (!alive()) return titleObserver.disconnect();
    if (popped === null || !TOP) return; // don't touch the title before we know
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
  if (TOP && document.head) {
    titleObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
  }

  // video: the token of the frame whose video pops out; undefined after a
  // page load (the frame with a big video takes it). relayout: the window
  // changed size (e.g. it went fullscreen).
  function setPopped(value, video, relayout = false) {
    const changed = value !== html.classList.contains("pf-popped");
    popped = value;
    html.classList.toggle("pf-popped", value);
    html.classList.toggle(YOUTUBE ? "pf-youtube" : "pf-generic", value);
    if (!YOUTUBE) {
      if (!value) unmark();
      else if (!document.querySelector("[data-pf-player]") && (video === token || video === undefined)) {
        const v = pickVideo();
        if (v) markVideo(v);
      }
    }
    applyTitle();
    if (!changed && !relayout) return;
    // Nudge the player to recompute its size.
    for (const ms of [100, 600, 1500]) {
      setTimeout(() => window.dispatchEvent(new Event("resize")), ms);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "ping") sendResponse(true);
    else if (msg.type === "status") sendResponse(status());
    else if (msg.type === "popped") {
      setPopped(msg.value, msg.video, true);
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
    .then((r) => setPopped(!!(r && r.popped), undefined))
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
