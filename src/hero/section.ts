// The section view. The ground is cut along the tube, a little to one side of
// the centreline, and everything on the near side of the cut is removed, so a
// camera standing in the cut-away half looks into the tube from outside it:
// the roof rock in section, the void, and the map building inside.
//
// One field drives every clip: a texture that gives, for a point on the plan,
// its signed distance across the tube and the half width of the tube there.
// The ground, the lidar points and the rocks all read it, so they are cut on
// the same surface, and the rock face is built on that surface.
//
// The face is drawn as stacked basalt flow units between one and three metres
// thick, as logged in the skylight walls of the real tube. The layering is an
// illustration; the outline of the void and the height of the ground are the
// survey.

import * as THREE from 'three';
import type { Meta } from './assets';
import { ENV_GLSL, type Env } from './env';
import { noiseTexture } from './util';

export type Section = {
  /** RGBA half float: distance across the tube (m, positive on the cut side), half width (m), station as a fraction of the tube length. */
  field: THREE.DataTexture;
  /** x0, z0, size x, size z of the field on the plan. */
  rect: THREE.Vector4;
  uniforms: { uField: { value: THREE.DataTexture }; uFieldRect: { value: THREE.Vector4 }; uCutN: { value: number }; uCutAmt: { value: number } };
  face: THREE.Mesh;
  /** Signed distance across the tube, half width, and station fraction at a plan position. */
  lateral(x: number, z: number): [number, number, number];
  /** Is this plan position on the side that the section removes? */
  cutAway(x: number, z: number): boolean;
  /** Side vector and centre of the tube near a position, averaged over a few stations so a camera does not twitch. */
  frameAt(x: number, z: number, out: { side: THREE.Vector3; centre: THREE.Vector3; station: number }): void;
};

/** GLSL: the clip test shared by the ground, the points and the face. */
export const SECTION_GLSL = /* glsl */ `
uniform sampler2D uField;
uniform vec4 uFieldRect;
uniform float uCutN;
uniform float uCutAmt;
// Positive when the plan position lies beyond the cut, in metres.
float beyondCut(vec2 xz) {
  vec2 f = texture2D(uField, (xz - uFieldRect.xy) / uFieldRect.zw).rg;
  return f.r - uCutN * f.g;
}
// Station along the tube as a fraction of its length.
float stationAt(vec2 xz) {
  return texture2D(uField, (xz - uFieldRect.xy) / uFieldRect.zw).b;
}
`;

const EXT = 260; // metres the cut line runs on past each end of the survey

export function createSection(meta: Meta, env: Env, ground: (x: number, z: number) => number): Section {
  const st = meta.stations;
  const n = st.pos.length;
  const cutN = meta.cutN;

  const lateral = (x: number, z: number): [number, number, number] => {
    // Nearest station; past the ends the end station's frame carries on straight.
    let best = 0;
    let bd = Infinity;
    for (let k = 0; k < n; k++) {
      const dx = x - st.pos[k][0];
      const dz = z - st.pos[k][2];
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    const s = st.side[best];
    return [(x - st.pos[best][0]) * s[0] + (z - st.pos[best][2]) * s[2], st.halfWidth[best], best / (n - 1)];
  };

  // Field texture: 2 m cells over a square that holds every camera position of the section views.
  const res = 2;
  const half = 420;
  const size = Math.round((2 * half) / res) + 1;
  const data = new Uint16Array(size * size * 4);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const [lat, hw, along] = lateral(-half + i * res, -half + j * res);
      const o = (j * size + i) * 4;
      data[o] = THREE.DataUtils.toHalfFloat(lat);
      data[o + 1] = THREE.DataUtils.toHalfFloat(hw);
      data[o + 2] = THREE.DataUtils.toHalfFloat(along);
    }
  const field = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.HalfFloatType);
  field.magFilter = field.minFilter = THREE.LinearFilter;
  field.needsUpdate = true;
  const rect = new THREE.Vector4(-half - res / 2, -half - res / 2, size * res, size * res);
  const uniforms = { uField: { value: field }, uFieldRect: { value: rect }, uCutN: { value: cutN }, uCutAmt: { value: 0 } };

  // The rock face: one column of four heights per station, on the cut line.
  type Col = { x: number; z: number; top: number; ceil: number; floor: number; s: number };
  const cols: Col[] = [];
  const BOTTOM = -46;
  const first = Math.max(meta.flight.stationTurn - 6, 0);
  const push = (k: number, along: number) => {
    const c = st.pos[k];
    const s = st.side[k];
    const t = st.tan[k];
    const off = cutN * st.halfWidth[k];
    const x = c[0] + s[0] * off + t[0] * along;
    const z = c[2] + s[2] * off + t[2] * along;
    const top = ground(x, z);
    if (along !== 0 || k < first) {
      // Past the survey, and in the low passage before the turn that the craft does not fly, the face is
      // solid rock. The void closes at mid height, so the two strips of the face meet without a gap.
      const e = Math.max(k, first);
      const midY = Math.min(0.5 * (st.cutCeil[e] + st.cutFloor[e]), top);
      cols.push({ x, z, top, ceil: midY, floor: midY, s: along < 0 ? along : k + along });
      return;
    }
    const ceil = Math.min(st.cutCeil[k], top);
    cols.push({ x, z, top, ceil, floor: Math.min(st.cutFloor[k], ceil), s: k });
  };
  for (let a = -EXT; a < 0; a += 4) push(0, a);
  for (let k = 0; k < n; k++) push(k, 0);
  for (let a = 4; a <= EXT; a += 4) push(n - 1, a);

  const m = cols.length;
  const pos = new Float32Array(m * 4 * 3);
  const depth = new Float32Array(m * 4); // metres below the ground at this column
  const along = new Float32Array(m * 4);
  cols.forEach((c, i) => {
    const ys = [c.top, c.ceil, c.floor, BOTTOM];
    ys.forEach((y, r) => {
      const o = i * 4 + r;
      pos.set([c.x, y, c.z], o * 3);
      depth[o] = c.top - y;
      along[o] = c.s;
    });
  });
  const idx: number[] = [];
  for (let i = 0; i < m - 1; i++) {
    const a = i * 4;
    const b = (i + 1) * 4;
    // Roof strip (ground to ceiling) and base strip (floor to bottom); the void between them stays open.
    idx.push(a, a + 1, b, b, a + 1, b + 1);
    idx.push(a + 2, a + 3, b + 2, b + 2, a + 3, b + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
  geo.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { ...env.uniforms, ...uniforms, uNoise: { value: noiseTexture(256, 5) }, uCam: { value: new THREE.Vector3() }, uLampPos: { value: new THREE.Vector3() }, uLamp: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float aDepth;
      attribute float aAlong;
      varying vec3 vWorld;
      varying float vDepth;
      varying float vAlong;
      void main() {
        vWorld = position;
        vDepth = aDepth;
        vAlong = aAlong;
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      ${ENV_GLSL}
      uniform sampler2D uNoise;
      uniform float uCutAmt;
      uniform vec3 uCam;
      uniform vec3 uLampPos;
      uniform float uLamp;
      varying vec3 vWorld;
      varying float vDepth;
      varying float vAlong;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        // The face appears with the cut, as a dither, so the ground can open gradually.
        if (hash(floor(gl_FragCoord.xy)) > uCutAmt) discard;
        vec2 uv = vec2(vAlong * 0.031, vWorld.y * 0.045);
        vec4 n1 = texture2D(uNoise, uv);
        vec4 n2 = texture2D(uNoise, uv * 6.3 + 0.21);
        vec4 n3 = texture2D(uNoise, vec2(vAlong * 0.9, vWorld.y * 0.35));
        // Flow units: boundaries wander by a metre along the tube, 1.2 to 2.8 m apart.
        float d = vDepth + (n1.r - 0.5) * 2.4 + (n1.g - 0.5) * 0.8;
        float unit = d / (1.9 + 0.5 * sin(d * 0.37));
        float f = fract(unit);
        // Each unit: a vesicular, rubbly top, then a massive core with cooling joints.
        float top = smoothstep(0.22, 0.0, f) ;
        float parting = smoothstep(0.035, 0.0, f) + smoothstep(0.985, 1.0, f);
        float joints = smoothstep(0.82, 0.9, texture2D(uNoise, vec2(vAlong * 1.7 + floor(unit) * 0.37, 0.5)).b) * smoothstep(0.25, 0.5, f);
        vec3 core = mix(vec3(0.058, 0.044, 0.04), vec3(0.092, 0.068, 0.056), n2.r);
        vec3 rubble = mix(vec3(0.115, 0.066, 0.045), vec3(0.16, 0.094, 0.058), n2.g);
        vec3 col = mix(core, rubble, top * (0.55 + 0.45 * n3.r));
        col *= 1.0 - 0.6 * parting - 0.35 * joints;
        // A pale line of dust where the ground meets the cut.
        col = mix(col, vec3(0.5, 0.3, 0.17), smoothstep(0.22, 0.0, vDepth));
        col *= 0.75 + 0.5 * n3.g;
        // Soil and dust at the top, a few decimetres to a metre.
        float soil = smoothstep(0.75 + 0.5 * n1.b, 0.15, vDepth);
        col = mix(col, vec3(0.3, 0.155, 0.08) * (0.7 + 0.6 * n2.b), soil);
        // The face is in shade: sky light from above, fading with depth, and what the lamps spill.
        vec3 light = skyColor(vec3(0.0, 1.0, 0.0)) * (3.4 * exp(-vDepth * 0.03) + 1.0);
        vec3 L = uLampPos - vWorld;
        float dl = length(L);
        light += vec3(1.0, 0.95, 0.88) * 26.0 * uLamp / (14.0 + dl * dl);
        col *= light;
        col = applyHaze(col, vWorld, uCam);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const face = new THREE.Mesh(geo, mat);
  face.frustumCulled = false;
  face.renderOrder = 6;

  // Side vectors averaged over a window, for cameras.
  const win = 14;
  const sideS: THREE.Vector3[] = [];
  for (let k = 0; k < n; k++) {
    const v = new THREE.Vector3();
    for (let j = Math.max(0, k - win); j <= Math.min(n - 1, k + win); j++) v.add(new THREE.Vector3(st.side[j][0], 0, st.side[j][2]));
    sideS.push(v.normalize());
  }
  const frameAt: Section['frameAt'] = (x, z, out) => {
    let best = 0;
    let bd = Infinity;
    for (let k = 0; k < n; k++) {
      const d = (x - st.pos[k][0]) ** 2 + (z - st.pos[k][2]) ** 2;
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    out.side.copy(sideS[best]);
    out.centre.set(st.pos[best][0], st.pos[best][1], st.pos[best][2]);
    out.station = best;
  };
  return {
    field,
    rect,
    uniforms,
    face,
    lateral,
    cutAway: (x, z) => {
      const [lat, hw] = lateral(x, z);
      return lat > cutN * hw - 0.5;
    },
    frameAt,
  };
}
