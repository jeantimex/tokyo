// The frame: the scene's own picture, then the sky and the aerial perspective of @takram/three-atmosphere
// (its node-based WebGPU version), then bloom and tone mapping — one node graph run by three's RenderPipeline.
//
// The atmosphere works in physical units on an Earth-centred frame. The scene keeps its own lights and its local
// frame: matrixWorldToECEF places it on the globe, and the colour buffer is scaled into the atmosphere's units
// before it and back after.
import * as THREE from 'three/webgpu';
import { pass, context, uniform, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { getSunDirectionECEF, getMoonDirectionECEF } from '@takram/three-atmosphere';
import { aerialPerspective, AtmosphereContext } from '@takram/three-atmosphere/webgpu';
import { Ellipsoid, Geodetic, radians } from '@takram/three-geospatial';

const UNITS = 0.1; // scene radiance -> the radiance the atmosphere works in (a sunlit white wall in both)

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
    atmosphere.showGround = false; // no dark planet below the horizon: beyond the area there is only sky
    atmosphere.matrixWorldToECEF.value.copy(this.worldToECEF);
    renderer.contextNode = context({ ...renderer.contextNode.value, getAtmosphere: () => atmosphere });

    // ---- the passes
    const scenePass = this.scenePass = pass(scene, camera, { samples: 0 });
    const colour = scenePass.getTextureNode('output'), depth = scenePass.getTextureNode('depth');
    const units = uniform(UNITS);
    this.skyOn = uniform(1);
    const aerial = this.aerial = aerialPerspective(vec4(colour.rgb.mul(units), colour.a), depth);
    const lit = aerial.rgb.div(units);
    this.bloomNode = bloom(lit, 0.5, 0.4, 0.9);
    this.pipeline = new THREE.RenderPipeline(renderer);
    this.pipeline.outputNode = vec4(lit.add(this.bloomNode.rgb), 1);
    this.bloom = this.bloomNode.strength; // (.value: how strong)

    this.sun = new THREE.Vector3(); this.moon = new THREE.Vector3();
    this.ready = true;
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
  render() { this.pipeline.render(); }
}
