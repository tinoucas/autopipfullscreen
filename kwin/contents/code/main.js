// KWin script (Plasma 6) for the YouTube Pop-Out extension.
//
// The extension marks its pop-out window with "[PopOut]" in the title. When
// such a window appears (or a window's title gains the mark), this script:
//   - moves it to the target screen: the one named in the "Output" setting,
//     else the smallest screen;
//   - maximizes it (the extension then makes it fullscreen);
//   - puts it on all desktops;
//   - gives the focus back to the window you were working in.
//
// Settings (optional), e.g. to pick a screen by its name (see the
// "kscreen-doctor -o" output):
//   kwriteconfig6 --file kwinrc --group Script-youtube-popout --key Output HDMI-A-1
// Debug output: journalctl --user -f | grep youtube-popout

const TAG = "[PopOut]";
const REFOCUS_MS = 5000; // how long after it appears focus is given back

const handled = {}; // internalId -> time it was placed
let lastActive = workspace.activeWindow;

function log(...a) {
  print("youtube-popout:", ...a);
}

function isPopOut(w) {
  return w && w.normalWindow && String(w.caption).indexOf(TAG) !== -1;
}

function targetOutput(w) {
  const screens = workspace.screens;
  const name = readConfig("Output", "");
  if (name) {
    const named = screens.find((o) => o.name === name);
    if (named) return named;
    log("no screen named", name);
  }
  if (screens.length < 2) return null;
  const area = (o) => o.geometry.width * o.geometry.height;
  return screens.reduce((a, b) => (area(b) < area(a) ? b : a));
}

function place(w, previous) {
  if (!isPopOut(w)) return;
  const id = String(w.internalId);
  if (handled[id]) return;
  handled[id] = { at: Date.now(), previous: previous };

  const out = targetOutput(w);
  if (out && (!w.output || w.output.name !== out.name)) workspace.sendClientToScreen(w, out);
  w.onAllDesktops = true;
  w.setMaximize(true, true);
  log("placed", w.caption, "on", out ? out.name : "(only one screen)");
  refocus(w);
}

// Within a few seconds of the pop-out appearing, whenever it takes the
// focus, give it back to the window you were working in.
function refocus(w) {
  const h = handled[String(w.internalId)];
  if (!h || Date.now() - h.at > REFOCUS_MS) return;
  if (workspace.activeWindow === w && h.previous && h.previous !== w) workspace.activeWindow = h.previous;
}

function watch(w) {
  if (!w || !w.normalWindow) return;
  const previous = isPopOut(lastActive) ? null : lastActive;
  place(w, workspace.activeWindow && workspace.activeWindow !== w ? workspace.activeWindow : previous);
  w.captionChanged.connect(() => place(w, isPopOut(lastActive) ? null : lastActive));
}

workspace.windowActivated.connect((w) => {
  if (!w) return;
  if (handled[String(w.internalId)]) refocus(w);
  else lastActive = w;
});
workspace.windowAdded.connect(watch);
workspace.windowRemoved.connect((w) => delete handled[String(w.internalId)]);
workspace.windowList().forEach(watch);
