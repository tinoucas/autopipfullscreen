# YouTube Pop-Out to Second Screen

A Chromium (MV3) extension, made for Helium on KDE Plasma: when you switch
away from a YouTube tab whose video is playing, the tab moves into its own
window, without tab strip or toolbar. With the KWin window rule below, that
window goes fullscreen on your other screen.

This is an alternative to Chromium's picture-in-picture window, which has a
maximum size that can't be changed.

## Install

1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
2. Add the KWin window rule (see below), so the window goes to the right
   screen.

## Use

- **Pop out:** play a video, switch to another tab. The video's tab moves to
  its own window, and a **stand-in tab** keeps its place: same title (marked
  with 📺) and icon.
- **Bring back:** switch to the stand-in tab, or press **Escape** in the
  video window, or click the toolbar button, or press **Alt+Shift+Y** from
  any window. The video comes back in place, still playing, and its window
  closes.
- **Close:** closing the stand-in tab closes the video; closing the video's
  window removes the stand-in.
- **Fullscreen:** when the video's window gets maximized (by KWin, or by
  you), the extension makes it fullscreen, without tab strip or toolbar.
- Toolbar button or Alt+Shift+Y on a tab that isn't popped out pops it out.
- Nothing happens with a single screen.

The window is a popup window: no tab strip or toolbar, only a thin read-only
address bar that Chromium always shows on web pages in popups (fullscreen
hides it too). It asks to appear small, at the bottom right of the current
screen; on Wayland, Chromium can't place its own windows, so the position is
up to KWin, hence the rule. Keeping it above other windows or on all desktops
is up to KWin too: extensions can't.

## KWin window rule (Plasma 6, Wayland or X11)

The extension adds `[PopOut]` to the title of the video's window, before the
window is created, so a rule matches it from the start.

**System Settings → Window Management → Window Rules → Add New**:

- Window title: **Substring Match**, `[PopOut]`
- Add properties:
  - Screen: **Force**, your secondary screen
  - Fullscreen: **Force**, Yes
  - No titlebar and frame: **Force**, Yes
  - Focus stealing prevention: **Force**, Extreme: the window never takes
    the focus when it appears, so you can keep typing where you were (e.g.
    Ctrl+T and an address right away). The extension also gives the focus
    back for a few seconds, but keys typed before that would go to YouTube,
    where letters and digits are shortcuts.
- Optional:
  - Virtual Desktop: **Force**, All Desktops
  - Keep above other windows: **Force**, Yes
  - Accept focus: **Force**, No, if the window should never take the
    keyboard focus, even when clicked (the mouse still works on the video;
    bring it back with the stand-in tab or Alt+Shift+Y instead of Escape)

## Troubleshooting

Right-click the toolbar button → **Show pop-out log**: every decision the
extension makes, with a Copy button. (Also in `chrome://extensions` → this
extension → "service worker".)

## Files

- `manifest.json`
- `background.js`: tab switches, pop-out / bring back, the stand-in tab,
  fullscreen, the log
- `content.js` / `content.css`: on YouTube, the "is it playing?" check, the
  `[PopOut]` title, the player stretched over the window, Escape
- `placeholder.html` / `placeholder.js`: the stand-in tab
- `log.html` / `log.js`: the log page
- `test/`: an end-to-end test against fake YouTube pages (`test/run.sh`; it
  needs Xvfb, openssl, Node with Playwright, and optionally openbox).
  `OTHER_EXT=<dir>` loads other extensions alongside, e.g. Static New Tab;
  `OLD_EXT=<dir>` starts from an older version and upgrades it in place.
