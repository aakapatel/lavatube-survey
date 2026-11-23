// The hero engine: renderer, the two worlds (orbit and surface), the mission
// clock and the camera director.
//
//   assets.ts    loading
//   mission.ts   chapters, loop time to flight time, the flight path
//   orbit.ts     Mars from orbit, the orbiter, the image strips
//   terrain.ts   ground of the concept site (survey tile and far field)
//   tube.ts      sky, tube rock, the interior lidar map
//   vehicles.ts  rotorcraft kinematics, lander, lidar beams
//   overlays.ts  surface model points, detections, registration, overburden curtain
//   analysis.ts  overburden, shielding and stability from the survey data
//
// Everything on screen is a function of the loop time, so a jump to any time
// is exact. The camera follows a script per chapter; a drag turns it about its
// target and the script takes over again after a few seconds.

import * as THREE from 'three';
import { loadAssets, type Assets } from './assets';
import { GRAVITY, SURFACES, assess, degrade, profile, type Assessment, type BodyId, type Profile, type SurfaceId } from './analysis';
import { createEnv } from './env';
import { CHAPTERS, CLIMB_END, LOOP, SHOTS, at, chapterAt, createFlight, within, type ChapterId, type Pose } from './mission';
import { MEAN_MOTION, ORBIT_ALT, ORBIT_RATE, ORBIT_SPEED, createOrbit } from './orbit';
import { createCurtain, createDetections, createRegistration, createSurfacePoints } from './overlays';
import { createRocks } from './rocks';
import { createTerrain } from './terrain';
import { createSection, type Section } from './section';
import { createCloud, createSky, createTube, type Cloud } from './tube';
import { clamp, damp, lcg, lerp, ramp, smooth } from './util';
import { createBeams, createLander, createRotorcraft } from './vehicles';

export type Anchor = { id: string; x: number; y: number; show: number };

export type HeroState = {
  t: number;
  chapter: ChapterId;
  playing: boolean;
  orbit: { altitude: number; speed: number; range: number; lat: number; lon: number; rate: number };
  flight: { time: number; leg: string; speed: number; agl: number; rate: number; points: number; total: number; mapped: number };
  registration: { stage: number; offsets: [number, number, number] };
  surface: SurfaceId;
  body: BodyId;
  profile: Profile;
  survey: Profile;
  assessment: Assessment;
  /** 0..1 how much of the overburden profile has been drawn. */
  reveal: number;
  /** True once the full rock mesh of the tube has replaced the light one (never on small devices). */
  meshFull: boolean;
};

export type Engine = {
  assets: Assets;
  /** Orbital angular rate, rad per second. */
  meanMotion: number;
  seek(t: number): void;
  play(on: boolean): void;
  setSurface(id: SurfaceId): void;
  setBody(id: BodyId): void;
  state(): HeroState;
  subscribe(fn: (s: HeroState) => void): () => void;
  /** Screen positions of things the page labels, updated every frame. */
  anchors(): Anchor[];
  onFrame(fn: () => void): void;
  /** Camera and craft positions of the last frame, scene frame, for the checking tools. */
  probe(): { cam: number[]; craft: number[]; view: string; rail: number };
  dispose(): void;
};

/** A camera set-up. `rail` is how far the camera has moved onto the flown line (0 free, 1 on it): on the line it is not damped. */
type Shot = { pos: THREE.Vector3; tgt: THREE.Vector3; fov: number; rail: number };

const D = at('descent');
const E = at('explore');
const R = at('register');
const O = at('overburden');
/** The exploration: behind the craft, the wide section, behind the craft again, the wide section again. */
const WIDE1 = E + SHOTS.wide1;
const FOLLOW2 = E + SHOTS.follow2;
const WIDE2 = E + SHOTS.wide2;
/** Loop times where the picture changes scene, so the camera jumps and the screen dips to black. */
const CUTS = [at('survey'), D, WIDE1, FOLLOW2, WIDE2, R];
const FADE = 0.32;
/** Metres of flown line between the camera and the craft in the shots from behind. */
const LAG = 3.4;
type View = 'aerial' | 'follow' | 'wide' | 'data';
const viewAt = (t: number): View => (t < D ? 'aerial' : t < WIDE1 || (t >= FOLLOW2 && t < WIDE2) ? 'follow' : t < R ? 'wide' : 'data');

export async function startEngine(canvas: HTMLCanvasElement, base: string, opts: { reduce: boolean; onProgress: (f: number) => void }): Promise<Engine> {
  // Small or low-memory devices get a lighter ground and the light point file. ?quality=high or low overrides.
  const asked = new URLSearchParams(window.location.search).get('quality');
  const lowPower = asked === 'low' || (asked !== 'high' && (Math.min(window.screen.width, window.screen.height) < 700 || ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 4));
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.autoClear = false;
  let dpr = Math.min(window.devicePixelRatio || 1, lowPower ? 1.25 : 1.75);
  renderer.setPixelRatio(dpr);

  const assets = await loadAssets(base, renderer, opts.onProgress);
  const meta = assets.meta;
  const env = createEnv(meta.terrain.sun);
  const flight = createFlight(meta);

  // ---------------------------------------------------------------- surface world
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.15, 9000);
  let section: Section;
  const terrain = createTerrain(assets, env, lowPower, () => section);
  section = createSection(meta, env, terrain.height);
  terrain.bindSection();
  const tube = createTube(assets, env, section);
  const sky = createSky(env);
  const craft = createRotorcraft(assets, flight);
  const lander = createLander(assets);
  const beams = createBeams(48);
  const surfacePts = createSurfacePoints(assets.near);
  const detections = createDetections(meta);
  const registration = createRegistration(meta);
  const curtain = createCurtain(assets);
  // Dark walls and floor under the ground, open to the sky: a gap in the map shows unlit rock.
  const dark = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide });
  const none = new THREE.MeshBasicMaterial({ visible: false });
  const shroud = new THREE.Mesh(new THREE.BoxGeometry(900, 70, 900), [dark, dark, none, dark, dark, dark]);
  shroud.position.y = -38.5;
  shroud.renderOrder = 0;
  const sun = new THREE.DirectionalLight(0xffe2c4, 3.2);
  sun.position.copy(env.uniforms.uSunDir.value).multiplyScalar(100);
  const hemi = new THREE.HemisphereLight(0xc79a78, 0x5a3a26, 0.7);
  // The vehicles reflect the Martian sky.
  {
    const s = new THREE.Scene();
    s.add(createSky(env));
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromScene(s, 0.03).texture;
    pm.dispose();
  }
  scene.add(createRocks(meta, terrain.height, section.cutAway));
  scene.add(sky, shroud, terrain.group, tube.mesh, section.face, surfacePts.points, detections.group, registration.group, curtain.mesh, curtain.edges, lander.group, craft.group, beams.lines, sun, hemi);

  // The interior map and the full rock mesh are large; they arrive after the first frame.
  let cloud: Cloud | null = null;
  assets
    .loadCloud(lowPower)
    .then(({ meta: cm, data }) => {
      cloud = createCloud(cm, data, section);
      cloud.uniforms.uPx.value = height * dpr * 0.5;
      scene.add(cloud.fine, cloud.data);
    })
    .catch((err) => console.error(err));
  let meshFull = false;
  if (!lowPower)
    assets
      .loadTubeHi()
      .then((hi) => {
        tube.upgrade(hi);
        meshFull = true;
      })
      .catch((err) => console.error(err));

  // ---------------------------------------------------------------- orbit world
  const orbit = createOrbit(assets, renderer);

  // Black veil for cuts between shots.
  const veilScene = new THREE.Scene();
  const veilCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const veilMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
  veilScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), veilMat));

  // ---------------------------------------------------------------- analysis
  let surface: SurfaceId = 'hirise';
  let bodyId: BodyId = 'mars';
  const survey = profile(meta, assets.near, assets.near.h);
  const heightsOf = new Map<SurfaceId, Float32Array>();
  const heights = (id: SurfaceId) => {
    let h = heightsOf.get(id);
    if (!h) {
      h = degrade(assets.near, SURFACES.find((s) => s.id === id)!, 100 + SURFACES.findIndex((s) => s.id === id));
      heightsOf.set(id, h);
    }
    return h;
  };
  let prof = survey;
  let assessment = assess(meta, prof, GRAVITY[bodyId]);
  const applySurface = () => {
    const s = SURFACES.find((x) => x.id === surface)!;
    const h = heights(surface);
    prof = profile(meta, assets.near, h);
    assessment = assess(meta, prof, GRAVITY[bodyId]);
    surfacePts.build(h, s.posting);
    curtain.build(prof);
  };
  applySurface();

  // ---------------------------------------------------------------- clock and input
  let T = 0;
  let playing = !opts.reduce;
  let seekFlag = true;
  let visible = true;
  const drag = { yaw: 0, pitch: 0, zoom: 1, last: -1e9, active: false, x: 0, y: 0 };
  const onDown = (e: PointerEvent) => {
    drag.active = true;
    drag.x = e.clientX;
    drag.y = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!drag.active) return;
    drag.yaw -= (e.clientX - drag.x) * 0.005;
    drag.pitch = clamp(drag.pitch + (e.clientY - drag.y) * 0.004, -0.9, 0.9);
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.last = performance.now();
  };
  const onUp = (e: PointerEvent) => {
    drag.active = false;
    drag.last = performance.now();
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  const onWheel = (e: WheelEvent) => {
    // Zoom only with a modifier, so the page still scrolls past the hero.
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) return;
    e.preventDefault();
    drag.zoom = clamp(drag.zoom * Math.exp(e.deltaY * 0.0012), 0.45, 2.2);
    drag.last = performance.now();
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  const io = new IntersectionObserver((es) => (visible = es[0].isIntersecting), { threshold: 0.05 });
  io.observe(canvas);

  let width = 1;
  let height = 1;
  const resize = () => {
    width = canvas.clientWidth || 1;
    height = canvas.clientHeight || 1;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    const px = height * dpr * 0.5;
    if (cloud) cloud.uniforms.uPx.value = px;
    surfacePts.uniforms.uPx.value = px;
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);

  // ---------------------------------------------------------------- the director
  const st = meta.stations;
  const S = meta.skylights.map((s) => new THREE.Vector3(s.pos[0], s.pos[1], s.pos[2]));
  const L = new THREE.Vector3(meta.lander[0], meta.lander[1], meta.lander[2]);
  const mid = new THREE.Vector3(-8, -3, -10);
  const shot: Shot = { pos: new THREE.Vector3(), tgt: new THREE.Vector3(), fov: 40, rail: 0 };
  const rail = new THREE.Vector3();
  const railPose: Pose = { p: [0, 0, 0], q: [0, 0, 0, 1] };
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const blend = (u: number, p0: THREE.Vector3, t0: THREE.Vector3, f0: number, p1: THREE.Vector3, t1: THREE.Vector3, f1: number) => {
    shot.pos.lerpVectors(p0, p1, u);
    shot.tgt.lerpVectors(t0, t1, u);
    shot.fov = lerp(f0, f1, u);
  };
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const frame = { side: new THREE.Vector3(), centre: new THREE.Vector3(), station: 0 };
  // The lander shot looks across the lander toward the skylight, from the side the sun is on.
  const toS1 = S[0].clone().sub(L).setY(0).normalize();
  const acrossS1 = new THREE.Vector3(-toS1.z, 0, toS1.x);

  const direct = (t: number, tf: number) => {
    const c = craft.pos;
    shot.rail = 0;
    if (t < D) {
      const s0 = at('survey');
      if (t < s0 + 9.5) {
        // Looking straight down with the orbiter's camera while the strip is read out.
        blend(within(t, s0, s0 + 9.5), V(6, 560, 46), V(0, 0, -6), 30, V(0, 470, 40), V(0, 0, -8), 30);
      } else {
        blend(within(t, s0 + 9.5, s0 + 14.5), V(0, 470, 40), V(0, 0, -8), 30, V(-128, 96, 168), V(17, -2, 48), 33);
      }
    } else if (viewAt(t) === 'follow') {
      // One continuous move from the deck into the tube. Close on the lander for the spin-up and the
      // lift-off, alongside for the transit, then onto the line the craft has flown, LAG metres behind
      // it: that line is free space, so the camera goes down the shaft and through the tube without
      // meeting rock.
      const lift = Math.max(c.y - (L.y + 1.24), 0);
      const u = within(t, D + CLIMB_END - 1.6, D + CLIMB_END + 2.4);
      a.copy(L).addScaledVector(toS1, -3.2 - 1.9 * lift).addScaledVector(acrossS1, -3.8 - 0.35 * lift).add(V(0, 1.7 + 0.7 * lift, 0));
      b.copy(c).addScaledVector(toS1, -6.5).addScaledVector(acrossS1, 4.2).add(V(0, 2.4, 0));
      shot.pos.lerpVectors(a, b, u);
      a.copy(L).add(V(0, 1.3 + 0.62 * lift, 0));
      shot.tgt.lerpVectors(a, c, u);
      const [d0] = flight.legs.descent;
      const v = smooth((tf - (d0 - 9)) / 11);
      if (v > 0) {
        flight.pose(flight.timeAtArc(Math.max(flight.arc(tf) - LAG, 0)), railPose);
        rail.set(railPose.p[0], railPose.p[1] + 0.35, railPose.p[2]);
        // In a shaft the flown line is vertical and the camera would sit straight above the craft. There it
        // stands back from the line by a metre and a quarter, inside the shaft's free radius, and looks down
        // past the craft into the tube.
        const steep = smooth((Math.abs(rail.y - c.y) / Math.max(rail.distanceTo(c), 0.1) - 0.45) / 0.4);
        rail.addScaledVector(craft.forward, -1.25 * steep);
        shot.pos.lerp(rail, v);
        // Look past the craft to where it is heading.
        shot.tgt.addScaledVector(craft.forward, lerp(3.0, 1.2, steep) * v);
      }
      shot.rail = v;
      shot.fov = lerp(42, 60, v);
    } else if (t < R) {
      // The wide section: beside the tube, in the half of the ground that is cut away, far enough back
      // that the surface, the rock in section, the tube and the map are in one picture.
      section.frameAt(c.x, c.z, frame);
      const w = t < FOLLOW2 ? (t - WIDE1) / (FOLLOW2 - WIDE1) : (t - WIDE2) / (R - WIDE2);
      const dist = t < FOLLOW2 ? lerp(40, 47, w) : lerp(44, 60, w);
      const rise = t < FOLLOW2 ? lerp(13, 16, w) : lerp(15, 21, w);
      shot.pos.set(c.x + frame.side.x * dist, c.y + rise, c.z + frame.side.z * dist);
      // Aim between the craft and the ground above it, so the surface stays in the picture where the tube runs deep.
      shot.tgt.set(c.x, lerp(c.y, terrain.height(c.x, c.z), 0.38), c.z);
      shot.fov = 35;
    } else if (t < O) {
      const u = within(t, R, O);
      shot.pos.set(lerp(-178, -150, u), lerp(128, 112, u), lerp(170, 142, u));
      shot.tgt.copy(mid).add(V(0, lerp(14, 0, within(t, R + 4, R + 14)), 0));
      shot.fov = 33;
    } else {
      // Travel beside the tube with the front of the profile, then pull back to the whole section.
      const k = Math.round(clamp(within(t, O + 1.5, O + 11), 0, 1) * (st.pos.length - 1));
      const u = within(t, O, O + 3);
      const w = within(t, O + 11.5, O + 18);
      a.set(-150, 112, 142);
      b.set(st.pos[k][0] + 84, st.pos[k][1] + 36, st.pos[k][2] - 20).lerp(V(196, 60, -8), w);
      shot.pos.lerpVectors(a, b, u);
      a.copy(mid);
      b.set(st.pos[k][0], st.pos[k][1] + 5, st.pos[k][2] + 6).lerp(V(mid.x, 0, mid.z), w);
      shot.tgt.lerpVectors(a, b, u);
      shot.fov = lerp(33, 36, u);
    }
  };

  const camPos = new THREE.Vector3();
  const camTgt = new THREE.Vector3();
  let camFov = 40;
  const off = new THREE.Vector3();
  const look = new THREE.Vector3();
  const sph = new THREE.Spherical();
  const rnd = lcg(99);
  const hits = new Float32Array(48 * 3);
  const anchorList: Anchor[] = [...meta.skylights.map((s) => ({ id: s.id, x: 0, y: 0, show: 0 })), { id: 'lander', x: 0, y: 0, show: 0 }];
  const proj = new THREE.Vector3();
  const place = (an: Anchor, world: THREE.Vector3, cam: THREE.Camera, show: number) => {
    proj.copy(world).project(cam);
    an.x = (proj.x * 0.5 + 0.5) * width;
    an.y = (-proj.y * 0.5 + 0.5) * height;
    an.show = proj.z < 1 && Math.abs(proj.x) < 1.05 && Math.abs(proj.y) < 1.05 ? show : 0;
  };
  let regStage = 0;
  let reveal = 0;
  const frameFns: (() => void)[] = [];
  const subs = new Set<(s: HeroState) => void>();
  let lastEmit = 0;
  let slow = 0;

  const state = (): HeroState => {
    const tf = flight.time(T);
    return {
      t: T,
      chapter: chapterAt(T).id,
      playing,
      orbit: { altitude: ORBIT_ALT, speed: ORBIT_SPEED, range: orbit.rangeToSite, lat: orbit.latitude, lon: orbit.longitude, rate: ORBIT_RATE },
      flight: { time: tf, leg: flight.legAt(tf), speed: craft.speed, agl: craft.agl, rate: flight.rate(T), points: cloud ? cloud.shown : 0, total: cloud ? cloud.count : 0, mapped: clamp((tf - flight.legs.backtrack[0]) / (flight.legs.traverse[1] - flight.legs.backtrack[0]), 0, 1) },
      registration: { stage: regStage, offsets: registration.offsets },
      surface,
      body: bodyId,
      profile: prof,
      survey,
      assessment,
      reveal,
      meshFull,
    };
  };

  const renderFrame = (dt: number) => {
    env.uniforms.uTime.value += dt;
    const seek = seekFlag;
    seekFlag = false;
    // The script takes the camera back a few seconds after the last drag.
    const idle = (performance.now() - drag.last) / 1000;
    if (!drag.active && idle > 4 && playing) {
      drag.yaw = damp(drag.yaw, 0, 1.6, dt);
      drag.pitch = damp(drag.pitch, 0, 1.6, dt);
      drag.zoom = damp(drag.zoom, 1, 1.6, dt);
    }
    // Dip to black around each change of scene, and around the loop point.
    let veil = 0;
    for (const cut of CUTS) veil = Math.max(veil, 1 - Math.abs(T - cut) / FADE);
    veil = Math.max(veil, 1 - T / (FADE * 2), 1 - (LOOP - T) / (FADE * 3));
    veilMat.opacity = smooth(clamp(veil, 0, 1));

    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, width, height);
    renderer.clear();
    if (T < at('survey')) {
      orbit.update(ORBIT_RATE * (T - (at('survey') - 0.8)), within(T, 0, at('survey') - 0.4), width / height, drag, dt);
      renderer.render(orbit.planetScene, orbit.planetCam);
      renderer.clearDepth();
      renderer.render(orbit.craftScene, orbit.craftCam);
      for (const an of anchorList) an.show = 0;
    } else {
      const tf = flight.time(T);
      craft.update(tf, dt, flight.rotor(T), terrain.height);
      const under = clamp((terrain.height(craft.pos.x, craft.pos.z) - craft.pos.y - 0.5) / 2.5, 0, 1);
      const ch = chapterAt(T).id;
      const view = viewAt(T);
      const dataView = view === 'data';
      const cutView = view === 'wide';
      const cutAmt = cutView ? 1 : 0;

      direct(T, tf);
      if (seek || CUTS.some((cut) => Math.abs(T - cut) < 0.05)) {
        camPos.copy(shot.pos);
        camTgt.copy(shot.tgt);
        camFov = shot.fov;
      } else {
        // On the flown line the camera is not damped: damping would cut the bends and put it in the rock.
        const rate = lerp(2.4, 40, shot.rail);
        camPos.x = damp(camPos.x, shot.pos.x, rate, dt);
        camPos.y = damp(camPos.y, shot.pos.y, rate, dt);
        camPos.z = damp(camPos.z, shot.pos.z, rate, dt);
        if (shot.rail > 0.999) camPos.copy(shot.pos);
        const aim = lerp(3.6, 7, shot.rail);
        camTgt.x = damp(camTgt.x, shot.tgt.x, aim, dt);
        camTgt.y = damp(camTgt.y, shot.tgt.y, aim, dt);
        camTgt.z = damp(camTgt.z, shot.tgt.z, aim, dt);
        camFov = damp(camFov, shot.fov, 2, dt);
      }
      off.copy(camPos).sub(camTgt);
      sph.setFromVector3(off);
      if (shot.rail > 0.5) {
        // On the flown line a drag turns the view about the camera, which stays where it is.
        off.negate();
        sph.setFromVector3(off);
        sph.theta += drag.yaw;
        sph.phi = clamp(sph.phi - drag.pitch, 0.06, Math.PI - 0.06);
        off.setFromSpherical(sph);
        camera.position.copy(camPos);
        look.copy(camPos).add(off);
        camera.fov = clamp(camFov * drag.zoom, 20, 90);
      } else {
        // Elsewhere a drag turns the camera about its target.
        sph.theta += drag.yaw;
        sph.phi = clamp(sph.phi - drag.pitch, 0.06, Math.PI - 0.06);
        sph.radius *= drag.zoom;
        off.setFromSpherical(sph);
        camera.position.copy(camTgt).add(off);
        look.copy(camTgt);
        camera.fov = camFov;
        // Where the ground has not been cut away, the camera stays above it.
        if (shot.rail < 0.01 && (!cutView || !section.cutAway(camera.position.x, camera.position.z))) camera.position.y = Math.max(camera.position.y, terrain.height(camera.position.x, camera.position.z) + 0.6);
      }
      camera.near = lerp(0.3, 0.08, shot.rail);
      camera.updateProjectionMatrix();
      camera.lookAt(look);

      // What each chapter shows.
      const s0 = at('survey');
      section.uniforms.uCutAmt.value = cutAmt;
      section.face.visible = cutAmt > 0;
      const faceU = (section.face.material as THREE.ShaderMaterial).uniforms;
      faceU.uCam.value.copy(camera.position);
      faceU.uLampPos.value.copy(craft.sensor);
      faceU.uLamp.value = under * craft.power;
      terrain.uniforms.uCam.value.copy(camera.position);
      terrain.uniforms.uScan.value.set(0, -1, lerp(-215, 215, within(T, s0 + 0.6, s0 + 8.6)), T < s0 + 10 ? 1 - within(T, s0 + 8.6, s0 + 10) : 0);
      terrain.uniforms.uXray.value = dataView ? 1 : 0;
      terrain.uniforms.uData.value = dataView ? 0.92 : T < D ? ramp(T, s0 + 10, s0 + 13) * 0.45 * (1 - ramp(T, D - 1.5, D)) : 0;
      tube.uniforms.uCam.value.copy(camera.position);
      tube.uniforms.uShell.value = dataView ? 1 : 0;
      // The rock mesh is the tube in every view but the registration, where the points alone are shown.
      tube.mesh.visible = !(T >= R && T < O);
      tube.uniforms.uLampPos.value.copy(craft.sensor);
      tube.uniforms.uLampDir.value.copy(craft.forward).setY(-0.12).normalize();
      const legs = flight.legs;
      // The lamps come on as the craft starts down and stay on until it is back above ground.
      const lamps = ramp(tf, legs.descent[0] + 1, legs.descent[0] + 4) * (1 - ramp(tf, legs.ascent[1], legs.ascent[1] + 3)) * craft.power;
      tube.uniforms.uLamp.value = dataView ? 0 : lamps;
      // What the lidar has covered so far, as a stretch of stations: back to the turn, then on past the first skylight.
      section.frameAt(craft.pos.x, craft.pos.z, frame);
      const scanFrom = legs.descent[0] + 12;
      const reach = 13 * ramp(tf, scanFrom, scanFrom + 10);
      const k1 = meta.flight.stationS1;
      const lo = tf < legs.traverse[0] ? Math.min(frame.station, k1) : meta.flight.stationTurn;
      const hi = tf < legs.traverse[0] ? k1 : tf > legs.traverse[1] ? st.pos.length : Math.max(frame.station, k1);
      tube.uniforms.uMapped.value.set(tf > scanFrom ? (lo - reach) / (st.pos.length - 1) : 2, tf > scanFrom ? (hi + reach) / (st.pos.length - 1) : -1);
      tube.uniforms.uMapLight.value = cutView ? 1 : 0;
      craft.setLampGlow(lamps * lerp(0.35, 1, under));
      // Daylight on the vehicles goes as the craft goes underground. From behind, in the tube, the airframe
      // is close to a silhouette against the rock its lamps light; in the section it stays readable.
      sun.intensity = 3.2 * (1 - under);
      hemi.intensity = 0.7 * lerp(1, cutView ? 0.3 : 0.14, under);
      scene.environmentIntensity = 0.85 * lerp(1, cutView ? 0.3 : 0.1, under);

      if (cloud) {
        cloud.setTime(tf);
        cloud.fine.visible = view === 'follow' || cutView;
        cloud.data.visible = dataView;
        const u = cloud.uniforms;
        // A new return fades to its settled level in under two seconds of screen time, whatever the playback rate.
        u.uFade.value = 1 / (1.7 * Math.max(flight.rate(T), 1));
        u.uFlash.value = cutView ? 0.9 : 0.6;
        u.uSettled.value = cutView ? 0.32 : 0.07;
        u.uOpacity.value = ch === 'overburden' ? 0.07 : 0.03;
        u.uTint.value.setRGB(0.35, 0.88, 1.0);
        u.uOffset.value.copy(registration.matrix);
      }

      // Registration: the interior map moves from the robot's frame onto the surface model.
      regStage = ch === 'register' ? clamp((T - (R + 2.5)) / 5.5, 0, 1) + clamp((T - (R + 12)) / 6, 0, 1) : 2;
      registration.set(regStage, ch === 'register' ? ramp(T, R + 1, R + 2.5) * (1 - ramp(T, O - 2, O)) : 0);

      surfacePts.points.visible = T < D || dataView;
      surfacePts.uniforms.uSweep.value = T < D ? lerp(-215, 215, within(T, s0 + 0.6, s0 + 8.6)) - 2 : 1e9;
      surfacePts.uniforms.uOpacity.value = T < D ? 0.9 * (1 - ramp(T, D - 1.5, D)) : ch === 'register' ? 0.55 : 0.16;
      // All four candidates stand until the match with the interior map rejects the fourth.
      detections.set(T < D ? clamp((T - (s0 + 10.5)) / 3.2, 0, 1) : ch === 'register' ? 1 + ramp(T, R + 8, R + 10) : 2, T < D ? 1 - ramp(T, D - 1, D) : ch === 'register' ? ramp(T, R + 1, R + 2.5) : ch === 'overburden' ? 0.5 : 0);

      reveal = T >= O ? within(T, O + 1.5, O + 11) : 0;
      curtain.uniforms.uReveal.value = reveal * 1.02;
      curtain.uniforms.uOpacity.value = T >= O ? 1 : 0;

      // Lidar beams to the newest returns, only while mapping, and only to returns the section keeps.
      const mapping = cutView && craft.power > 0.5 && under > 0.5 && tf < flight.legs.traverse[1];
      let nb = 0;
      if (mapping && cloud) {
        const got = cloud.recent(48, hits, rnd);
        for (let i = 0; i < got; i++) {
          if (section.cutAway(hits[i * 3], hits[i * 3 + 2])) continue;
          hits.copyWithin(nb * 3, i * 3, i * 3 + 3);
          nb++;
        }
      }
      beams.set(craft.sensor, hits, nb, mapping ? 0.13 : 0);
      beams.lines.visible = nb > 0;

      craft.group.visible = T >= D;
      lander.group.visible = true;
      renderer.render(scene, camera);

      const lab = (T >= s0 + 10.5 && T < D) || ch === 'register' || ch === 'overburden' ? 1 : 0;
      detections.anchors.forEach((d, i) => place(anchorList[i], d.pos, camera, lab * (d.matched || T < R + 12 ? 1 : 0)));
      place(anchorList[S.length], a.copy(L).add(V(0, 2.6, 0)), camera, (T >= s0 + 12 && T < D) || T >= O ? 1 : 0);
    }
    renderer.render(veilScene, veilCam);
    for (const fn of frameFns) fn();
  };

  let raf = 0;
  let last = performance.now();
  const loop = () => {
    raf = requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (!visible || document.hidden) return;
    if (playing) {
      T += dt;
      if (T >= LOOP) {
        T -= LOOP;
        seekFlag = true;
      }
    }
    renderFrame(dt);
    // If frames run long for a while, give up resolution before smoothness.
    slow = dt > 0.024 ? slow + dt : Math.max(0, slow - dt * 0.5);
    if (slow > 2.5 && dpr > 1) {
      dpr = Math.max(1, dpr - 0.25);
      renderer.setPixelRatio(dpr);
      resize();
      slow = 0;
    }
    if (now - lastEmit > 100) {
      lastEmit = now;
      const s = state();
      for (const fn of subs) fn(s);
    }
  };
  loop();

  return {
    assets,
    meanMotion: MEAN_MOTION,
    seek(t) {
      T = clamp(t, 0, LOOP - 0.01);
      seekFlag = true;
      drag.yaw = drag.pitch = 0;
      drag.zoom = 1;
      if (!playing) renderFrame(0);
    },
    play(on) {
      playing = on;
    },
    setSurface(id) {
      surface = id;
      applySurface();
    },
    setBody(id) {
      bodyId = id;
      assessment = assess(meta, prof, GRAVITY[bodyId]);
    },
    state,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    anchors: () => anchorList,
    probe: () => ({ cam: camera.position.toArray(), craft: craft.pos.toArray(), view: viewAt(T), rail: shot.rail }),
    onFrame(fn) {
      frameFns.push(fn);
    },
    dispose() {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      renderer.dispose();
    },
  };
}

export { CHAPTERS, LOOP, MEAN_MOTION, SURFACES, at };
