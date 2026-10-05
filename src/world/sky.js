// Sky dome: horizon/zenith gradient, sun, drifting procedural clouds, and a night sky with stars and
// city glow. The same shader (sun disc off) is rendered into the environment map for reflections.
import * as THREE from 'three/webgpu';

export const SKY = {
  zenith: new THREE.Color().setRGB(0.17, 0.33, 0.62),
  horizon: new THREE.Color().setRGB(0.68, 0.76, 0.85),
  ground: new THREE.Color().setRGB(0.3, 0.28, 0.25),
  nightZenith: new THREE.Color().setRGB(0.004, 0.006, 0.016),
  nightHorizon: new THREE.Color().setRGB(0.05, 0.04, 0.045), // sodium-and-LED glow over the city
};

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = vec4(p.xy, p.w * 0.999999, p.w); // just inside the far plane
}`;

const FRAG = /* glsl */ `
uniform vec3 uSunDir, uZenith, uHorizon, uGround, uNightZenith, uNightHorizon;
uniform float uNight, uTime, uSunDisc, uCloudCover;
varying vec3 vDir;

float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + vec2(17.1, 9.3); a *= 0.5; }
  return s;
}

void main() {
  vec3 d = normalize(vDir);
  float h = max(d.y, 0.0);
  float sd = max(dot(d, uSunDir), 0.0);

  // day
  vec3 day = mix(uHorizon, uZenith, pow(h, 0.5));
  day += vec3(1.0, 0.82, 0.6) * (pow(sd, 12.0) * 0.18 + pow(sd, 180.0) * 0.5);
  day += vec3(1.0, 0.95, 0.85) * smoothstep(0.9994, 0.9998, sd) * 30.0 * uSunDisc;

  // clouds on a plane overhead; two octaves of structure, lit from the sun side
  if (d.y > 0.0) {
    vec2 p = d.xz / (d.y + 0.12) * 0.9 + vec2(uTime * 0.006, uTime * 0.002);
    float c = fbm(p);
    float cover = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.22, c);
    float lit = fbm(p + uSunDir.xz * 0.12);
    vec3 cloud = mix(vec3(0.95, 0.96, 0.98), vec3(0.55, 0.6, 0.68), smoothstep(0.35, 0.85, lit * cover + c * 0.4));
    cloud += vec3(1.0, 0.9, 0.75) * pow(sd, 6.0) * 0.25;
    cover *= smoothstep(0.0, 0.16, d.y);
    day = mix(day, cloud, cover * 0.92);
  }

  // night: dark gradient, glow near the horizon, stars
  vec3 night = mix(uNightHorizon, uNightZenith, pow(h, 0.35));
  vec2 sp = d.xz / (abs(d.y) + 0.35) * 220.0;
  float star = step(0.9975, hash(floor(sp))) * smoothstep(0.1, 0.5, d.y);
  night += vec3(0.8, 0.85, 1.0) * star * 0.5 * uSunDisc;

  vec3 col = mix(day, night, uNight);
  // below the horizon: ground bounce colour (matters for the environment map)
  col = mix(col, uGround * mix(1.0, 0.06, uNight), 1.0 - smoothstep(-0.06, 0.0, d.y));
  gl_FragColor = vec4(col, 1.0);
}`;

// `ground`: colour below the horizon. The visible sky uses the horizon haze; the environment map a ground bounce.
export function createSky({ sunDisc = 1, ground = SKY.horizon } = {}) {
  const uniforms = {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uZenith: { value: SKY.zenith }, uHorizon: { value: SKY.horizon }, uGround: { value: ground },
    uNightZenith: { value: SKY.nightZenith }, uNightHorizon: { value: SKY.nightHorizon },
    uNight: { value: 0 }, uTime: { value: 0 }, uSunDisc: { value: sunDisc }, uCloudCover: { value: 0.52 },
  };
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 48, 24),
    new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, side: THREE.BackSide, depthWrite: false, fog: false }),
  );
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.name = 'sky';
  return mesh;
}
