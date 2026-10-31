// Stand-in tab for a popped-out video: keeps its place and title in the
// original window, with this extension's icon to show it is popped out. The
// background brings the video back when this tab is activated; the button is
// there for when it is already active.
const params = new URLSearchParams(location.search);
const tabId = Number(params.get("tab"));

// Chromium shows a speaker on the tab playing sound: the popped-out video's
// tab, out of sight. Show it here too, in the title.
function render(title, audible, muted) {
  const sound = muted ? "🔇 " : audible ? "🔊 " : "";
  document.title = sound + (title || "Video");
  document.getElementById("title").textContent = title || "";
}
render(params.get("title"));

async function refresh() {
  const { popped = {} } = await chrome.storage.local.get("popped");
  const info = popped[tabId];
  if (info) {
    render(info.title, info.audible, info.muted);
    document.getElementById("status").textContent = info.error || "";
  }
  return !!info;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.popped) refresh();
});

// Left over (e.g. restored after a browser restart): offer to reopen the
// video here instead.
refresh().then(async (live) => {
  if (live) return;
  await new Promise((r) => setTimeout(r, 1500)); // the pop-out may still be saving
  if (!(await refresh())) document.body.classList.add("gone");
});

document.getElementById("back").onclick = async () => {
  const status = document.getElementById("status");
  status.textContent = "";
  try {
    const r = await chrome.runtime.sendMessage({ type: "bringBack", tabId });
    if (r && r.error) status.textContent = r.error;
  } catch (e) {
    status.textContent = e.message;
  }
};
document.getElementById("open").onclick = () => location.replace(params.get("url"));
