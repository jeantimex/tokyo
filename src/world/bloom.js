// Bloom: what is brighter than a threshold is blurred wide and laid back over the picture. The blur is the
// mipmap blur of Call of Duty: Advanced Warfare (Jimenez 2014), as pmndrs' postprocessing does it, which the
// amounts in environment.js were chosen for: the bright parts are halved in size eight times over, each time
// through a 13-tap filter, and brought back up through a 3x3 tent, each level mixed with the one below.
import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, uv, float, vec2, vec4, mix, min, luminance, smoothstep } from 'three/tsl';

const LEVELS = 8;
const _quad = new THREE.QuadMesh(), _size = new THREE.Vector2();
let _state;

class BloomNode extends THREE.TempNode {
  static get type() { return 'MipmapBloomNode'; }

  // input: a texture node holding the picture (linear, before tone mapping)
  constructor(input, { intensity = 1, threshold = 0.9, smoothing = 0.2, radius = 0.85 } = {}) {
    super('vec4');
    this.input = input;
    this.intensity = uniform(intensity);
    this.threshold = uniform(threshold);
    this.smoothing = uniform(smoothing);
    this.radius = uniform(radius);
    this.updateBeforeType = THREE.NodeUpdateType.FRAME;

    const target = () => new THREE.RenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType });
    this.bright = target();
    this.down = Array.from({ length: LEVELS }, target);
    this.up = Array.from({ length: LEVELS - 1 }, target);
    this.source = texture(this.bright.texture);  // what the pass at hand reads
    this.support = texture(this.bright.texture); // (upsampling: the level being added to)
    this.texel = uniform(new THREE.Vector2());
    this.result = texture(this.up[0].texture);
  }

  setSize(width, height) {
    if (this.bright.width === width && this.bright.height === height) return;
    this.bright.setSize(width, height);
    let w = width, h = height;
    for (let i = 0; i < LEVELS; i++) {
      w = Math.max(1, Math.round(w * 0.5)); h = Math.max(1, Math.round(h * 0.5));
      this.down[i].setSize(w, h);
      if (i < this.up.length) this.up[i].setSize(w, h);
    }
  }

  updateBefore({ renderer }) {
    if (this.intensity.value <= 0) return;
    _state = THREE.RendererUtils.resetRendererState(renderer, _state);
    const size = renderer.getDrawingBufferSize(_size);
    this.setSize(size.width, size.height);

    _quad.material = this.brightMaterial;
    renderer.setRenderTarget(this.bright);
    _quad.render(renderer);

    let previous = this.bright;
    _quad.material = this.downMaterial;
    for (const level of this.down) {
      this.source.value = previous.texture;
      this.texel.value.set(1 / previous.width, 1 / previous.height);
      renderer.setRenderTarget(level);
      _quad.render(renderer);
      previous = level;
    }
    _quad.material = this.upMaterial;
    for (let i = this.up.length - 1; i >= 0; i--) {
      this.source.value = previous.texture;
      this.support.value = this.down[i].texture;
      this.texel.value.set(1 / previous.width, 1 / previous.height);
      renderer.setRenderTarget(this.up[i]);
      _quad.render(renderer);
      previous = this.up[i];
    }
    THREE.RendererUtils.restoreRendererState(renderer, _state);
  }

  setup(builder) {
    const { source, support, texel } = this;
    const material = (name, node) => {
      const m = new THREE.NodeMaterial();
      m.name = name;
      m.fragmentNode = node.context(builder.getSharedContext());
      return m;
    };
    // the bright parts, in their colours
    this.brightMaterial = material('Bloom.bright', Fn(() => {
      const texel = this.input.sample(uv());
      return texel.mul(smoothstep(this.threshold, this.threshold.add(this.smoothing), luminance(texel.rgb)));
    })());
    // half the size: four taps round the middle weigh most, nine further out the rest; none from beyond the edge
    this.downMaterial = material('Bloom.down', Fn(() => {
      const at = uv(), sum = vec4(0).toVar();
      const tap = (x, y, weight) => {
        const p = at.add(texel.mul(vec2(x, y))).toVar();
        const inside = p.x.greaterThanEqual(0).and(p.x.lessThanEqual(1)).and(p.y.greaterThanEqual(0)).and(p.y.lessThanEqual(1));
        sum.addAssign(source.sample(p).mul(inside.select(float(weight), 0)));
      };
      for (const [x, y] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) tap(x, y, 0.125);
      for (const [x, y] of [[-2, 2], [0, 2], [2, 2], [-2, 0], [2, 0], [-2, -2], [0, -2], [2, -2]]) tap(x, y, 0.05556);
      sum.addAssign(source.sample(at).mul(0.05556));
      return sum;
    })());
    // back up: a 3x3 tent over the smaller level, mixed with the level of this size
    this.upMaterial = material('Bloom.up', Fn(() => {
      const at = uv(), sum = vec4(0).toVar();
      for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) sum.addAssign(source.sample(at.add(texel.mul(vec2(x, y)))).mul((x ? 1 : 2) * (y ? 1 : 2) / 16));
      return mix(support.sample(at), sum, this.radius);
    })());
    return this.result;
  }

  dispose() { for (const t of [this.bright, ...this.down, ...this.up]) t.dispose(); }
}

// The picture with its bloom laid over it (as a screen: light adds up, but never beyond white on white).
// Returns { node, intensity (a uniform) }.
export function bloomOver(input, options) {
  const bloom = new BloomNode(input, options);
  const node = Fn(() => {
    const base = input.sample(uv()).rgb, glow = bloom.rgb.mul(bloom.intensity);
    return base.add(glow).sub(min(base.mul(glow), 1));
  })();
  return { node, bloom, intensity: bloom.intensity };
}
