// The ground. Two height grids drawn with one shader: the survey tile (0.5 m,
// measured) and the generated far field around it (4 m). Heights are read in
// the vertex shader, normals come from the height texture, and the colour is
// built from the survey orthomosaic: its luminance carries the real lava
// texture and its green index, where moss fills the hollows, stands in for
// the dust that fills hollows on Mars.

import * as THREE from 'three';
import type { Assets, Grid } from './assets';
import { ENV_GLSL, type Env } from './env';
import { SECTION_GLSL, type Section } from './section';
import { clamp, noiseTexture } from './util';

const VERT = /* glsl */ `
uniform sampler2D uH;
uniform sampler2D uHFar;
uniform vec4 uGrid;     // x0, z0, size x, size z of this grid
uniform vec4 uGridFar;
uniform float uIsNear;
uniform float uSkirt;
varying vec3 vWorld;
varying vec2 vUv;
varying float vEdge;

void main() {
  vec3 p = position;
  vec2 uv = (p.xz - uGrid.xy) / uGrid.zw;
  float h = texture2D(uH, uv).r;
  float edge = 1.0;
  if (uIsNear > 0.5) {
    // Toward the border of the survey tile the height runs into the far field.
    vec2 d = min(p.xz - uGrid.xy, uGrid.xy + uGrid.zw - p.xz);
    edge = smoothstep(0.0, 12.0, min(d.x, d.y));
    float hf = texture2D(uHFar, (p.xz - uGridFar.xy) / uGridFar.zw).r;
    h = mix(hf, h, edge);
    h -= uSkirt * position.y;
  }
  p.y = h;
  vWorld = p;
  vUv = uv;
  vEdge = edge;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
${ENV_GLSL}
${SECTION_GLSL}
uniform sampler2D uH;
uniform sampler2D uDetail;   // near: luminance, dust index, baked sun
uniform sampler2D uLight;    // far: baked sun
uniform sampler2D uTile;     // seamless patch of the survey ground
uniform sampler2D uOpen;     // near: skylight openings
uniform sampler2D uTubeMask; // near: distance to the tube footprint
uniform sampler2D uNoise;    // tiling noise for grain finer than the photograph
uniform vec4 uGrid;
uniform vec4 uNearRect;      // x0, z0, x1, z1 of the survey tile
uniform vec2 uTexel;
uniform float uRes;
uniform float uIsNear;
uniform float uTileSize;
uniform float uXray;         // 0 solid ground, 1 ground thinned over the tube
uniform float uData;         // 0 natural colour, 1 quiet data backdrop
uniform vec4 uScan;          // dir x, dir z, position, on
uniform vec3 uCam;
varying vec3 vWorld;
varying vec2 vUv;
varying float vEdge;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec2 uv = vUv;
  // The section: ground on the near side of the cut dissolves away.
  if (uCutAmt > 0.0 && beyondCut(vWorld.xz) > 0.0 && hash(floor(gl_FragCoord.xy)) < uCutAmt) discard;
  if (uIsNear < 0.5) {
    // The far field leaves a window for the survey tile.
    vec2 a = step(uNearRect.xy + 1.0, vWorld.xz) * step(vWorld.xz, uNearRect.zw - 1.0);
    if (a.x * a.y > 0.5) discard;
  } else {
    if (texture2D(uOpen, uv).r > 0.5) discard;
  }

  float hl = texture2D(uH, uv - vec2(uTexel.x, 0.0)).r;
  float hr = texture2D(uH, uv + vec2(uTexel.x, 0.0)).r;
  float hd = texture2D(uH, uv - vec2(0.0, uTexel.y)).r;
  float hu = texture2D(uH, uv + vec2(0.0, uTexel.y)).r;
  vec3 n = normalize(vec3(hl - hr, 2.0 * uRes, hd - hu));

  // Ground texture: the survey patch tiled at two scales, replaced by the
  // orthomosaic itself inside the survey tile.
  vec2 tw = vWorld.xz / uTileSize;
  vec3 t1 = texture2D(uTile, tw).rgb;
  vec3 t2 = texture2D(uTile, vec2(-tw.y, tw.x) * 0.173 + 0.37).rgb;
  float lum = mix(t1.r, t2.r, 0.35);
  float dust = mix(t1.g, t2.g, 0.55);
  float lit = 1.0;
  vec2 bump = vec2(0.0);
  float dist = length(vWorld - uCam);
  if (uIsNear > 0.5) {
    vec3 d = texture2D(uDetail, uv).rgb;
    // Snow patches in the survey photograph read as white specks; hold the brightest values down.
    lum = mix(lum, min(d.r, 0.66 + 0.2 * (d.r - 0.66)), vEdge);
    dust = mix(dust, d.g, vEdge);
    lit = d.b;
    vec2 px = vec2(0.16) / uGrid.zw;
    float lx = texture2D(uDetail, uv + vec2(px.x, 0.0)).r - texture2D(uDetail, uv - vec2(px.x, 0.0)).r;
    float lz = texture2D(uDetail, uv + vec2(0.0, px.y)).r - texture2D(uDetail, uv - vec2(0.0, px.y)).r;
    bump = vec2(lx, lz) * vEdge;
  } else {
    lit = texture2D(uLight, uv).r;
    float e = 0.004;
    float lx = texture2D(uTile, tw + vec2(e, 0.0)).r - texture2D(uTile, tw - vec2(e, 0.0)).r;
    float lz = texture2D(uTile, tw + vec2(0.0, e)).r - texture2D(uTile, tw - vec2(0.0, e)).r;
    bump = vec2(lx, lz) * 0.6;
  }
  // The photograph's shading stands in for relief finer than the height grid.
  n = normalize(n - vec3(bump.x, 0.0, bump.y) * 2.1 * smoothstep(320.0, 15.0, dist) * (1.0 - 0.75 * smoothstep(26.0, 6.0, dist)));
  // Close to the camera, grain finer than the photograph.
  vec2 fw = vec2(vWorld.x * 0.83 + vWorld.z * 0.56, vWorld.z * 0.83 - vWorld.x * 0.56) / 11.7;
  float fe = 0.006;
  vec2 fine = vec2(texture2D(uTile, fw + vec2(fe, 0.0)).r - texture2D(uTile, fw - vec2(fe, 0.0)).r,
                   texture2D(uTile, fw + vec2(0.0, fe)).r - texture2D(uTile, fw - vec2(0.0, fe)).r);
  float nearK = smoothstep(60.0, 5.0, dist);
  n = normalize(n - vec3(fine.x, 0.0, fine.y) * 0.9 * nearK);
  lum = mix(lum, lum * (0.8 + 0.4 * texture2D(uTile, fw).r), nearK * 0.6);
  // Within a few metres: gravel and dust ripples from noise at two scales.
  float closeK = smoothstep(22.0, 2.5, dist);
  if (closeK > 0.0) {
    vec4 g1 = texture2D(uNoise, vWorld.xz * 0.41);
    vec4 g2 = texture2D(uNoise, vWorld.xz * 2.3 + 0.37);
    vec2 gb = (g1.rg - 0.5) * 0.9 + (g2.rg - 0.5) * 0.7;
    n = normalize(n + vec3(gb.x, 0.0, gb.y) * closeK);
    float gravel = smoothstep(0.52, 0.7, g2.b) * 0.35 + (g1.a - 0.5) * 0.3;
    lum = mix(lum, clamp(lum * (0.85 + 0.5 * g1.b) - gravel * 0.25, 0.0, 1.0), closeK);
    dust = mix(dust, clamp(dust + (g1.b - 0.5) * 0.5, 0.0, 1.0), closeK);
  }

  // Mars: dark basalt where the rock is bare, ochre dust where it is mantled,
  // more dust on flat ground and less on steep faces.
  float flat_ = smoothstep(0.75, 0.97, n.y);
  float mantle = clamp(smoothstep(0.3, 0.8, dust) * 0.8 + 0.2 * flat_ - 0.12, 0.0, 1.0);
  vec3 rock = vec3(0.062, 0.04, 0.032);
  vec3 dustCol = vec3(0.4, 0.185, 0.085);
  vec3 albedo = mix(rock, dustCol, mantle) * (0.3 + 1.3 * lum);

  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 skyUp = skyColor(vec3(n.x, max(n.y, 0.0) * 0.7 + 0.3, n.z));
  vec3 light = uSunCol * ndl * lit + skyUp * (0.3 + 0.34 * n.y) + vec3(0.1, 0.055, 0.03) * (1.0 - n.y);
  vec3 col = albedo * light;
  // From below, the ground is the unlit roof of whatever void the camera is in.
  if (!gl_FrontFacing) {
    // In the section view the underside is not drawn, so the pits under the openings do not hide the map.
    if (uCutAmt > 0.5) discard;
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  col = applyHaze(col, vWorld, uCam);

  // The scan line of the orbital pass: ground not yet imaged stays dark.
  if (uScan.w > 0.001) {
    float s = dot(vWorld.xz, uScan.xy) - uScan.z;
    float seen = smoothstep(1.5, -1.5, s);
    float line = exp(-abs(s) * 0.9);
    col = mix(col, col * (0.05 + 0.95 * seen) + vec3(1.0, 0.82, 0.55) * line * 0.9, uScan.w);
  }

  // Data backdrop: the ground recedes so the point clouds read.
  float g = dot(col, vec3(0.3, 0.5, 0.2));
  col = mix(col, vec3(g) * vec3(0.5, 0.42, 0.4) * 0.55, uData);

  float alpha = 1.0;
  if (uIsNear > 0.5 && uXray > 0.001) {
    float m = texture2D(uTubeMask, uv).r;       // 0 on the tube, 1 at 24 m and beyond
    float open = smoothstep(0.62, 0.05, m);
    // Thin the ground to a dithered veil over the tube, keeping a faint grid of it.
    alpha = mix(1.0, 0.1 + 0.1 * hash(floor(gl_FragCoord.xy)), open * uXray);
  }
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export type Terrain = {
  group: THREE.Group;
  uniforms: {
    uXray: { value: number };
    uData: { value: number };
    uScan: { value: THREE.Vector4 };
    uCam: { value: THREE.Vector3 };
  };
  /** Ground height in metres at scene (x, z), survey where it exists. */
  height(x: number, z: number): number;
  tubeMask: THREE.DataTexture;
  /** Connect the ground to the section field once the section exists. */
  bindSection(): void;
};

function plane(xs: Float32Array, zs: Float32Array, skirt: boolean): THREE.BufferGeometry {
  const nx = xs.length;
  const nz = zs.length;
  const pos = new Float32Array(nx * nz * 3);
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const o = (j * nx + i) * 3;
      pos[o] = xs[i];
      // y is 1 on the outermost ring of a skirted grid, which the shader pulls down.
      pos[o + 1] = skirt && (i === 0 || j === 0 || i === nx - 1 || j === nz - 1) ? 1 : 0;
      pos[o + 2] = zs[j];
    }
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let k = 0;
  for (let j = 0; j < nz - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      idx[k++] = a;
      idx[k++] = a + nx;
      idx[k++] = a + 1;
      idx[k++] = a + 1;
      idx[k++] = a + nx;
      idx[k++] = a + nx + 1;
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

/** Distance from each metre of the survey tile to the tube footprint, as a texture. */
function tubeMaskTexture(a: Assets): THREE.DataTexture {
  const g = a.near;
  const w = Math.floor((g.nx - 1) * g.res);
  const h = Math.floor((g.nz - 1) * g.res);
  const st = a.meta.stations;
  const data = new Uint8Array(w * h);
  data.fill(255);
  const reach = 24;
  for (let k = 0; k < st.pos.length; k += 1) {
    const [px, , pz] = st.pos[k];
    const half = Math.max(st.width[k] / 2, 3);
    const r = Math.ceil(half + reach);
    const ci = Math.round(px - g.x0);
    const cj = Math.round(pz - g.z0);
    for (let j = Math.max(0, cj - r); j < Math.min(h, cj + r); j++)
      for (let i = Math.max(0, ci - r); i < Math.min(w, ci + r); i++) {
        const d = Math.hypot(i + 0.5 + g.x0 - px, j + 0.5 + g.z0 - pz) - half;
        const v = Math.round(clamp(d / reach, 0, 1) * 255);
        const o = j * w + i;
        if (v < data[o]) data[o] = v;
      }
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RedFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export function createTerrain(a: Assets, env: Env, lowPower: boolean, section: () => Section): Terrain {
  const near = a.near;
  const far = a.far;
  const tubeMask = tubeMaskTexture(a);
  const noise = noiseTexture(256, 23);
  const sizeOf = (g: Grid) => new THREE.Vector4(g.x0, g.z0, (g.nx - 1) * g.res, (g.nz - 1) * g.res);
  // Texture coordinates address texel centres, so the grid rectangle is half a cell wider on each side.
  const rect = (g: Grid) => new THREE.Vector4(g.x0 - g.res / 2, g.z0 - g.res / 2, g.nx * g.res, g.nz * g.res);
  const shared = {
    uXray: { value: 0 },
    uData: { value: 0 },
    uScan: { value: new THREE.Vector4(1, 0, 0, 0) },
    uCam: { value: new THREE.Vector3() },
  };
  // The section is created after the terrain (it needs ground heights), so its uniforms are filled in later.
  const sectionUniforms = { uField: { value: null as THREE.Texture | null }, uFieldRect: { value: new THREE.Vector4(0, 0, 1, 1) }, uCutN: { value: 0.42 }, uCutAmt: { value: 0 } };
  const ns = sizeOf(near);
  const make = (g: Grid, isNear: boolean) =>
    new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      uniforms: {
        ...env.uniforms,
        ...shared,
        ...sectionUniforms,
        uH: { value: g.tex },
        uHFar: { value: far.tex },
        uGrid: { value: rect(g) },
        uGridFar: { value: rect(far) },
        uIsNear: { value: isNear ? 1 : 0 },
        uSkirt: { value: 3 },
        uDetail: { value: a.nearDetail },
        uLight: { value: a.farLight },
        uTile: { value: a.groundTile },
        uOpen: { value: a.nearOpen },
        uTubeMask: { value: tubeMask },
        uNoise: { value: noise },
        uNearRect: { value: new THREE.Vector4(ns.x, ns.y, ns.x + ns.z, ns.y + ns.w) },
        uTexel: { value: new THREE.Vector2(1 / g.nx, 1 / g.nz) },
        uRes: { value: g.res },
        uTileSize: { value: a.meta.terrain.tile.size_m },
      },
    });

  // Survey tile at 1 m (or 2 m on weak devices); the normals still come from the 0.5 m texture.
  const step = lowPower ? 2 : 1;
  const nxs = Math.floor(ns.z / step) + 1;
  const nzs = Math.floor(ns.w / step) + 1;
  const xs = new Float32Array(nxs).map((_, i) => ns.x + (i / (nxs - 1)) * ns.z);
  const zs = new Float32Array(nzs).map((_, j) => ns.y + (j / (nzs - 1)) * ns.w);
  const nearMesh = new THREE.Mesh(plane(xs, zs, true), make(near, true));
  nearMesh.frustumCulled = false;
  nearMesh.renderOrder = 2;

  // Far field: 4 m cells out to 520 m, then cells that grow toward the edge.
  const fs = sizeOf(far);
  const coords: number[] = [];
  const inner = 520;
  for (let v = -inner; v <= inner + 1e-6; v += lowPower ? 8 : 4) coords.push(v);
  let v = inner;
  let d = lowPower ? 8 : 4;
  const limit = fs.z / 2;
  while (v < limit) {
    d *= 1.16;
    v = Math.min(v + d, limit);
    coords.push(v);
    coords.unshift(-v);
  }
  const fc = new Float32Array(coords);
  const farMesh = new THREE.Mesh(plane(fc, fc, false), make(far, false));
  farMesh.frustumCulled = false;
  farMesh.renderOrder = 1;

  const group = new THREE.Group();
  group.add(farMesh, nearMesh);

  const nearMat = nearMesh.material as THREE.ShaderMaterial;
  const setXray = () => {
    const on = shared.uXray.value > 0.001;
    if (nearMat.transparent !== on) {
      nearMat.transparent = on;
      nearMat.depthWrite = !on;
      nearMat.needsUpdate = true;
      nearMesh.renderOrder = on ? 20 : 2;
    }
  };
  nearMesh.onBeforeRender = setXray;

  const height = (x: number, z: number) => {
    const inNear = x > ns.x && z > ns.y && x < ns.x + ns.z && z < ns.y + ns.w;
    const hf = sample(far, x, z);
    if (!inNear) return hf;
    const e = clamp(Math.min(x - ns.x, z - ns.y, ns.x + ns.z - x, ns.y + ns.w - z) / 12, 0, 1);
    const w = e * e * (3 - 2 * e);
    return hf * (1 - w) + sample(near, x, z) * w;
  };
  const bindSection = () => {
    const s = section();
    sectionUniforms.uField = s.uniforms.uField;
    sectionUniforms.uFieldRect = s.uniforms.uFieldRect;
    sectionUniforms.uCutN = s.uniforms.uCutN;
    sectionUniforms.uCutAmt = s.uniforms.uCutAmt;
    for (const mesh of [nearMesh, farMesh]) {
      const u = (mesh.material as THREE.ShaderMaterial).uniforms;
      u.uField = s.uniforms.uField;
      u.uFieldRect = s.uniforms.uFieldRect;
      u.uCutN = s.uniforms.uCutN;
      u.uCutAmt = s.uniforms.uCutAmt;
    }
  };
  return { group, uniforms: shared, height, tubeMask, bindSection };
}

function sample(g: Grid, x: number, z: number): number {
  const fx = clamp((x - g.x0) / g.res, 0, g.nx - 1.001);
  const fz = clamp((z - g.z0) / g.res, 0, g.nz - 1.001);
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const w = fz - j;
  const o = j * g.nx + i;
  return (g.h[o] * (1 - u) + g.h[o + 1] * u) * (1 - w) + (g.h[o + g.nx] * (1 - u) + g.h[o + g.nx + 1] * u) * w;
}
