// Loose rocks on the ground near where the camera comes close: around the
// lander and the first skylight. They give the eye a scale that a height
// grid at half a metre cannot. Generated, not surveyed.

import * as THREE from 'three';
import type { Meta } from './assets';
import { lcg } from './util';

function rockGeometry(seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const rnd = lcg(seed);
  const lobes = Array.from({ length: 5 }, () => new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize());
  const amp = lobes.map(() => 0.12 + rnd() * 0.22);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    let r = 1;
    lobes.forEach((l, k) => (r += amp[k] * Math.max(0, v.dot(l)) ** 2 - amp[k] * 0.3 * Math.max(0, -v.dot(l))));
    // Flattened and faceted, like blocks broken from a flow top.
    v.multiplyScalar(r);
    v.y *= 0.5;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

export function createRocks(meta: Meta, ground: (x: number, z: number) => number, cutAway: (x: number, z: number) => boolean): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x70482f, roughness: 0.95, metalness: 0, envMapIntensity: 0.5 });
  const rnd = lcg(4242);
  const centres: [number, number, number, number][] = [
    [meta.lander[0], meta.lander[2], 30, 380],
    [meta.skylights[0].pos[0], meta.skylights[0].pos[2], 26, 300],
    [meta.skylights[2].pos[0], meta.skylights[2].pos[2], 22, 160],
  ];
  const total = centres.reduce((n, c) => n + c[3], 0);
  const geos = [rockGeometry(1), rockGeometry(2), rockGeometry(3)];
  const meshes = geos.map((g) => new THREE.InstancedMesh(g, mat, Math.ceil(total / geos.length) + 4));
  const counts = [0, 0, 0];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const col = new THREE.Color();
  for (const [cx, cz, radius, n] of centres) {
    for (let i = 0; i < n; i++) {
      const r = radius * Math.sqrt(rnd());
      const a = rnd() * Math.PI * 2;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      // Keep the openings and the lander deck clear.
      if (meta.skylights.some((k) => Math.hypot(x - k.pos[0], z - k.pos[2]) < k.semiMajor * 1.7 + 1.2)) continue;
      if (Math.hypot(x - meta.lander[0], z - meta.lander[2]) < 2.6) continue;
      // And none on the side of the tube that the section view removes.
      if (cutAway(x, z)) continue;
      // Many pebbles, few blocks.
      const size = 0.04 + 0.3 * Math.pow(rnd(), 3.4);
      const k = Math.floor(rnd() * geos.length);
      p.set(x, ground(x, z) + size * 0.18, z);
      e.set((rnd() - 0.5) * 0.5, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.5);
      q.setFromEuler(e);
      s.set(size * (0.8 + rnd() * 0.6), size * (0.7 + rnd() * 0.5), size * (0.8 + rnd() * 0.6));
      m.compose(p, q, s);
      meshes[k].setMatrixAt(counts[k], m);
      const shade = 0.55 + rnd() * 0.75;
      meshes[k].setColorAt(counts[k], col.setRGB(shade, shade * (0.9 + rnd() * 0.15), shade * (0.85 + rnd() * 0.2)));
      counts[k]++;
    }
  }
  meshes.forEach((mesh, k) => {
    mesh.count = counts[k];
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    group.add(mesh);
  });
  return group;
}
