// Sky dome for the environment map: horizon/zenith gradient, a glow round the sun, drifting procedural clouds,
// and a dark night sky with the glow of the city at the horizon. It is not seen in the picture (the atmosphere
// draws the sky there): it is rendered into the environment map that lights the shaded sides and fills the glass.
import * as THREE from 'three/webgpu';
import { Fn, uniform, float, vec2, vec3, mix, max, pow, dot, normalize, smoothstep, positionLocal } from 'three/tsl';
import { vnoise } from './materials.js';

export const SKY = {
  zenith: new THREE.Color().setRGB(0.17, 0.33, 0.62),
  horizon: new THREE.Color().setRGB(0.68, 0.76, 0.85),
  ground: new THREE.Color().setRGB(0.3, 0.28, 0.25),
  nightZenith: new THREE.Color().setRGB(0.004, 0.006, 0.016),
  nightHorizon: new THREE.Color().setRGB(0.05, 0.04, 0.045), // sodium-and-LED glow over the city
};

const v3 = (c) => vec3(c.r, c.g, c.b);

const fbm = (p0) => {
  let s = float(0), a = 0.5, p = p0;
  for (let i = 0; i < 5; i++) { s = s.add(vnoise(p).mul(a)); p = p.mul(2.03).add(vec2(17.1, 9.3)); a *= 0.5; }
  return s;
};

// `ground`: colour below the horizon (a ground bounce). Returns the mesh; mesh.userData holds its uniforms
// uSunDir, uNight (0 day .. 1 night), uTime.
export function createSky({ ground = SKY.ground } = {}) {
  const uSunDir = uniform(new THREE.Vector3(0, 1, 0)), uNight = uniform(0), uTime = uniform(0), uCloudCover = uniform(0.52);
  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
  material.colorNode = Fn(() => {
    const d = normalize(positionLocal).toVar();
    const h = max(d.y, 0), sd = max(dot(d, uSunDir), 0).toVar();

    // day
    const day = mix(v3(SKY.horizon), v3(SKY.zenith), pow(h, 0.5)).toVar();
    day.addAssign(vec3(1, 0.82, 0.6).mul(pow(sd, 12).mul(0.18).add(pow(sd, 180).mul(0.5))));

    // clouds on a plane overhead; two octaves of structure, lit from the sun side
    const p = d.xz.div(d.y.add(0.12)).mul(0.9).add(vec2(uTime.mul(0.006), uTime.mul(0.002))).toVar();
    const c = fbm(p).toVar();
    const cover = smoothstep(uCloudCover.oneMinus(), uCloudCover.oneMinus().add(0.22), c).toVar();
    const lit = fbm(p.add(uSunDir.xz.mul(0.12)));
    const cloud = mix(vec3(0.95, 0.96, 0.98), vec3(0.55, 0.6, 0.68), smoothstep(0.35, 0.85, lit.mul(cover).add(c.mul(0.4)))).add(vec3(1, 0.9, 0.75).mul(pow(sd, 6)).mul(0.25));
    day.assign(mix(day, cloud, cover.mul(smoothstep(0, 0.16, d.y)).mul(0.92).mul(d.y.greaterThan(0).select(1, 0))));

    // night: dark gradient, glow near the horizon
    const night = mix(v3(SKY.nightHorizon), v3(SKY.nightZenith), pow(h, 0.35));
    const col = mix(day, night, uNight);
    // below the horizon: ground bounce colour
    return mix(col, v3(ground).mul(mix(1, 0.06, uNight)), smoothstep(-0.06, 0, d.y).oneMinus());
  })();
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), material);
  mesh.frustumCulled = false;
  mesh.name = 'sky';
  mesh.userData = { uSunDir, uNight, uTime };
  return mesh;
}
