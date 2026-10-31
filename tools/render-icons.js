// Renders icon.svg to icons/<size>.png with Playwright's Chromium:
//   node tools/render-icons.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const dir = path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const svg = fs.readFileSync(path.join(dir, 'icon.svg')).toString('base64');
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}</style><img width="${size}" height="${size}" src="data:image/svg+xml;base64,${svg}">`);
    await page.waitForFunction(() => document.images[0].complete);
    await page.screenshot({ path: path.join(dir, 'icons', `${size}.png`), omitBackground: true });
  }
  await browser.close();
})();
