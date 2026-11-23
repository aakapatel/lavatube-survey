// Does the canvas change while the mission plays? Frame differences at several loop times,
// then the same after forcing a WebGL context loss and restore.
import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';
const url = process.argv[2] ?? 'http://127.0.0.1:5183/?quality=high';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl'] });
const p = await b.newPage();
await p.setViewport({ width: 960, height: 540 });
const logs = [];
p.on('console', (m) => { if (m.type() !== 'debug' && !m.text().includes('404')) logs.push(`${m.type()}: ${m.text()}`); });
p.on('pageerror', (e) => logs.push('pageerror: ' + e));
await p.goto(url);
await p.waitForFunction('document.documentElement.dataset.ready === "1"', { timeout: 30000 });
const canvasShot = async () => PNG.sync.read(Buffer.from(await (await p.$("#hero-canvas")).screenshot()));
const diff = (a, c) => { let n = 0; for (let i = 0; i < a.data.length; i += 4) if (Math.abs(a.data[i] - c.data[i]) + Math.abs(a.data[i + 1] - c.data[i + 1]) + Math.abs(a.data[i + 2] - c.data[i + 2]) > 24) n++; return (100 * n) / (a.data.length / 4); };
const probe = async (label) => {
  const t0 = await p.evaluate(() => hero.state().t);
  const a = await canvasShot();
  await new Promise((r) => setTimeout(r, 1000));
  const c = await canvasShot();
  const t1 = await p.evaluate(() => hero.state().t);
  console.log(`${label}: clock ${t0.toFixed(1)} -> ${t1.toFixed(1)} s, pixels changed ${diff(a, c).toFixed(1)}%`);
};
for (const t of [5, 26, 39.5, 43, 52, 57, 64, 74, 85, 100, 112, 135]) { await p.evaluate((t) => { hero.seek(t); hero.play(true); }, t); await new Promise((r) => setTimeout(r, 500)); await probe(`t=${t}`); }
console.log('--- forcing context loss');
await p.evaluate(() => { hero.seek(86); hero.play(true); });
await new Promise((r) => setTimeout(r, 600));
await p.evaluate(() => { const gl = document.getElementById('hero-canvas').getContext('webgl2'); window.__lose = gl.getExtension('WEBGL_lose_context'); window.__lose.loseContext(); });
await new Promise((r) => setTimeout(r, 800));
await probe('context lost');
await p.evaluate(() => window.__lose.restoreContext());
await new Promise((r) => setTimeout(r, 4000));
await p.waitForFunction('document.documentElement.dataset.ready === "1"', { timeout: 30000 }).catch(() => {});
await p.evaluate(() => { hero.seek(86); hero.play(true); }).catch((e) => console.log('after restore:', String(e).split('\n')[0]));
await new Promise((r) => setTimeout(r, 800));
await probe('after restore');
console.log(logs.length ? 'console:\n  ' + [...new Set(logs)].slice(0, 8).join('\n  ') : 'console: clean');
await b.close();
