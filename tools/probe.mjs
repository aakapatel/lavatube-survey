// Where the camera is through the shots from behind the craft, written as JSON for tools/camera_clearance.py.
//   node tools/probe.mjs <out.json> [t0] [t1] [step]
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';
const [out, t0 = '50', t1 = '107', step = '0.1', url = 'http://127.0.0.1:5183/?quality=high'] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl'] });
const p = await b.newPage();
await p.setViewport({ width: 960, height: 540 });
await p.goto(url);
await p.waitForFunction('document.documentElement.dataset.ready === "1"', { timeout: 30000 });
// Play through in real time so the damped parts of the camera behave as a visitor sees them.
await p.evaluate((t) => { hero.seek(t); hero.play(true); }, +t0);
const rows = [];
const end = Date.now() + (+t1 - +t0) * 1000 + 500;
while (Date.now() < end) {
  rows.push(await p.evaluate(() => ({ t: hero.state().t, tf: hero.state().flight.time, ...hero.probe() })));
  await new Promise((r) => setTimeout(r, +step * 1000));
}
writeFileSync(out, JSON.stringify(rows));
console.log('wrote', out, rows.length, 'samples');
await b.close();
