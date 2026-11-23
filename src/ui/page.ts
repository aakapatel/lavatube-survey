// The page below the hero: figures and legends from the manuscript, the
// figure viewer, the citation button and the optional video.

import figures from '../content/figures.json';

type Fig = { id: string; label: string; title: string; legend: string; src: string; thumb: string; w: number; h: number };

export function mountPage() {
  const base = import.meta.env.BASE_URL;
  const top = document.querySelector('.top') as HTMLElement;
  const hero = document.getElementById('hero') as HTMLElement;
  const onScroll = () => top.classList.toggle('solid', window.scrollY > hero.offsetHeight - 60);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Figure viewer.
  const box = document.getElementById('lightbox') as HTMLElement;
  const boxImg = box.querySelector('img') as HTMLImageElement;
  const boxCap = box.querySelector('.cap') as HTMLElement;
  let opener: HTMLElement | null = null;
  const open = (src: string, alt: string, caption: string, from: HTMLElement) => {
    opener = from;
    boxImg.src = src;
    boxImg.alt = alt;
    boxCap.innerHTML = caption;
    box.hidden = false;
    document.body.style.overflow = 'hidden';
    (box.querySelector('.close') as HTMLElement).focus();
  };
  const close = () => {
    box.hidden = true;
    boxImg.src = '';
    document.body.style.overflow = '';
    opener?.focus();
  };
  box.addEventListener('click', (e) => {
    if (e.target === box || (e.target as HTMLElement).classList.contains('close')) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !box.hidden) close();
  });

  // Main figures with their legends beside them.
  const list = document.getElementById('figure-list') as HTMLElement;
  for (const f of figures.main as Fig[]) {
    const fig = document.createElement('figure');
    fig.id = f.id;
    fig.innerHTML = `
      <button class="frame" type="button" aria-label="Open ${f.label} at full size">
        <img src="${base}${f.src}" width="${f.w}" height="${f.h}" alt="${f.title}" loading="lazy">
      </button>
      <figcaption><span class="title"><span class="n">${f.label}</span>${f.title}</span><p>${f.legend}</p></figcaption>`;
    const btn = fig.querySelector('button') as HTMLButtonElement;
    btn.addEventListener('click', () => open(`${base}${f.src}`, f.title, `<b>${f.label} | ${f.title}.</b> ${f.legend}`, btn));
    list.appendChild(fig);
  }
  const ed = document.getElementById('ed-list') as HTMLElement;
  for (const f of figures.extended as Fig[]) {
    const li = document.createElement('li');
    li.innerHTML = `<button type="button" aria-label="Open ${f.label}"><span class="thumb"><img src="${base}${f.thumb}" alt="" loading="lazy"></span><span class="n">${f.label}</span><span class="t">${f.title}</span></button>`;
    const btn = li.querySelector('button') as HTMLButtonElement;
    btn.addEventListener('click', () => open(`${base}${f.src}`, f.title, `<b>${f.label} | ${f.title}.</b> ${f.legend}`, btn));
    ed.appendChild(li);
  }
  // Figures carried over as plain links in the older sections.
  document.querySelectorAll<HTMLAnchorElement>('a[data-lightbox]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      open(a.href, a.dataset.alt ?? '', a.dataset.caption ?? '', a);
    }),
  );

  // Citation.
  const copy = document.getElementById('copy-bibtex');
  const note = document.getElementById('copied-note');
  copy?.addEventListener('click', async () => {
    await navigator.clipboard.writeText((document.getElementById('bibtex') as HTMLElement).textContent ?? '');
    if (note) {
      note.hidden = false;
      window.setTimeout(() => (note.hidden = true), 2500);
    }
  });

  // The video section appears only when the file is there.
  const video = document.getElementById('paper-video') as HTMLVideoElement | null;
  if (video) {
    const src = `${base}video/supplementary_video_1.mp4`;
    fetch(src, { method: 'HEAD' })
      .then((r) => {
        if (!r.ok || !(r.headers.get('content-type') ?? '').startsWith('video')) return;
        video.src = src;
        video.poster = `${base}video/poster.jpg`;
        (document.getElementById('video') as HTMLElement).hidden = false;
      })
      .catch(() => {});
  }
}
