// Contact sheet of the hero at given loop times.
//   node tools/reel.mjs <out.png> <t1,t2,...> [cols] [cell width] [cell height]
// BARE=1 hides the page interface so the picture alone is judged; CROP=x,y,w,h (fractions) cuts each frame.
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [out, times, cols = '3', w = '960', h = '540', url = 'http://127.0.0.1:5183/?quality=high'] = process.argv.slice(2);
const ts = times.split(',').map(Number);
const dir = mkdtempSync(join(tmpdir(), 'reel-'));
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl', `--window-size=${w},${h}`],
});
const page = await browser.newPage();
await page.setViewport({ width: +w, height: +h, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction('document.documentElement.dataset.ready === "1"', { timeout: 30000 }).catch(() => errors.push('not ready'));
await page.waitForFunction('hero.state().flight.total > 0 && hero.state().meshFull', { timeout: 90000 }).catch(() => errors.push('interior map or full mesh not loaded'));
if (process.env.BARE) await page.addStyleTag({ content: '#hero-canvas ~ *, header, nav { visibility: hidden !important; }' });
const files = [];
for (const t of ts) {
  // Play for a moment before the frame so damped motion and particles settle, then hold.
  await page.evaluate((t) => { hero.play(false); hero.seek(Math.max(t - 0.6, 0)); hero.play(true); }, t).catch((e) => errors.push(String(e).split('\n')[0]));
  await new Promise((r) => setTimeout(r, 600));
  await page.evaluate(() => hero.play(false));
  await new Promise((r) => setTimeout(r, 120));
  const f = join(dir, `f${String(files.length).padStart(3, '0')}.png`);
  await page.screenshot({ path: f });
  files.push(f);
}
await browser.close();
execFileSync('python3', ['-I', '-c', `
import sys
from PIL import Image, ImageDraw
files=sys.argv[3:]; cols=int(sys.argv[2]); ims=[Image.open(f).convert('RGB') for f in files]
crop='${process.env.CROP ?? ''}'
if crop:
    cx,cy,cw,ch=[float(v) for v in crop.split(',')]; W,H=ims[0].size; ims=[im.crop((int(cx*W),int(cy*H),int((cx+cw)*W),int((cy+ch)*H))) for im in ims]
w,h=ims[0].size; rows=(len(ims)+cols-1)//cols
sheet=Image.new('RGB',(w*cols,h*rows),'black')
labels=${JSON.stringify(ts)}
for i,im in enumerate(ims):
    d=ImageDraw.Draw(im); d.rectangle([0,0,90,22],fill=(0,0,0)); d.text((6,5),'t = %g s'%labels[i],fill=(255,255,255))
    sheet.paste(im,((i%cols)*w,(i//cols)*h))
sheet.save(sys.argv[1])
`, out, cols, ...files]);
if (errors.length) console.log('console:', [...new Set(errors)].slice(0, 10).join('\n  '));
console.log('wrote', out);
