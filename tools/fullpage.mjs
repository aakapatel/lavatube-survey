// Full-page screenshot of the site below the hero, and a phone-width view.
import puppeteer from 'puppeteer-core';
const [out, w = '1280', h = '800', t = '134', url = 'http://127.0.0.1:5183/?quality=high'] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl'] });
const p = await b.newPage();
await p.setViewport({ width: +w, height: +h, deviceScaleFactor: 1 });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(url, { waitUntil: 'networkidle2' });
await p.waitForFunction('document.documentElement.dataset.ready === "1"', { timeout: 30000 });
await p.evaluate((t) => { hero.play(false); hero.seek(+t); document.querySelectorAll('img[loading=lazy]').forEach((i) => (i.loading = 'eager')); }, t);
await new Promise((r) => setTimeout(r, 2500));
await p.screenshot({ path: out, fullPage: true });
if (errs.length) console.log(errs.join('\n'));
await b.close();
