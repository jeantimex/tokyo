// The frame: the scene's own picture, then the sky and the aerial perspective of @takram/three-atmosphere
// (its node-based WebGPU version), then bloom and tone mapping — one node graph run by three's RenderPipeline.
//
// The atmosphere works in physical units on an Earth-centred frame. The scene keeps its own lights and its local
// frame: matrixWorldToECEF places it on the globe, and the colour buffer is scaled into the atmosphere's units
// before it and back after.
import * as THREE from 'three/webgpu';
import { pass, context, uniform, vec2, vec3, vec4, Fn, If, mix, uv, positionGeometry } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { getSunDirectionECEF, getMoonDirectionECEF } from '@takram/three-atmosphere';
import { AtmosphereContext, getAtmosphereContext, getIndirectLuminance, getIndirectLuminanceToPoint, SunNode, MoonNode } from '@takram/three-atmosphere/webgpu';
import { depthToViewZ, screenToPositionView, projectionMatrix, inverseProjectionMatrix, inverseViewMatrix } from '@takram/three-geospatial/webgpu';
import { Ellipsoid, Geodetic, radians } from '@takram/three-geospatial';

const UNITS = 0.1; // scene radiance -> the radiance the atmosphere works in (a sunlit white wall in both)

// The node version of the library gives a brighter sky and a thicker haze than its WebGL effect, for which the
// picture was balanced: both are brought back to that.
const SKY_SCALE = 0.67, HAZE_SCALE = 0.7;
export const BLOOM_SCALE = 0.11; // three's bloom node against the bloom effect the amounts were chosen for

// The air over the scene's picture: what is left of each surface's light on its way to the eye plus the light
// scattered into that path, and the sky where there is no surface. (The library's AerialPerspectiveNode, with
// the scales above and a sky that goes all the way round.)
class AirNode extends THREE.TempNode {
  static get type() { return 'AirNode'; }

  constructor(colorNode, depthNode) {
    super('vec4');
    this.colorNode = colorNode;
    this.depthNode = depthNode;
    this.sunNode = new SunNode();
    this.moonNode = new MoonNode();
    this.skyScale = uniform(SKY_SCALE);
    this.hazeScale = uniform(HAZE_SCALE);
  }

  setup(builder) {
    const atmosphere = getAtmosphereContext(builder), camera = atmosphere.camera ?? builder.camera;
    const { worldToUnit } = atmosphere.parametersNode;
    const { matrixWorldToECEF, sunDirectionECEF, cameraPositionUnit, altitudeCorrectionUnit } = atmosphere;
    const depth = this.depthNode.r.toConst(), eye = cameraPositionUnit.add(altitudeCorrectionUnit);

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
        const transfer = getIndirectLuminance(eye, direction, vec2(0), sunDirectionECEF).toConst();
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
        const transfer = getIndirectLuminanceToPoint(eye, point, vec2(0), sunDirectionECEF).toConst();
        out.rgb.assign(out.rgb.mul(transfer.get('transmittance')).add(transfer.get('luminance').mul(this.hazeScale)));
      });
      return out;
    })();
  }
}

export class Atmosphere {
  // origin: { lon, lat } of the world origin; the world is x east, y up, z south.
  constructor(renderer, scene, camera, origin) {
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
    const air = this.air = new AirNode(vec4(colour.rgb.mul(units), colour.a), depth);
    const lit = air.rgb.div(units);
    this.bloomNode = bloom(lit, 0.5, 0.4, 0.9);
    this.pipeline = new THREE.RenderPipeline(renderer);
    this.pipeline.outputNode = vec4(lit.add(this.bloomNode.rgb), 1);
    this.bloom = this.bloomNode.strength; // (.value: how strong)

    this.sun = new THREE.Vector3(); this.moon = new THREE.Vector3();
    this.reflect = true;
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
    return { sun: this.sun.clone().applyMatrix3(toWorld), moon: this.moon.clone().applyMatrix3(toWorld) };
  }

  setSize() { /* the pipeline follows the renderer */ }
  render() {
    this.pipeline.render();
    if (this.lutSteps && this.lutSteps.steps.next().done) { this.lutSteps.done(); this.lutSteps = null; }
  }
}
