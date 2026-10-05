// The land around an area: coarse terrain (backdrop.bin, a height grid some tens of kilometres wide) under an
// aerial photo — a coarse one of all of it and a sharper one of the land just beyond the last houses. It is
// what stands on the horizon (Mt Fuji behind Fujinomiya) and has no buildings. High ground carries snow.
import * as THREE from 'three/webgpu';
import { Fn, texture, vec2, vec3, min, mix, smoothstep, atan, length, positionWorld } from 'three/tsl';
import { vnoise } from './materials.js';

const MAX = 4096;          // photo texture pixels along a side
const SINK = 40;           // metres the backdrop is sunk under the area itself, so the detailed ground covers it
const SNOW_LINE = 2500;    // metres: about where the snow of a winter mountain ends (ragged, lower in the gullies)

const tileLon = (x, z) => (x / 2 ** z) * 360 - 180;
const tileLat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

// The photo tiles in `dir` (index.json: { z, x0, x1, y0, y1 }) as one texture, and the rectangle it covers in the
// area's metres: { texture, rect: [x0, z0, width, depth] }, or null without tiles. clip: [x0, z0, width, depth]
// to keep to (the tiles may reach further).
async function photo(dir, proj, renderer, clip) {
  const tiles = await fetch(`${dir}/index.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!tiles) return null;
  const { z, x0, x1, y0, y1 } = tiles;
  let [ax, az] = proj.project(tileLon(x0, z), tileLat(y0, z)), [bx, bz] = proj.project(tileLon(x1 + 1, z), tileLat(y1 + 1, z));
  if (clip) { ax = Math.max(ax, clip[0]); az = Math.max(az, clip[1]); bx = Math.min(bx, clip[0] + clip[2]); bz = Math.min(bz, clip[1] + clip[3]); }
  const k = MAX / Math.max(bx - ax, bz - az);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round((bx - ax) * k); canvas.height = Math.round((bz - az) * k);
  const g = canvas.getContext('2d');
  g.fillStyle = '#2c4a5e'; g.fillRect(0, 0, canvas.width, canvas.height); // (no photo: the sea)
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    jobs.push(fetch(`${dir}/${z}_${x}_${y}.jpg`).then((r) => (r.ok ? r.blob() : null)).then((blob) => blob && createImageBitmap(blob)).then((img) => {
      if (!img) return;
      // (over one tile the Mercator grid is as good as linear in the area's metres)
      const [px, pz] = proj.project(tileLon(x, z), tileLat(y, z)), [qx, qz] = proj.project(tileLon(x + 1, z), tileLat(y + 1, z));
      g.drawImage(img, (px - ax) * k, (pz - az) * k, (qx - px) * k + 0.5, (qz - pz) * k + 0.5);
    }).catch(() => {}));
  }
  await Promise.all(jobs);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.getMaxAnisotropy();
  return { texture, rect: [ax, az, bx - ax, bz - az] };
}

// base: the area's tile directory; photoBase: its backdrop photo tiles; proj: makeProjection() of the area.
export async function loadBackdrop(base, photoBase, manifest, proj, renderer) {
  const { file, x0, z0, step, w, h } = manifest.backdrop, b = manifest.bounds;
  const heights = new Float32Array(await (await fetch(`${base}/${file}`)).arrayBuffer());
  const rect = [x0, z0, (w - 1) * step, (h - 1) * step];

  // ---- the terrain: every grid cell; under the area itself it lies sunk below the detailed ground (and shows
  // where that has not been loaded yet)
  const pos = new Float32Array(w * h * 3);
  const inside = (x, z, m) => x > b.minX - m && x < b.maxX + m && z > b.minZ - m && z < b.maxZ + m;
  let top = 0;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i, x = x0 + i * step, z = z0 + j * step;
    pos.set([x, heights[k] - (inside(x, z, 0) ? SINK : 0), z], k * 3);
    if (heights[k] > heights[top]) top = k;
  }
  const index = [];
  for (let j = 0; j + 1 < h; j++) for (let i = 0; i + 1 < w; i++) {
    const a = j * w + i, c = a + w;
    index.push(a, c, a + 1, a + 1, c, c + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();

  const [far, near] = await Promise.all([photo(photoBase, proj, renderer, rect), photo(`${photoBase}/near`, proj, renderer)]);
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  const fbm = (p) => vnoise(p).mul(0.5).add(vnoise(p.mul(2.03)).mul(0.25)).add(vnoise(p.mul(4.01)).mul(0.125)).add(vnoise(p.mul(8.1)).mul(0.0625));
  const peak = vec2(pos[top * 3], pos[top * 3 + 2]); // the highest summit: its snow runs down from there
  material.colorNode = Fn(() => {
    const at = positionWorld;
    // the photo: the sharp one near the area, the coarse one beyond
    const land = vec3(far ? 1 : 0.16).toVar();
    if (far) {
      const fu = at.xz.sub(vec2(far.rect[0], far.rect[1])).div(vec2(far.rect[2], far.rect[3]));
      land.assign(texture(far.texture, vec2(fu.x, fu.y.oneMinus())).rgb);
    }
    if (near) {
      const nu = at.xz.sub(vec2(near.rect[0], near.rect[1])).div(vec2(near.rect[2], near.rect[3])).toVar();
      const edge = min(nu, nu.oneMinus());
      const sharp = smoothstep(0, 0.06, min(edge.x, edge.y));
      land.assign(mix(land, texture(near.texture, vec2(nu.x, nu.y.oneMinus())).rgb, sharp));
    }
    // snow: above a ragged line, reaching further down in the gullies that run from the summit
    const fromPeak = at.xz.sub(peak).toVar();
    const around = atan(fromPeak.y, fromPeak.x), out = length(fromPeak);
    const gully = fbm(vec2(around.mul(28), out.mul(0.00025))).sub(0.47);
    const line = gully.mul(520).add(SNOW_LINE).add(fbm(at.xz.mul(0.0012)).sub(0.47).mul(260)).toVar();
    const snow = smoothstep(line.sub(90), line.add(160), at.y).mul(vnoise(at.xz.mul(0.02)).mul(0.18).add(0.82));
    return mix(land, vec3(0.93, 0.95, 0.98), snow);
  })();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'backdrop';
  mesh.frustumCulled = false;
  return mesh;
}
