// Shows the extension's log (kept in storage.session, newest at the bottom).
const pre = document.getElementById("log");
const status = document.getElementById("status");

async function show() {
  const { log = [] } = await chrome.storage.session.get("log");
  const atBottom = innerHeight + scrollY >= document.body.scrollHeight - 4;
  pre.textContent = log.join("\n") || "(empty: switch away from a playing video, then come back here)";
  if (atBottom) scrollTo(0, document.body.scrollHeight);
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.log) show();
});
show();

document.getElementById("copy").onclick = async () => {
  await navigator.clipboard.writeText(pre.textContent);
  status.textContent = "Copied";
  setTimeout(() => (status.textContent = ""), 1500);
};
document.getElementById("clear").onclick = () => chrome.storage.session.set({ log: [] });
