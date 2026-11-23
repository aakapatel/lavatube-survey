// The paper's quantities, computed in the browser from the survey data.
//
// Overburden at a station is the ground height minus the highest point of the
// mapped ceiling. With the survey surface the values are the paper's own
// (read from meta.json). With a degraded surface, the ground height changes by
// the difference between the degraded and the native elevation model at the
// station, which is the paper's orbital transfer test: block averaging to the
// posting, plus vertical noise correlated over 25 m.

import type { Grid, Meta } from './assets';
import { sampleGrid } from './assets';
import { lcg } from './util';

export type SurfaceId = 'survey' | 'hirise' | 'lroc' | 'ctx';
export type Surface = { id: SurfaceId; label: string; posting: number; sigma: number; note: string };

/** Postings and vertical noise as in the paper's transfer test (Fig. 5a). */
export const SURFACES: Surface[] = [
  { id: 'survey', label: 'Aerial survey', posting: 0.5, sigma: 0, note: 'photogrammetry, 3 cm imagery' },
  { id: 'hirise', label: 'HiRISE class', posting: 1, sigma: 0.3, note: '1 m posting, 0.3 m noise' },
  { id: 'lroc', label: 'LROC NAC class', posting: 5, sigma: 1.0, note: '5 m posting, 1 m noise' },
  { id: 'ctx', label: 'CTX class', posting: 20, sigma: 3.0, note: '20 m posting, 3 m noise' },
];

export type BodyId = 'earth' | 'mars' | 'moon';
export const GRAVITY: Record<BodyId, number> = { earth: 9.81, mars: 3.71, moon: 1.62 };

const CORR_LEN = 25; // metres

/** The survey elevation model degraded to a posting and a noise level. Same grid as the input. */
export function degrade(g: Grid, s: Surface, seed: number): Float32Array {
  if (s.id === 'survey') return g.h;
  const out = new Float32Array(g.h.length);
  const b = Math.max(1, Math.round(s.posting / g.res));
  const cx = Math.ceil(g.nx / b);
  const cz = Math.ceil(g.nz / b);
  // Block means.
  const mean = new Float32Array(cx * cz);
  const cnt = new Uint16Array(cx * cz);
  for (let j = 0; j < g.nz; j++) {
    const cj = Math.floor(j / b);
    for (let i = 0; i < g.nx; i++) {
      const o = cj * cx + Math.floor(i / b);
      mean[o] += g.h[j * g.nx + i];
      cnt[o]++;
    }
  }
  for (let o = 0; o < mean.length; o++) mean[o] /= Math.max(cnt[o], 1);
  // Correlated noise: white noise on a 25 m lattice, interpolated.
  const rnd = lcg(seed);
  const gauss = () => {
    let u = 0;
    for (let k = 0; k < 6; k++) u += rnd();
    return (u - 3) * Math.SQRT2; // close to a unit normal
  };
  const lx = Math.ceil(((g.nx - 1) * g.res) / CORR_LEN) + 2;
  const lz = Math.ceil(((g.nz - 1) * g.res) / CORR_LEN) + 2;
  const lat = new Float32Array(lx * lz);
  for (let o = 0; o < lat.length; o++) lat[o] = gauss();
  const bil = (a: Float32Array, w: number, h: number, fx: number, fz: number) => {
    const i = Math.min(Math.max(Math.floor(fx), 0), w - 2);
    const j = Math.min(Math.max(Math.floor(fz), 0), h - 2);
    const u = Math.min(Math.max(fx - i, 0), 1);
    const v = Math.min(Math.max(fz - j, 0), 1);
    const su = u * u * (3 - 2 * u);
    const sv = v * v * (3 - 2 * v);
    return (a[j * w + i] * (1 - su) + a[j * w + i + 1] * su) * (1 - sv) + (a[(j + 1) * w + i] * (1 - su) + a[(j + 1) * w + i + 1] * su) * sv;
  };
  for (let j = 0; j < g.nz; j++)
    for (let i = 0; i < g.nx; i++) {
      // A terrain model at posting p is read by interpolating between its posts.
      const base = bil(mean, cx, cz, (i + 0.5) / b - 0.5, (j + 0.5) / b - 0.5);
      const noise = bil(lat, lx, lz, (i * g.res) / CORR_LEN, (j * g.res) / CORR_LEN);
      out[j * g.nx + i] = base + noise * s.sigma * 1.18; // 1.18 restores the variance lost by interpolating the lattice
    }
  return out;
}

export type Profile = {
  /** Overburden per station, NaN where the station is not retained. */
  tau: Float32Array;
  /** Ground height used per station. */
  dem: Float32Array;
  n: number;
  min: number;
  max: number;
  median: number;
  q25: number;
  q75: number;
  /** Root-mean-square difference from the survey profile over retained stations. */
  rmsFromSurvey: number;
};

const quantile = (sorted: number[], q: number) => {
  const p = (sorted.length - 1) * q;
  const i = Math.floor(p);
  return sorted[i] + (sorted[Math.min(i + 1, sorted.length - 1)] - sorted[i]) * (p - i);
};

export function profile(meta: Meta, g: Grid, heights: Float32Array): Profile {
  const st = meta.stations;
  const n = st.s.length;
  const tau = new Float32Array(n).fill(NaN);
  const dem = new Float32Array(n).fill(NaN);
  const native = heights === g.h;
  const alt: Grid = { ...g, h: heights };
  const vals: number[] = [];
  let se = 0;
  for (let k = 0; k < n; k++) {
    if (st.cls[k] !== 'intact') continue;
    const [x, , z] = st.pos[k];
    const d = native ? 0 : sampleGrid(alt, x, z) - sampleGrid(g, x, z);
    dem[k] = st.dem[k] + d;
    tau[k] = st.tau[k] + d;
    vals.push(tau[k]);
    se += d * d;
  }
  vals.sort((a, b) => a - b);
  return {
    tau,
    dem,
    n: vals.length,
    min: vals[0],
    max: vals[vals.length - 1],
    median: quantile(vals, 0.5),
    q25: quantile(vals, 0.25),
    q75: quantile(vals, 0.75),
    rmsFromSurvey: Math.sqrt(se / Math.max(vals.length, 1)),
  };
}

export type Assessment = {
  /** Areal mass of the median column, g cm^-2, at the bulk density. */
  shieldingMedian: number;
  /** Fraction of retained stations above 1,000 g cm^-2. */
  shieldingOver1000: number;
  /** Tensile strength each span asks of its roof, MPa: median and 95th percentile, and the number of stations used. */
  strengthMedian: number;
  strengthP95: number;
  strengthN: number;
  /** Largest stable span at the median overburden for 0.5, 1 and 2.5 MPa, metres. */
  span: [number, number, number];
};

/**
 * Shielding mass and the clamped-strip stability model of the paper:
 * sigma = beta * rho * g * L^2 / tau, so L_max = sqrt(sigma_t * tau / (beta * rho * g)).
 */
export function assess(meta: Meta, p: Profile, gravity: number): Assessment {
  const rho = meta.paper.rho;
  const beta = meta.paper.beta;
  const st = meta.stations;
  const sigmaTau = meta.registration.sigma;
  const mass: number[] = [];
  const req: number[] = [];
  for (let k = 0; k < p.tau.length; k++) {
    const t = p.tau[k];
    if (!Number.isFinite(t)) continue;
    mass.push((rho * t) / 10);
    // As in the paper, only columns thicker than the uncertainty are interpreted.
    if (t > sigmaTau && Number.isFinite(st.span[k])) req.push((beta * rho * gravity * st.span[k] * st.span[k]) / t / 1e6);
  }
  mass.sort((a, b) => a - b);
  req.sort((a, b) => a - b);
  const lmax = (s: number) => Math.sqrt((s * 1e6 * p.median) / (beta * rho * gravity));
  return {
    shieldingMedian: quantile(mass, 0.5),
    shieldingOver1000: mass.filter((m) => m > 1000).length / mass.length,
    strengthMedian: req.length ? quantile(req, 0.5) : NaN,
    strengthP95: req.length ? quantile(req, 0.95) : NaN,
    strengthN: req.length,
    span: [lmax(0.5), lmax(1), lmax(2.5)],
  };
}

/** Colour ramp for overburden, dark violet to pale yellow, as in the paper's plan view. */
export function magma(t: number, out: [number, number, number]): [number, number, number] {
  const stops: [number, number, number][] = [
    [0.99, 0.82, 0.38],
    [0.98, 0.55, 0.2],
    [0.83, 0.28, 0.33],
    [0.62, 0.2, 0.52],
    [0.44, 0.2, 0.66],
    [0.3, 0.2, 0.6],
  ];
  const x = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const u = x - i;
  for (let k = 0; k < 3; k++) out[k] = stops[i][k] + (stops[i + 1][k] - stops[i][k]) * u;
  return out;
}
