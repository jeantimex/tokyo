// The light of the scene, taken from the atmosphere (@takram/three-atmosphere, as its own examples set it up):
// the sun is a directional light whose colour and strength are what is left of sunlight after its way through
// the air — white at noon, orange and weak at the horizon, nothing below it — and the sky is a light probe that
// holds what the whole dome of the sky sends down at this hour. Both come from the same tables the sky itself is
// drawn from (atmosphere.js), so the light on the city and the sky above it always agree. The sky is also kept as
// an environment map, for what mirrors it: glass, water, anything smooth.
//
// By night neither gives any light. The directional light is then the moon (dim, blue), and a faint even glow
// stands for the city's own light on the haze above it.
import * as THREE from 'three';
import { SunDirectionalLight, SkyLightProbe } from '@takram/three-atmosphere';
import { shared } from './materials.js';

const SHADOW_SIZE = 4096;
// The atmosphere's radiance is ten times smaller than the scene's (atmosphere.js: UNITS): its lights are made ten
// times stronger here, which is what an exposure of 10 does in the library's own examples.
const LIGHT = 10;
// The exposure goes by the light, as a camera's (or the eye's) does: a sunlit noon is many times brighter than
// dusk, and each is shown as well as it can be. target: how bright the picture is meant to be; least, most: the
// exposure's limits (at noon, and in the night).
const EXPOSURE = { target: 1.8, least: 0.38, most: 1.7 };
const BLOOM = { day: 0.12, night: 0.45 };
const DAYLIGHT = new THREE.Vector3(0.83, 1, 1.2); // what daylight is multiplied by to be white on the screen
// The picture as in Bruneton's demo (`plain`). night: the exposure by night. radiance: the atmosphere library works
// in luminance (the sky's radiance times a factor for each of red, green and blue, as in the demo's other mode);
// the demo shows radiance, which is bluer: the factors are taken out again.
const PLAIN = { night: 1.4, radiance: new THREE.Vector3(1 / 1.5185, 1 / 0.9417, 1 / 0.8626) };
const MOON = { strength: 0.32, color: new THREE.Color(0x9fb4e0) };
// the night's even light: a city is never dark — its own lights come back from the haze above it, a pale grey on everything
const GLOW = { strength: 0.5, sky: new THREE.Color(0xe6eaf4), ground: new THREE.Color(0x8a8172) };
const MOON_STAND_IN = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 40), THREE.MathUtils.degToRad(205));

// Call once, before any material is compiled. The environment map is for reflections only: the sky's even light
// on a surface comes from the light probe (taking it from the map as well would count the sky twice).
export function installSkyLight() {
  THREE.ShaderChunk.envmap_physical_pars_fragment = THREE.ShaderChunk.envmap_physical_pars_fragment.replace(
    'return PI * envMapColor.rgb * envMapIntensity;', 'return vec3( 0.0 );');
}

export class Environment {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.night = 0;  // how far the city's lights are on: they come on while it is still light
    this.dark = 0;   // how dark it is: this follows the sun all the way down through twilight
    this.daylight = 1; this.moonlight = 0; this.warmth = 0; this.elevation = 40;
    this.brightness = 1; // of the whole picture (the exposure is multiplied by it)
    // The sun's light and the sky's, against what the atmosphere gives (1: as it is in nature). More of the sky's
    // lights the shade and colours it blue; the reflections of the sky (in glass, on water) go with it.
    this.sunStrength = 1; this.skyStrength = 1;
    // Sunlight that the ground and the walls send on (bounceStrength: 1 as worked out below): without it the shade is
    // lit by the blue sky alone, and is as blue as the sky and darker than it is in a city of pale stone and concrete.
    this.bounceStrength = 2.5;
    // By night: the moon's light, the city's own glow (each 1 as designed), and how bright the night is shown.
    this.moonStrength = 1; this.glowStrength = 1; this.nightBrightness = 1;
    this.balance = new THREE.Vector3(1, 1, 1); // (see apply)
    this.plain = true; // the tone curve is Bruneton's (set by whoever sets the curve)
    this.sunDir = new THREE.Vector3(0.3, 0.8, 0.5).normalize(); // where the light comes from: the sun, or the moon by night
    this.bloom = BLOOM.day;

    this.sun = new SunDirectionalLight({ distance: 2000 });
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
    const c = this.sun.shadow.camera;
    c.near = 10; c.far = 4000;
    this.shadowExtent = 0;
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.5;
    this.sun.shadow.radius = 5; // (soft edges)
    this.sun.intensity = 0; // (until the atmosphere's tables are there)
    this.skyLight = new SkyLightProbe();
    this.skyLight.intensity = 0;
    this.glow = new THREE.HemisphereLight(GLOW.sky, GLOW.ground, 0);
    this.bounce = new THREE.HemisphereLight(0x000000, 0x000000, 1);
    scene.add(this.sun, this.sun.target, this.skyLight, this.glow, this.bounce);

    // the sky as an environment map (see lightFromSky)
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.physical = null; this.bakedSun = new THREE.Vector3(); this.baked = -1; this.bakedAt = 0;
    this.sunColor = new THREE.Color(); // the sun's light as it arrives (for the glint in the windows)
    this.apply();
  }

  // The atmosphere: its tables (textures: { transmittanceTexture, irradianceTexture }), where the scene sits on
  // the globe (worldToECEF), its sky for the environment map (sky: { mesh, scale }, Atmosphere.environmentSky())
  // and whether it can draw yet (ready()).
  lightFromSky(textures, worldToECEF, sky, ready) {
    this.sun.transmittanceTexture = textures.transmittanceTexture;
    this.skyLight.irradianceTexture = textures.irradianceTexture;
    this.sun.worldToECEFMatrix.copy(worldToECEF);
    this.skyLight.worldToECEFMatrix.copy(worldToECEF);
    // (a physical night sky is black: the glow of the city's lights on the haze is put under it)
    const glow = new THREE.MeshBasicMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    Object.assign(sky.mesh.material, { blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false });
    sky.mesh.renderOrder = 1;
    this.envScene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), glow), sky.mesh);
    this.physical = { glow, scale: sky.scale, ready };
  }

  // Renders the environment map for the sky as it now is (again whenever the sun has moved a little).
  bakeEnvironment(sun) {
    if (!this.physical?.ready()) return;
    this.bakedAt = performance.now();
    this.baked = this.dark;
    this.bakedSun.copy(sun);
    this.physical.glow.color.setRGB(0.05, 0.04, 0.045).multiplyScalar(this.dark / this.physical.scale);
    const old = this.scene.environment;
    this.scene.environment = this.pmrem.fromScene(this.envScene, 0, 0.1, 10).texture;
    this.scene.environmentIntensity = this.physical.scale;
    old?.dispose();
  }

  // sun, moon: unit vectors towards them in the scene's frame; sunECEF: the sun's in the globe's (for the
  // atmosphere's lights). The light is the sun as long as any of it arrives, then the moon (or a stand-in for it
  // while the moon is down); the change of direction happens in deep twilight, when neither casts a shadow to speak of.
  setSky(sun, moon, sunECEF) {
    const deg = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(sun.y, -1, 1))), step = THREE.MathUtils.smoothstep;
    this.elevation = deg;
    // Dusk in order: the lights come on as the sun nears the horizon and are all on when it sets; the dark
    // then comes slowly, with the sun, until the end of nautical twilight (and the other way round at dawn).
    this.night = 1 - step(deg, 0, 9);
    this.dark = 1 - step(deg, -13, 5);
    this.daylight = step(deg, -5, 9);
    this.moonlight = 1 - step(deg, -14, -5.5);
    this.warmth = 1 - step(deg, 3, 24);
    const sunUp = deg > -5.5;
    if (sunUp) this.sunDir.copy(sun).setY(Math.max(sun.y, 0.06)).normalize(); // (never quite grazing: shadows stay finite)
    else if (moon.y > 0.2) this.sunDir.copy(moon);
    else this.sunDir.copy(MOON_STAND_IN);
    shared.uSunDir.value.copy(sun);

    if (this.physical?.ready()) {
      // the sun: its colour and strength from the atmosphere, for where the view is
      this.sun.sunDirection.copy(sunECEF);
      this.sun.update();
      this.sunColor.copy(this.sun.color);
      if (sunUp) this.sun.intensity = LIGHT * this.sunStrength;
      else { this.sun.color.copy(MOON.color); this.sun.intensity = MOON.strength * this.moonStrength * this.moonlight; }
      // the sunlight sent on by the city itself: what falls on the ground, a third of it sent back (the city's
      // albedo), reaches a wall from below and from the side — most of it what faces down, least what faces up
      const sent = sunUp ? 0.3 * this.sun.intensity * Math.max(sun.y, 0) * this.bounceStrength : 0;
      this.bounce.groundColor.copy(this.sunColor).multiplyScalar(0.8 * sent);
      this.bounce.color.copy(this.sunColor).multiplyScalar(0.2 * sent);
      // the sky
      this.skyLight.sunDirection.copy(sunECEF);
      this.skyLight.position.copy(this.sun.target.position);
      this.skyLight.update();
      this.skyLight.intensity = LIGHT * this.skyStrength;
      shared.uSunGlint.value.copy(this.sunColor).multiplyScalar(LIGHT * 0.9);
      const now = performance.now();
      if (now - this.bakedAt > 200 && (this.baked < 0 || sun.angleTo(this.bakedSun) > 0.006 || Math.abs(this.dark - this.baked) > 0.04)) this.bakeEnvironment(sun);
    }
    this.apply();
  }

  // The shadow frustum follows the focus, snapped to texels so shadows do not shimmer.
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
    const texel = (2 * extent) / SHADOW_SIZE;
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.copy(this.sun.target.position).addScaledVector(this.sunDir, 2000);
  }

  update() {}

  apply() {
    const t = this.dark, lerp = (a, b) => a + (b - a) * t;
    this.glow.intensity = GLOW.strength * this.glowStrength * t;
    // (how much light there is: the sun on the ground, the sky, the night's own glow)
    const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b, sh = this.skyLight.sh.coefficients[0];
    const light = 0.3 * lum(this.sun.color) * this.sun.intensity * Math.max(this.sunDir.y, 0.05) + 2.5 * (0.2126 * sh.x + 0.7152 * sh.y + 0.0722 * sh.z) * this.skyLight.intensity + 1.3 * t * t * t;
    this.renderer.toneMappingExposure = THREE.MathUtils.clamp(EXPOSURE.target / Math.max(light, 1e-3), EXPOSURE.least, EXPOSURE.most) * this.brightness * (1 + (this.nightBrightness - 1) * t);
    this.bloom = lerp(BLOOM.day, BLOOM.night);
    if (this.plain) {
      // As Bruneton's demo shows its sky: a fixed exposure (its 10, which is 1 in the scene's units) for as long as
      // the sun is up, the light simply fading with it — and more only as night comes, for the city's own lights;
      // no glow round the sun.
      const late = 1 - THREE.MathUtils.smoothstep(this.elevation, -8, -1);
      this.renderer.toneMappingExposure = (1 + (PLAIN.night - 1) * late) * this.brightness * (1 + (this.nightBrightness - 1) * late);
      this.bloom = BLOOM.night * late;
    }
    // the white balance: for daylight — the sun's light a warm white, here cooled to the screen's — and none by night
    this.balance.set(1, 1, 1).lerp(this.plain ? PLAIN.radiance : DAYLIGHT, this.plain ? 1 - t : this.daylight);
    shared.uNight.value = this.night;
    shared.uDark.value = t;
  }
}
