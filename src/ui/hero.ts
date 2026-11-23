// The interface over the 3D module: chapter bar, readouts, the overburden
// chart and its switches, and the labels pinned to things in the scene.
// Everything here is ordinary HTML and works from the keyboard.

import { CHAPTERS, LOOP, SURFACES, at, type Engine, type HeroState } from '../hero/engine';
import type { BodyId, SurfaceId } from '../hero/analysis';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');
const thousands = (v: number) => Math.round(v).toLocaleString('en-GB');
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Times inside the last chapter: the profile is drawn by ASSESS, and the loop can be held at HOLD. */
const O = at('overburden');
const R = at('register');
const ASSESS = O + 11.5;
const HOLD = O + 23.5;

const LEGS: Record<string, string> = {
  takeoff: 'Take-off',
  transit: 'Transit to the skylight',
  descent: 'Descent through the skylight',
  backtrack: 'Toward the entrance',
  traverse: 'Mapping the tube',
  return: 'Return to the largest skylight',
  ascent: 'Ascent',
  home: 'Transit to the lander',
  landing: 'Landing',
};
const BODIES: { id: BodyId; label: string }[] = [
  { id: 'earth', label: 'Earth' },
  { id: 'mars', label: 'Mars' },
  { id: 'moon', label: 'Moon' },
];

type Row = { key: string; label: string; cls?: string };

export function mountHero(engine: Engine) {
  const hero = $('hero');
  const panel = $('hero-panel');
  const chTitle = $('ch-title');
  const chLine = $('ch-line');
  const chNum = $('ch-num');
  const list = $('hero-chapters');
  const playBtn = $<HTMLButtonElement>('hero-play');
  const labels = $('hero-labels');
  const meta = engine.assets.meta;

  // ---------------------------------------------------------------- chapter bar
  const fills: HTMLElement[] = [];
  CHAPTERS.forEach((c, i) => {
    const li = document.createElement('li');
    li.style.flex = String(c.end - c.start);
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<span class="lbl"><b>${i + 1}</b>${c.title}</span><span class="trk"><i></i></span>`;
    b.setAttribute('aria-label', `Chapter ${i + 1}: ${c.title}`);
    b.addEventListener('click', () => {
      hold = false;
      engine.seek(c.start + 0.4);
      setPlaying(true);
    });
    li.appendChild(b);
    list.appendChild(li);
    fills.push(b.querySelector('i') as HTMLElement);
  });

  let playing = true;
  /** After a request for a computation the loop stops at the end of the last chapter, so the switches can be used. */
  let hold = false;
  const setPlaying = (on: boolean) => {
    playing = on;
    engine.play(on);
    playBtn.setAttribute('aria-pressed', String(on));
    playBtn.setAttribute('aria-label', on ? 'Pause the animation' : 'Play the animation');
  };
  playBtn.addEventListener('click', () => {
    if (!playing && engine.state().t > HOLD - 0.5) engine.seek(0);
    hold = false;
    setPlaying(!playing);
  });
  hero.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && (e.target === hero || e.target === $('hero-canvas'))) {
      e.preventDefault();
      playBtn.click();
    }
  });
  $('ask-overburden').addEventListener('click', () => {
    hold = true;
    engine.seek(O + 0.2);
    setPlaying(true);
  });
  $('ask-assess').addEventListener('click', () => {
    hold = true;
    engine.seek(ASSESS);
    setPlaying(true);
  });

  // ---------------------------------------------------------------- panels, one per chapter
  const defs: Record<string, { title: string; rows: Row[]; foot: string }> = {
    orbit: {
      title: 'Orbiter',
      rows: [
        { key: 'alt', label: 'Altitude' },
        { key: 'spd', label: 'Speed' },
        { key: 'per', label: 'Period' },
        { key: 'rng', label: 'Ground track to the site', cls: 's' },
        { key: 'sub', label: 'Below the orbiter' },
        { key: 'rate', label: 'Shown' },
      ],
      foot: 'Circular orbit at 93° inclination. The bright strip is 6 km of high-resolution imaging inside 30 km of context.',
    },
    survey: {
      title: 'Surface model',
      rows: [
        { key: 'post', label: 'Posting', cls: 's' },
        { key: 'pts', label: 'Posts over the site', cls: 's' },
        { key: 'noise', label: 'Vertical noise' },
        { key: 'open', label: 'Candidate openings', cls: 's' },
      ],
      foot: 'An opening is an enclosed region where the surface drops away. The relief is the aerial survey of the real site, resampled to a HiRISE-class terrain model.',
    },
    flight: {
      title: 'Rotorcraft',
      rows: [
        { key: 'leg', label: 'Phase' },
        { key: 'time', label: 'Flight time' },
        { key: 'spd', label: 'Speed' },
        { key: 'dep', label: 'Below the surface' },
        { key: 'pts', label: 'Lidar returns in the map', cls: 'i' },
        { key: 'rate', label: 'Shown' },
      ],
      foot: 'Speeds follow the real mission, 298 m of flight in 560 s. The airframe tilts by tan θ = a / g under Mars gravity, so a slow survey flight is close to level.',
    },
    register: {
      title: 'Registration',
      rows: [
        { key: 'o1', label: 'Interior map above its place, S1', cls: 'i' },
        { key: 'o2', label: 'S2', cls: 'i' },
        { key: 'o3', label: 'S3', cls: 'i' },
        { key: 'c1', label: 'Skylight spacing, inside against above' },
        { key: 'c2', label: 'Tape at seven rim points' },
        { key: 'c3', label: 'Adopted vertical uncertainty' },
      ],
      foot: 'Matching skylight centres leaves the interior several metres too high, because the rim seen from below is the ceiling and the rim seen from above is the ground. The fit on the rock around each opening removes it.',
    },
  };

  const groups: Record<string, { root: HTMLElement; cells: Record<string, HTMLElement>; stage?: HTMLElement }> = {};
  for (const [id, d] of Object.entries(defs)) {
    const root = document.createElement('div');
    root.hidden = true;
    root.innerHTML =
      `<h3>${d.title}</h3>` +
      (id === 'register' ? '<p class="stage"></p>' : '') +
      `<dl>${d.rows.map((r) => `<dt>${r.label}</dt><dd class="${r.cls ?? ''}" data-k="${r.key}"></dd>`).join('')}</dl>` +
      `<p class="foot">${d.foot}</p>`;
    panel.appendChild(root);
    const cells: Record<string, HTMLElement> = {};
    root.querySelectorAll<HTMLElement>('dd').forEach((el) => (cells[el.dataset.k!] = el));
    groups[id] = { root, cells, stage: root.querySelector('.stage') as HTMLElement | undefined };
  }

  // Overburden panel: chart, numbers, and the two switches.
  const ob = document.createElement('div');
  ob.className = 'cols';
  ob.hidden = true;
  ob.innerHTML = `
    <div class="group">
      <h3>Overburden along the tube</h3>
      <canvas id="ob-chart" width="544" height="236" role="img" aria-label="Overburden in metres against distance along the tube"></canvas>
      <dl>
        <dt>Median</dt><dd class="s" data-k="med"></dd>
        <dt>Middle half</dt><dd data-k="iqr"></dd>
        <dt>Range, uncertainty</dt><dd data-k="rng"></dd>
      </dl>
      <div class="seg" role="group" aria-label="Surface model">${SURFACES.map((s) => `<button type="button" data-surface="${s.id}" aria-pressed="false">${s.label.replace(' class', '')}</button>`).join('')}</div>
      <p class="hint" data-k="surf"></p>
    </div>
    <div class="group" data-assess hidden>
      <h3>Assessment inputs</h3>
      <dl>
        <dt>Shielding mass, median</dt><dd data-k="mass"></dd>
        <dt>Stations above 1,000 g cm<sup>-2</sup></dt><dd data-k="m1000"></dd>
        <dt>Strength the roof needs</dt><dd data-k="req"></dd>
        <dt>Widest stable span at 1 MPa</dt><dd class="s" data-k="span"></dd>
      </dl>
      <div class="seg" role="group" aria-label="Gravity">${BODIES.map((b) => `<button type="button" data-body="${b.id}" aria-pressed="false">${b.label}</button>`).join('')}</div>
      <p class="hint">Areal mass is an input to radiation transport, not a dose. Span range: rock of 0.5 to 2.5 MPa.</p>
    </div>`;
  panel.appendChild(ob);
  const obCells: Record<string, HTMLElement> = {};
  ob.querySelectorAll<HTMLElement>('[data-k]').forEach((el) => (obCells[el.dataset.k!] = el));
  const assessGroup = ob.querySelector('[data-assess]') as HTMLElement;
  const chart = ob.querySelector('canvas') as HTMLCanvasElement;
  const g2 = chart.getContext('2d')!;
  const touch = () => {
    // A switch was used: stay in the last chapter and stop the loop there.
    hold = true;
    const t = engine.state().t;
    if (t < ASSESS || t > HOLD - 0.1) engine.seek(O + 18);
  };
  ob.querySelectorAll<HTMLButtonElement>('[data-surface]').forEach((b) =>
    b.addEventListener('click', () => {
      engine.setSurface(b.dataset.surface as SurfaceId);
      touch();
      render(engine.state(), true);
    }),
  );
  ob.querySelectorAll<HTMLButtonElement>('[data-body]').forEach((b) =>
    b.addEventListener('click', () => {
      engine.setBody(b.dataset.body as BodyId);
      touch();
      render(engine.state(), true);
    }),
  );

  const set = (cells: Record<string, HTMLElement>, k: string, v: string) => {
    const el = cells[k];
    if (el && el.textContent !== v) el.textContent = v;
  };

  const drawChart = (s: HeroState) => {
    const w = chart.width;
    const h = chart.height;
    const padL = 34;
    const padB = 26;
    const padT = 8;
    const st = meta.stations;
    const n = st.s.length;
    const yMax = 18;
    const yMin = -4;
    const X = (k: number) => padL + (k / (n - 1)) * (w - padL - 4);
    const Y = (v: number) => padT + (1 - (v - yMin) / (yMax - yMin)) * (h - padT - padB);
    g2.clearRect(0, 0, w, h);
    g2.font = '500 18px "IBM Plex Mono", monospace';
    // Skylight reaches.
    g2.fillStyle = 'rgba(232,166,96,0.16)';
    let run = -1;
    for (let k = 0; k <= n; k++) {
      const sky = k < n && st.cls[k] === 'skylight';
      if (sky && run < 0) run = k;
      if (!sky && run >= 0) {
        g2.fillRect(X(run), padT, Math.max(X(k - 1) - X(run), 3), h - padT - padB);
        run = -1;
      }
    }
    // Axes.
    g2.strokeStyle = 'rgba(236,229,218,0.22)';
    g2.fillStyle = 'rgba(183,171,155,0.9)';
    g2.lineWidth = 1;
    for (const v of [0, 5, 10, 15]) {
      g2.beginPath();
      g2.moveTo(padL, Y(v) + 0.5);
      g2.lineTo(w - 4, Y(v) + 0.5);
      g2.stroke();
      g2.textAlign = 'right';
      g2.fillText(String(v), padL - 6, Y(v) + 6);
    }
    g2.textAlign = 'center';
    for (const d of [0, 100, 200, 300]) g2.fillText(`${d}`, X(d), h - 5);
    g2.textAlign = 'right';
    g2.fillText('m', w - 4, h - 5);
    const line = (tau: Float32Array, upTo: number, style: string, width: number) => {
      g2.strokeStyle = style;
      g2.lineWidth = width;
      g2.beginPath();
      let pen = false;
      for (let k = 0; k < n && k <= upTo; k++) {
        const v = tau[k];
        if (!Number.isFinite(v)) {
          pen = false;
          continue;
        }
        if (pen) g2.lineTo(X(k), Y(v));
        else g2.moveTo(X(k), Y(v));
        pen = true;
      }
      g2.stroke();
    };
    const upTo = Math.round(s.reveal * (n - 1));
    // The systematic band around the survey profile, then the survey, then the chosen surface model.
    g2.fillStyle = 'rgba(236,229,218,0.09)';
    const sig = meta.registration.sigma;
    for (let k = 1; k < n && k <= upTo; k++) {
      const a = s.survey.tau[k - 1];
      const b = s.survey.tau[k];
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      g2.beginPath();
      g2.moveTo(X(k - 1), Y(a + sig));
      g2.lineTo(X(k), Y(b + sig));
      g2.lineTo(X(k), Y(b - sig));
      g2.lineTo(X(k - 1), Y(a - sig));
      g2.fill();
    }
    line(s.survey.tau, upTo, 'rgba(236,229,218,0.55)', 2);
    if (s.surface !== 'survey') line(s.profile.tau, upTo, '#e8a660', 2.5);
  };

  let lastChapter = '';
  const render = (s: HeroState, force = false) => {
    const ci = CHAPTERS.findIndex((c) => c.id === s.chapter);
    const c = CHAPTERS[ci];
    if (s.chapter !== lastChapter || force) {
      lastChapter = s.chapter;
      chTitle.textContent = c.title;
      chLine.textContent = c.line;
      chNum.textContent = String(ci + 1);
      const which = s.chapter === 'descent' || s.chapter === 'explore' ? 'flight' : s.chapter;
      for (const [id, g] of Object.entries(groups)) g.root.hidden = id !== which;
      ob.hidden = s.chapter !== 'overburden';
      if (s.chapter !== 'overburden') panel.classList.remove('wide');
      list.querySelectorAll('li').forEach((li, i) => li.classList.toggle('on', i === ci));
    }
    CHAPTERS.forEach((ch, i) => {
      const f = Math.min(Math.max((s.t - ch.start) / (ch.end - ch.start), 0), 1);
      fills[i].style.width = `${(i === CHAPTERS.length - 1 && s.t >= ch.end ? 1 : f) * 100}%`;
    });
    if (hold && playing && s.t >= HOLD) setPlaying(false);

    if (s.chapter === 'orbit') {
      const o = groups.orbit.cells;
      set(o, 'alt', `${o_alt} km`);
      set(o, 'spd', `${fmt(s.orbit.speed, 2)} km/s`);
      set(o, 'per', `${period} min`);
      set(o, 'rng', s.orbit.range > 1 ? `${thousands(s.orbit.range)} km` : 'overhead');
      set(o, 'sub', `${fmt(Math.abs(s.orbit.lat), 1)}° ${s.orbit.lat < 0 ? 'S' : 'N'}, ${fmt(Math.abs(s.orbit.lon), 1)}° ${s.orbit.lon < 0 ? 'W' : 'E'}`);
      set(o, 'rate', `${s.orbit.rate} times real speed`);
    } else if (s.chapter === 'survey') {
      const o = groups.survey.cells;
      set(o, 'post', '1 m');
      set(o, 'pts', thousands(posts * Math.min(Math.max((s.t - (at('survey') + 0.6)) / 8, 0), 1)));
      set(o, 'noise', '0.3 m');
      set(o, 'open', s.t < at('survey') + 10.5 ? 'searching' : String(Math.min(4, 1 + Math.floor((s.t - (at('survey') + 10.5)) / 0.75))));
    } else if (s.chapter === 'descent' || s.chapter === 'explore') {
      const o = groups.flight.cells;
      set(o, 'leg', s.flight.time < 0.5 ? 'On the lander' : (LEGS[s.flight.leg] ?? s.flight.leg));
      set(o, 'time', clock(s.flight.time));
      set(o, 'spd', `${fmt(s.flight.speed, 2)} m/s`);
      set(o, 'dep', s.flight.agl < -0.5 ? `${fmt(-s.flight.agl, 1)} m` : 'above ground');
      set(o, 'pts', s.flight.total ? thousands(s.flight.points) : 'loading the map');
      set(o, 'rate', s.flight.rate > 0.5 ? `${fmt(s.flight.rate, 0)} times real speed` : 'real time');
    } else if (s.chapter === 'register') {
      const g = groups.register;
      const st = s.registration.stage;
      const text = st < 0.02 ? 'The interior map, in the frame the robot built it in.' : st < 1 ? 'Closed-form fit: the three openings seen from inside onto three of the four seen from above.' : st < 1.98 ? 'Refinement on six sections through the rock around the openings.' : 'Registered. The fourth candidate had no partner inside and is rejected.';
      if (g.stage && g.stage.textContent !== text) g.stage.textContent = text;
      const off = s.registration.offsets;
      const show = (v: number) => (st < 0.98 ? 'not yet aligned' : `${fmt(Math.max(v, 0), 1)} m`);
      set(g.cells, 'o1', show(off[0]));
      set(g.cells, 'o2', show(off[1]));
      set(g.cells, 'o3', show(off[2]));
      const done = st >= 1.98;
      set(g.cells, 'c1', done ? '0.12 to 0.24 m' : '');
      set(g.cells, 'c2', done ? '0.33 m r.m.s.' : '');
      set(g.cells, 'c3', done ? `±${fmt(meta.registration.sigma, 1)} m` : '');
    } else {
      const p = s.profile;
      set(obCells, 'med', `${fmt(p.median, 1)} m`);
      set(obCells, 'iqr', `${fmt(p.q25, 1)} to ${fmt(p.q75, 1)} m`);
      set(obCells, 'rng', `${fmt(Math.max(p.min, 0), 1)} to ${fmt(p.max, 1)} m, ±${fmt(meta.registration.sigma, 1)}`);
      const sf = SURFACES.find((x) => x.id === s.surface)!;
      set(obCells, 'surf', s.surface === 'survey' ? 'Aerial survey of the real site: the values of the paper.' : `${sf.label}: ${sf.note}. Differs from the aerial survey by ${fmt(p.rmsFromSurvey, 2)} m r.m.s. (grey line).`);
      ob.querySelectorAll<HTMLButtonElement>('[data-surface]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.surface === s.surface)));
      ob.querySelectorAll<HTMLButtonElement>('[data-body]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.body === s.body)));
      assessGroup.hidden = s.t < ASSESS;
      panel.classList.toggle('wide', !assessGroup.hidden);
      const a = s.assessment;
      set(obCells, 'mass', `${thousands(Math.round(a.shieldingMedian / 10) * 10)} g cm⁻²`);
      set(obCells, 'm1000', `${fmt(a.shieldingOver1000 * 100, 0)}%`);
      set(obCells, 'req', `${fmt(a.strengthMedian, 2)} MPa (95%: ${fmt(a.strengthP95, 1)})`);
      set(obCells, 'span', `${fmt(a.span[1], 0)} m (${fmt(a.span[0], 0)} to ${fmt(a.span[2], 0)})`);
      drawChart(s);
    }
  };
  const o_alt = engine.state().orbit.altitude;
  const period = Math.round((2 * Math.PI) / engine.meanMotion / 60);
  const posts = (Math.floor((engine.assets.near.nx - 1) / 2) + 1) * (Math.floor((engine.assets.near.nz - 1) / 2) + 1);
  engine.subscribe(render);
  render(engine.state(), true);

  // ---------------------------------------------------------------- labels in the scene
  const text: Record<string, [string, string]> = { S1: ['S1', 's'], S2: ['S2', 's'], S3: ['S3', 's'], rejected: ['candidate', 's'], lander: ['lander', ''] };
  const els = engine.anchors().map((a) => {
    const el = document.createElement('span');
    el.textContent = text[a.id]?.[0] ?? a.id;
    el.className = text[a.id]?.[1] ?? '';
    labels.appendChild(el);
    return el;
  });
  engine.onFrame(() => {
    const t = engine.state().t;
    engine.anchors().forEach((a, i) => {
      const el = els[i];
      if (!el.textContent) return;
      el.style.opacity = String(a.show);
      if (a.show > 0) el.style.transform = `translate(${Math.round(a.x + 8)}px, ${Math.round(a.y - 6)}px)`;
      if (a.id === 'rejected') {
        const rej = t >= R + 10 && t < LOOP;
        const want = rej ? 'rejected' : 'candidate';
        if (el.textContent !== want) {
          el.textContent = want;
          el.className = rej ? 'dim' : 's';
        }
      }
    });
  });
}
