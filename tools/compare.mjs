// Compares two captures of the same view (the WebGPU build and the WebGL reference): mean colour over a grid
// of regions, and a side-by-side picture. Usage: node tools/compare.mjs <a.png> <b.png> [out.jpg]
import sharp from 'sharp';

const [a, b, out] = process.argv.slice(2);
const W = 640, H = 448, GX = 4, GY = 3;
const load = (f) => sharp(f).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer();
const [pa, pb] = await Promise.all([load(a), load(b)]);
const mean = (p, gx, gy) => {
  const s = [0, 0, 0]; let n = 0;
  for (let y = Math.floor((gy * H) / GY); y < Math.floor(((gy + 1) * H) / GY); y++)
    for (let x = Math.floor((gx * W) / GX); x < Math.floor(((gx + 1) * W) / GX); x++) { const i = (y * W + x) * 3; s[0] += p[i]; s[1] += p[i + 1]; s[2] += p[i + 2]; n++; }
  return s.map((v) => Math.round(v / n));
};
let total = 0;
for (let gy = 0; gy < GY; gy++) {
  const row = [];
  for (let gx = 0; gx < GX; gx++) { const m = mean(pa, gx, gy), r = mean(pb, gx, gy); total += Math.abs(m[0] - r[0]) + Math.abs(m[1] - r[1]) + Math.abs(m[2] - r[2]); row.push(`${m.join(',')} | ${r.join(',')}`); }
  console.log(row.join('    '));
}
let diff = 0;
for (let i = 0; i < pa.length; i++) diff += Math.abs(pa[i] - pb[i]);
console.log(`regions: mean abs difference ${(total / (GX * GY * 3)).toFixed(1)} / 255; pixels: ${(diff / pa.length).toFixed(1)} / 255   (left of each pair: ${a.split(/[\/]/).pop()}, right: ${b.split(/[\/]/).pop()})`);
if (out) {
  const img = (p) => sharp(p, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  await sharp({ create: { width: W * 2 + 8, height: H, channels: 3, background: '#000' } }).composite([{ input: await img(pa), left: 0, top: 0 }, { input: await img(pb), left: W + 8, top: 0 }]).jpeg({ quality: 88 }).toFile(out);
}
