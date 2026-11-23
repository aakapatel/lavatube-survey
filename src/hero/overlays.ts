// Data drawn over the scene: the surface elevation model as points, the
// skylight detections, the registration of the interior map to the surface,
// and the overburden curtain along the tube.

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Assets, Grid, Meta } from './assets';
import { magma, type Profile } from './analysis';
import { clamp, lerp, smooth } from './util';

// ---------------------------------------------------------------- surface model points

export type SurfacePoints = {
  points: THREE.Points;
  /** Rebuild from a height grid sampled at a posting (metres). */
  build(heights: Float32Array, posting: number): void;
  uniforms: { uSweep: { value: number }; uOpacity: { value: number }; uPx: { value: number }; uSize: { value: number } };
};

export function createSurfacePoints(g: Grid): SurfacePoints {
  const geo = new THREE.BufferGeometry();
  const uniforms = { uSweep: { value: 1e9 }, uOpacity: { value: 0 }, uPx: { value: 1 }, uSize: { value: 0.5 }, uRange: { value: new THREE.Vector2(-6, 14) } };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      uniform float uSweep;
      uniform float uPx;
      uniform float uSize;
      uniform vec2 uRange;
      varying float vShow;
      varying float vH;
      varying float vNew;
      void main() {
        // The pass runs north (toward -z): a point exists once the scan line has crossed it.
        float s = -position.z;
        vShow = step(s, uSweep);
        vNew = exp(-max(uSweep - s, 0.0) * 0.12);
        vH = clamp((position.y - uRange.x) / (uRange.y - uRange.x), 0.0, 1.0);
        vec4 mv = viewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(uSize * (1.0 + vNew) * projectionMatrix[1][1] * uPx / max(-mv.z, 0.1), 1.0, 22.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uOpacity;
      varying float vShow;
      varying float vH;
      varying float vNew;
      void main() {
        if (vShow < 0.5) discard;
        vec2 q = gl_PointCoord - 0.5;
        float r = dot(q, q) * 4.0;
        if (r > 1.0) discard;
        vec3 c = mix(vec3(0.5, 0.2, 0.06), vec3(1.0, 0.72, 0.36), vH);
        c = mix(c, vec3(1.0, 0.95, 0.85), vNew);
        gl_FragColor = vec4(c * (1.0 - r) * uOpacity * (0.5 + vNew), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 28;
  const build = (heights: Float32Array, posting: number) => {
    const step = Math.max(1, Math.round(Math.max(posting, 1) / g.res));
    const nx = Math.floor((g.nx - 1) / step) + 1;
    const nz = Math.floor((g.nz - 1) / step) + 1;
    const pos = new Float32Array(nx * nz * 3);
    let o = 0;
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const gi = Math.min(i * step, g.nx - 1);
        const gj = Math.min(j * step, g.nz - 1);
        pos[o++] = g.x0 + gi * g.res;
        pos[o++] = heights[gj * g.nx + gi] + 0.12;
        pos[o++] = g.z0 + gj * g.res;
      }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setDrawRange(0, nx * nz);
    uniforms.uSize.value = Math.max(0.42, posting * 0.42);
  };
  return { points, build, uniforms };
}

// ---------------------------------------------------------------- skylight detections

/** An ellipse drawn as a line of constant width on screen (pixels), so it reads from any distance. */
function ellipseLine(semiMajor: number, semiMinor: number, color: number, width = 2.6): Line2 {
  const n = 96;
  const pos: number[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    pos.push(Math.cos(a) * semiMajor, 0, Math.sin(a) * semiMinor);
  }
  const g = new LineGeometry();
  g.setPositions(pos);
  const m = new LineMaterial({ color, linewidth: width, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
  const l = new Line2(g, m);
  l.renderOrder = 50;
  l.frustumCulled = false;
  return l;
}

export type Detections = {
  group: THREE.Group;
  /** p: 0 nothing, 1 all four candidates outlined, 2 the fourth rejected. */
  set(p: number, opacity: number): void;
  anchors: { id: string; pos: THREE.Vector3; matched: boolean }[];
};

export function createDetections(meta: Meta, color = 0xffd9a0): Detections {
  const group = new THREE.Group();
  const rings: { ring: Line2; halo: Line2; matched: boolean; order: number }[] = [];
  const anchors: Detections['anchors'] = [];
  meta.skylights.forEach((s, i) => {
    // Drawn 1.6 times the fitted ellipse, the margin the paper uses to class a station as aperture.
    const ring = ellipseLine(s.semiMajor * 1.6, Math.max(s.semiMinor, 0.8) * 1.6, s.matched ? color : 0xff6a5a);
    const halo = ellipseLine(s.semiMajor * 1.6 + 2.2, Math.max(s.semiMinor, 0.8) * 1.6 + 2.2, s.matched ? color : 0xff6a5a, 1.3);
    for (const l of [ring, halo]) {
      l.position.set(s.pos[0], s.pos[1] + 0.6, s.pos[2]);
      l.rotation.y = s.angle;
      group.add(l);
    }
    rings.push({ ring, halo, matched: s.matched, order: i });
    anchors.push({ id: s.id, pos: new THREE.Vector3(s.pos[0], s.pos[1] + 0.6, s.pos[2]), matched: s.matched });
  });
  const set = (p: number, opacity: number) => {
    for (const r of rings) {
      // Candidates appear one after another; then the unmatched one fades.
      const appear = smooth(clamp(p * 4 - r.order * 0.75, 0, 1));
      const keep = r.matched ? 1 : 1 - 0.8 * smooth(clamp(p - 1, 0, 1));
      r.ring.material.opacity = appear * keep * opacity;
      r.halo.material.opacity = appear * keep * opacity * 0.55;
      const s = lerp(2.4, 1, appear);
      r.ring.scale.setScalar(s);
      r.halo.scale.setScalar(s);
    }
  };
  return { group, set, anchors };
}

// ---------------------------------------------------------------- registration

export type Registration = {
  group: THREE.Group;
  /** Transform of the interior map at progress p (0 robot frame, 1 centroid match, 2 final). */
  matrix: THREE.Matrix4;
  set(p: number, opacity: number): void;
  /** Height of the interior map above its final place at each skylight, metres. */
  offsets: [number, number, number];
};

export function createRegistration(meta: Meta): Registration {
  const sk = meta.skylights.filter((s) => s.matched);
  const c = sk.map((s) => new THREE.Vector3(s.pos[0], s.pos[1], s.pos[2]));
  const dz = meta.registration.centroidVerticalOffset; // how far the closed-form solution sits above the final one
  // The centroid solution as a rigid motion of the final one: a lift plus a small
  // tilt about the horizontal axis across the skylight line, fitted to the three offsets.
  const axisLine = c[2].clone().sub(c[0]).setY(0).normalize();
  const mid = c[0].clone().add(c[2]).multiplyScalar(0.5);
  const t = c.map((p) => p.clone().sub(mid).dot(axisLine));
  const n = 3;
  const mt = (t[0] + t[1] + t[2]) / n;
  const md = (dz[0] + dz[1] + dz[2]) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (t[i] - mt) * (dz[i] - md);
    den += (t[i] - mt) * (t[i] - mt);
  }
  const slope = num / den; // metres of height per metre along the skylight line
  const tiltAxis = new THREE.Vector3(axisLine.z, 0, -axisLine.x); // horizontal, across the line
  const qB = new THREE.Quaternion().setFromAxisAngle(tiltAxis, -Math.atan(slope));
  const pivot = mid.clone().addScaledVector(axisLine, mt);
  const posB = new THREE.Vector3(0, md, 0);
  // The robot frame: the map as the robot built it, with its own origin and heading.
  const qA = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(-34)).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(4)));
  const posA = new THREE.Vector3(-22, 40, 6);

  const group = new THREE.Group();
  const matrix = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const toPivot = new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);
  const fromPivot = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z);
  const rot = new THREE.Matrix4();

  // Interior detections ride on the interior map; links join each to its surface twin.
  const inner = sk.map((s) => {
    const l = ellipseLine(s.semiMajor * 1.6, Math.max(s.semiMinor, 0.8) * 1.6, 0x7fe6ff, 2.8);
    l.rotation.y = s.angle;
    group.add(l);
    return l;
  });
  const linkGeo = new THREE.BufferGeometry();
  const linkPos = new Float32Array(sk.length * 6);
  linkGeo.setAttribute('position', new THREE.BufferAttribute(linkPos, 3));
  const links = new THREE.LineSegments(linkGeo, new THREE.LineDashedMaterial({ color: 0xffffff, transparent: true, opacity: 0, dashSize: 1.6, gapSize: 1.2, depthTest: false }));
  links.renderOrder = 51;
  links.frustumCulled = false;
  group.add(links);
  // Six section planes, one along and one across the tube at each skylight.
  const planes: THREE.Mesh[] = [];
  sk.forEach((s, i) => {
    const k = [meta.flight.stationS1, Math.round((meta.flight.stationS1 + meta.flight.stationS3) / 2), meta.flight.stationS3][i];
    const tan = meta.stations.tan[Math.min(k, meta.stations.tan.length - 1)];
    const yaw = Math.atan2(tan[0], tan[2]);
    for (const turn of [0, Math.PI / 2]) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(30, 22),
        new THREE.MeshBasicMaterial({ color: 0xbfe9ff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      m.position.set(s.pos[0], s.pos[1] - 5, s.pos[2]);
      m.rotation.y = yaw + turn + Math.PI / 2;
      m.renderOrder = 45;
      planes.push(m);
      group.add(m);
    }
  });

  const reg: Registration = {
    group,
    matrix,
    offsets: [0, 0, 0],
    set(pr, opacity) {
      const a = smooth(clamp(pr, 0, 1)); // robot frame to centroid match
      const b = smooth(clamp(pr - 1, 0, 1)); // centroid match to final
      // Centroid solution relative to final, fading out with b.
      q.identity().slerp(qB, 1 - b);
      p.copy(posB).multiplyScalar(1 - b);
      rot.compose(p, q, one);
      matrix.copy(fromPivot).multiply(rot).multiply(toPivot);
      // Robot frame on top of that, fading out with a.
      if (a < 1) {
        const qa = new THREE.Quaternion().slerp(qA, 1 - a);
        const pa = posA.clone().multiplyScalar(1 - a);
        const ra = new THREE.Matrix4().compose(pa, qa, one);
        const about = new THREE.Vector3(c[1].x, c[1].y, c[1].z);
        matrix.premultiply(new THREE.Matrix4().makeTranslation(about.x, about.y, about.z).multiply(ra).multiply(new THREE.Matrix4().makeTranslation(-about.x, -about.y, -about.z)));
      }
      sk.forEach((s, i) => {
        const w = new THREE.Vector3(s.pos[0], s.pos[1] + 0.6, s.pos[2]).applyMatrix4(matrix);
        inner[i].position.copy(w);
        inner[i].quaternion.setFromRotationMatrix(matrix).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.angle));
        inner[i].material.opacity = opacity * smooth(clamp(pr * 3, 0, 1));
        linkPos.set([w.x, w.y, w.z, s.pos[0], s.pos[1] + 0.6, s.pos[2]], i * 6);
        reg.offsets[i] = w.y - (s.pos[1] + 0.6);
      });
      linkGeo.attributes.position.needsUpdate = true;
      links.computeLineDistances();
      (links.material as THREE.LineDashedMaterial).opacity = opacity * 0.8 * smooth(clamp(pr * 3 - 0.6, 0, 1)) * (1 - smooth(clamp((pr - 1.75) * 4, 0, 1)));
      // Section planes pulse in turn while the refinement runs.
      planes.forEach((m, i) => {
        const u = (pr - 1.05) * 6.5 - i * 0.55;
        (m.material as THREE.MeshBasicMaterial).opacity = opacity * 0.2 * Math.max(0, Math.sin(clamp(u, 0, 1) * Math.PI)) + opacity * 0.035 * smooth(clamp(pr - 1, 0, 1)) * (1 - smooth(clamp((pr - 1.9) * 6, 0, 1)));
      });
    },
  };
  reg.set(0, 0);
  return reg;
}

// ---------------------------------------------------------------- overburden curtain

export type Curtain = {
  mesh: THREE.Mesh;
  edges: THREE.LineSegments;
  /** Set the profile to show; the top edge of the curtain follows the ground heights. */
  build(p: Profile): void;
  uniforms: { uReveal: { value: number }; uOpacity: { value: number } };
  /** Largest overburden on the colour scale, metres. */
  scaleMax: number;
};

export function createCurtain(a: Assets): Curtain {
  const st = a.meta.stations;
  const n = st.s.length;
  const scaleMax = 16;
  const pos = new Float32Array(n * 2 * 3);
  const col = new Float32Array(n * 2 * 3);
  const along = new Float32Array(n * 2);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
  const uniforms = { uReveal: { value: 0 }, uOpacity: { value: 0 } };
  const shader = (line: boolean) =>
    new THREE.ShaderMaterial({
      uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        attribute float aAlong;
        attribute vec3 color;
        varying vec3 vC;
        varying float vA;
        varying float vY;
        void main() {
          vC = color; vA = aAlong; vY = position.y;
          gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform float uReveal;
        uniform float uOpacity;
        varying vec3 vC;
        varying float vA;
        varying float vY;
        void main() {
          if (vA > uReveal) discard;
          float head = exp(-(uReveal - vA) * 60.0);
          // Fine horizontal lines every metre of rock, like a scale drawn on the section.
          float metre = ${line ? '0.0' : 'smoothstep(0.06, 0.0, abs(fract(vY) - 0.5) - 0.44) * 0.18'};
          vec3 c = vC * ${line ? '1.5' : '(0.85 - metre)'} + vec3(1.0, 0.9, 0.7) * head * 0.8;
          gl_FragColor = vec4(c, uOpacity * ${line ? '1.0' : '0.93'});
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
  const mesh = new THREE.Mesh(geo, shader(false));
  mesh.frustumCulled = false;
  mesh.renderOrder = 42;
  const edgeGeo = new THREE.BufferGeometry();
  const edges = new THREE.LineSegments(edgeGeo, shader(true));
  edges.frustumCulled = false;
  edges.renderOrder = 43;

  const c: [number, number, number] = [0, 0, 0];
  const build = (p: Profile) => {
    const idx: number[] = [];
    const eidx: number[] = [];
    for (let k = 0; k < n; k++) {
      const ok = Number.isFinite(p.tau[k]);
      const [x, , z] = st.pos[k];
      const ceil = st.ceil[k];
      const top = ok ? p.dem[k] : ceil;
      pos.set([x, ceil, z, x, top, z], k * 6);
      magma(1 - clamp((ok ? p.tau[k] : 0) / scaleMax, 0, 1), c);
      col.set([c[0] * 0.75, c[1] * 0.75, c[2] * 0.75, c[0], c[1], c[2]], k * 6);
      along[k * 2] = along[k * 2 + 1] = k / (n - 1);
      if (k > 0 && ok && Number.isFinite(p.tau[k - 1])) {
        const a0 = (k - 1) * 2;
        const b0 = k * 2;
        idx.push(a0, a0 + 1, b0, b0, a0 + 1, b0 + 1);
        eidx.push(a0 + 1, b0 + 1, a0, b0);
      }
    }
    geo.setIndex(idx);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.attributes.aAlong.needsUpdate = true;
    edgeGeo.setAttribute('position', geo.attributes.position);
    edgeGeo.setAttribute('color', geo.attributes.color);
    edgeGeo.setAttribute('aAlong', geo.attributes.aAlong);
    edgeGeo.setIndex(eidx);
  };
  return { mesh, edges, build, uniforms, scaleMax };
}
