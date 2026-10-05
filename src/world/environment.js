// Sky, sun, image-based ambient light and the day/night blend. (No fog: the whole area is loaded and seen clearly.)
import * as THREE from 'three/webgpu';
import { createSky } from './sky.js';
import { shared } from './materials.js';

const SHADOW_SIZE = 4096;

// The renderer draws every shadow caster with one material, on which it sets each caster's alphaTest in turn;
// three counts that as a change of the material whenever a cut-out follows a solid, and then checks every
// caster's shader again, every frame. Each caster keeps its own shader as it is: nothing has changed.
const alphaTest = Object.getOwnPropertyDescriptor(THREE.Material.prototype, 'alphaTest');
Object.defineProperty(THREE.NodeMaterial.prototype, 'alphaTest', {
  get() { return this._alphaTest; },
  set(v) { if (this.isShadowPassMaterial) this._alphaTest = v; else alphaTest.set.call(this, v); },
});

const DAY = { hemi: 0.55, sun: 3.4, sunColor: new THREE.Color(0xfff0dc), env: 1.0, exposure: 0.82, bloom: 0.12 };
const NIGHT = {
  hemi: 0.42, sun: 0.32, sunColor: new THREE.Color(0x9fb4e0),
  env: 1.0, exposure: 1.15, bloom: 0.45,
};

const SUNSET = new THREE.Color(0xff9a52);
const MOON_STAND_IN = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 40), THREE.MathUtils.degToRad(205));

export class Environment {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.night = 0;  // how far the city's lights are on: they come on while it is still light
    this.dark = 0;   // how dark it is: this follows the sun all the way down through twilight
    this.daylight = 1; this.moonlight = 0; this.warmth = 0; this.elevation = 40;
    this.time = 0;
    this.sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 40), THREE.MathUtils.degToRad(205));

    // Environment map: a sky of its own (sky.js), which lights the shaded sides and stands in the glass.
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envSky = createSky();
    this.envSky.userData.uSunDir.value.copy(this.sunDir);
    this.envScene.add(this.envSky);
    this.bakeEnvironment();
    // (pipelines are compiled in the background: the first bake may come out black, so it is done again once the
    // sky and the blur passes have theirs)
    this.rebake = [0.3, 1.5, 4];

    this.hemi = new THREE.HemisphereLight(0xfff4e6, 0x8a8172);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight();
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
    const c = this.sun.shadow.camera;
    c.near = 10; c.far = 4000;
    this.shadowExtent = 0;
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.5;
    scene.add(this.sun, this.sun.target);

    this.apply();
  }

  // Renders the environment map for the sky as dark as it now is (again whenever that has changed a little).
  bakeEnvironment() {
    this.baked = this.dark;
    this.envSky.userData.uNight.value = this.baked;
    const old = this.envTarget;
    this.envTarget = this.pmrem.fromScene(this.envScene, 0, 0.1, 10);
    this.scene.environment = this.envTarget.texture;
    old?.dispose();
  }

  // sun, moon: unit vectors towards them (world space). The light is the sun by day — dimmer and warmer as it
  // sinks — and the moon by night (or a stand-in for it while the moon is down); the change of direction
  // happens around sunset, when neither casts a shadow to speak of.
  setSky(sun, moon) {
    const deg = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(sun.y, -1, 1))), step = THREE.MathUtils.smoothstep;
    this.elevation = deg;
    // Dusk in order: the lights come on as the sun nears the horizon and are all on when it sets; the dark
    // then comes slowly, with the sun, until the end of nautical twilight (and the other way round at dawn).
    this.night = 1 - step(deg, 0, 9);
    this.dark = 1 - step(deg, -13, 5);
    this.daylight = step(deg, -5, 9);          // how much of the sun's light arrives (the afterglow included)
    this.moonlight = 1 - step(deg, -14, -5.5);
    this.warmth = 1 - step(deg, 3, 24);        // 1 at the horizon: orange light
    if (deg > -5.5) this.sunDir.copy(sun).setY(Math.max(sun.y, 0.06)).normalize(); // (never quite grazing: shadows stay finite)
    else if (moon.y > 0.2) this.sunDir.copy(moon);
    else this.sunDir.copy(MOON_STAND_IN);
    shared.uSunDir.value.copy(sun);
    shared.uSunGlint.value.copy(DAY.sunColor).lerp(SUNSET, this.warmth).multiplyScalar(this.daylight * 3);
    this.apply();
    if (Math.abs(this.dark - this.baked) > 0.04 || (this.dark !== this.baked && (this.dark === 0 || this.dark === 1))) this.bakeEnvironment();
  }

  // The sky follows the camera; the shadow frustum follows the focus, snapped to texels so shadows do not shimmer.
  follow(focus, camera) {
    // Shadow coverage grows with the viewing distance (in coarse steps, so it rarely changes).
    const want = THREE.MathUtils.clamp(camera.position.distanceTo(focus) * 1.1, 220, 1800);
    const extent = 220 * 1.3 ** Math.ceil(Math.log(want / 220) / Math.log(1.3));
    if (extent !== this.shadowExtent) {
      this.shadowExtent = extent;
      const c = this.sun.shadow.camera;
      c.left = c.bottom = -extent; c.right = c.top = extent;
      c.updateProjectionMatrix();
      this.sun.shadow.normalBias = 0.25 + extent / 900;
    }
    const texel = (2 * extent) / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, 2000);
  }

  update(dt) {
    this.time += dt;
    if (this.rebake.length && this.time > this.rebake[0]) { this.rebake.shift(); this.bakeEnvironment(); }
  }

  apply() {
    const t = this.dark, lerp = (a, b) => a + (b - a) * t;
    this.hemi.intensity = lerp(DAY.hemi, NIGHT.hemi);
    this.sun.intensity = DAY.sun * this.daylight + NIGHT.sun * this.moonlight;
    this.sun.color.copy(DAY.sunColor).lerp(SUNSET, this.warmth).lerp(NIGHT.sunColor, this.moonlight);
    this.scene.environmentIntensity = lerp(DAY.env, NIGHT.env); // (the map itself darkens with the sky)
    this.renderer.toneMappingExposure = lerp(DAY.exposure, NIGHT.exposure);
    this.bloom = lerp(DAY.bloom, NIGHT.bloom);
    shared.uNight.value = this.night;
    shared.uDark.value = t;
  }
}
