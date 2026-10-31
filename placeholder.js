// Stand-in tab for a popped-out video: keeps its place, title and icon in
// the original window. The background brings the video back when this tab
// is activated; the button is there for when it is already active.
const params = new URLSearchParams(location.search);
const tabId = Number(params.get("tab"));

function render(title, icon) {
  document.title = title || "Video";
  document.getElementById("title").textContent = title || "";
  document.getElementById("icon").href = icon || "";
}
render(params.get("title"), params.get("icon"));

async function refresh() {
  const { popped = {} } = await chrome.storage.session.get("popped");
  const info = popped[tabId];
  if (info) render(info.title, info.favIconUrl);
  return !!info;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.popped) refresh();
});

// Left over (e.g. restored after a browser restart): offer to reopen the
// video here instead.
refresh().then(async (live) => {
  if (live) return;
  await new Promise((r) => setTimeout(r, 1500)); // the pop-out may still be saving
  if (!(await refresh())) document.body.classList.add("gone");
});

document.getElementById("back").onclick = () => chrome.runtime.sendMessage({ type: "bringBack", tabId });
document.getElementById("open").onclick = () => location.replace(params.get("url"));
