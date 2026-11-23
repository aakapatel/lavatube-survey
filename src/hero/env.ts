// Light and atmosphere of the surface scene, shared by every material.
//
// One set of uniforms: the sun (direction from meta.json, so the baked terrain
// shadows agree with it), a dusty sky and distance haze.

import * as THREE from 'three';

export type Env = {
  uniforms: {
    uSunDir: { value: THREE.Vector3 };
    uSunCol: { value: THREE.Color };
    uSkyZenith: { value: THREE.Color };
    uSkyHorizon: { value: THREE.Color };
    uHaze: { value: number };
    uTime: { value: number };
  };
};

export function createEnv(sun: [number, number, number]): Env {
  return {
    uniforms: {
      uSunDir: { value: new THREE.Vector3(sun[0], sun[1], sun[2]).normalize() },
      uSunCol: { value: new THREE.Color(4.6, 3.75, 2.85) },
      uSkyZenith: { value: new THREE.Color(0.2, 0.135, 0.1) },
      uSkyHorizon: { value: new THREE.Color(0.62, 0.41, 0.26) },
      uHaze: { value: 0.00021 },
      uTime: { value: 0 },
    },
  };
}

/** GLSL shared by the surface materials: sky colour along a direction and haze. */
export const ENV_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform float uHaze;

vec3 skyColor(vec3 d) {
  float h = clamp(d.y, -0.08, 1.0);
  float t = pow(1.0 - max(h, 0.0), 3.2);
  vec3 c = mix(uSkyZenith, uSkyHorizon, t);
  // Forward scattering by dust: a broad warm brightening toward the sun and a
  // small cool core close to the disc, as in rover images of the Martian sky.
  float mu = max(dot(d, uSunDir), 0.0);
  c += uSkyHorizon * 0.55 * pow(mu, 6.0);
  c += vec3(0.55, 0.62, 0.74) * 0.9 * pow(mu, 90.0);
  // Below the horizon the dome darkens to the ground haze colour.
  c = mix(c, uSkyHorizon * 0.72, smoothstep(0.0, -0.08, d.y));
  return c;
}

vec3 applyHaze(vec3 col, vec3 worldPos, vec3 camPos) {
  vec3 v = worldPos - camPos;
  float dist = length(v);
  vec3 dir = v / max(dist, 1e-3);
  // Dust is denser near the ground; integrate an exponential profile along the ray.
  float hCam = max(camPos.y, 0.0);
  float k = 1.0 / 900.0;
  float od = uHaze * dist * exp(-hCam * k) * (abs(dir.y) > 1e-3 ? (1.0 - exp(-dir.y * dist * k)) / (dir.y * dist * k) : 1.0);
  float f = 1.0 - exp(-od);
  return mix(col, skyColor(vec3(dir.x, max(dir.y, 0.0) * 0.25 + 0.02, dir.z)), clamp(f, 0.0, 1.0));
}
`;
