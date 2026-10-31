// End-to-end test of the extension against fake YouTube pages, in the
// pre-installed Playwright Chromium. Run with test/run.sh.
require('./server.js');
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path'), os = require('os');
const SRC = path.resolve(__dirname, '..');
// The extension is loaded from a copy. OLD_EXT=<dir> loads that version
// first, then upgrades it to this one in place, like reloading after a pull.
const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'popout-ext-'));
const FILES = ['manifest.json', 'background.js', 'content.js', 'content.css'];
const install = (from) => FILES.forEach((f) => fs.copyFileSync(path.join(from, f), path.join(EXT, f)));
install(process.env.OLD_EXT || SRC);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'PASS ' : 'FAIL ') + name, extra); if (!ok) fails++; };

(async () => {
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'popout-')), {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      '--host-resolver-rules=MAP www.youtube.com 127.0.0.1:8443', '--no-proxy-server', '--ignore-certificate-errors',
      '--autoplay-policy=no-user-gesture-required'],
  });
  const logs = [];
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
  const activate = (id) => ev((id) => chrome.tabs.update(id, { active: true }), id);

  // Open the tabs BEFORE the extension is loaded: they have no content
  // script, as after reloading the extension from chrome://extensions.
  const p0 = ctx.pages()[0];
  await p0.goto('https://www.youtube.com/watch?v=a');
  const pB = await ctx.newPage(); await pB.goto('https://www.youtube.com/');
  const pC = await ctx.newPage(); await pC.goto('https://www.youtube.com/watch?v=c&paused=1');
  // Reload the extension from chrome://extensions, as you do: the open
  // tabs keep only an orphaned content script.
  const first = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  install(SRC);
  const ext = await ctx.newPage();
  await ext.goto('chrome://extensions');
  await ext.locator('#devMode').click();
  await ext.locator('#dev-reload-button').click();
  await sleep(1000);
  await ext.close();
  for (let i = 0; i < 50 && !sw; i++) { await sleep(200); await [p0, pB, pC][i % 3].bringToFront(); sw = ctx.serviceWorkers().find((w) => w !== first); }
  if (!sw) throw new Error('no service worker after reload');
  hook(sw);
  await stubDisplays();
  console.log('displays:', JSON.stringify(await ev(() => chrome.system.display.getInfo().then(d => d.map(x => [x.bounds, x.isPrimary])))));

  const A = await tabByUrl('v=a'), B = (await ev(() => chrome.tabs.query({}))).find((t) => t.url.endsWith('youtube.com/')), C = await tabByUrl('v=c');
  await activate(A.id); await sleep(300);
  // Switch away from the playing video A.
  await activate(B.id); await sleep(1500);
  let ws = await windows();
  const popWin = ws.find((w) => w.tabs.some((t) => t.id === A.id));
  check('pop-out after extension reload (re-injection)', ws.length === 2 && popWin.id !== B.windowId, `windows=${ws.length}`);
  check('pop-out window is fullscreen', popWin && popWin.state === 'fullscreen', popWin && popWin.state);
  check('chose the smaller display', logs.some((l) => l.includes('on small')));
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
  check('player fills viewport', await p0.evaluate(() => { const r = document.querySelector('#movie_player').getBoundingClientRect(); return r.width === innerWidth && r.height === innerHeight; }));
  check('origin window focused again', (await windows()).find((w) => w.id === B.windowId).focused);

  // Hover preview on the home page (B) must not pop out; nor must a paused video (C).
  await activate(C.id); await sleep(800);
  await activate(B.id); await sleep(800);
  check('no pop-out for home-page preview or paused video', (await windows()).length === 2);

  // Escape in the popped-out tab brings it back at its original index.
  await p0.bringToFront(); await p0.keyboard.press('Escape'); await sleep(1000);
  ws = await windows();
  const back = (await ev((id) => chrome.tabs.get(id), A.id));
  check('Escape brings it back', ws.length === 1 && back.windowId === B.windowId && back.index === 0, `windows=${ws.length} index=${back.index}`);
  check('title restored', !(await p0.title()).startsWith('[PopOut]'));
  check('class removed', !(await p0.evaluate(() => document.documentElement.classList.contains('pf-popped'))));

  // Rapid switching: A (playing) -> B -> C -> B quickly; A must pop out exactly once.
  await activate(A.id); await sleep(300);
  await Promise.all([activate(B.id), activate(C.id), activate(B.id)]);
  await sleep(2000);
  ws = await windows();
  check('rapid switching pops out exactly once', ws.length === 2, `windows=${ws.length}`);
  await ev((id) => chrome.tabs.sendMessage(id, { type: 'x' }).catch(() => 0), A.id);
  // Bring back via the keyboard command path (toggle with no popped tab passed).
  await p0.bringToFront(); await p0.keyboard.press('Escape'); await sleep(1000);
  check('back again', (await windows()).length === 1);

  // Dragging a playing tab into its own window must not trigger a pop-out.
  await activate(A.id); await sleep(300);
  await ev((id) => chrome.windows.create({ tabId: id }), A.id); await sleep(1500);
  ws = await windows();
  check('tearing off a playing tab is not a pop-out', ws.length === 2 && !ws.some((w) => w.state === 'fullscreen'), `windows=${ws.length}`);

  // Closing a playing tab must not pop anything out.
  await ev(([id, w]) => chrome.tabs.move(id, { windowId: w, index: 0 }), [A.id, B.windowId]);
  await activate(A.id); await sleep(300);
  await ev((id) => chrome.tabs.remove(id), A.id); await sleep(1200);
  check('closing a playing tab does not pop out', (await windows()).length === 1);

  console.log('--- service worker log ---\n' + logs.join('\n'));
  await ctx.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
