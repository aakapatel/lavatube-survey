// Screenshots of the running dev server, on the GPU, for checking the hero.
//   node tools/shot.mjs <out.png> '<js to run in the page>' [width] [height] [settle ms] [url]
import puppeteer from 'puppeteer-core';

const [out, js = '', w = '1600', h = '900', settle = '900', url = 'http://127.0.0.1:5183/?quality=high'] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl', '--enable-webgl', `--window-size=${w},${h}`],
});
const page = await browser.newPage();
await page.setViewport({ width: +w, height: +h, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction('document.documentElement.dataset.ready === "1"', { timeout: 20000 }).catch(() => errors.push('not ready after 60 s'));
if (js) await page.evaluate(js).catch((e) => errors.push('eval: ' + String(e).split('\n')[0]));
await new Promise((r) => setTimeout(r, +settle));
const info = await page.evaluate(() => {
  const c = document.createElement('canvas').getContext('webgl2');
  const e = c && c.getExtension('WEBGL_debug_renderer_info');
  return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'no webgl2';
});
await page.screenshot({ path: out });
console.log('renderer:', info);
if (errors.length) console.log('console:', [...new Set(errors)].slice(0, 12).join('\n  '));
await browser.close();
