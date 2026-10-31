const TAG = "[PopOut] ";
let popped = false;

function getVideo() {
  return document.querySelector("video.html5-main-video") || document.querySelector("video");
}

function isPlaying() {
  const v = getVideo();
  return !!(v && !v.paused && !v.ended && v.readyState > 2);
}

// Prefix the window title so a KWin rule can match the pop-out window.
function applyTitle() {
  const t = document.title;
  if (popped && !t.startsWith(TAG)) document.title = TAG + t;
  else if (!popped && t.startsWith(TAG)) document.title = t.slice(TAG.length);
}
new MutationObserver(applyTitle).observe(document.head, {
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
  if (msg.type === "isPlaying") sendResponse({ playing: isPlaying() });
  else if (msg.type === "popped") setPopped(msg.value);
});

// Escape in the pop-out window sends the tab back to where it came from.
document.addEventListener(
  "keydown",
  (e) => {
    if (popped && e.key === "Escape") {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: "bringBack" });
    }
  },
  true
);
