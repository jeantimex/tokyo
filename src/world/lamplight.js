// Lamp light on the ground at night: street lamps, car and train headlamps.
// Every lamp is a flat quad carrying the footprint of its light. The quads are not drawn in the picture:
// they are drawn from straight above into a light map around the focus, where overlapping lamps keep the
// brighter of the two (lights never pile up into a glare), and every lit surface that faces the sky takes its
// lamp light from that map — as light on its own colour, so asphalt stays asphalt and paint stays paint.
import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, vec2, vec3, vec4, smoothstep, step, positionWorld, normalWorld, diffuseColor, materialColor, vertexColor, uv } from 'three/tsl';

export const LAMP_LAYER = 2; // the layer the lamp quads live on: the picture's camera does not see it
const SIZE = 2048;
const Y0 = 200, YSPAN = 1000; // heights are stored as (y + Y0) / YSPAN

const target = new THREE.RenderTarget(SIZE, SIZE, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
const lampMap = texture(target.texture);
const lampOn = uniform(0);
const lampRect = uniform(new THREE.Vector4(0, 0, 1, 0)); // centre x, centre z, half size, 0

// Material for a lamp quad: `map` is the footprint; the colour (times the vertex colour, if any) is the light.
export function lampMaterial(map, { vertexColors = false } = {}) {
  const m = new THREE.MeshBasicNodeMaterial({
    side: THREE.DoubleSide, depthTest: false, depthWrite: false, transparent: true,
    blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  m.map = map; // (kept for those who share it)
  // The height the light lies at goes into the alpha channel, so that a lamp under a flyover does not light
  // the deck above it, nor a car on the deck the street below.
  m.outputNode = Fn(() => {
    const light = texture(map, uv()).rgb.mul(materialColor).mul(vertexColors ? vertexColor().rgb : vec3(1)).toVar();
    const height = positionWorld.y.add(Y0).div(YSPAN);
    return vec4(light, step(0.004, light.r.add(light.g).add(light.b)).mul(height));
  })();
  return m;
}

// The lamp light falling on the surface being drawn (to be multiplied by its colour).
const lampGlow = Fn(() => {
  const at = positionWorld;
  const lampUv = vec2(at.x.sub(lampRect.x), lampRect.y.sub(at.z)).div(lampRect.z.mul(2)).add(0.5).toVar();
  const edge = smoothstep(vec2(0), vec2(0.04), lampUv).mul(smoothstep(vec2(0.96), vec2(1), lampUv).oneMinus());
  const up = smoothstep(0.25, 0.7, normalWorld.y);
  const texel = lampMap.sample(lampUv);
  const level = smoothstep(2.5, 5, at.y.sub(texel.a.mul(YSPAN).sub(Y0)).abs()).oneMinus(); // only light lying at this height
  return texel.rgb.mul(edge.x).mul(edge.y).mul(up).mul(level).mul(lampOn);
});

// Makes a lit material take part: the lamp light on its own colour is added to what it sends out.
export function lampLit(material) {
  const glow = lampGlow().mul(diffuseColor.rgb);
  material.emissiveNode = material.emissiveNode ? material.emissiveNode.add(glow) : glow;
  return material;
}

export class LampLight {
  constructor(renderer) {
    this.renderer = renderer;
    this.target = target;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 4000);
    this.camera.up.set(0, 0, -1);
    this.camera.layers.set(LAMP_LAYER);
    this.half = 0;
    this.black = new THREE.Color(0, 0, 0);
  }

  // scene: the scene holding the lamp quads; focus: what the view looks at; eye: the camera's position.
  update(scene, focus, eye, night) {
    lampOn.value = night > 0.02 ? 1 : 0;
    if (night <= 0.02) return;
    // the map reaches as far as the view does (in coarse steps), and moves a whole texel at a time
    const want = THREE.MathUtils.clamp(eye.distanceTo(focus) * 1.6, 350, 2400), half = 350 * 1.35 ** Math.ceil(Math.log(want / 350) / Math.log(1.35));
    const cam = this.camera;
    if (half !== this.half) { this.half = half; cam.left = cam.bottom = -half; cam.right = cam.top = half; cam.updateProjectionMatrix(); }
    const texel = (2 * half) / SIZE, cx = Math.round(focus.x / texel) * texel, cz = Math.round(focus.z / texel) * texel;
    cam.position.set(cx, focus.y + 2000, cz);
    cam.lookAt(cx, focus.y, cz);
    lampRect.value.set(cx, cz, half, 0);

    const r = this.renderer, previous = r.getRenderTarget(), clear = r.getClearColor(new THREE.Color()), alpha = r.getClearAlpha();
    r.setRenderTarget(this.target);
    r.setClearColor(this.black, 0);
    r.render(scene, cam); // (only the lamp quads are on this camera's layer)
    r.setRenderTarget(previous);
    r.setClearColor(clear, alpha);
  }
}
