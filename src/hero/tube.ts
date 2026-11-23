// The lava tube: sky dome, the rock mesh of the interior and the lidar map.
//
// The mesh is a surface fitted to the interior lidar cloud of the first long
// flight. Its vertex colours carry three bakes (tools/build_data.py), ambient
// occlusion, how much sky a point sees through an opening and direct sun, and
// the lidar intensity. Underground the only other light is the rotorcraft's
// own lamps. Relief and colour finer than the 15 cm mesh come from a tiling
// texture; they are an illustration of basalt, not a measurement.

import * as THREE from 'three';
import type { Assets, CloudMeta } from './assets';
import { ENV_GLSL, type Env } from './env';
import { SECTION_GLSL, type Section } from './section';
import { rockTexture } from './util';

// ------------------------------------------------------------------ sky

export function createSky(env: Env): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    uniforms: { ...env.uniforms },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      ${ENV_GLSL}
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 c = skyColor(d);
        float mu = dot(d, uSunDir);
        // The disc, about 0.35 degrees across from Mars, with a soft limb.
        c += vec3(6.0, 5.6, 5.0) * smoothstep(0.999955, 0.999985, mu);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), mat);
  m.frustumCulled = false;
  m.renderOrder = -10;
  return m;
}

// ------------------------------------------------------------------ rock

export type Tube = {
  mesh: THREE.Mesh;
  /** Swap in the full mesh once it has arrived. */
  upgrade(hi: THREE.Mesh): void;
  uniforms: {
    uLampPos: { value: THREE.Vector3 };
    uLampDir: { value: THREE.Vector3 };
    uLamp: { value: number };
    uCam: { value: THREE.Vector3 };
    uShell: { value: number };
    uMapLight: { value: number };
    uMapped: { value: THREE.Vector2 };
  };
};

export function createTube(a: Assets, env: Env, section: Section): Tube {
  const uniforms = {
    ...env.uniforms,
    ...section.uniforms,
    uRock: { value: rockTexture(512, 11) },
    uLampPos: { value: new THREE.Vector3() },
    uLampDir: { value: new THREE.Vector3(0, 0, 1) },
    uLamp: { value: 0 },
    uCam: { value: new THREE.Vector3() },
    /** 0 lit rock, 1 a dim shell for views through the ground. */
    uShell: { value: 0 },
    /** Even light on the mapped part of the tube, for the section view from outside. */
    uMapLight: { value: 0 },
    /** The mapped part, as station fractions from and to. */
    uMapped: { value: new THREE.Vector2(0, 0) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec4 color;
      varying vec3 vWorld;
      varying vec3 vN;
      varying vec4 vBake;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        vBake = color;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      ${ENV_GLSL}
      ${SECTION_GLSL}
      uniform sampler2D uRock;   // r broad relief, g ridges, b pits, a a second broad field
      uniform vec3 uLampPos;
      uniform vec3 uLampDir;
      uniform float uLamp;
      uniform vec3 uCam;
      uniform float uShell;
      uniform float uMapLight;
      uniform vec2 uMapped;
      varying vec3 vWorld;
      varying vec3 vN;
      varying vec4 vBake;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      vec4 tri(vec3 p, vec3 w, float s) {
        return texture2D(uRock, p.yz * s) * w.x + texture2D(uRock, p.xz * s + 0.37) * w.y + texture2D(uRock, p.xy * s + 0.71) * w.z;
      }

      void main() {
        // In the section view the half of the tube on the near side of the cut is not drawn.
        if (uCutAmt > 0.0 && beyondCut(vWorld.xz) > 0.0 && hash(floor(gl_FragCoord.xy)) < uCutAmt) discard;
        float ao = vBake.r;
        float sky = vBake.g;
        float sun = vBake.b;
        float inten = vBake.a;

        vec3 n = normalize(vN);
        vec3 V = normalize(uCam - vWorld);
        // Face the viewer whichever way the triangle is wound.
        if (dot(n, V) < 0.0) n = -n;
        vec3 w = pow(abs(n), vec3(4.0));
        w /= (w.x + w.y + w.z);
        float dist = length(uCam - vWorld);
        vec4 t0 = tri(vWorld, w, 0.045);  // 22 m: staining
        vec4 t1 = tri(vWorld, w, 0.21);   // 5 m: flow lobes
        vec4 t2 = tri(vWorld, w, 0.93);   // 1 m: blocks and cracks
        vec4 t3 = tri(vWorld, w, 4.1);    // 25 cm: vesicles and grain
        // Relief finer than the mesh, as a height in metres.
        float fine = smoothstep(26.0, 3.0, dist);
        float h = 0.05 * t1.r + 0.035 * t2.g - 0.02 * t2.b + fine * (0.011 * t3.g - 0.012 * t3.b + 0.006 * t3.r);
        // Bump the normal from the screen-space slope of that height.
        vec3 dpx = dFdx(vWorld);
        vec3 dpy = dFdy(vWorld);
        float dhx = dFdx(h);
        float dhy = dFdy(h);
        vec3 r1 = cross(dpy, n);
        vec3 r2 = cross(n, dpx);
        float det = dot(dpx, r1);
        vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
        n = normalize(abs(det) * n - 1.5 * grad);

        // Basalt: near black where fresh, browner where weathered. The lidar intensity carries the real
        // variation from metre to metre; noise adds what is finer than the map.
        float tone = clamp(0.25 + 0.75 * inten + 0.35 * (t1.a - 0.5) + 0.25 * (t2.r - 0.5), 0.0, 1.0);
        vec3 albedo = mix(vec3(0.017, 0.015, 0.015), vec3(0.074, 0.06, 0.052), tone);
        // Cracks and pits hold shadow.
        albedo *= 1.0 - 0.45 * smoothstep(0.55, 0.9, t2.b) - 0.3 * fine * smoothstep(0.5, 0.9, t3.b);
        // Iron staining in patches, and thin pale mineral crusts where water has seeped.
        albedo = mix(albedo, vec3(0.085, 0.048, 0.032), smoothstep(0.58, 0.8, t0.r) * (0.3 + 0.35 * t2.r));
        albedo = mix(albedo, vec3(0.24, 0.21, 0.17), smoothstep(0.7, 0.86, t0.a) * smoothstep(0.45, 0.75, t2.g) * 0.28);
        // Dust settles on what faces up.
        float up = smoothstep(0.55, 0.95, vN.y * sign(dot(vN, V)));
        albedo = mix(albedo, vec3(0.082, 0.054, 0.038) * (0.7 + 0.6 * t2.r), up * (0.3 + 0.4 * t1.r));

        vec3 col = vec3(0.0);
        // Daylight through the openings.
        col += albedo * (uSkyHorizon * 0.6 + uSkyZenith * 0.4) * sky * 6.0 * ao;
        col += albedo * uSunCol * sun * max(dot(n, uSunDir), 0.1);

        // Lamps: two forward floods and a weak all-round glow from the body.
        vec3 L = uLampPos - vWorld;
        float d = length(L);
        L /= max(d, 1e-3);
        float ndl = max(dot(n, L), 0.0);
        float cone = smoothstep(0.05, 0.8, dot(-L, uLampDir));
        // Inverse square with a floor on the distance, so a wall at arm's length does not burn out.
        float fall = 1.0 / (11.0 + d * d);
        vec3 lampCol = vec3(1.0, 0.93, 0.84) * (cone * 135.0 + 24.0) * fall * uLamp;
        col += albedo * lampCol * ndl * (0.3 + 0.7 * ao);
        // Glazed basalt and damp rock return a soft highlight.
        float spec = pow(max(dot(n, normalize(L + V)), 0.0), 42.0) * (0.2 + 0.8 * t2.g);
        col += lampCol * spec * 0.022 * ao;
        // A little of the lamp light bounced around the chamber.
        col += albedo * vec3(0.9, 0.85, 0.8) * 2.0 * uLamp * ao / (6.0 + 0.03 * d * d);

        // The section view from outside: what has been mapped is shown in a soft, even light.
        if (uMapLight > 0.001) {
          float s = stationAt(vWorld.xz);
          float mapped = smoothstep(uMapped.x - 0.012, uMapped.x + 0.004, s) * (1.0 - smoothstep(uMapped.y - 0.004, uMapped.y + 0.012, s));
          float shade = 0.3 + 0.7 * max(dot(n, normalize(V + vec3(0.0, 0.5, 0.0))), 0.0);
          col += albedo * vec3(1.0, 0.94, 0.88) * 3.0 * shade * (0.25 + 0.75 * ao) * mapped * uMapLight;
        }

        if (uShell > 0.5) {
          // Seen through the ground: a dim solid with light edges.
          float rim = pow(1.0 - abs(dot(n, V)), 2.0);
          col = albedo * 0.5 * (0.35 + 0.65 * ao) + vec3(0.5, 0.36, 0.27) * rim * 0.22 + col * 0.6;
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = a.tube;
  mesh.material = mat;
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  const upgrade = (hi: THREE.Mesh) => {
    const old = mesh.geometry;
    mesh.geometry = hi.geometry;
    mesh.position.copy(hi.position);
    mesh.quaternion.copy(hi.quaternion);
    mesh.scale.copy(hi.scale);
    mesh.updateMatrix();
    old.dispose();
  };
  return { mesh, upgrade, uniforms };
}

// ------------------------------------------------------------------ lidar map

// The interior map as the lidar delivers it: points, each with the moment it
// was first seen and its intensity. Points are sorted by that moment; drawing
// the first k shows the map as it stood at a time.
//
// Two views of the same points: `fine` lies on the rock mesh as small points
// that light up when first seen and then settle to a faint trace, and `data`
// is the tint used in the registration and overburden views (every third
// point).

export type Cloud = {
  fine: THREE.Points;
  data: THREE.Points;
  count: number;
  duration: number;
  /** Show the points first seen by scan time t (seconds of flight). */
  setTime(t: number): void;
  /** Positions of up to n of the most recent returns, into out; gives how many. */
  recent(n: number, out: Float32Array, rnd: () => number): number;
  shown: number;
  uniforms: {
    uT: { value: number };
    uPx: { value: number };
    uFade: { value: number };
    uFlash: { value: number };
    uSettled: { value: number };
    uTint: { value: THREE.Color };
    uOpacity: { value: number };
    uOffset: { value: THREE.Matrix4 };
  };
};

const BYTES = 11; // 3 x uint16 position, uint16 first-seen time, 2 x int8 normal (octahedral), uint8 intensity

export function createCloud(m: CloudMeta, buf: ArrayBuffer, section: Section): Cloud {
  const n = m.count;
  const dv = new DataView(buf);
  const pos = new Float32Array(n * 3);
  const time = new Float32Array(n);
  const inten = new Uint8Array(n);
  const [x0, y0, z0] = m.bbox.min;
  const sx = (m.bbox.max[0] - x0) / 65535;
  const sy = (m.bbox.max[1] - y0) / 65535;
  const sz = (m.bbox.max[2] - z0) / 65535;
  for (let i = 0; i < n; i++) {
    const o = i * BYTES;
    pos[i * 3] = x0 + dv.getUint16(o, true) * sx;
    pos[i * 3 + 1] = y0 + dv.getUint16(o + 2, true) * sy;
    pos[i * 3 + 2] = z0 + dv.getUint16(o + 4, true) * sz;
    time[i] = dv.getUint16(o + 6, true) * m.timeScale;
    inten[i] = dv.getUint8(o + 10);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aTime', new THREE.BufferAttribute(time, 1));
  geo.setAttribute('aInt', new THREE.BufferAttribute(inten, 1, true));
  const uniforms = {
    ...section.uniforms,
    uT: { value: 0 },
    uPx: { value: 1 },
    /** How fast a new return fades to its settled level, per second of flight. */
    uFade: { value: 0.05 },
    /** Brightness of a return the moment it is first seen, and once settled. */
    uFlash: { value: 0.8 },
    uSettled: { value: 0.1 },
    uTint: { value: new THREE.Color(0.35, 0.88, 1.0) },
    uOpacity: { value: 1 },
    /** Rigid transform applied to the whole map, for the registration sequence. */
    uOffset: { value: new THREE.Matrix4() },
  };
  const fineMat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      ${SECTION_GLSL}
      attribute float aTime;
      attribute float aInt;
      uniform float uT;
      uniform float uPx;
      uniform float uFade;
      uniform float uFlash;
      uniform float uSettled;
      varying vec3 vCol;
      void main() {
        vec4 mv = viewMatrix * vec4(position, 1.0);
        // Lift the point five centimetres toward the eye, so it sits on the rock mesh and not in it.
        mv.xyz *= 1.0 - 0.05 / max(length(mv.xyz), 0.2);
        gl_Position = projectionMatrix * mv;
        if (uCutAmt > 0.5 && beyondCut(position.xz) > 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        float fresh = exp(-max(uT - aTime, 0.0) * uFade);
        // A return is three centimetres across; it never draws larger than two and a half pixels, and when
        // it would be smaller than one it is drawn at one and dimmed by the area it really covers.
        float px = 0.03 * projectionMatrix[1][1] * uPx / max(-mv.z, 0.1);
        gl_PointSize = clamp(px, 1.0, 2.5);
        float cover = clamp(px * px, 0.06, 1.0);
        float level = (uSettled * (0.4 + 0.6 * aInt) + uFlash * fresh) * cover;
        vCol = mix(vec3(0.5, 0.74, 0.86), vec3(0.72, 0.95, 1.0), fresh) * level;
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vCol;
      void main() {
        vec2 q = gl_PointCoord - 0.5;
        float r2 = dot(q, q) * 4.0;
        if (r2 > 1.0) discard;
        gl_FragColor = vec4(vCol * (1.0 - 0.5 * r2), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const dataMat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aInt;
      uniform float uPx;
      uniform mat4 uOffset;
      varying float vKeep;
      varying float vInt;
      void main() {
        vec4 w = uOffset * vec4(position, 1.0);
        vec4 mv = viewMatrix * w;
        gl_Position = projectionMatrix * mv;
        // Every third point is enough for a tint seen from far off.
        vKeep = step(mod(float(gl_VertexID), 3.0), 0.5);
        vInt = aInt;
        gl_PointSize = clamp(0.34 * projectionMatrix[1][1] * uPx / max(-mv.z, 0.1), 1.0, 8.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uTint;
      uniform float uOpacity;
      varying float vKeep;
      varying float vInt;
      void main() {
        if (vKeep < 0.5) discard;
        vec2 q = gl_PointCoord - 0.5;
        float r = dot(q, q) * 4.0;
        if (r > 1.0) discard;
        gl_FragColor = vec4(uTint * (0.45 + 0.75 * vInt) * (1.0 - r) * uOpacity, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const fine = new THREE.Points(geo, fineMat);
  fine.frustumCulled = false;
  fine.renderOrder = 8;
  const data = new THREE.Points(geo, dataMat);
  data.frustumCulled = false;
  data.renderOrder = 30;
  const setTime = (t: number) => {
    // Points are sorted by first-seen time: find how many are visible.
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (time[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    geo.setDrawRange(0, lo);
    uniforms.uT.value = t;
    cloud.shown = lo;
  };
  const recent = (k: number, out: Float32Array, rnd: () => number) => {
    const hi = cloud.shown;
    const span = Math.min(2400, hi);
    if (span < 8) return 0;
    for (let i = 0; i < k; i++) {
      const j = hi - 1 - Math.floor(rnd() * span);
      out[i * 3] = pos[j * 3];
      out[i * 3 + 1] = pos[j * 3 + 1];
      out[i * 3 + 2] = pos[j * 3 + 2];
    }
    return k;
  };
  const cloud: Cloud = { fine, data, count: n, duration: m.duration, setTime, recent, shown: 0, uniforms };
  setTime(0);
  return cloud;
}
