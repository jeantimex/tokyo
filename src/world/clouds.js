// Volumetric clouds, after @takram/three-clouds (which has no node version): the same weather map, the same
// shape and detail noise, the same three layers and the same lighting, written as nodes. A ray is marched from
// the eye through the layers; at every step the weather map says where there is cloud, the noise wears its
// edges, and a short march towards the sun plus a shadow map (the clouds seen from the sun) say how much
// light gets there. The result is laid over the picture by the air (atmosphere.js), which also takes the
// clouds' shadow on the ground from the shadow map.
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, Break, Continue, uniform, texture, texture3D, float, int, vec2, vec3, vec4, mix, min, max, clamp, dot, normalize, length, pow, exp,
  sqrt, log2, abs, sign, select, smoothstep, uv, screenCoordinate, getViewPosition,
} from 'three/tsl';
import { getAtmosphereContext, getSplitScalarIlluminance, getIndirectLuminanceToPoint } from '@takram/three-atmosphere/webgpu';

const ASSETS = 'assets/takram'; // cloud shape and weather textures and blue noise, as shipped with the packages
const FADE = 500;                // metres beyond the area over which the clouds thin out to nothing
const SHADOW_REACH = 12000;      // metres around the focus that the shadow map covers
const RESOLUTION = 0.5;          // the clouds' picture, as a share of the screen

// what the quality presets change (three-clouds: qualityPresets.ts)
const QUALITY = {
  low: { iterations: 200, minStep: 100, maxDistance: 1e5, minDensity: 1e-4, minTransmittance: 1e-1, toSun: 1, toGround: 0, detail: 0, turbulence: 0, shadowSize: 256, shadowIterations: 25 },
  medium: { iterations: 500, minStep: 50, maxDistance: 2e5, minDensity: 1e-4, minTransmittance: 1e-2, toSun: 2, toGround: 1, detail: 1, turbulence: 0, shadowSize: 256, shadowIterations: 50 },
  high: { iterations: 500, minStep: 50, maxDistance: 2e5, minDensity: 1e-5, minTransmittance: 1e-2, toSun: 2, toGround: 3, detail: 1, turbulence: 1, shadowSize: 512, shadowIterations: 50 },
  ultra: { iterations: 500, minStep: 10, maxDistance: 2e5, minDensity: 1e-5, minTransmittance: 1e-2, toSun: 2, toGround: 3, detail: 1, turbulence: 1, shadowSize: 1024, shadowIterations: 50 },
};

const volume = (url, size) => {
  const t = new THREE.Data3DTexture(new Uint8Array(size[0] * size[1] * size[2]), ...size);
  t.format = THREE.RedFormat; t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  fetch(url).then((r) => r.arrayBuffer()).then((b) => { t.image.data = new Uint8Array(b); t.needsUpdate = true; }).catch((e) => console.error(e));
  return t;
};
const tiled = (url) => new THREE.TextureLoader().load(url, (t) => {
  t.minFilter = THREE.LinearMipMapLinearFilter; t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
});

const remapClamped = (x, a, b) => clamp(x.sub(a).div(b.sub(a)), 0, 1);
const _quad = new THREE.QuadMesh(), _size = new THREE.Vector2(), _v = new THREE.Vector3(), _x = new THREE.Vector3(), _y = new THREE.Vector3();
let _state;

export class Clouds extends THREE.TempNode {
  static get type() { return 'CloudsNode'; }

  // depth: the texture node of the scene's depth; atmosphere: the library's context; worldToECEF: where the scene sits on the globe;
  // bounds: { minX, maxX, minZ, maxZ } of the area, to which the clouds can be kept.
  constructor(camera, depth, atmosphere, worldToECEF, bounds) {
    super('vec4');
    this.bottom = float(atmosphere.parameters.bottomRadius); // (metres)
    this.altitude = atmosphere.altitudeCorrectionECEF;
    this.sunECEF = atmosphere.sunDirectionECEF;
    this.camera = camera;
    this.depth = depth;
    this.updateBeforeType = THREE.NodeUpdateType.FRAME;
    this.enabled = false;
    this.on = uniform(0);

    // ---- what the user sets
    this.coverage = uniform(0.25);
    this.base = 450; // metres: the foot of the low clouds (the library's default is 750)
    this.velocity = new THREE.Vector2(0.001, 0); // of the weather map, per second
    this.cityRect = uniform(new THREE.Vector4(bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ));
    this.cityFade = uniform(FADE);
    this.opts = { iterations: uniform(500), minStep: uniform(50), maxDistance: uniform(2e5), minDensity: uniform(1e-5), minTransmittance: uniform(1e-2), toSun: uniform(2), toGround: uniform(3), detail: uniform(1), turbulence: uniform(1), shadowIterations: uniform(50) };
    this.shadowTexel = uniform(1 / 512);
    this.quality = 'high';

    // ---- the layers: two of low cloud (the second starts 250 m above the first), one of thin high cloud
    this.minLayer = uniform(new THREE.Vector3()); this.maxLayer = uniform(new THREE.Vector3());
    this.layerGap = uniform(new THREE.Vector2());      // between the low clouds and the high ones there is nothing
    this.minHeight = uniform(0); this.maxHeight = uniform(0); this.shadowTop = uniform(0); this.shadowBottom = uniform(0);
    this.setLayers();

    // ---- textures
    this.weather = texture(tiled(`${ASSETS}/local_weather.png`));
    this.turbulence = texture(tiled(`${ASSETS}/turbulence.png`));
    this.shape = texture3D(volume(`${ASSETS}/shape.bin`, [128, 128, 128]));
    this.detail = texture3D(volume(`${ASSETS}/shape_detail.bin`, [32, 32, 32]));
    const stbn = volume(`${ASSETS}/stbn.bin`, [128, 128, 64]);
    stbn.minFilter = stbn.magFilter = THREE.NearestFilter;
    this.stbn = texture3D(stbn);
    this.weatherOffset = uniform(new THREE.Vector2());

    // ---- frames of reference
    this.worldToECEF = uniform(worldToECEF.clone());
    this.ecefToWorld = uniform(worldToECEF.clone().invert());
    this.inverseProjection = uniform(camera.projectionMatrixInverse);
    this.cameraWorld = uniform(camera.matrixWorld);

    // ---- targets
    this.target = new THREE.RenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType });
    this.shadowTarget = new THREE.RenderTarget(512, 512, { depthBuffer: false, type: THREE.HalfFloatType });
    this.result = texture(this.target.texture);
    this.shadowMap = texture(this.shadowTarget.texture);
    // the shadow map looks along the sun's rays: its centre, and its two axes divided by its reach (world space)
    this.shadowCentre = uniform(new THREE.Vector3()); this.shadowX = uniform(new THREE.Vector3(1, 0, 0)); this.shadowY = uniform(new THREE.Vector3(0, 0, 1));
    this.sunWorld = uniform(new THREE.Vector3(0, 1, 0));
    this.frame = 0;
  }

  get quality() { return this._quality; }
  set quality(name) {
    const q = QUALITY[name] ?? QUALITY.high;
    this._quality = name;
    for (const k in this.opts) this.opts[k].value = q[k];
    this.shadowSize = q.shadowSize;
    this.shadowTexel.value = 1 / q.shadowSize;
  }
  get overCity() { return this.cityFade.value < 1e6; }
  set overCity(v) { this.cityFade.value = v ? FADE : 1e9; }

  setLayers() {
    const b = this.base;
    this.minLayer.value.set(b, b + 250, 7500); this.maxLayer.value.set(b + 650, b + 1450, 8000);
    this.layerGap.value.set(b + 1450, 7500);
    this.minHeight.value = b; this.maxHeight.value = 8000; this.shadowBottom.value = b; this.shadowTop.value = b + 1450;
  }

  // dt: seconds; focus: the point looked at; sun: the direction to the sun (world).
  update(dt, focus, sun) {
    this.on.value = this.enabled ? 1 : 0;
    if (!this.enabled) return;
    this.setLayers();
    this.weatherOffset.value.addScaledVector(this.velocity, dt);
    this.sunWorld.value.copy(sun);
    _x.crossVectors(Math.abs(sun.y) > 0.99 ? _v.set(1, 0, 0) : _v.set(0, 1, 0), sun).normalize();
    _y.crossVectors(sun, _x).normalize();
    // (the map moves a whole texel at a time)
    const texel = (2 * SHADOW_REACH) / this.shadowSize, cx = Math.round(focus.dot(_x) / texel) * texel, cy = Math.round(focus.dot(_y) / texel) * texel;
    this.shadowCentre.value.copy(_x).multiplyScalar(cx).addScaledVector(_y, cy);
    this.shadowX.value.copy(_x); this.shadowY.value.copy(_y);
  }

  updateBefore({ renderer }) {
    if (!this.enabled || !this.cloudMaterial) return;
    _state = THREE.RendererUtils.resetRendererState(renderer, _state);
    const size = renderer.getDrawingBufferSize(_size), w = Math.max(1, Math.round(size.width * RESOLUTION)), h = Math.max(1, Math.round(size.height * RESOLUTION));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
    if (this.shadowTarget.width !== this.shadowSize) this.shadowTarget.setSize(this.shadowSize, this.shadowSize);
    // (the clouds drift slowly: their shadow map is redone every third frame)
    if (this.frame++ % 3 === 0) {
      _quad.material = this.shadowMaterial;
      renderer.setRenderTarget(this.shadowTarget);
      _quad.render(renderer);
    }
    _quad.material = this.cloudMaterial;
    renderer.setRenderTarget(this.target);
    _quad.render(renderer);
    THREE.RendererUtils.restoreRendererState(renderer, _state);
  }

  // ------------------------------------------------------------------ the medium
  // Where a point of the globe lies in the weather map (a cube laid round the sphere).
  globeUv(position) {
    const n = normalize(position).toVar(), f = abs(n).toVar(), c = n.div(max(f.x, max(f.y, f.z))).toVar();
    const m = select(f.y.greaterThan(f.x).and(f.y.greaterThan(f.z)), select(c.y.greaterThan(0), vec2(n.x.negate(), n.z), n.xz),
      select(f.x.greaterThan(f.y).and(f.x.greaterThan(f.z)), select(c.x.greaterThan(0), n.yz, vec2(n.y.negate(), n.z)), select(c.z.greaterThan(0), n.xy, vec2(n.x, n.y.negate())))).toVar();
    const m2 = m.mul(m).toVar(), q = dot(m2, vec2(-2, 2)).sub(3).toVar();
    const x = sqrt(max(m2.x.sub(m2.y).add(1.5).sub(sqrt(max(m2.x.mul(-24).add(q.mul(q)), 0)).mul(0.5)), 0)).mul(select(m.x.greaterThan(0), 1, -1)).toVar();
    return vec2(x, sqrt(float(6).div(x.mul(x).oneMinus().add(2))).mul(m.y)).mul(0.5).add(0.5);
  }

  heightFraction(height) { return remapClamped(vec3(height), this.minLayer, this.maxLayer); }

  // How much cloud the weather map puts at a point, for each layer (before the noise wears it down).
  // shadow: for the shadow map, which only the low clouds throw.
  weatherAt(position, at, height, mip, shadow = false) {
    const hf = this.heightFraction(height).toVar();
    const local = this.weather.sample(at.mul(100).add(this.weatherOffset)).level(mip).rgb.toVar();
    // clouds over the area only: the map is faded out beyond the area's rectangle
    const w = this.ecefToWorld.mul(vec4(position.sub(this.altitude), 1)).xyz;
    const beyond = max(this.cityRect.xy.sub(w.xz), w.xz.sub(this.cityRect.zw));
    local.mulAssign(smoothstep(0, this.cityFade, max(beyond.x, beyond.y)).oneMinus());
    if (shadow) local.mulAssign(vec3(1, 1, 0));
    // (a semi-circle rounds the clouds towards the top)
    const x = clamp(pow(hf, vec3(0.35)).mul(2).sub(1), -1, 1), heightScale = x.mul(x).oneMinus();
    const factor = this.coverage.mul(heightScale).oneMinus().toVar(), width = vec3(0.6, 0.6, 0.5);
    return remapClamped(mix(local, vec3(1), width), factor, factor.add(width));
  }

  // The medium at a point: vec3(scattering, extinction, how high in its layer the cloud here is).
  mediaAt(weather, position, at, height, mip, jitter) {
    const density = vec3(weather).toVar(), hf = this.heightFraction(height).toVar();
    const up = normalize(position), evolution = up.mul(length(this.weatherOffset)).mul(-2e4);
    const turbulence = vec3(0).toVar();
    If(this.opts.turbulence.greaterThan(0.5), () => {
      turbulence.assign(this.turbulence.sample(at.mul(100 * 20)).level(0).rgb.mul(2).sub(1).mul(350).mul(dot(density, remapClamped(hf, vec3(0.3), vec3(0)))));
    });
    const shape = this.shape.sample(position.add(evolution).add(turbulence).mul(0.0003)).level(0).r;
    density.assign(remapClamped(density, vec3(shape.oneMinus()).mul(vec3(1, 1, 0.4)), vec3(1)));
    If(this.opts.detail.greaterThan(0.5).and(mip.mul(0.5).add(jitter.sub(0.5).mul(0.5)).lessThan(0.5)), () => {
      const detail = this.detail.sample(position.add(turbulence).mul(0.006)).level(0).r.toVar();
      // fluffy at the top and wispy at the bottom
      const modifier = mix(vec3(pow(detail, 6)), vec3(detail.oneMinus()), remapClamped(hf, vec3(0.2), vec3(0.4))).mul(vec3(1, 1, 0));
      density.assign(remapClamped(density.mul(2), modifier.mul(0.5), vec3(1)));
    });
    density.assign(clamp(density.mul(vec3(0.2, 0.2, 0.003)).mul(hf.mul(0.75).add(0.25)), 0, 1));
    const sum = density.x.add(density.y).add(density.z).toVar();
    return vec3(sum, sum, dot(hf.mul(0.5).add(0.5), density.div(max(sum, 1e-7))));
  }

  inGap(height) { return height.greaterThan(this.layerGap.x).and(height.lessThan(this.layerGap.y)); }

  // The optical depth along a short march from a point: vec2(depth, how far the march went).
  opticalDepth(origin, direction, count, mip, jitter) {
    const result = vec2(0.5, 0).toVar(); // (no steps: a fudge for the mean depth, as the library has it)
    const n = int(max(0, mix(count.add(1), float(1), mip).sub(jitter))).toVar();
    If(n.greaterThan(0), () => {
      const step = float(100).div(float(n)).toVar(), next = step.mul(jitter).toVar(), depth = float(0).toVar(), far = float(0).toVar();
      Loop({ start: int(0), end: n }, () => {
        far.assign(next);
        const p = origin.add(direction.mul(far)).toVar(), at = this.globeUv(p).toVar(), height = length(p).sub(this.bottom).toVar();
        const media = this.mediaAt(this.weatherAt(p, at, height, mip), p, at, height, mip, jitter);
        depth.addAssign(media.y.mul(step));
        next.addAssign(step);
        step.mulAssign(2);
      });
      result.assign(vec2(depth, far));
    });
    return result;
  }

  raySphere(origin, direction, radius, second) {
    const b = dot(direction, origin).mul(2), c = dot(origin, origin).sub(radius.mul(radius)), d = b.mul(b).sub(c.mul(4));
    return select(d.lessThan(0), float(-1), (second ? b.negate().add(sqrt(max(d, 0))) : b.negate().sub(sqrt(max(d, 0)))).mul(0.5));
  }

  // The optical depth of the clouds between a point (on the globe, metres) and the sun, from the shadow map.
  // offset: the part of the way that has been marched already.
  shadowDepth(position, offset = float(0)) {
    const toTop = this.raySphere(position, this.sunECEF, this.bottom.add(this.shadowTop), true).toVar();
    const w = this.ecefToWorld.mul(vec4(position.sub(this.altitude), 1)).xyz.sub(this.shadowCentre).toVar();
    const at = vec2(dot(w, this.shadowX), dot(w, this.shadowY)).div(SHADOW_REACH).mul(0.5).add(0.5).toVar();
    // r: where the cloud begins (km from the top), g: its mean extinction, b: its whole optical depth, a: the tail
    const s = this.shadowMap.sample(at).level(0);
    const depth = min(s.b.add(s.a), s.g.mul(max(0, toTop.sub(offset).sub(s.r.mul(1000)))));
    const inside = toTop.greaterThan(0).and(at.x.greaterThan(0)).and(at.x.lessThan(1)).and(at.y.greaterThan(0)).and(at.y.lessThan(1)).and(this.sunWorld.y.greaterThan(0.03));
    return select(inside, depth, 0).mul(this.on);
  }

  // What is left of the sun's light on a point of the scene (world space) under the clouds.
  sunTransmittance(world) {
    const position = this.worldToECEF.mul(vec4(world, 1)).xyz.add(this.altitude);
    const toTop = this.raySphere(position, this.sunECEF, this.bottom.add(this.shadowTop), true);
    const w = world.sub(this.shadowCentre), at = vec2(dot(w, this.shadowX), dot(w, this.shadowY)).div(SHADOW_REACH).mul(0.5).add(0.5).toVar();
    // (four taps a texel apart: the map is coarse; without the tail, which only brings aliasing here)
    const sum = float(0).toVar(), texel = this.shadowTexel;
    for (const [x, y] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) {
      const s = this.shadowMap.sample(at.add(vec2(x, y).mul(texel))).level(0);
      sum.addAssign(min(s.b, s.g.mul(max(0, toTop.sub(s.r.mul(1000))))));
    }
    const inside = toTop.greaterThan(0).and(at.x.greaterThan(0)).and(at.x.lessThan(1)).and(at.y.greaterThan(0)).and(at.y.lessThan(1)).and(this.sunWorld.y.greaterThan(0.03));
    return exp(select(inside, sum.mul(0.25), 0).mul(this.on).negate());
  }

  setup(builder) {
    const atmosphere = getAtmosphereContext(builder);
    const { worldToUnit } = atmosphere.parametersNode;
    const { opts: q, bottom, sunECEF } = this;
    const material = (name, node) => { const m = new THREE.NodeMaterial(); m.name = name; m.fragmentNode = node.context(builder.getSharedContext()); return m; };
    const noise = (frame) => this.stbn.sample(vec3(screenCoordinate.xy.div(128), float(frame).add(0.5).div(64))).level(0).r;

    const phase = (cosTheta, attenuation) => {
      const g = vec2(0.7, -0.2).mul(attenuation), g2 = g.mul(g);
      const hg = g2.oneMinus().div(max(vec2(1e-7), pow(g2.add(1).sub(g.mul(cosTheta).mul(2)), vec2(1.5)))).mul(1 / (4 * Math.PI));
      return dot(hg, vec2(0.5));
    };
    // light scattered many times inside the cloud (Wrenninge's octaves)
    const multipleScattering = (depth, cosTheta) => {
      let sum = float(0);
      for (let i = 0, k = 1; i < 8; i++, k *= 0.5) sum = sum.add(exp(depth.mul(-k)).mul(k).mul(phase(cosTheta, k)));
      return sum;
    };

    // ---- the clouds as the eye sees them: colour times alpha, and alpha
    this.cloudMaterial = material('Clouds', Fn(() => {
      const at = uv(), depth = this.depth.sample(at).r.toVar();
      const view = getViewPosition(at, float(0.5), this.inverseProjection).toVar();
      const ray = normalize(this.worldToECEF.mul(this.cameraWorld.mul(vec4(view, 0))).xyz).toVar();
      const eye = atmosphere.cameraPositionECEF.add(this.altitude).toVar(), eyeHeight = length(eye).sub(bottom).toVar();
      const cosTheta = dot(sunECEF, ray).toVar(), jitter = noise(0).toVar();
      const out = vec4(0).toVar();

      // where the ray is inside the layers
      const r = length(eye), mu = dot(eye, ray).div(r);
      const ground = mu.lessThan(0).and(r.mul(r).mul(mu.mul(mu).sub(1)).add(bottom.mul(bottom)).greaterThanEqual(0)).toVar();
      const lowIn = this.raySphere(eye, ray, bottom.add(this.minHeight), false), lowOut = this.raySphere(eye, ray, bottom.add(this.minHeight), true);
      const highIn = this.raySphere(eye, ray, bottom.add(this.maxHeight), false), highOut = this.raySphere(eye, ray, bottom.add(this.maxHeight), true);
      const range = vec2(0).toVar();
      If(eyeHeight.lessThan(this.minHeight), () => {
        range.assign(select(ground, vec2(-1), vec2(lowOut, min(highOut, q.maxDistance))));
      }).ElseIf(eyeHeight.lessThan(this.maxHeight), () => {
        range.assign(vec2(0.1, select(ground, lowIn, highOut)));
      }).Else(() => {
        range.assign(vec2(highIn, select(ground, lowIn, highOut)));
      });
      // (nothing behind what stands in the scene)
      If(depth.lessThan(1), () => { range.y.assign(min(range.y, length(getViewPosition(at, depth, this.inverseProjection)))); });

      If(range.x.greaterThanEqual(0).and(range.y.greaterThan(range.x)), () => {
        const origin = eye.add(ray.mul(range.x)).toVar(), up = normalize(origin).toVar();
        // the light of the sun and of the sky at the foot and at the top of the clouds, and on the ground
        const low = getSplitScalarIlluminance(up.mul(bottom.add(this.minHeight)).mul(worldToUnit), sunECEF).toConst();
        const high = getSplitScalarIlluminance(up.mul(bottom.add(this.maxHeight)).mul(worldToUnit), sunECEF).toConst();
        const floor = getSplitScalarIlluminance(eye.mul(worldToUnit), sunECEF).toConst();
        const lowSun = low.get('direct').toVar(), lowSky = low.get('indirect').toVar(), highSun = high.get('direct').toVar(), highSky = high.get('indirect').toVar();
        const groundLight = floor.get('indirect').add(floor.get('direct').mul(this.coverage.oneMinus())).mul(0.3 / Math.PI).toVar();

        const radiance = vec3(0).toVar(), through = float(1).toVar(), weighted = float(0).toVar(), throughSum = float(0).toVar();
        const far = range.y.sub(range.x).toVar(), step = q.minStep.add(range.x.mul(0.01)).toVar(), distance = step.mul(jitter).mul(2).toVar();
        Loop({ start: int(0), end: int(q.iterations) }, () => {
          If(distance.greaterThan(far), () => { Break(); });
          const p = origin.add(ray.mul(distance)).toVar(), height = length(p).sub(bottom).toVar();
          const mip = log2(max(1, distance.mul(1e-5).add(1))).toVar();
          If(this.inGap(height), () => { step.mulAssign(1.01); distance.addAssign(mix(step, float(1000), min(1, mip))); Continue(); });
          const where = this.globeUv(p).toVar(), weather = this.weatherAt(p, where, height, mip).toVar();
          If(max(weather.x, max(weather.y, weather.z)).lessThanEqual(q.minDensity), () => { step.mulAssign(1.01); distance.addAssign(mix(step, float(1000), min(1, mip))); Continue(); });
          const media = this.mediaAt(weather, p, where, height, mip, jitter).toVar();
          If(media.y.greaterThan(q.minDensity), () => {
            const k = remapClamped(height, this.minHeight, this.maxHeight);
            const sun = mix(lowSun, highSun, k), sky = mix(lowSky, highSky, k), normal = normalize(p).toVar();
            // towards the sun: a short march for the fine shapes, the shadow map for the rest of the way
            const marched = this.opticalDepth(p, sunECEF, q.toSun, mip, jitter).toVar(), toSun = marched.x.toVar();
            If(height.lessThan(this.shadowTop), () => { toSun.addAssign(this.shadowDepth(p, marched.y)); });
            const light = sun.mul(multipleScattering(toSun, cosTheta)).toVar();
            // (what the ground throws back up, under the cloud)
            If(q.toGround.greaterThan(0.5).and(height.lessThan(this.shadowTop)).and(mip.lessThan(0.5)), () => {
              light.addAssign(groundLight.mul(exp(this.opticalDepth(p, normal.negate(), q.toGround, mip, jitter).x.negate())).mul(1 / (4 * Math.PI)));
            });
            light.addAssign(sky.mul(media.z).mul(1 / (4 * Math.PI)));
            light.mulAssign(media.x);
            light.mulAssign(exp(media.y.mul(-150)).mul(0.8).oneMinus()); // (the dark edges of thin cloud)
            // (the scattered light summed over the step, with what the step itself takes away: Frostbite's)
            const left = exp(media.y.mul(step).negate());
            radiance.addAssign(light.sub(light.mul(left)).div(max(media.y, 1e-7)).mul(through));
            through.mulAssign(left);
            weighted.addAssign(distance.mul(through)); throughSum.addAssign(through);
          });
          If(through.lessThanEqual(q.minTransmittance), () => { Break(); });
          step.mulAssign(1.01);
          distance.addAssign(step);
        });

        If(throughSum.greaterThan(0), () => {
          const alpha = remapClamped(through, float(1), q.minTransmittance).toVar();
          // the air between the eye and the cloud
          const front = eye.add(ray.mul(range.x.add(weighted.div(throughSum))));
          const air = getIndirectLuminanceToPoint(eye.mul(worldToUnit), front.mul(worldToUnit), vec2(0), sunECEF).toConst();
          out.assign(vec4(radiance.mul(air.get('transmittance')).add(air.get('luminance').mul(alpha).mul(this.hazeScale ?? 1)), alpha));
        });
      });
      return out;
    })());

    // ---- the clouds seen from the sun: where they begin, how thick they are (see shadowDepth)
    this.shadowMaterial = material('Clouds.shadow', Fn(() => {
      const at = uv().mul(2).sub(1).toVar();
      const world = this.shadowCentre.add(this.shadowX.mul(at.x.mul(SHADOW_REACH))).add(this.shadowY.mul(at.y.mul(SHADOW_REACH))).add(this.sunWorld.mul(1e5));
      const start = this.worldToECEF.mul(vec4(world, 1)).xyz.add(this.altitude).toVar(), ray = sunECEF.negate().toVar();
      const near = max(0, this.raySphere(start, ray, bottom.add(this.shadowTop), false)).toVar();
      const exit = this.raySphere(start, ray, bottom.add(this.shadowBottom), false);
      const far = select(exit.lessThan(0), float(1e6), exit).sub(near).toVar(), origin = start.add(ray.mul(near)).toVar();
      const step = clamp(far.div(q.shadowIterations), 100, 1000).toVar(), distance = step.mul(0.5).toVar();
      const sum = float(0).toVar(), depth = float(0).toVar(), tail = float(0).toVar(), through = float(1).toVar(), weighted = float(0).toVar(), throughSum = float(0).toVar(), count = float(0).toVar();
      Loop({ start: int(0), end: int(q.shadowIterations) }, () => {
        If(distance.greaterThan(far), () => { Break(); });
        const p = origin.add(ray.mul(distance)).toVar(), height = length(p).sub(bottom).toVar(), where = this.globeUv(p).toVar();
        const weather = this.weatherAt(p, where, height, float(0), true).toVar();
        If(max(weather.x, weather.y).greaterThan(q.minDensity), () => {
          const media = this.mediaAt(weather, p, where, height, float(0), float(0.5)).toVar();
          If(media.y.greaterThan(q.minDensity), () => {
            sum.addAssign(media.y); depth.addAssign(media.y.mul(step));
            through.mulAssign(exp(media.y.mul(step).negate()));
            weighted.addAssign(distance.mul(through)); throughSum.addAssign(through); count.addAssign(1);
          });
        });
        If(through.lessThanEqual(1e-4), () => { tail.assign(min(step.mul(2).mul(exp(count.oneMinus())), step.mul(0.5))); Break(); });
        distance.addAssign(step);
      });
      return select(count.lessThan(0.5), vec4(far.mul(1e-3), 0, 0, 0), vec4(min(weighted.div(max(throughSum, 1e-7)), far).mul(1e-3), sum.div(max(count, 1)), depth, tail));
    })());

    return this.result;
  }

  dispose() { this.target.dispose(); this.shadowTarget.dispose(); }
}
