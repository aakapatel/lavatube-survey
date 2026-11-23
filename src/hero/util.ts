import * as THREE from 'three';

export const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (t: number) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};
/** 0 before a, 1 after b, smooth between. */
export const ramp = (t: number, a: number, b: number) => smooth((t - a) / (b - a));
export const v3 = (a: number[] | readonly number[]) => new THREE.Vector3(a[0], a[1], a[2]);

/** Deterministic random numbers in [0, 1). */
export function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Exponential approach that does not depend on the frame rate. */
export const damp = (a: number, b: number, rate: number, dt: number) => lerp(a, b, 1 - Math.exp(-rate * dt));

/** A soft round sprite, white with alpha falling off from the centre. */
export function radialTexture(size = 64, power = 2): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      const a = Math.pow(clamp(1 - r, 0, 1), power);
      const o = (y * size + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
      img.data[o + 3] = Math.round(a * 255);
    }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** Tiling smooth noise in four channels, for triplanar rock detail. */
export function noiseTexture(size = 256, seed = 7): THREE.DataTexture {
  const rnd = lcg(seed);
  const data = new Uint8Array(size * size * 4);
  for (let c = 0; c < 4; c++) {
    // Sum of octaves of value noise on a wrapping lattice.
    const acc = new Float32Array(size * size);
    let amp = 1;
    let norm = 0;
    for (let cell = size / 4; cell >= 2; cell /= 2) {
      const n = size / cell;
      const lat = new Float32Array(n * n);
      for (let i = 0; i < lat.length; i++) lat[i] = rnd();
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const fx = x / cell;
          const fy = y / cell;
          const x0 = Math.floor(fx) % n;
          const y0 = Math.floor(fy) % n;
          const x1 = (x0 + 1) % n;
          const y1 = (y0 + 1) % n;
          const u = smooth(fx - Math.floor(fx));
          const v = smooth(fy - Math.floor(fy));
          acc[y * size + x] += amp * lerp(lerp(lat[y0 * n + x0], lat[y0 * n + x1], u), lerp(lat[y1 * n + x0], lat[y1 * n + x1], u), v);
        }
      norm += amp;
      amp *= 0.55;
    }
    for (let i = 0; i < acc.length; i++) data[i * 4 + c] = Math.round(clamp(acc[i] / norm, 0, 1) * 255);
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/**
 * Tiling rock detail in four channels: r and a broad fields (sums of octaves),
 * g ridges (folded octaves, for cracks and flow wrinkles), b pits (distance to
 * scattered points, for vesicles).
 */
export function rockTexture(size = 512, seed = 7): THREE.DataTexture {
  const rnd = lcg(seed);
  const data = new Uint8Array(size * size * 4);
  const octaves = (c: number, ridged: boolean, first: number) => {
    const acc = new Float32Array(size * size);
    let amp = 1;
    for (let cell = first; cell >= 2; cell /= 2) {
      const n = size / cell;
      const lat = new Float32Array(n * n);
      for (let i = 0; i < lat.length; i++) lat[i] = rnd();
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const fx = x / cell;
          const fy = y / cell;
          const x0 = Math.floor(fx) % n;
          const y0 = Math.floor(fy) % n;
          const x1 = (x0 + 1) % n;
          const y1 = (y0 + 1) % n;
          const u = smooth(fx - Math.floor(fx));
          const v = smooth(fy - Math.floor(fy));
          let val = lerp(lerp(lat[y0 * n + x0], lat[y0 * n + x1], u), lerp(lat[y1 * n + x0], lat[y1 * n + x1], u), v);
          if (ridged) {
            val = 1 - Math.abs(2 * val - 1);
            val *= val;
          }
          acc[y * size + x] += amp * val;
        }
      amp *= ridged ? 0.5 : 0.55;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < acc.length; i++) {
      lo = Math.min(lo, acc[i]);
      hi = Math.max(hi, acc[i]);
    }
    for (let i = 0; i < acc.length; i++) data[i * 4 + c] = Math.round(((acc[i] - lo) / (hi - lo)) * 255);
  };
  octaves(0, false, size / 4);
  octaves(1, true, size / 8);
  octaves(3, false, size / 4);
  // Pits: one point per cell of a wrapping grid, the value falls with distance to the nearest.
  const cells = 40;
  const cs = size / cells;
  const px = new Float32Array(cells * cells);
  const py = new Float32Array(cells * cells);
  const pr = new Float32Array(cells * cells);
  for (let i = 0; i < cells * cells; i++) {
    px[i] = rnd();
    py[i] = rnd();
    pr[i] = 0.25 + 0.75 * rnd() * rnd();
  }
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const gx = Math.floor(x / cs);
      const gy = Math.floor(y / cs);
      let best = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const cx = (gx + dx + cells) % cells;
          const cy = (gy + dy + cells) % cells;
          const k = cy * cells + cx;
          const ddx = x / cs - (gx + dx + px[k]);
          const ddy = y / cs - (gy + dy + py[k]);
          const d = Math.hypot(ddx, ddy) / (0.55 * pr[k]);
          best = Math.max(best, 1 - smooth(d));
        }
      data[(y * size + x) * 4 + 2] = Math.round(best * 255);
    }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}
