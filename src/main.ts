import './styles.css';
import { startEngine } from './hero/engine';
import { mountHero } from './ui/hero';
import { mountPage } from './ui/page';

mountPage();

const canvas = document.getElementById('hero-canvas') as HTMLCanvasElement;
const hero = document.getElementById('hero') as HTMLElement;
const loading = document.getElementById('hero-loading') as HTMLElement;
const meter = document.getElementById('hero-meter') as HTMLElement;
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
hero.classList.add('intro');

startEngine(canvas, `${import.meta.env.BASE_URL}hero`, { reduce, onProgress: (f) => (meter.style.width = `${Math.round(f * 100)}%`) })
  .then((engine) => {
    mountHero(engine);
    // With reduced motion the module opens on the finished overburden view and stays still until asked.
    if (reduce) engine.seek(148);
    loading.classList.add('done');
    hero.classList.remove('intro');
    (window as unknown as { hero: unknown }).hero = engine;
    document.documentElement.dataset.ready = '1';
  })
  .catch((err) => {
    // No WebGL, or an asset failed: show the still image and say so in the console.
    console.error(err);
    const poster = document.getElementById('hero-poster') as HTMLImageElement;
    poster.hidden = false;
    canvas.hidden = true;
    loading.classList.add('done');
    for (const id of ['hero-panel', 'hero-chapters', 'hero-play', 'ask-overburden', 'ask-assess']) document.getElementById(id)?.setAttribute('hidden', '');
    document.documentElement.dataset.ready = '1';
  });
