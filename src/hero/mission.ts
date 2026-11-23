// The mission clock. One loop of LOOP seconds drives everything, and every
// quantity shown is a function of the loop time alone, so the visitor can jump
// to any moment and the scene is right at once.

import type { Meta } from './assets';
import { clamp, lerp, smooth } from './util';

export type ChapterId = 'orbit' | 'survey' | 'descent' | 'explore' | 'register' | 'overburden';

export type Chapter = { id: ChapterId; start: number; end: number; title: string; line: string };

export const CHAPTERS: Chapter[] = [
  { id: 'orbit', start: 0, end: 20, title: 'Orbit', line: 'An orbiter images the surface in strips and builds an elevation model.' },
  { id: 'survey', start: 20, end: 38, title: 'Skylights', line: 'Four candidate openings show up in the surface model.' },
  { id: 'descent', start: 38, end: 60, title: 'Descent', line: 'A rotorcraft leaves the lander and drops through the first skylight.' },
  { id: 'explore', start: 60, end: 104, title: 'Exploration', line: 'It flies the tube by itself and maps it with a spinning lidar. No positioning, no pilot, no prior map.' },
  { id: 'register', start: 104, end: 128, title: 'Registration', line: 'Three openings seen from inside match three seen from above, and tie the interior map to the surface.' },
  { id: 'overburden', start: 128, end: 152, title: 'Overburden', line: 'Rock cover above the ceiling, at every metre of the tube.' },
];
export const LOOP = 160;
/** Start time of a chapter. */
export const at = (id: ChapterId) => CHAPTERS.find((c) => c.id === id)!.start;

export function chapterAt(t: number): Chapter {
  for (const c of CHAPTERS) if (t < c.end) return c;
  return CHAPTERS[CHAPTERS.length - 1];
}

/** Piecewise-linear map through (x, y) knots. */
function pw(t: number, knots: [number, number][]): number {
  if (t <= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i++) {
    if (t <= knots[i][0]) {
      const [x0, y0] = knots[i - 1];
      const [x1, y1] = knots[i];
      return lerp(y0, y1, (t - x0) / (x1 - x0));
    }
  }
  return knots[knots.length - 1][1];
}

export type Pose = { p: [number, number, number]; q: [number, number, number, number] };

export type Flight = {
  /** Seconds of flight shown at loop time t. */
  time(t: number): number;
  /** Position and attitude at flight time tf, from the simulated flight (tools/build_data.py). */
  pose(tf: number, out: Pose): Pose;
  /** Metres flown by flight time tf. */
  arc(tf: number): number;
  /** Flight time at which the craft had flown s metres. */
  timeAtArc(s: number): number;
  /** How many times faster than real the flight is being shown at loop time t. */
  rate(t: number): number;
  /** Rotor speed as a fraction of flight speed, at loop time t: spin-up on the deck, spin-down after landing. */
  rotor(t: number): number;
  legAt(tf: number): string;
  duration: number;
  legs: Record<string, [number, number]>;
};

/** Seconds of the loop, after the start of the descent chapter, that the craft stands on the deck while the rotors come up to speed. */
export const SPIN_UP = 3.8;
/** Seconds into the descent chapter at which the take-off climb ends. */
export const CLIMB_END = 8.4;
/** The exploration chapter in four shots, as seconds after its start: follow, wide, follow, wide. The picture cuts between them. */
export const SHOTS = { wide1: 9.4, follow2: 17.4, wide2: 36.6 };

export function createFlight(meta: Meta): Flight {
  const f = meta.flight;
  const n = f.pos.length;
  const legs: Record<string, [number, number]> = {};
  for (const l of f.legs) legs[l.name] = [l.t0, l.t1];
  const duration = f.duration;
  // Loop time to flight time. The craft stands on the deck while the rotors
  // spin up, climbs at twice real speed, and crosses to the skylight and
  // descends about four times faster. In the tube the shots that ride behind
  // the craft run at six and nine times real speed; the wide shots run faster
  // and the flight time steps forward at each cut, so the whole traverse fits.
  const d = at('descent');
  const e = at('explore');
  const r = at('register');
  const [tr0, tr1] = legs.traverse;
  const knots: [number, number][] = [
    [d + SPIN_UP, 0],
    [d + CLIMB_END, legs.takeoff[1]],
    [e, legs.backtrack[0]],
    [e + SHOTS.wide1, legs.backtrack[1] + 1],
    [e + SHOTS.follow2 - 0.001, tr0 + 150],
    [e + SHOTS.follow2, tr0 + 170],
    [e + SHOTS.wide2 - 0.001, tr0 + 170 + (SHOTS.wide2 - SHOTS.follow2) * 9],
    [e + SHOTS.wide2, tr0 + 170 + (SHOTS.wide2 - SHOTS.follow2) * 9 + 20],
    [r, tr1],
    [r + 19, duration],
  ];
  const time = (t: number) => pw(t, knots);
  const rate = (t: number) => (time(t + 0.05) - time(t - 0.05)) / 0.1;
  // Rotor speed rises close to linearly, as a motor at constant torque gives; the last part eases in.
  const rotor = (t: number) => {
    if (t < d) return 0;
    if (t < r + 19) return clamp((t - (d + 0.5)) / (SPIN_UP - 0.9), 0, 1) ** 0.85;
    return 1 - smooth((t - (r + 19.3)) / 5);
  };

  // Metres flown at each sample, for the camera that rides the flown line a fixed distance behind.
  const arcAt = new Float32Array(n);
  for (let i = 1; i < n; i++) arcAt[i] = arcAt[i - 1] + Math.hypot(f.pos[i][0] - f.pos[i - 1][0], f.pos[i][1] - f.pos[i - 1][1], f.pos[i][2] - f.pos[i - 1][2]);
  const arc = (tf: number) => {
    const x = clamp(tf, 0, duration) * f.hz;
    const i = Math.min(Math.floor(x), n - 2);
    return lerp(arcAt[i], arcAt[i + 1], clamp(x - i, 0, 1));
  };
  const timeAtArc = (s: number) => {
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (arcAt[mid] <= s) lo = mid;
      else hi = mid;
    }
    const span = arcAt[hi] - arcAt[lo];
    return (lo + (span > 1e-6 ? clamp((s - arcAt[lo]) / span, 0, 1) : 0)) / f.hz;
  };

  const pose = (tf: number, out: Pose) => {
    const x = clamp(tf, 0, duration) * f.hz;
    const i = Math.min(Math.floor(x), n - 2);
    const u = clamp(x - i, 0, 1);
    const a = f.pos[i];
    const b = f.pos[i + 1];
    const p0 = f.pos[Math.max(i - 1, 0)];
    const p3 = f.pos[Math.min(i + 2, n - 1)];
    const u2 = u * u;
    const u3 = u2 * u;
    for (let k = 0; k < 3; k++) {
      // Catmull-Rom through the samples: continuous velocity between them.
      const m0 = (b[k] - p0[k]) * 0.5;
      const m1 = (p3[k] - a[k]) * 0.5;
      out.p[k] = (2 * u3 - 3 * u2 + 1) * a[k] + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * b[k] + (u3 - u2) * m1;
    }
    // Samples are 0.2 s apart and the attitude changes slowly, so a normalised blend is enough.
    const qa = f.quat[i];
    const qb = f.quat[i + 1];
    let len = 0;
    for (let k = 0; k < 4; k++) {
      out.q[k] = qa[k] + (qb[k] - qa[k]) * u;
      len += out.q[k] * out.q[k];
    }
    len = Math.sqrt(len) || 1;
    for (let k = 0; k < 4; k++) out.q[k] /= len;
    return out;
  };
  const legAt = (tf: number) => {
    for (const l of f.legs) if (tf <= l.t1 + 1e-6) return l.name;
    return 'landing';
  };
  return { time, pose, arc, timeAtArc, rate, rotor, legAt, duration, legs };
}

/** Progress 0..1 through a window of the loop, eased. */
export const within = (t: number, a: number, b: number) => smooth((t - a) / (b - a));
