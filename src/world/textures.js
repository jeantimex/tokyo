// Loads the CC0 texture sets (public/textures, see tools/assets/fetch_textures.mjs) into texture arrays:
// one array of wall finishes and one of ground surfaces, each with a matching normal-map array.
//
// Albedo layers are stored as *detail*: each channel is divided by the layer's mean, so a sample
// averages 1.0 (stored halved to fit 8 bits). The shader multiplies it by the surface's own colour, which
// lets one tile texture serve white, beige and brown buildings alike.
import * as THREE from 'three/webgpu';

const SIZE = 1024;

// Layer order matches WALL / GROUND in constants.js. `scale` = metres per texture repeat;
// `detail` = how strongly the texture's own light and dark shows (plaster photographs blotchy).
export const WALL_LAYERS = [
  { key: 'wall_tile', scale: 1.3, detail: 0.8 },
  { key: 'wall_concrete', scale: 3.2, detail: 0.75 },
  { key: 'wall_plaster', scale: 2.6, detail: 0.3 },
  { key: 'wall_brick', scale: 0.85, detail: 0.8 },
  { key: 'wall_siding', scale: 1.6, detail: 0.6 },
  { key: 'roof', scale: 5.0, detail: 0.6 },
];

export const GROUND_LAYERS = [
  { key: 'asphalt', scale: 5.0 },
  { key: 'pavers', scale: 2.2 },
  { key: 'grass', scale: 3.0 },
  { key: 'ground', scale: 4.0 },
];

async function pixels(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  const canvas = new OffscreenCanvas(SIZE, SIZE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, SIZE, SIZE);
  return ctx.getImageData(0, 0, SIZE, SIZE).data;
}

const toLinear = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });

function detail(px) {
  const mean = [0, 0, 0], n = px.length / 4;
  for (let i = 0; i < px.length; i += 4) for (let c = 0; c < 3; c++) mean[c] += toLinear[px[i + c]];
  const out = new Uint8Array(px.length);
  for (let i = 0; i < px.length; i += 4) {
    for (let c = 0; c < 3; c++) out[i + c] = Math.min(255, Math.round((toLinear[px[i + c]] / (mean[c] / n)) * 127.5));
    out[i + 3] = 255;
  }
  return out;
}

function arrayTexture(layers, renderer) {
  const data = new Uint8Array(SIZE * SIZE * 4 * layers.length);
  layers.forEach((l, i) => data.set(l, i * SIZE * SIZE * 4));
  const t = new THREE.DataArrayTexture(data, SIZE, SIZE, layers.length);
  t.format = THREE.RGBAFormat;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = Math.min(8, renderer.getMaxAnisotropy());
  t.needsUpdate = true;
  return t;
}

async function loadSet(defs, renderer) {
  const [diff, nor] = await Promise.all([
    Promise.all(defs.map((d) => pixels(`textures/${d.key}/diff.jpg`).then(detail))),
    Promise.all(defs.map((d) => pixels(`textures/${d.key}/nor.jpg`))),
  ]);
  return { albedo: arrayTexture(diff, renderer), normal: arrayTexture(nor, renderer), scales: defs.map((d) => d.scale), details: defs.map((d) => d.detail ?? 1) };
}

export async function loadTextures(renderer) {
  const [wall, ground] = await Promise.all([loadSet(WALL_LAYERS, renderer), loadSet(GROUND_LAYERS, renderer)]);
  return { wall, ground };
}
