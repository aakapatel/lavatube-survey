// The orbital pass. Mars is a sphere of its real radius in kilometres with
// the Viking colour mosaic on it (public domain, NASA/JPL/USGS); the orbiter
// is a model in metres drawn in a second pass, so both keep depth precision.
//
// The orbit is circular at 300 km and nearly polar (93 degrees), like the
// orbits used for imaging Mars. Its angular rate is n = sqrt(mu / a^3), about
// 112 minutes a revolution; the pass is shown ORBIT_RATE times faster than
// real. The ground track is laid through the concept site.

import * as THREE from 'three';
import type { Assets } from './assets';
import { clamp, noiseTexture } from './util';

const R_MARS = 3389.5; // km
const MU = 42828.37; // km^3 / s^2
const ALT = 300; // km
const INCL = THREE.MathUtils.degToRad(93);
const A = R_MARS + ALT;
export const MEAN_MOTION = Math.sqrt(MU / (A * A * A)); // rad / s
export const ORBIT_SPEED = MEAN_MOTION * A; // km / s
export const ORBIT_RATE = 40;
export const ORBIT_ALT = ALT;
const SPIN = (2 * Math.PI) / 88642.66; // sidereal rotation, rad / s
const SITE_LAT = THREE.MathUtils.degToRad(-6.5);
const SITE_LON = THREE.MathUtils.degToRad(-119.5);
const REGION_LAT = THREE.MathUtils.degToRad(-18);
const REGION_SPAN = new THREE.Vector2(THREE.MathUtils.degToRad(18), THREE.MathUtils.degToRad(60));
const REGION_LON = THREE.MathUtils.degToRad(-119.5);
/** Half widths of the two image strips on the ground, km: a 6 km high-resolution strip inside a 30 km context strip. */
const SWATH_FINE = 3;
const SWATH_WIDE = 15;

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const body = (lat: number, lon: number) => new THREE.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon));

export type Orbit = {
  planetScene: THREE.Scene;
  craftScene: THREE.Scene;
  /** Camera for both passes; the engine renders planetScene, clears depth, then craftScene. */
  planetCam: THREE.PerspectiveCamera;
  craftCam: THREE.PerspectiveCamera;
  /** tau: seconds of orbit relative to the moment over the site. view: 0..1 through the chapter. */
  update(tau: number, view: number, aspect: number, drag: { yaw: number; pitch: number; zoom: number }, dt: number): void;
  /** Ground distance still to fly to the site, km (negative after it). */
  rangeToSite: number;
  latitude: number;
  longitude: number;
};

function planetShineEnv(renderer: THREE.WebGLRenderer): THREE.Texture {
  const s = new THREE.Scene();
  s.add(
    new THREE.Mesh(
      new THREE.SphereGeometry(10, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        vertexShader: 'varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'varying vec3 vD; void main(){ vec3 d = normalize(vD); float g = smoothstep(0.15, -0.5, d.y); float limb = exp(-pow((d.y + 0.2) * 6.0, 2.0)); gl_FragColor = vec4(vec3(0.95, 0.56, 0.36) * g * 1.3 + vec3(0.55, 0.6, 0.75) * limb * 0.35 + vec3(0.012), 1.0); }',
      }),
    ),
  );
  const pm = new THREE.PMREMGenerator(renderer);
  const t = pm.fromScene(s, 0.02).texture;
  pm.dispose();
  return t;
}

export function createOrbit(a: Assets, renderer: THREE.WebGLRenderer): Orbit {
  const planetScene = new THREE.Scene();
  const craftScene = new THREE.Scene();
  const planetCam = new THREE.PerspectiveCamera(42, 1, 20, 40000);
  const craftCam = new THREE.PerspectiveCamera(42, 1, 0.5, 600);

  // Orbit geometry in the inertial frame, with the site under the track at tau = 0.
  const s0 = body(SITE_LAT, SITE_LON);
  const north = new THREE.Vector3(0, 1, 0).addScaledVector(s0, -s0.y).normalize();
  const east = new THREE.Vector3().crossVectors(north, s0).normalize();
  const az = Math.asin(Math.cos(INCL) / Math.cos(SITE_LAT));
  const v0 = north.clone().multiplyScalar(Math.cos(az)).addScaledVector(east, Math.sin(az)).normalize();
  const hN = new THREE.Vector3().crossVectors(s0, v0).normalize();
  // Sun low over the site, matching the surface scene.
  const el = Math.asin(a.meta.terrain.sun[1]);
  const sunDir = s0.clone().multiplyScalar(Math.sin(el)).addScaledVector(east, -Math.cos(el) * 0.82).addScaledVector(north, Math.cos(el) * 0.57).normalize();
  const earthDir = new THREE.Vector3(0.35, 0.25, 0.9).normalize();

  // ---------------------------------------------------------------- planet
  const uniforms = {
    uGlobal: { value: a.marsGlobal },
    uStrip0: { value: a.marsStrips[0] },
    uStrip1: { value: a.marsStrips[1] },
    uStrip2: { value: a.marsStrips[2] },
    uNoise: { value: noiseTexture(256, 3) },
    uRegionBox: { value: new THREE.Vector4(REGION_LON, REGION_LAT, REGION_SPAN.x, REGION_SPAN.y) },
    uSun: { value: sunDir },
    uSpin: { value: 0 },
    uS0: { value: s0 },
    uV0: { value: v0 },
    uH: { value: hN },
    uPhase: { value: new THREE.Vector2(-1, -1) }, // strip start and current angle along the track
    uSwath: { value: new THREE.Vector2(SWATH_FINE / R_MARS, SWATH_WIDE / R_MARS) },
    uCamPos: { value: new THREE.Vector3() },
  };
  const planetMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vP;
      void main() {
        vP = position;
        gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform sampler2D uGlobal;
      uniform sampler2D uStrip0;
      uniform sampler2D uStrip1;
      uniform sampler2D uStrip2;
      uniform sampler2D uNoise;
      uniform vec4 uRegionBox;
      uniform vec3 uSun;
      uniform float uSpin;
      uniform vec3 uS0;
      uniform vec3 uV0;
      uniform vec3 uH;
      uniform vec2 uPhase;
      uniform vec2 uSwath;
      uniform vec3 uCamPos;
      varying vec3 vP;
      const float PI = 3.141592653589793;

      vec3 albedoAt(vec3 b) {
        float lon = atan(-b.z, b.x);
        float lat = asin(clamp(b.y, -1.0, 1.0));
        vec3 c = texture2D(uGlobal, vec2(lon / (2.0 * PI) + 0.5, 0.5 + lat / PI)).rgb;
        vec2 r = vec2(lon - uRegionBox.x, lat - uRegionBox.y) / uRegionBox.zw + 0.5;
        vec2 e = smoothstep(vec2(0.0), vec2(0.06), r) * smoothstep(vec2(0.0), vec2(0.06), 1.0 - r);
        float w = e.x * e.y;
        if (w > 0.0) {
          // The strip is stored as three images, north to south.
          float v = (1.0 - r.y) * 3.0;
          vec3 s = v < 1.0 ? texture2D(uStrip0, vec2(r.x, 1.0 - v)).rgb : v < 2.0 ? texture2D(uStrip1, vec2(r.x, 2.0 - v)).rgb : texture2D(uStrip2, vec2(r.x, 3.0 - v)).rgb;
          c = mix(c, s, w);
        }
        return c;
      }

      void main() {
        vec3 n = normalize(vP);
        // Body-fixed direction: undo the planet's rotation about its axis.
        float cs = cos(uSpin), sn = sin(uSpin);
        vec3 b = vec3(cs * n.x - sn * n.z, n.y, sn * n.x + cs * n.z);
        vec3 alb = albedoAt(b);
        // Relief from the brightness of the mosaic, which was taken under low sun.
        float e = 0.0004;
        vec3 t1 = normalize(cross(n, vec3(0.0, 1.0, 0.0)));
        vec3 t2 = cross(n, t1);
        float l0 = dot(alb, vec3(0.33));
        vec3 b1 = normalize(b + (vec3(cs * t1.x - sn * t1.z, t1.y, sn * t1.x + cs * t1.z)) * e);
        vec3 b2 = normalize(b + (vec3(cs * t2.x - sn * t2.z, t2.y, sn * t2.x + cs * t2.z)) * e);
        float l1 = dot(albedoAt(b1), vec3(0.33));
        float l2 = dot(albedoAt(b2), vec3(0.33));
        // The mosaic already carries the relief shading of its own low sun; light the sphere smoothly.
        float ndl = dot(n, uSun) + 0.0 * (l0 + l1 + l2);
        float day = smoothstep(-0.08, 0.25, ndl) * (0.35 + 0.65 * clamp(ndl, 0.0, 1.0));
        // Grain below the resolution of the mosaic, so the ground does not look smooth close to nadir.
        float g = texture2D(uNoise, b.xz * 900.0).r * 0.5 + texture2D(uNoise, b.zy * 3700.0).g * 0.5;
        vec3 col = pow(alb, vec3(1.35)) * vec3(1.0, 0.92, 0.86) * day * 1.25 * (0.93 + 0.14 * g);

        // Image strips along the ground track.
        float cross_ = asin(clamp(dot(n, uH), -1.0, 1.0));
        float along = atan(dot(n, uV0), dot(n, uS0));
        float inStrip = step(uPhase.x, along) * step(along, uPhase.y);
        float wide = smoothstep(uSwath.y, uSwath.y * 0.94, abs(cross_)) * inStrip;
        float fine = smoothstep(uSwath.x, uSwath.x * 0.8, abs(cross_)) * inStrip;
        col = mix(col, col * 1.12 + vec3(0.05, 0.035, 0.02) * day, wide * 0.6);
        col = mix(col, col * 1.35 + vec3(0.2, 0.16, 0.1) * day, fine * 0.85);
        // The line being read out now.
        float head = exp(-pow((along - uPhase.y) * 2600.0, 2.0)) * smoothstep(uSwath.y, uSwath.y * 0.9, abs(cross_));
        col += vec3(1.0, 0.86, 0.6) * head * 1.6;

        // Dust haze thickens toward the limb.
        vec3 v = normalize(uCamPos - vP);
        float mu = clamp(dot(n, v), 0.0, 1.0);
        float haze = pow(1.0 - mu, 3.0);
        col = mix(col, vec3(0.62, 0.42, 0.3) * (0.25 + 0.75 * day) * 1.5, haze * 0.6);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const planet = new THREE.Mesh(new THREE.SphereGeometry(R_MARS, 256, 128), planetMat);
  planetScene.add(planet);

  // The limb: a thin shell that scatters toward the sun side.
  const air = new THREE.Mesh(
    new THREE.SphereGeometry(R_MARS + 45, 128, 64),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uSun: uniforms.uSun, uCamPos: uniforms.uCamPos },
      vertexShader: /* glsl */ `
        varying vec3 vP;
        void main() { vP = position; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uSun;
        uniform vec3 uCamPos;
        varying vec3 vP;
        void main() {
          vec3 n = normalize(vP);
          vec3 v = normalize(vP - uCamPos);
          float rim = pow(clamp(1.0 - abs(dot(n, v)), 0.0, 1.0), 4.0);
          float day = smoothstep(-0.25, 0.4, dot(n, uSun));
          vec3 c = mix(vec3(0.7, 0.46, 0.32), vec3(0.5, 0.52, 0.6), rim) * rim * day * 0.5;
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    }),
  );
  planetScene.add(air);

  // Stars and the sun.
  {
    const n = 2600;
    const pos = new Float32Array(n * 3);
    const mag = new Float32Array(n);
    let seed = 12345;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < n; i++) {
      const z = rnd() * 2 - 1;
      const ph = rnd() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      pos[i * 3] = r * Math.cos(ph) * 30000;
      pos[i * 3 + 1] = z * 30000;
      pos[i * 3 + 2] = r * Math.sin(ph) * 30000;
      mag[i] = Math.pow(rnd(), 6.0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    const stars = new THREE.Points(
      g,
      new THREE.ShaderMaterial({
        depthWrite: false,
        transparent: true,
        blending: THREE.AdditiveBlending,
        uniforms: { uPx: { value: 1 } },
        vertexShader: /* glsl */ `
          attribute float aMag;
          uniform float uPx;
          varying float vM;
          void main() {
            vM = aMag;
            vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
            gl_Position = p.xyww;
            gl_PointSize = (1.0 + 2.2 * aMag) * uPx;
          }`,
        fragmentShader: /* glsl */ `
          varying float vM;
          void main() {
            vec2 q = gl_PointCoord - 0.5;
            float a = smoothstep(0.5, 0.0, length(q));
            gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * a * (0.12 + 0.88 * vM), 1.0);
          }`,
      }),
    );
    stars.frustumCulled = false;
    stars.renderOrder = -5;
    planetScene.add(stars);
  }

  // The scan fan from the telescope to the line on the ground.
  const fanGeo = new THREE.BufferGeometry();
  const fanPos = new Float32Array(9);
  fanGeo.setAttribute('position', new THREE.BufferAttribute(fanPos, 3));
  const fan = new THREE.Mesh(fanGeo, new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending }));
  fan.frustumCulled = false;
  planetScene.add(fan);

  // ---------------------------------------------------------------- orbiter
  const craft = new THREE.Group();
  const model = a.models.orbiter;
  if (model) craft.add(model);
  else {
    const m = new THREE.MeshStandardMaterial({ color: 0xa08a52, roughness: 0.4, metalness: 0.85 });
    craft.add(new THREE.Mesh(new THREE.BoxGeometry(2.4, 2.8, 2.2), m));
    const p = new THREE.MeshStandardMaterial({ color: 0x10152a, roughness: 0.3, metalness: 0.6 });
    for (const s of [-1, 1]) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.05, 2.2), p);
      w.position.x = s * 3.8;
      craft.add(w);
    }
  }
  craftScene.add(craft);
  const sunLight = new THREE.DirectionalLight(0xfff4e6, 3.4);
  craftScene.add(sunLight, sunLight.target);
  // Light returned by the planet below, and a faint fill so shadowed faces keep detail.
  const shine = new THREE.DirectionalLight(0xd0906a, 0.75);
  craftScene.add(shine, shine.target);
  craftScene.add(new THREE.AmbientLight(0x30343c, 0.35));
  // What the hardware reflects: black sky above, the lit planet below.
  craftScene.environment = planetShineEnv(renderer);
  craftScene.environmentIntensity = 0.7;
  const find = (name: string) => {
    let hit: THREE.Object3D | null = null;
    craft.traverse((o) => {
      if (!hit && o.name === name) hit = o;
    });
    return hit as THREE.Object3D | null;
  };
  const arrays = [find('array_l'), find('array_r')];
  const hga = find('hga');

  const pos = new THREE.Vector3();
  const up = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const camOff = new THREE.Vector3();
  const look = new THREE.Vector3();

  const orbit: Orbit = {
    planetScene,
    craftScene,
    planetCam,
    craftCam,
    rangeToSite: 0,
    latitude: 0,
    longitude: 0,
    update(tau, view, aspect, drag) {
      const th = MEAN_MOTION * tau;
      up.copy(s0).multiplyScalar(Math.cos(th)).addScaledVector(v0, Math.sin(th)).normalize();
      fwd.copy(v0).multiplyScalar(Math.cos(th)).addScaledVector(s0, -Math.sin(th)).normalize();
      right.crossVectors(up, fwd).normalize();
      pos.copy(up).multiplyScalar(A);
      // Nadir pointing: model up is local up, model forward is the velocity.
      basis.makeBasis(right, up, fwd);
      q.setFromRotationMatrix(basis);
      craft.quaternion.copy(q);
      const spin = SPIN * tau;
      uniforms.uSpin.value = spin;
      uniforms.uPhase.value.set(MEAN_MOTION * -ORBIT_RATE * 21, th);
      orbit.rangeToSite = -th * R_MARS;
      // Sub-satellite point in body coordinates.
      const cs = Math.cos(spin);
      const sn = Math.sin(spin);
      const bx = cs * up.x - sn * up.z;
      const bz = sn * up.x + cs * up.z;
      orbit.latitude = THREE.MathUtils.radToDeg(Math.asin(up.y));
      orbit.longitude = THREE.MathUtils.radToDeg(Math.atan2(-bz, bx));

      // Arrays turn about the wing axis toward the sun; the dish holds an inertial direction.
      const inv = q.clone().invert();
      const sunLocal = tmp.copy(sunDir).applyQuaternion(inv);
      for (const w of arrays) if (w) w.rotation.x = Math.atan2(sunLocal.z, sunLocal.y);
      if (hga) {
        // The dish boresight is the node's +y; keep it on the Earth direction, within the gimbal's reach.
        const e = tmp2.copy(earthDir).applyQuaternion(inv);
        e.y = Math.max(e.y, 0.35);
        hga.quaternion.setFromUnitVectors(Y_AXIS, e.normalize());
      }
      craftScene.environmentRotation.setFromQuaternion(q);
      sunLight.position.copy(sunDir).multiplyScalar(100);
      shine.position.copy(up).multiplyScalar(-100);

      // Chase camera: from behind and above the orbiter round to straight down the telescope.
      // The horizon stays in frame for most of the pass; the view tips to nadir at the end.
      const k = clamp((view - 0.62) / 0.38, 0, 1);
      const turn = view;
      const back = THREE.MathUtils.lerp(-34, -7, k * k) - 4 * Math.sin(turn * 2.2);
      const side = THREE.MathUtils.lerp(17, 9, k) - 9 * turn * (1 - k);
      const high = THREE.MathUtils.lerp(11, 27, k);
      const dist = Math.hypot(back, side, high) * drag.zoom;
      const yaw = Math.atan2(side, back) + drag.yaw;
      const pitch = clamp(Math.asin(high / Math.hypot(back, side, high)) + drag.pitch, -0.2, 1.5);
      camOff
        .copy(fwd)
        .multiplyScalar(Math.cos(yaw) * Math.cos(pitch) * dist)
        .addScaledVector(right, Math.sin(yaw) * Math.cos(pitch) * dist)
        .addScaledVector(up, Math.sin(pitch) * dist);
      // Look past the orbiter toward the ground ahead, tipping to nadir as the pass ends.
      look.copy(fwd).multiplyScalar(THREE.MathUtils.lerp(40, 2, k)).addScaledVector(up, THREE.MathUtils.lerp(-17, -30, k));
      craftCam.position.copy(camOff);
      craftCam.up.copy(up);
      craftCam.lookAt(look);
      craftCam.aspect = planetCam.aspect = aspect;
      craftCam.fov = planetCam.fov = THREE.MathUtils.lerp(44, 34, k);
      craftCam.updateProjectionMatrix();
      planetCam.updateProjectionMatrix();
      planetCam.position.copy(pos).addScaledVector(camOff, 0.001);
      planetCam.quaternion.copy(craftCam.quaternion);
      uniforms.uCamPos.value.copy(planetCam.position);

      // Scan fan: apex at the telescope, base across the context swath at nadir.
      const gx = tmp.copy(up).multiplyScalar(R_MARS + 0.5);
      fanPos.set([pos.x, pos.y, pos.z, gx.x + right.x * SWATH_WIDE, gx.y + right.y * SWATH_WIDE, gx.z + right.z * SWATH_WIDE, gx.x - right.x * SWATH_WIDE, gx.y - right.y * SWATH_WIDE, gx.z - right.z * SWATH_WIDE]);
      fanGeo.attributes.position.needsUpdate = true;
    },
  };
  return orbit;
}
