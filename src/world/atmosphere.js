// The frame: the scene's own picture, then the sky and the aerial perspective of @takram/three-atmosphere
// (its node-based WebGPU version), then bloom and tone mapping — one node graph run by three's RenderPipeline.
//
// The atmosphere works in physical units on an Earth-centred frame. The scene keeps its own lights and its local
// frame: matrixWorldToECEF places it on the globe, and the colour buffer is scaled into the atmosphere's units
// before it and back after.
import * as THREE from 'three/webgpu';
import { pass, context, uniform, vec2, vec3, vec4, Fn, If, mix, uv, positionGeometry, rtt, float, fract, sin, dot, normalize, length, screenCoordinate } from 'three/tsl';
import { bloomOver } from './bloom.js';
import { occlusion } from './occlusion.js';
import { windowReflections } from './reflections.js';
import { Clouds, blueNoise } from './clouds.js';
import { getSunDirectionECEF, getMoonDirectionECEF } from '@takram/three-atmosphere';
import { AtmosphereContext, getAtmosphereContext, getIndirectLuminance, getIndirectLuminanceToPoint, SunNode, MoonNode } from '@takram/three-atmosphere/webgpu';
import { depthToViewZ, screenToPositionView, projectionMatrix, inverseProjectionMatrix, inverseViewMatrix } from '@takram/three-geospatial/webgpu';
import { Ellipsoid, Geodetic, radians } from '@takram/three-geospatial';

const SHADE = 0.42; // what is left of a surface's light under a thick cloud: the sky still lights it
const UNITS = 0.1; // scene radiance -> the radiance the atmosphere works in (a sunlit white wall in both)

// The node version of the library gives a brighter sky and a thicker haze than its WebGL effect, for which the
// picture was balanced: both are brought back to that.
// The sky's share depends on how high the sun stands: [elevation in degrees, scale], measured against the effect.
const SKY_SCALE = [[-3, 1.04], [3, 1], [15, 0.88], [36, 0.715], [49, 0.65], [90, 0.6]], HAZE_SCALE = 0.7;
const skyScale = (elevation) => {
  const t = SKY_SCALE, e = Math.min(Math.max(elevation, t[0][0]), t[t.length - 1][0]);
  let i = 1; while (i < t.length - 1 && t[i][0] < e) i++;
  return t[i - 1][1] + (t[i][1] - t[i - 1][1]) * (e - t[i - 1][0]) / (t[i][0] - t[i - 1][0]);
};

// The air over the scene's picture: what is left of each surface's light on its way to the eye plus the light
// scattered into that path, and the sky where there is no surface. (The library's AerialPerspectiveNode, with
// the scales above and a sky that goes all the way round.)
class AirNode extends THREE.TempNode {
  static get type() { return 'AirNode'; }

  constructor(colorNode, depthNode, clouds) {
    super('vec4');
    this.clouds = clouds;
    this.colorNode = colorNode;
    this.depthNode = depthNode;
    this.sunNode = new SunNode();
    this.moonNode = new MoonNode();
    this.skyScale = uniform(skyScale(40));
    this.hazeScale = uniform(HAZE_SCALE);
  }

  setup(builder) {
    const atmosphere = getAtmosphereContext(builder), camera = atmosphere.camera ?? builder.camera;
    const { worldToUnit } = atmosphere.parametersNode;
    const { matrixWorldToECEF, sunDirectionECEF, cameraPositionUnit, altitudeCorrectionUnit } = atmosphere;
    const depth = this.depthNode.r.toConst(), eye = cameraPositionUnit.add(altitudeCorrectionUnit);
    const eyeMetres = atmosphere.cameraPositionECEF.add(atmosphere.altitudeCorrectionECEF);
    // (a little noise hides the steps of the march through the clouds' shadow)
    const grain = fract(sin(dot(screenCoordinate.xy, vec2(12.9898, 78.233))).mul(43758.5453));

    return Fn(() => {
      const out = this.colorNode.toVar();
      If(builder.renderer.reversedDepthBuffer ? depth.lessThanEqual(0) : depth.greaterThanEqual(1), () => {
        const view = inverseProjectionMatrix(camera).mul(vec4(positionGeometry, 1)).xyz;
        const world = inverseViewMatrix(camera).mul(vec4(view, 0)).xyz;
        const ray = matrixWorldToECEF.mul(vec4(world, 0)).xyz.toVertexStage().normalize().toConst();
        // Blue all round: the area is an island in the sky, so a ray that leaves it downwards sees the sky
        // mirrored at the horizon (capped, so that no second sun appears below) instead of a planet's surface.
        const up = cameraPositionUnit.normalize().toConst(), below = ray.dot(up).min(0).toConst();
        const direction = ray.sub(up.mul(below.mul(2))).toConst();
        // (the air in the clouds' shadow scatters no sunlight)
        const shaded = this.clouds.shadowLength(eyeMetres, direction, float(2e5), grain).mul(worldToUnit);
        const transfer = getIndirectLuminance(eye, direction, vec2(shaded, 0), sunDirectionECEF).toConst();
        const sky = vec3(0).toVar();
        this.sunNode.rayDirectionECEF = direction;
        sky.assign(mix(sky, this.sunNode.rgb, this.sunNode.a));
        this.moonNode.rayDirectionECEF = direction;
        sky.assign(mix(sky, this.moonNode.rgb, this.moonNode.a));
        sky.assign(sky.mul(transfer.get('transmittance')).add(transfer.get('luminance')).mul(this.skyScale));
        If(below.lessThan(0), () => { sky.assign(sky.min(vec3(0.5))); });
        out.rgb.assign(sky);
      }).Else(() => {
        const viewZ = depthToViewZ(depth, camera);
        const view = screenToPositionView(uv(), depth, viewZ, projectionMatrix(camera), inverseProjectionMatrix(camera));
        const world = inverseViewMatrix(camera).mul(vec4(view, 1)).xyz;
        const point = matrixWorldToECEF.mul(vec4(world, 1)).xyz.mul(worldToUnit).add(altitudeCorrectionUnit);
        const metres = matrixWorldToECEF.mul(vec4(world, 1)).xyz.add(atmosphere.altitudeCorrectionECEF).sub(eyeMetres).toVar();
        const shaded = this.clouds.shadowLength(eyeMetres, normalize(metres), length(metres), grain).mul(worldToUnit);
        const transfer = getIndirectLuminanceToPoint(eye, point, vec2(shaded, 0), sunDirectionECEF).toConst();
        // (the scene is lit by its own lights: the shadow of the clouds is laid over it here)
        const sunlit = mix(SHADE, 1, this.clouds.sunTransmittance(world));
        out.rgb.assign(out.rgb.mul(sunlit).mul(transfer.get('transmittance')).add(transfer.get('luminance').mul(this.hazeScale)));
      });
      const overlay = vec4(this.clouds).mul(this.clouds.on);
      out.rgb.assign(out.rgb.mul(overlay.a.oneMinus()).add(overlay.rgb));
      return out;
    })();
  }
}

// ambient occlusion: the reach in metres, and how dark
const AO = { radius: 7, falloff: 1, intensity: 2.6, color: [0.02, 0.02, 0.03] };

const ORIGIN = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);

export class Atmosphere {
  // origin: { lon, lat } of the world origin; the world is x east, y up, z south.
  // bounds: { minX, maxX, minZ, maxZ } of the area; the clouds can be kept to the sky above it.
  constructor(renderer, scene, camera, origin, bounds) {
    this.renderer = renderer;

    // ---- where the scene sits on the globe
    const position = new Geodetic(radians(origin.lon), radians(origin.lat), 0).toECEF();
    const east = new THREE.Vector3(), north = new THREE.Vector3(), up = new THREE.Vector3();
    Ellipsoid.WGS84.getEastNorthUpVectors(position, east, north, up);
    this.worldToECEF = new THREE.Matrix4().makeBasis(east, up, north.clone().negate()).setPosition(position);
    this.rotation = new THREE.Matrix3().setFromMatrix4(this.worldToECEF);

    const atmosphere = this.context = new AtmosphereContext();
    atmosphere.camera = camera;
    atmosphere.raymarchScattering = false;
    atmosphere.accurateShadowScattering = false; // (the shadowed stretch of a ray is taken off its far end, as the effect did)
    atmosphere.showGround = false; // no dark planet below the horizon: beyond the area there is only sky
    atmosphere.matrixWorldToECEF.value.copy(this.worldToECEF);
    renderer.contextNode = context({ ...renderer.contextNode.value, getAtmosphere: () => atmosphere });

    // The library computes its lookup tables in the browser's idle time, which a page that draws flat out (or a
    // hidden one) never has: the sky would stay black. Here the four steps are done on the first four frames.
    const lut = atmosphere.lutNode;
    this.ready = false; // (the sky is dark until the tables are done)
    lut.updateTextures = async (r) => {
      const ctx = lut.textures.createContext();
      lut.updating = true;
      this.lutSteps = { steps: lut.performCompute(r, ctx)[Symbol.iterator](), done: () => { lut.updating = false; ctx.dispose(); lut.disposeQueue?.(); this.ready = true; } };
    };

    // ---- the passes
    const scenePass = this.scenePass = pass(scene, camera, { samples: 0 });
    const colour = scenePass.getTextureNode('output'), depth = scenePass.getTextureNode('depth');
    const units = this.units = uniform(UNITS);
    this.skyOn = uniform(1);
    // window glass reflects what is on screen (first of all: it reads the panes marked in the alpha channel)
    const reflections = this.reflections = windowReflections(colour, depth, camera);
    this.reflectOn = uniform(1);
    const reflected = rtt(reflections.node);
    const seen = this.reflectOn.greaterThan(0.5).select(reflected.rgb, colour.rgb);
    // ambient occlusion: contact shading between buildings and the ground
    const stbn = blueNoise();
    const shaded = (this.aoNode = occlusion(seen, depth, camera, stbn, AO)).rgb;
    // volumetric clouds: drawn into a picture of their own, which the air lays over the scene
    const clouds = this.clouds = new Clouds(camera, depth, atmosphere, this.worldToECEF, bounds, stbn);
    const air = this.air = new AirNode(vec4(shaded.mul(units), 1), depth, clouds);
    clouds.hazeScale = air.hazeScale; clouds.skyScale = air.skyScale;
    const lit = rtt(air.rgb.div(units)); // (once for the bloom and for the picture)
    const glow = bloomOver(lit, { intensity: 0.5, threshold: 0.9, smoothing: 0.2 });
    this.pipeline = new THREE.RenderPipeline(renderer);
    this.pipeline.outputNode = vec4(glow.node, 1);
    this.bloom = glow.intensity; // (.value: how strong)

    this.sun = new THREE.Vector3(); this.moon = new THREE.Vector3();
  }

  // Puts the sun and the moon where they stand over the area at `date`. Returns their directions in world
  // space (unit vectors, y up) for the scene's own light.
  setDate(date) {
    getSunDirectionECEF(date, this.sun);
    getMoonDirectionECEF(date, this.moon);
    this.context.sunDirectionECEF.value.copy(this.sun);
    this.context.moonDirectionECEF.value.copy(this.moon);
    // world -> ECEF is a rotation: its transpose brings a direction back
    const toWorld = this.toWorld ??= this.rotation.clone().transpose();
    const sun = this.sun.clone().applyMatrix3(toWorld);
    this.air.skyScale.value = skyScale(THREE.MathUtils.radToDeg(Math.asin(sun.y)));
    this.sunWorld = sun;
    return { sun, moon: this.moon.clone().applyMatrix3(toWorld) };
  }

  get reflect() { return this.reflectOn.value > 0.5; }
  set reflect(v) { this.reflectOn.value = v ? 1 : 0; }
  get occlusion() { return this.aoNode.on.value > 0.5; }
  set occlusion(v) { this.aoNode.on.value = v ? 1 : 0; }

  get cloudsOn() { return this.clouds.enabled; } // (volumetric clouds are heavy: off until asked for)
  set cloudsOn(v) { this.clouds.enabled = v; }
  get coverage() { return this.clouds.coverage.value; }
  set coverage(v) { this.clouds.coverage.value = v; }
  // Altitude of the base of the two low cloud layers (the second starts 250 m above the first).
  get base() { return this.clouds.base; }
  set base(v) { this.clouds.base = v; }
  // clouds over the area only, or over the whole sky
  get overCity() { return this.clouds.overCity; }
  set overCity(v) { this.clouds.overCity = v; }
  get quality() { return this.clouds.quality; }
  set quality(v) { this.clouds.quality = v; }

  setSize() { /* the pipeline follows the renderer */ }
  // dt: seconds since the last frame; focus: the point looked at.
  render(dt = 0, focus = ORIGIN) {
    this.clouds.update(dt, focus, this.sunWorld ?? UP);
    this.pipeline.render();
    if (this.lutSteps && this.lutSteps.steps.next().done) { this.lutSteps.done(); this.lutSteps = null; }
  }
}
