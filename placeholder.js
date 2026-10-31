// Stand-in tab for a popped-out video: keeps its place, title and icon in
// the original window. The background brings the video back when this tab
// is activated; the button is there for when it is already active.
const params = new URLSearchParams(location.search);
const tabId = Number(params.get("tab"));

// Marks the stand-in in the tab strip: its video plays on the other screen.
const MARK = "📺 ";

function render(title, icon) {
  document.title = MARK + (title || "Video");
  document.getElementById("title").textContent = title || "";
  document.getElementById("icon").href = icon || "";
}
render(params.get("title"), params.get("icon"));

async function refresh() {
  const { popped = {} } = await chrome.storage.local.get("popped");
  const info = popped[tabId];
  if (info) {
    render(info.title, info.favIconUrl);
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
