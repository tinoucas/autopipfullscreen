# YouTube Pop-Out to Second Screen

A Chromium (MV3) extension, made for Helium on KDE Plasma: when you switch
away from a YouTube tab whose video is playing, the tab moves into its own
window. With the KWin script below, that window goes to your other screen,
maximized and then fullscreen, on all desktops, and the focus stays where you
were working.

This is an alternative to Chromium's picture-in-picture window, which has a
maximum size that can't be changed.

## Install

1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
2. Install the KWin script (see below), so the window goes to the right screen.

## Use

- **Pop out:** play a video, switch to another tab. The video's tab moves to
  its own window, and a **stand-in tab** keeps its place: same title and
  icon.
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

The window first appears small, at the bottom right of the current screen.
On Wayland, Chromium can't place its own windows, so the position is up to
KWin: without the script or a rule, it may appear elsewhere.

## KWin (Plasma 6, Wayland or X11)

The extension adds `[PopOut]` to the title of the video's window. Either use
the script (recommended) or a window rule, not both. If you still have an
older rule that forces this window fullscreen, disable it: the extension
makes it fullscreen itself, once KWin has maximized it on the right screen.

### Script (recommended)

It moves the window to the smallest screen (or the one you name), maximizes
it, puts it on all desktops, and gives the focus back to the window you were
in. It also reacts if the mark appears in the title later.

```bash
kpackagetool6 --type=KWin/Script --install kwin
```

To update it after a pull, use `--upgrade` instead of `--install`.

Enable it in **System Settings → Window Management → KWin Scripts →
YouTube Pop-Out placement**, or from a terminal:

```bash
kwriteconfig6 --file kwinrc --group Plugins --key youtube-popoutEnabled true
```

```bash
qdbus6 org.kde.KWin /KWin reconfigure
```

To use a given screen rather than the smallest one, use its name from
`kscreen-doctor -o`:

```bash
kwriteconfig6 --file kwinrc --group Script-youtube-popout --key Output HDMI-A-1
```

The script logs to the journal:

```bash
journalctl --user -f | grep youtube-popout
```

### Window rule (alternative)

**System Settings → Window Management → Window Rules → Add New**:

- Window title: **Substring Match**, `[PopOut]`
- Add properties:
  - Screen: **Force**, your secondary screen
  - Maximized horizontally: **Apply Initially**, Yes
  - Maximized vertically: **Apply Initially**, Yes
  - Virtual Desktop: **Force**, All Desktops
  - Focus stealing prevention: **Force**, Extreme (keeps the focus on your
    window)

A rule is matched when the window appears; the extension sets the title
before creating the window, so the mark is there from the start.

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
- `kwin/`: the KWin script
- `test/`: an end-to-end test against fake YouTube pages (`test/run.sh`; it
  needs Xvfb, openssl, Node with Playwright, and optionally openbox).
  `OTHER_EXT=<dir>` loads other extensions alongside, e.g. Static New Tab;
  `OLD_EXT=<dir>` starts from an older version and upgrades it in place.
