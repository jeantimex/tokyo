// Ambient occlusion: contact shading between buildings and the ground. After N8AO (the pass the amounts were
// chosen with, which is written for WebGL): the depth buffer at half size with normals worked out from it,
// sixteen samples on the hemisphere over every point, two rounds of smoothing that keep to the surface, and an
// upsampling that keeps to it as well.
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, uniform, texture, texture3D, uniformArray, uv, float, vec2, vec3, vec4, mix, min, max, abs, dot, cross, normalize, pow, exp, sin, cos,
  fract, floor, select, smoothstep, step, clamp, screenCoordinate, getViewPosition, getScreenPosition,
} from 'three/tsl';

const SAMPLES = 16, DENOISE_SAMPLES = 8, DENOISE_RADIUS = 12, RINGS = 11;
const _quad = new THREE.QuadMesh(), _size = new THREE.Vector2();
let _state;

// points on the hemisphere, evenly spread (a sunflower, lifted onto the dome)
const hemisphere = Array.from({ length: SAMPLES }, (_, k) => {
  const theta = 2.399963 * k, r = Math.sqrt(k + 0.5) / Math.sqrt(SAMPLES), x = r * Math.cos(theta), y = r * Math.sin(theta);
  return new THREE.Vector3(x, y, Math.sqrt(1 - (x * x + y * y)));
});
// a spiral of points in the disc, for the smoothing
const spiral = Array.from({ length: DENOISE_SAMPLES }, (_, i) => {
  const angle = i * 2 * Math.PI * RINGS / DENOISE_SAMPLES, radius = (i + 1) / DENOISE_SAMPLES;
  return new THREE.Vector2(Math.cos(angle), Math.sin(angle)).multiplyScalar(radius ** 0.75);
});

class OcclusionNode extends THREE.TempNode {
  static get type() { return 'OcclusionNode'; }

  // colour: the picture (a node read at each pixel); depth: the texture node of its depth; noise: a 3D texture of blue noise (128 x 128 x 64).
  constructor(colour, depth, camera, noise, { radius = 7, falloff = 1, intensity = 2.6, color = [0, 0, 0] } = {}) {
    super('vec4');
    this.colour = colour; this.depth = depth; this.noise = texture3D(noise);
    this.radius = uniform(radius); this.falloff = uniform(falloff); this.intensity = uniform(intensity); this.tint = uniform(new THREE.Vector3(...color));
    this.on = uniform(1);
    this.projection = uniform(camera.projectionMatrix); this.inverse = uniform(camera.projectionMatrixInverse);
    this.pixels = uniform(new THREE.Vector2(1, 1)); // the size of the picture
    this.round = uniform(0);
    this.updateBeforeType = THREE.NodeUpdateType.FRAME;

    this.small = new THREE.RenderTarget(1, 1, { depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, type: THREE.FloatType }); // depth, normal
    this.rounds = [0, 1].map(() => new THREE.RenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType })); // occlusion, normal
    this.smallMap = texture(this.small.texture);
    this.before = texture(this.rounds[1].texture);
    this.result = texture(this.rounds[0].texture);
  }

  updateBefore({ renderer }) {
    if (this.on.value < 0.5 || !this.downMaterial) return;
    _state = THREE.RendererUtils.resetRendererState(renderer, _state);
    const size = renderer.getDrawingBufferSize(_size), w = Math.max(1, Math.floor(size.width / 2)), h = Math.max(1, Math.floor(size.height / 2));
    this.pixels.value.copy(size);
    for (const t of [this.small, ...this.rounds]) if (t.width !== w || t.height !== h) t.setSize(w, h);
    const draw = (material, target) => { _quad.material = material; renderer.setRenderTarget(target); _quad.render(renderer); };
    draw(this.downMaterial, this.small);
    let [write, read] = this.rounds;
    draw(this.aoMaterial, write);
    for (let i = 0; i < 2; i++) {
      [write, read] = [read, write];
      this.before.value = read.texture; this.round.value = i;
      draw(this.smoothMaterial, write);
    }
    this.result.value = write.texture;
    THREE.RendererUtils.restoreRendererState(renderer, _state);
  }

  setup(builder) {
    const { depth, inverse, projection, pixels } = this;
    const material = (name, node) => { const m = new THREE.NodeMaterial(); m.name = name; m.fragmentNode = node.context(builder.getSharedContext()); return m; };
    const half = floor(pixels.mul(0.5));
    const viewAt = (at, d) => getViewPosition(at, d, inverse);
    // a step of (x, y) pixels across the picture, y upwards as on the screen (uv runs downwards)
    const moved = (at, x, y) => at.add(vec2(x, -y).div(pixels));
    // The surface's normal from the depth buffer: of the two neighbours on either side, the one that lies in
    // the same plane (so that edges stay sharp).
    const normalFrom = (at) => {
      const d = (x, y) => depth.sample(moved(at, x, y)).r;
      const c0 = d(0, 0).toVar(), l1 = d(-1, 0).toVar(), r1 = d(1, 0).toVar(), b1 = d(0, -1).toVar(), t1 = d(0, 1).toVar();
      const dl = abs(l1.mul(2).sub(d(-2, 0)).sub(c0)), dr = abs(r1.mul(2).sub(d(2, 0)).sub(c0)), db = abs(b1.mul(2).sub(d(0, -2)).sub(c0)), dt = abs(t1.mul(2).sub(d(0, 2)).sub(c0));
      const centre = viewAt(at, c0).toVar();
      const dx = select(dl.lessThan(dr), centre.sub(viewAt(moved(at, -1, 0), l1)), viewAt(moved(at, 1, 0), r1).sub(centre));
      const dy = select(db.lessThan(dt), centre.sub(viewAt(moved(at, 0, -1), b1)), viewAt(moved(at, 0, 1), t1).sub(centre));
      return normalize(cross(dx, dy));
    };
    const noiseAt = (layer) => this.noise.sample(vec3(screenCoordinate.xy.div(128), (layer + 0.5) / 64)).level(0).r;

    // ---- half size: of every four pixels the nearest or the farthest in turn (a chequerboard), with its normal
    this.downMaterial = material('Occlusion.down', Fn(() => {
      const at = uv().sub(vec2(0.5, -0.5).div(pixels)).toVar();
      const places = [at, moved(at, 1, 0), moved(at, 0, 1), moved(at, 1, 1)].map((p) => vec2(p).toVar());
      const depths = places.map((p) => depth.sample(p).r.toVar());
      const nearest = min(min(depths[0], depths[1]), min(depths[2], depths[3])), farthest = max(max(depths[0], depths[1]), max(depths[2], depths[3]));
      const wanted = select(screenCoordinate.x.add(screenCoordinate.y).mod(2).greaterThan(0.5), farthest, nearest).toVar();
      const place = vec2(places[3]).toVar(), chosen = float(depths[3]).toVar();
      for (let i = 2; i >= 0; i--) If(depths[i].equal(wanted), () => { place.assign(places[i]); chosen.assign(depths[i]); });
      return vec4(chosen, normalFrom(place));
    })());

    // ---- how much of the hemisphere over each point is taken up by what stands near it
    const samples = uniformArray(hemisphere);
    this.aoMaterial = material('Occlusion.ao', Fn(() => {
      const at = uv(), data = this.smallMap.sample(at).toVar(), d = data.r, out = vec4(1, 1, 1, 1).toVar();
      If(d.lessThan(1), () => {
        const position = viewAt(at, d).toVar(), normal = data.gba.toVar();
        const turn = noiseAt(0).mul(Math.PI * 2).toVar(), slide = noiseAt(1).toVar();
        const helper = select(normal.y.greaterThan(0.99), vec3(1, 0, 0), vec3(0, 1, 0));
        const tangent = normalize(cross(helper, normal)).toVar(), bitangent = cross(normal, tangent).toVar();
        const c = cos(turn).toVar(), s = sin(turn).toVar();
        const reach = this.radius.mul(this.falloff).mul(0.2);
        const occluded = float(0).toVar(), weight = float(0).toVar();
        Loop(SAMPLES, ({ i }) => {
          const k = samples.element(i), turned = vec3(c.mul(k.x).add(s.mul(k.y)), c.mul(k.y).sub(s.mul(k.x)), k.z);
          const direction = tangent.mul(turned.x).add(bitangent.mul(turned.y)).add(normal.mul(turned.z));
          const along = fract(slide.add(float(i).div(SAMPLES)));
          const p = position.add(direction.mul(this.radius).mul(along)).toVar();
          const q = getScreenPosition(p, projection).toVar(), clip = projection.mul(vec4(p, 1)), z = clip.z.div(clip.w);
          If(q.x.greaterThan(0).and(q.x.lessThan(1)).and(q.y.greaterThan(0)).and(q.y.lessThan(1)).and(z.greaterThan(0)).and(z.lessThan(1)), () => {
            const there = this.smallMap.sample(q).r.toVar();
            const found = viewAt(q, there).z.negate().toVar(), expected = p.z.negate().toVar();
            const range = smoothstep(0, 1, reach.div(abs(found.sub(expected))));
            const other = screenCoordinate.xy.sub(floor(q.mul(half)));
            occluded.addAssign(range.mul(select(found.notEqual(expected), 1, 0)).mul(select(there.notEqual(d), 1, 0)).mul(step(found, expected)).mul(step(1, dot(other, other))));
            weight.addAssign(1);
          });
        });
        out.assign(vec4(clamp(occluded.div(max(weight, 1)).oneMinus(), 0, 1), normal.mul(0.5).add(0.5)));
      });
      return out;
    })());

    // ---- smoothing: neighbours in a turned spiral, as far as they lie in the same plane and face the same way
    const disc = uniformArray(spiral);
    this.smoothMaterial = material('Occlusion.smooth', Fn(() => {
      const at = uv(), data = this.before.sample(at).toVar(), d = this.smallMap.sample(at).r.toVar(), out = vec4(data).toVar();
      If(d.lessThan(1), () => {
        const normal = data.gba.mul(2).sub(1).toVar(), position = viewAt(at, d).toVar();
        const angle = select(this.round.lessThan(0.5), noiseAt(3), noiseAt(2)).mul(Math.PI * 2).toVar(), c = cos(angle).toVar(), s = sin(angle).toVar();
        const reach = this.radius.mul(this.falloff).mul(0.2), sum = float(data.r).toVar(), count = float(1).toVar();
        Loop(DENOISE_SAMPLES, ({ i }) => {
          const k = disc.element(i), offset = vec2(c.mul(k.x).add(s.mul(k.y)), c.mul(k.y).sub(s.mul(k.x))).div(half).mul(DENOISE_RADIUS / 2);
          const q = at.add(offset).toVar(), near = this.before.sample(q).toVar(), there = this.smallMap.sample(q).r.toVar();
          const off = abs(dot(viewAt(q, there).sub(position), normal));
          const range = select(there.lessThan(1), 1, 0).mul(exp(off.div(reach).negate())).mul(max(dot(normal, near.gba.mul(2).sub(1)), 0));
          sum.addAssign(near.r.mul(range)); count.addAssign(range);
        });
        const smooth = clamp(sum.div(count), 0, 1).toVar();
        out.assign(vec4(select(smooth.equal(0), 1, smooth), normal.mul(0.5).add(0.5)));
      });
      return out;
    })());

    // ---- laid on the picture at full size: of the nine half-size pixels around, those of the same surface
    return Fn(() => {
      const at = uv(), scene = vec3(this.colour).toVar(), d = depth.sample(at).r.toVar(), ao = float(1).toVar();
      const normal = normalFrom(at).toVar(); // (taken outside the branch: it reads the depth around)
      If(d.lessThan(1).and(this.on.greaterThan(0.5)), () => {
        const position = viewAt(at, d).toVar(), sum = float(0).toVar(), weight = float(0).toVar();
        const base = floor(at.mul(half)).toVar();
        for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) {
          const q = base.add(vec2(x + 0.5, y + 0.5)).div(half).toVar();
          const near = this.result.sample(q).toVar(), there = this.smallMap.sample(q).r;
          const off = abs(dot(viewAt(q, there).sub(position), normal));
          const w = exp(off.div(this.falloff).negate()).mul(max(dot(normal, near.gba.mul(2).sub(1)), 0)).toVar();
          sum.addAssign(near.r.mul(w)); weight.addAssign(w);
        }
        ao.assign(pow(select(weight.equal(0), this.result.sample(at).r, sum.div(max(weight, 1e-9))), this.intensity));
      });
      return vec4(mix(scene, scene.mul(this.tint), ao.oneMinus()), 1);
    })();
  }

  dispose() { this.small.dispose(); for (const t of this.rounds) t.dispose(); }
}

export const occlusion = (...args) => new OcclusionNode(...args);
