// The rotorcraft and the lander.
//
// The rotorcraft's pose is read from the simulated flight (tools/build_data.py):
// a speed profile with limited acceleration, a second-order vehicle response,
// and an attitude whose thrust axis lies along acceleration plus Mars gravity.
// Rotors, lidar head and the rotor tremor run in real time, whatever the
// playback rate.

import * as THREE from 'three';
import type { Assets } from './assets';
import type { Flight, Pose } from './mission';
import { clamp, radialTexture } from './util';

const ROTOR_HZ = 43; // about 2,600 rpm, the range Mars rotors need in thin air
const LIDAR_HZ = 10;
const UP = new THREE.Vector3(0, 1, 0);

export type Rotorcraft = {
  group: THREE.Group;
  pos: THREE.Vector3;
  /** Unit vector the nose points along. */
  forward: THREE.Vector3;
  /** Where the lidar sits, scene frame. */
  sensor: THREE.Vector3;
  /** Rotor speed as a fraction of flight speed: 0 parked with rotors still, 1 flying. */
  power: number;
  speed: number;
  agl: number;
  update(tf: number, dt: number, rotor: number, ground: (x: number, z: number) => number): void;
  setLampGlow(v: number): void;
};

function findNode(root: THREE.Object3D, name: string): THREE.Object3D | null {
  let hit: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!hit && o.name === name) hit = o;
  });
  return hit;
}

function placeholderCraft(): THREE.Group {
  const g = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.45, metalness: 0.5 });
  const foil = new THREE.MeshStandardMaterial({ color: 0xb08a3a, roughness: 0.35, metalness: 0.9 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.26, 0.32), foil);
  body.name = 'body';
  g.add(body);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.5, 8), dark);
  mast.position.y = 0.36;
  g.add(mast);
  for (const [name, y] of [
    ['rotor_upper', 0.56],
    ['rotor_lower', 0.44],
  ] as const) {
    const r = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.006, 0.05), dark);
    r.name = name;
    r.position.y = y;
    g.add(r);
    const d = new THREE.Mesh(new THREE.CircleGeometry(0.6, 48), new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false }));
    d.name = name.replace('rotor_', 'rotor_disc_');
    d.rotation.x = -Math.PI / 2;
    d.position.y = y;
    g.add(d);
  }
  for (let k = 0; k < 4; k++) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.42, 6), dark);
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    leg.position.set(Math.cos(a) * 0.22, -0.26, Math.sin(a) * 0.22);
    leg.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
    g.add(leg);
  }
  const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.043, 0.07, 20), dark);
  lid.name = 'lidar_head';
  lid.position.set(0, -0.19, 0.08);
  g.add(lid);
  return g;
}

export function createRotorcraft(a: Assets, flight: Flight): Rotorcraft {
  const model = a.models.rotorcraft ?? placeholderCraft();
  const group = new THREE.Group();
  // The airframe tilts and trembles inside the group, which carries position and heading.
  const frame = new THREE.Group();
  frame.add(model);
  group.add(frame);
  const upper = findNode(model, 'rotor_upper');
  const lower = findNode(model, 'rotor_lower');
  const discU = findNode(model, 'rotor_disc_upper') as THREE.Mesh | null;
  const discL = findNode(model, 'rotor_disc_lower') as THREE.Mesh | null;
  const lidar = findNode(model, 'lidar_head');
  const discMats: THREE.Material[] = [];
  for (const d of [discU, discL]) {
    if (!d) continue;
    d.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = new THREE.MeshBasicMaterial({ color: 0x0c0c0d, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
      m.material = mat;
      m.renderOrder = 40;
      discMats.push(mat);
    });
  }
  const bladeMats: THREE.Material[] = [];
  for (const r of [upper, lower]) {
    r?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = (m.material as THREE.Material).clone();
      mat.transparent = true;
      m.material = mat;
      bladeMats.push(mat);
    });
  }
  // Lamp lenses glow; a sprite adds the bloom the eye sees around a bright LED.
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture(64, 2.4), color: 0xfff0dc, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  glow.scale.setScalar(0.9);
  const lampL = findNode(model, 'lamp_l');
  glow.position.copy(lampL ? lampL.position : new THREE.Vector3(0, -0.12, 0.2));
  glow.position.x = 0;
  frame.add(glow);
  const bodyLight = new THREE.PointLight(0xffe8d0, 0, 6, 2);
  bodyLight.position.set(0, 0.5, -0.6);
  frame.add(bodyLight);

  const pose: Pose = { p: [0, 0, 0], q: [0, 0, 0, 1] };
  const before: Pose = { p: [0, 0, 0], q: [0, 0, 0, 1] };
  const pos = new THREE.Vector3();
  const forward = new THREE.Vector3(0, 0, 1);
  const sensor = new THREE.Vector3();
  let clock = 0;
  let angle = 0;
  const lidarLocal = lidar ? lidar.position.clone() : new THREE.Vector3(0, -0.19, 0.08);
  const tremor = new THREE.Quaternion();
  const e = new THREE.Euler();

  const craft: Rotorcraft = {
    group,
    pos,
    forward,
    sensor,
    power: 0,
    speed: 0,
    agl: 0,
    update(tf, dt, rotor, ground) {
      clock += dt;
      // Position and attitude come from the simulated flight: the airframe leans
      // into its acceleration because its thrust axis follows acceleration plus gravity.
      flight.pose(tf, pose);
      flight.pose(tf - 0.4, before);
      pos.set(pose.p[0], pose.p[1], pose.p[2]);
      craft.speed = Math.hypot(pose.p[0] - before.p[0], pose.p[1] - before.p[1], pose.p[2] - before.p[2]) / 0.4;
      craft.agl = pos.y - ground(pos.x, pos.z);
      craft.power = rotor;
      // Rotor tremor in real time: a few millimetres and a tenth of a degree at full speed.
      const k = rotor * rotor;
      const tr = (f: number, ph: number) => Math.sin(clock * f + ph) * 0.6 + Math.sin(clock * f * 2.3 + ph * 1.7) * 0.4;
      group.position.set(pos.x + tr(1.9, 0.3) * 0.006 * k, pos.y + tr(2.4, 1.1) * 0.005 * k, pos.z + tr(1.6, 2.2) * 0.006 * k);
      group.quaternion.set(pose.q[0], pose.q[1], pose.q[2], pose.q[3]);
      frame.quaternion.copy(tremor.setFromEuler(e.set(tr(2.1, 0.7) * 0.003 * k, 0, tr(2.6, 1.9) * 0.003 * k)));
      forward.set(0, 0, 1).applyQuaternion(group.quaternion);
      // Rotors turn at the speed given, so the spin-up shows: blades clear when slow, a faint disc at speed.
      angle += dt * ROTOR_HZ * Math.PI * 2 * rotor;
      if (upper) upper.rotation.y = angle;
      if (lower) lower.rotation.y = -angle * 1.03;
      const blur = clamp((rotor - 0.22) / 0.5, 0, 1);
      for (const m of discMats) m.opacity = 0.11 * blur;
      for (const m of bladeMats) m.opacity = 1 - 0.86 * blur;
      if (lidar) lidar.rotation.y = clock * LIDAR_HZ * Math.PI * 2 * (rotor > 0.05 ? 1 : 0);
      sensor.copy(lidarLocal).applyQuaternion(group.quaternion).add(group.position);
    },
    setLampGlow(v) {
      (glow.material as THREE.SpriteMaterial).opacity = 0.85 * v;
      bodyLight.intensity = 1.6 * v;
    },
  };
  return craft;
}

export type Lander = { group: THREE.Group; deckY: number };

export function createLander(a: Assets): Lander {
  const group = new THREE.Group();
  // The height in meta.json is the ground of the survey tile under the lander, and the flight starts from it.
  const [x, y, z] = a.meta.lander;
  if (a.models.lander) {
    group.add(a.models.lander);
    // Aim the dish at a point in the sky; its boresight is the node's +y.
    const dish = findNode(a.models.lander, 'dish');
    if (dish) dish.quaternion.setFromUnitVectors(UP, new THREE.Vector3(0.45, 0.8, -0.4).normalize());
  } else {
    const m = new THREE.MeshStandardMaterial({ color: 0x8d7a55, roughness: 0.5, metalness: 0.6 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.1, 0.6, 8), m);
    body.position.y = 0.6;
    group.add(body);
  }
  group.position.set(x, y, z);
  return { group, deckY: y + 0.9 };
}

/** Thin additive lines from the lidar to the returns it has just made. */
export function createBeams(count: number): { lines: THREE.LineSegments; set(sensor: THREE.Vector3, hits: Float32Array, n: number, strength: number): void } {
  const pos = new Float32Array(count * 6);
  const alpha = new Float32Array(count * 2);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uStrength: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float aAlpha;
      varying float vA;
      void main() { vA = aAlpha; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uStrength;
      varying float vA;
      void main() { gl_FragColor = vec4(vec3(0.3, 0.85, 1.0) * vA * uStrength, 1.0); }`,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  lines.renderOrder = 35;
  return {
    lines,
    set(sensor, hits, n, strength) {
      const m = Math.min(n, count);
      for (let i = 0; i < m; i++) {
        pos[i * 6] = sensor.x;
        pos[i * 6 + 1] = sensor.y;
        pos[i * 6 + 2] = sensor.z;
        pos[i * 6 + 3] = hits[i * 3];
        pos[i * 6 + 4] = hits[i * 3 + 1];
        pos[i * 6 + 5] = hits[i * 3 + 2];
        alpha[i * 2] = 0.5;
        alpha[i * 2 + 1] = 0.06;
      }
      geo.setDrawRange(0, m * 2);
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aAlpha.needsUpdate = true;
      mat.uniforms.uStrength.value = strength;
    },
  };
}
