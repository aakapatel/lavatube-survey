// Loading of the hero assets written by tools/build_data.py and tools/models.py.
//
// meta.json describes the survey in the scene frame (metres, y up). The
// height grids arrive as raw little-endian uint16 and are kept twice: as
// Float32 arrays for queries on the CPU and as half-float textures for the
// shaders.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export type Grid = {
  nx: number;
  nz: number;
  res: number;
  x0: number;
  z0: number;
  /** Heights in metres, row j along z, column i along x. */
  h: Float32Array;
  tex: THREE.DataTexture;
};

export type CloudMeta = { file: string; count: number; bbox: { min: number[]; max: number[] }; timeScale: number; duration: number; voxel: number; range: number };

export type Skylight = { id: string; pos: [number, number, number]; semiMajor: number; semiMinor: number; angle: number; matched: boolean };

export type Meta = {
  note: string;
  terrain: {
    near: { nx: number; nz: number; res: number; x0: number; z0: number; hmin: number; hmax: number };
    far: { n: number; res: number; x0: number; z0: number; hmin: number; hmax: number };
    sun: [number, number, number];
    tile: { size_m: number };
  };
  cloud: Record<'dense' | 'lite', CloudMeta>;
  /** Where the section is cut, as a fraction of the half width on the +side of the tube. */
  cutN: number;
  stations: {
    s: number[];
    pos: [number, number, number][];
    tan: [number, number, number][];
    /** Unit vector across the tube, toward the side the section cuts away. */
    side: [number, number, number][];
    halfWidth: number[];
    /** Ceiling and floor of the void where the section cut meets it. */
    cutCeil: number[];
    cutFloor: number[];
    width: number[];
    height: number[];
    floor: number[];
    ceil: number[];
    dem: number[];
    tau: number[];
    span: number[];
    cls: string[];
  };
  skylights: Skylight[];
  lander: [number, number, number];
  flight: { hz: number; pos: [number, number, number][]; quat: [number, number, number, number][]; legs: { name: string; t0: number; t1: number }[]; duration: number; stationS1: number; stationS3: number; stationTurn: number };
  registration: { centroidVerticalOffset: number[]; rimRms: number; sigma: number };
  paper: {
    tau: { min: number; max: number; median: number; q25: number; q75: number; sigma: number };
    nIntact: number;
    nSkylight: number;
    nStations: number;
    ciBlock30: [number, number];
    shielding: Record<string, { median_g_cm2: number; frac_gt_100: number; frac_gt_500: number; frac_gt_1000: number }>;
    strength: { median: number; p95: number; max: number; n: number };
    beta: number;
    rho: number;
    length: number;
  };
};

export type Assets = {
  meta: Meta;
  near: Grid;
  far: Grid;
  nearDetail: THREE.Texture;
  nearOpen: THREE.Texture;
  farLight: THREE.Texture;
  groundTile: THREE.Texture;
  marsGlobal: THREE.Texture;
  marsStrips: THREE.Texture[];
  /** The light tube mesh, in the first download. */
  tube: THREE.Mesh;
  /** The full tube mesh (about two million triangles), fetched after the first frame. */
  loadTubeHi(): Promise<THREE.Mesh>;
  /** The interior map, fetched after the first frame: the dense file, or the light one on small devices. */
  loadCloud(lite: boolean): Promise<{ meta: CloudMeta; data: ArrayBuffer }>;
  models: { orbiter: THREE.Group | null; rotorcraft: THREE.Group | null; lander: THREE.Group | null };
};

function gridFromU16(buf: ArrayBuffer, nx: number, nz: number, res: number, x0: number, z0: number, hmin: number, hmax: number): Grid {
  const u = new Uint16Array(buf);
  const h = new Float32Array(nx * nz);
  const half = new Uint16Array(nx * nz);
  const k = (hmax - hmin) / 65535;
  for (let i = 0; i < h.length; i++) {
    h[i] = hmin + u[i] * k;
    half[i] = THREE.DataUtils.toHalfFloat(h[i]);
  }
  const tex = new THREE.DataTexture(half, nx, nz, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { nx, nz, res, x0, z0, h, tex };
}

/** Bilinear height of a grid at scene (x, z); clamps at the edges. */
export function sampleGrid(g: Grid, x: number, z: number): number {
  const fx = Math.min(Math.max((x - g.x0) / g.res, 0), g.nx - 1.001);
  const fz = Math.min(Math.max((z - g.z0) / g.res, 0), g.nz - 1.001);
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const u = fx - i;
  const v = fz - j;
  const a = j * g.nx + i;
  return (g.h[a] * (1 - u) + g.h[a + 1] * u) * (1 - v) + (g.h[a + g.nx] * (1 - u) + g.h[a + g.nx + 1] * u) * v;
}

export function insideGrid(g: Grid, x: number, z: number, margin = 0): boolean {
  return x >= g.x0 + margin && z >= g.z0 + margin && x <= g.x0 + (g.nx - 1) * g.res - margin && z <= g.z0 + (g.nz - 1) * g.res - margin;
}

export async function loadAssets(base: string, renderer: THREE.WebGLRenderer, onProgress: (f: number) => void): Promise<Assets> {
  const total = 14;
  let done = 0;
  const tick = <T>(p: Promise<T>): Promise<T> =>
    p.then((v) => {
      onProgress(++done / total);
      return v;
    });
  const bin = (name: string) =>
    tick(
      fetch(`${base}/${name}`).then((r) => {
        if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
    );
  const texLoader = new THREE.TextureLoader();
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const tex = (name: string, srgb: boolean, repeat = false) =>
    tick(
      texLoader.loadAsync(`${base}/${name}`).then((t) => {
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.anisotropy = aniso;
        if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
        return t;
      }),
    );
  const gltf = new GLTFLoader();
  gltf.setMeshoptDecoder(MeshoptDecoder);
  const model = (name: string) =>
    tick(
      gltf
        .loadAsync(`${base}/${name}`)
        .then((g) => g.scene)
        .catch(() => null),
    );

  const meta = (await tick(fetch(`${base}/meta.json`).then((r) => r.json()))) as Meta;
  // Stations with no value (inside an opening) arrive as null.
  const st = meta.stations as unknown as Record<string, unknown[]>;
  for (const k of ['width', 'height', 'floor', 'ceil', 'dem', 'tau', 'span', 'cutCeil', 'cutFloor']) st[k] = st[k].map((v) => (v === null ? NaN : v));
  const tn = meta.terrain.near;
  const tf = meta.terrain.far;
  const [nearBuf, farBuf, nearDetail, nearOpen, farLight, groundTile, marsGlobal, strip0, strip1, strip2, tubeScene, orbiter, rotorcraft, lander] = await Promise.all([
    bin('terrain_near.u16'),
    bin('terrain_far.u16'),
    tex('terrain_near_detail.jpg', false),
    tex('terrain_near_open.png', false),
    tex('terrain_far_light.png', false),
    tex('ground_tile.jpg', false, true),
    tex('mars_global.jpg', true),
    tex('mars_strip_0.jpg', true),
    tex('mars_strip_1.jpg', true),
    tex('mars_strip_2.jpg', true),
    tick(gltf.loadAsync(`${base}/tube.glb`).then((g) => g.scene)),
    model('orbiter.glb'),
    model('rotorcraft.glb'),
    model('lander.glb'),
  ]);
  // The loaders flip image rows; the grids are stored top row first, so undo it.
  for (const t of [nearDetail, nearOpen, farLight]) {
    t.flipY = false;
    t.needsUpdate = true;
  }
  nearOpen.magFilter = THREE.LinearFilter;
  // gltfpack stores quantised positions under a node transform. Keep that
  // transform as the mesh matrix; the vertex data stays quantised.
  const firstMesh = (root: THREE.Object3D, name: string): THREE.Mesh => {
    let found: THREE.Mesh | null = null;
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && !found) found = m;
    });
    if (!found) throw new Error(`${name} holds no mesh`);
    const mesh = found as THREE.Mesh;
    mesh.matrixWorld.decompose(mesh.position, mesh.quaternion, mesh.scale);
    mesh.removeFromParent();
    mesh.updateMatrix();
    return mesh;
  };
  const tubeMesh = firstMesh(tubeScene, 'tube.glb');
  return {
    meta,
    near: gridFromU16(nearBuf, tn.nx, tn.nz, tn.res, tn.x0, tn.z0, tn.hmin, tn.hmax),
    far: gridFromU16(farBuf, tf.n, tf.n, tf.res, tf.x0, tf.z0, tf.hmin, tf.hmax),
    nearDetail,
    nearOpen,
    farLight,
    groundTile,
    marsGlobal,
    marsStrips: [strip0, strip1, strip2],
    tube: tubeMesh,
    loadTubeHi: async () => firstMesh((await gltf.loadAsync(`${base}/tube_hi.glb`)).scene, 'tube_hi.glb'),
    loadCloud: async (lite) => {
      const m = meta.cloud[lite ? 'lite' : 'dense'];
      const r = await fetch(`${base}/${m.file}`);
      if (!r.ok) throw new Error(`${m.file}: HTTP ${r.status}`);
      return { meta: m, data: await r.arrayBuffer() };
    },
    models: { orbiter, rotorcraft, lander },
  };
}
