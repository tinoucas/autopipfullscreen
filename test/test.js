// End-to-end test of the extension against fake YouTube pages, in the
// pre-installed Playwright Chromium. Run with test/run.sh.
require('./server.js');
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path'), os = require('os');
const SRC = path.resolve(__dirname, '..');
// The extension is loaded from a copy. OLD_EXT=<dir> loads that version
// first, then upgrades it to this one in place, like reloading after a pull.
const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'popout-ext-'));
const install = (from) => fs.readdirSync(from)
  .filter((f) => /\.(json|js|css|html|png|svg)$/.test(f))
  .forEach((f) => fs.copyFileSync(path.join(from, f), path.join(EXT, f)));
install(process.env.OLD_EXT || SRC);
// OTHER_EXT=<dir>[,<dir>...]: also load these extensions (e.g. Static New Tab,
// which pins a New Tab page in every window, the pop-out one included).
const OTHERS = process.env.OTHER_EXT ? process.env.OTHER_EXT.split(',') : [];
const ALL = [EXT, ...OTHERS].join(',');
const NAME = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'))).name;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const logs = []; // the extension's service worker console
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name, extra); if (!ok) fails++; };

(async () => {
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'popout-')), {
    headless: false,
    viewport: null, // or Playwright resizes windows to 1280x720 whenever a page appears in them
    args: [`--disable-extensions-except=${ALL}`, `--load-extension=${ALL}`,
      '--host-resolver-rules=MAP www.youtube.com 127.0.0.1:8443', '--no-proxy-server', '--ignore-certificate-errors',
      '--autoplay-policy=no-user-gesture-required'],
  });
  const hook = (w) => w.on('console', (m) => logs.push(m.text()));
  let sw;
  const ev = (fn, arg) => sw.evaluate(fn, arg);
  const windows = () => ev(() => chrome.windows.getAll({ populate: true }));
  const tabByUrl = async (s) => (await ev(() => chrome.tabs.query({}))).find((t) => t.url.includes(s));
  // Fake two displays (the container has a single virtual screen).
  const stubDisplays = () => ev(() => {
    const d = (id, w, h, left, isPrimary) => ({ id, name: id, isPrimary, bounds: { left, top: 0, width: w, height: h }, workArea: { left, top: 0, width: w, height: h } });
    chrome.system.display.getInfo = async () => [d('big', 1920, 1080, 0, true), d('small', 1280, 720, 1920, false)];
  });
  const placeholders = async () => (await ev(() => chrome.tabs.query({}))).filter((t) => t.url.includes('placeholder.html'));
  const activate = (id) => ev((id) => ((globalThis.unlocked && globalThis.unlocked.tu) || chrome.tabs.update)(id, { active: true }), id); // a switch by hand is never refused

  // Open the tabs BEFORE the extension is loaded: they have no content
  // script, as after reloading the extension from chrome://extensions.
  const p0 = ctx.pages()[0];
  await p0.goto('https://www.youtube.com/watch?v=a');
  const pB = await ctx.newPage(); await pB.goto('https://www.youtube.com/');
  const pC = await ctx.newPage(); await pC.goto('https://www.youtube.com/watch?v=c&paused=1');
  // Reload the extension from chrome://extensions, as you do: the open
  // tabs keep only an orphaned content script.
  const ours = async () => {
    for (const w of ctx.serviceWorkers()) if ((await w.evaluate(() => chrome.runtime.getManifest().name).catch(() => '')) === NAME) return w;
  };
  let first;
  for (let i = 0; i < 50 && !first; i++) { first = await ours(); if (!first) await sleep(200); }
  install(SRC);
  const ext = await ctx.newPage();
  await ext.goto('chrome://extensions');
  await ext.locator('#devMode').click();
  await ext.locator('extensions-item', { hasText: NAME }).locator('#dev-reload-button').click();
  await sleep(1000);
  await ext.close();
  for (let i = 0; i < 50 && !sw; i++) { await sleep(200); await [p0, pB, pC][i % 3].bringToFront(); const w = await ours(); if (w && w !== first) sw = w; }
  if (!sw) throw new Error('no service worker after reload');
  hook(sw);
  await stubDisplays();
  console.log('displays:', JSON.stringify(await ev(() => chrome.system.display.getInfo().then(d => d.map(x => [x.bounds, x.isPrimary])))));

  const A = await tabByUrl('v=a'), B = (await ev(() => chrome.tabs.query({}))).find((t) => t.url.endsWith('youtube.com/')), C = await tabByUrl('v=c');
  await activate(A.id); await sleep(300);
  const home = (await ev((id) => chrome.tabs.get(id), A.id)).index; // after any pinned tab
  // As after a restart: nothing recorded yet, only what is active now.
  await ev(() => { state.last = {}; return seedLastActive(); });
  // As when switching with a click: Chromium refuses tab changes until the
  // mouse button is released ("user may be dragging a tab").
  const lockTabs = (ms) => ev((ms) => {
    const until = Date.now() + ms;
    globalThis.unlocked ||= { tc: chrome.tabs.create, tm: chrome.tabs.move, tu: chrome.tabs.update, tr: chrome.tabs.remove, wc: chrome.windows.create };
    const u = globalThis.unlocked;
    const lock = (f) => (...a) => (Date.now() < until ? Promise.reject(new Error('Tabs cannot be edited right now (user may be dragging a tab).')) : f(...a));
    chrome.tabs.create = lock(u.tc); chrome.tabs.move = lock(u.tm); chrome.tabs.update = lock(u.tu); chrome.tabs.remove = lock(u.tr); chrome.windows.create = lock(u.wc);
  }, ms);
  await lockTabs(800);
  // Switch away from the playing video A.
  await activate(B.id); await sleep(2300);
  let ws = await windows();
  const popWin = ws.find((w) => w.tabs.some((t) => t.id === A.id));
  check('pop-out on the first switch after a fresh start, after reload (re-injection), with tab edits refused for a moment', ws.length === 2 && popWin.id !== B.windowId, `windows=${ws.length}`);
  const r = popWin && [popWin.left, popWin.top, popWin.width, popWin.height];
  check('pop-out window starts small, bottom right of the current screen',
    popWin && popWin.type === 'popup' && popWin.state === 'normal' && Math.abs(r[0] + r[2] - (1920 - 24)) < 30 && Math.abs(r[1] + r[3] - (1080 - 24)) < 30 && r[2] < 1000,
    popWin && `${popWin.type} ${popWin.state} ${JSON.stringify(r)}`);
  check('no other tab in the pop-out window (other extensions leave popups alone)', popWin && popWin.tabs.length === 1, popWin && popWin.tabs.map((t) => t.url).join(' '));
  // Play KWin's part: maximize the window (on the other screen); the
  // extension turns that into fullscreen.
  await ev((id) => chrome.windows.update(id, { state: 'maximized' }), popWin.id); await sleep(1500);
  const fs1 = (await ev((id) => chrome.windows.get(id), popWin.id)).state;
  check('maximized pop-out window goes fullscreen', fs1 === 'fullscreen', fs1);
  const titleChanges = await Promise.race([
    p0.evaluate(() => new Promise((r) => {
      let n = 0;
      const o = new MutationObserver(() => n++);
      o.observe(document.head, { childList: true, subtree: true, characterData: true });
      setTimeout(() => { o.disconnect(); r(n); }, 1000);
    })),
    sleep(5000).then(() => 'page hung'),
  ]);
  check('page stays responsive, title settles', titleChanges === 0, `title changes in 1 s: ${titleChanges}`);
  // After an upgrade from a version without the give-up rule, its orphaned
  // copy wins the title until the tab is reloaded.
  if (!process.env.OLD_EXT) check('title prefixed', (await p0.title()).startsWith('[PopOut] '), await p0.title());
  check('pf-popped class', await p0.evaluate(() => document.documentElement.classList.contains('pf-popped')));
  check('log page has the log', await (async () => {
    const lp = await ctx.newPage(); await lp.goto(`chrome-extension://${new URL(sw.url()).host}/log.html`); await sleep(500);
    const t = await lp.locator('#log').textContent(); await lp.close(); return t.includes('popped out tab');
  })());
  check('player fills viewport', await p0.evaluate(() => { const r = document.querySelector('#movie_player').getBoundingClientRect(); return r.width === innerWidth && r.height === innerHeight; }));
  check('origin window focused again', (await windows()).find((w) => w.id === B.windowId).focused);

  let phs = await placeholders();
  check('stand-in tab keeps its place', phs.length === 1 && phs[0].windowId === B.windowId && phs[0].index === home && !phs[0].active,
    JSON.stringify(phs.map((t) => [t.windowId, t.index, t.active])));
  check('stand-in tab has the video title', phs[0] && phs[0].title === 'Video a - YouTube', phs[0] && phs[0].title);

  // Hover preview on the home page (B) must not pop out; nor must a paused video (C).
  await activate(C.id); await sleep(800);
  await activate(B.id); await sleep(800);
  check('no pop-out for home-page preview or paused video', (await windows()).length === 2);

  // Escape in the popped-out tab brings it back at its original index.
  await p0.bringToFront(); await p0.keyboard.press('Escape'); await sleep(1000);
  ws = await windows();
  const back = (await ev((id) => chrome.tabs.get(id), A.id));
  check('Escape brings it back', ws.length === 1 && back.windowId === B.windowId && back.index === home, `windows=${ws.length} index=${back.index}`);
  check('title restored', !(await p0.title()).startsWith('[PopOut]'));
  check('class removed', !(await p0.evaluate(() => document.documentElement.classList.contains('pf-popped'))));
  check('stand-in removed', (await placeholders()).length === 0);

  // Switching to the stand-in tab brings the video back in its place.
  await activate(A.id); await sleep(300);
  await activate(B.id); await sleep(2500);
  phs = await placeholders();
  await activate(phs[0].id); await lockTabs(800); await sleep(1800);
  ws = await windows();
  const back2 = await ev((id) => chrome.tabs.get(id), A.id);
  check('switching to the stand-in brings it back (tab edits refused for a moment)', ws.length === 1 && back2.windowId === B.windowId && back2.index === home && back2.active && (await placeholders()).length === 0,
    `windows=${ws.length} index=${back2.index} active=${back2.active}`);
  check('video still playing after coming back', await p0.evaluate(() => !document.querySelector('video').paused));

  // tabs.move failing once (e.g. "Tabs cannot be edited right now"): retried.
  await activate(A.id); await sleep(300);
  await activate(B.id); await sleep(2500);
  await ev(() => { const m = chrome.tabs.move; let n = 0; globalThis.realMove = m;
    chrome.tabs.move = (...a) => (n++ < 1 ? Promise.reject(new Error('Tabs cannot be edited right now')) : m(...a)); });
  await activate((await placeholders())[0].id); await sleep(1500);
  check('a failed move back is retried', (await windows()).length === 1 && (await placeholders()).length === 0);

  // tabs.move failing every time: the button says why, and nothing is lost.
  await activate(A.id); await sleep(300);
  await activate(B.id); await sleep(2500);
  await ev(() => { chrome.tabs.move = () => Promise.reject(new Error('Tabs can only be moved to and from normal windows.')); });
  const phPage = ctx.pages().find((q) => q.url().includes('placeholder.html'));
  await phPage.bringToFront(); await sleep(1500);
  const status = await phPage.locator('#status').textContent();
  check('failed bring-back shown on the stand-in', status.includes('normal windows'), JSON.stringify(status));
  await phPage.locator('#back').click(); await sleep(2000);
  check('still popped out after a failed bring-back', (await windows()).length === 2 && (await placeholders()).length === 1);
  await ev(() => { chrome.tabs.move = globalThis.unlocked.tm; });
  await phPage.locator('#back').click(); await sleep(1500);
  check('"Bring it back here" works', (await windows()).length === 1 && (await placeholders()).length === 0);

  // Rapid switching: A (playing) -> B -> C -> B quickly; A must pop out exactly once.
  await activate(A.id); await sleep(300);
  await Promise.all([activate(B.id), activate(C.id), activate(B.id)]);
  await sleep(2000);
  ws = await windows();
  check('rapid switching pops out exactly once', ws.length === 2, `windows=${ws.length}`);
  await ev((id) => chrome.tabs.sendMessage(id, { type: 'x' }).catch(() => 0), A.id);
  // Bring back via the keyboard command path (toggle with no popped tab passed).
  await p0.bringToFront(); await p0.keyboard.press('Escape'); await sleep(1000);
  check('back again', (await windows()).length === 1 && (await placeholders()).length === 0);

  // Toolbar / shortcut on the active video: its stand-in becomes the active
  // tab and must not bring it straight back.
  await activate(A.id); await sleep(300);
  await ev(async (id) => toggle(await chrome.tabs.get(id)), A.id); await sleep(3000);
  phs = await placeholders();
  check('toolbar pop-out stays out, stand-in active', (await windows()).length === 2 && phs.length === 1 && phs[0].active);
  await ev(async (id) => toggle(await chrome.tabs.get(id)), phs[0].id); await sleep(1000);
  check('toolbar on the stand-in brings it back', (await windows()).length === 1 && (await ev((id) => chrome.tabs.get(id), A.id)).active && (await placeholders()).length === 0);

  // Dragging a playing tab into its own window must not trigger a pop-out.
  await activate(A.id); await sleep(300);
  await ev((id) => chrome.windows.create({ tabId: id }), A.id); await sleep(1500);
  ws = await windows();
  check('tearing off a playing tab is not a pop-out', ws.length === 2 && !ws.some((w) => w.state === 'fullscreen'), `windows=${ws.length}`);

  // Closing a playing tab must not pop anything out.
  const torn = (await ev((id) => chrome.tabs.get(id), A.id)).windowId;
  await ev(([id, w]) => chrome.tabs.move(id, { windowId: w, index: 0 }), [A.id, B.windowId]);
  await ev((w) => chrome.windows.remove(w).catch(() => {}), torn); // other extensions may have added tabs to it
  await activate(A.id); await sleep(300);
  await ev((id) => chrome.tabs.remove(id), A.id); await sleep(1200);
  check('closing a playing tab does not pop out', (await windows()).length === 1);

  // Closing the stand-in tab closes the video.
  const playing = async (v) => {
    const pg = await ctx.newPage(); await pg.goto('https://www.youtube.com/watch?v=' + v); await sleep(500);
    const t = await tabByUrl('v=' + v);
    await activate(B.id); await sleep(2500);
    return t;
  };
  const D = await playing('d');
  phs = await placeholders();
  check('popped out again', (await windows()).length === 2 && phs.length === 1);
  await ev((id) => chrome.tabs.remove(id), phs[0].id); await sleep(1000);
  check('closing the stand-in closes the video', (await windows()).length === 1 && !(await tabByUrl('v=d')));

  // Closing the pop-out window removes the stand-in.
  const E = await playing('e');
  const winE = (await ev((id) => chrome.tabs.get(id), E.id)).windowId;
  await ev((id) => chrome.windows.remove(id), winE); await sleep(1000);
  check('closing the pop-out window removes the stand-in', (await windows()).length === 1 && (await placeholders()).length === 0);

  console.log('--- service worker log ---\n' + logs.join('\n'));
  await ctx.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); console.log('--- service worker log ---\n' + logs.join('\n')); process.exit(2); });
