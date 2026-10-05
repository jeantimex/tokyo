// Trains running on the railway lines. Each line's OSM ways are chained into paths (way direction =
// running direction); one train per path loops through the area, leaving at one edge and re-entering
// at the other.
import * as THREE from 'three/webgpu';
import { beamTexture } from './traffic.js';
import { LAMP_LAYER, lampMaterial } from './lamplight.js';

// Line name (substring) -> rolling stock. Colours follow the real line colours.
const STOCK = [
  { match: '山手貨物線', stripe: '#00a08e', body: '#c9ccce', cars: 10, length: 20 },  // Saikyo / Shonan-Shinjuku trains use the freight tracks
  { match: '山手線', stripe: '#8fc31f', body: '#c9ccce', cars: 11, length: 20 },
  { match: '埼京', stripe: '#00a08e', body: '#c9ccce', cars: 10, length: 20 },
  { match: '小田急', stripe: '#2a6fc9', body: '#d2d4d6', cars: 10, length: 20 },
  { match: '井の頭', stripe: '#e8709f', body: '#d2d4d6', cars: 5, length: 20 },
  { match: '銀座', stripe: '#8a4a1c', body: '#f2b62a', cars: 6, length: 16 },
];
const DEFAULT_STOCK = { stripe: '#7b8794', body: '#c9ccce', cars: 8, length: 20 };
const SPEED = 15;        // m/s
const GAP = 350;         // metres of pause before a train re-enters
const MIN_PATH = 260;

// The livery of one car, drawn into one picture (2048 x 512): plain body and underframe swatches in the top
// 16 px, the side of the car below them, the end of the car (cab window, lamps) in the lower left corner.
// The second picture is what shines: saloon windows, lamps and the destination sign.
const TEX_W = 2048, TEX_H = 512, SIDE_Y0 = 16, SIDE_Y1 = 256;
function carTextures(stock) {
  const side = document.createElement('canvas'), glow = document.createElement('canvas');
  side.width = glow.width = TEX_W; side.height = glow.height = TEX_H;
  const g = side.getContext('2d'), e = glow.getContext('2d');
  e.fillStyle = '#000'; e.fillRect(0, 0, TEX_W, TEX_H);
  g.fillStyle = stock.body; g.fillRect(0, 0, TEX_W, TEX_H);
  g.fillStyle = '#26282b'; g.fillRect(TEX_W / 2, 0, TEX_W / 2, SIDE_Y0);  // underframe swatch
  const glass = (x, y, w, h, lit = true) => {
    const k = g.createLinearGradient(0, y, 0, y + h);
    k.addColorStop(0, '#2c3a47'); k.addColorStop(0.5, '#151b21'); k.addColorStop(1, '#0c1014');
    g.fillStyle = '#5c6066'; g.fillRect(x - 3, y - 3, w + 6, h + 6);    // frame
    g.fillStyle = k; g.fillRect(x, y, w, h);
    if (lit) { e.fillStyle = '#fff0d0'; e.fillRect(x, y, w, h); }
  };
  // ---- the side
  const Y = SIDE_Y0, H = SIDE_Y1 - SIDE_Y0;
  const shade = g.createLinearGradient(0, Y, 0, Y + H);                  // a brushed body: lighter above, darker by the sill
  shade.addColorStop(0, 'rgba(255,255,255,0.16)'); shade.addColorStop(0.55, 'rgba(255,255,255,0)'); shade.addColorStop(1, 'rgba(0,0,0,0.24)');
  g.fillStyle = shade; g.fillRect(0, Y, TEX_W, H);
  g.fillStyle = 'rgba(0,0,0,0.1)'; for (let x = 0; x < TEX_W; x += 64) g.fillRect(x, Y, 1, H); // panel seams
  g.fillStyle = stock.stripe; g.fillRect(0, Y + 14, TEX_W, 12); g.fillRect(0, Y + 132, TEX_W, 18);
  g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillRect(0, Y + 150, TEX_W, 3);
  g.fillStyle = '#3a3d41'; g.fillRect(0, Y + H - 22, TEX_W, 22);         // skirt
  const doors = 4, pitch = TEX_W / doors;
  for (let d = 0; d < doors; d++) {
    const x = pitch * (d + 0.5);
    for (const [wx, ww] of [[x - pitch * 0.41, pitch * 0.25], [x + pitch * 0.16, pitch * 0.25]]) glass(wx, Y + 46, ww, 74); // windows between doors
    g.fillStyle = stock.stripe; g.fillRect(x - 54, Y + 30, 108, H - 52);  // door leaves in the line colour
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(x - 56, Y + 30, 2, H - 52); g.fillRect(x + 54, Y + 30, 2, H - 52);
    glass(x - 42, Y + 48, 34, 82); glass(x + 8, Y + 48, 34, 82);
    g.fillStyle = '#2a2c2f'; g.fillRect(x - 1, Y + 30, 3, H - 52);
  }
  // destination sign by the first door: amber on black, lit
  g.fillStyle = '#0a0a0a'; g.fillRect(pitch * 0.5 - 150, Y + 30, 70, 12);
  e.fillStyle = '#ffb030'; for (let k = 0; k < 6; k++) e.fillRect(pitch * 0.5 - 146 + k * 11, Y + 33, 8, 6);
  // ---- the end: a wide cab window over the line colour, lamps low down
  const EY = SIDE_Y1, ES = TEX_H - SIDE_Y1;
  g.fillStyle = stock.body; g.fillRect(0, EY, ES, ES);
  g.fillStyle = stock.stripe; g.fillRect(0, EY + ES * 0.52, ES, ES * 0.2);
  g.fillStyle = '#3a3d41'; g.fillRect(0, EY + ES * 0.9, ES, ES * 0.1);
  glass(ES * 0.1, EY + ES * 0.1, ES * 0.8, ES * 0.36, false);
  g.fillStyle = '#0a0a0a'; g.fillRect(ES * 0.3, EY + ES * 0.03, ES * 0.4, ES * 0.055);
  e.fillStyle = '#ffb030'; e.fillRect(ES * 0.33, EY + ES * 0.04, ES * 0.34, ES * 0.035);
  for (const sx of [0.16, 0.84]) {
    g.fillStyle = '#f6f2e4'; g.beginPath(); g.arc(ES * sx, EY + ES * 0.8, ES * 0.045, 0, Math.PI * 2); g.fill();
    e.fillStyle = '#fff6e0'; e.beginPath(); e.arc(ES * sx, EY + ES * 0.8, ES * 0.045, 0, Math.PI * 2); e.fill();
    g.fillStyle = '#c01818'; g.beginPath(); g.arc(ES * (sx < 0.5 ? sx + 0.1 : sx - 0.1), EY + ES * 0.8, ES * 0.03, 0, Math.PI * 2); g.fill();
    e.fillStyle = '#ff2a1a'; e.beginPath(); e.arc(ES * (sx < 0.5 ? sx + 0.1 : sx - 0.1), EY + ES * 0.8, ES * 0.03, 0, Math.PI * 2); e.fill();
  }
  const tex = (c) => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; };
  return { map: tex(side), emissiveMap: tex(glow) };
}

// Car body (floor 1 m above the rail), underframe, bogies and the boxes on the roof. The long sides show the
// side of the livery, the two ends its end; everything else takes a plain swatch.
function carGeometry(length) {
  const SWATCH = 1 - SIDE_Y0 / 2 / TEX_H;
  const plain = (geo, u) => { const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, u, SWATCH); return geo; };
  const body = new THREE.BoxGeometry(2.9, 2.75, length - 0.6).translate(0, 1.0 + 1.375, 0);
  const uv = body.attributes.uv, v0 = 1 - SIDE_Y1 / TEX_H, v1 = 1 - SIDE_Y0 / TEX_H, end = (TEX_H - SIDE_Y1) / TEX_W;
  // BoxGeometry faces: +x, -x, +y, -y, +z, -z (4 vertices each)
  for (let i = 0; i < uv.count; i++) {
    if (i < 8) uv.setY(i, v0 + uv.getY(i) * (v1 - v0));                           // the sides
    else if (i >= 16) uv.setXY(i, uv.getX(i) * end, uv.getY(i) * v0);             // the ends
    else uv.setXY(i, 0.25, SWATCH);                                                // roof and floor
  }
  const parts = [body, plain(new THREE.BoxGeometry(2.5, 0.85, length - 2.5).translate(0, 0.575, 0), 0.75)];
  for (const z of [-0.36, 0.36]) parts.push(plain(new THREE.BoxGeometry(2.3, 0.5, 3.2).translate(0, 0.25, z * length), 0.75));   // bogies
  for (const z of [-0.2, 0.2]) parts.push(plain(new THREE.BoxGeometry(1.9, 0.32, 3.6).translate(0, 3.75 + 0.16, z * length), 0.75)); // air conditioning
  const g = new THREE.BufferGeometry(), index = [];
  let count = 0;
  for (const name of ['position', 'normal', 'uv']) {
    const size = parts[0].attributes[name].itemSize, arr = new Float32Array(parts.reduce((s, p) => s + p.attributes[name].array.length, 0));
    let o = 0;
    for (const p of parts) { arr.set(p.attributes[name].array, o); o += p.attributes[name].array.length; }
    g.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  for (const p of parts) { index.push(...Array.from(p.index.array, (i) => i + count)); count += p.attributes.position.count; }
  g.setIndex(index);
  return g;
}

// Chains lines of the same name end to start into paths: [{ name, pts: [[x, y, z]], cum: [distance], length }].
function chain(lines) {
  const key = (x, z) => x.toFixed(1) + ',' + z.toFixed(1);
  const items = lines.map((l) => {
    const pts = [];
    for (let i = 0; i < l.pts.length; i += 3) pts.push([l.pts[i], l.pts[i + 1], l.pts[i + 2]]);
    return { name: l.name ?? '', pts, start: key(pts[0][0], pts[0][2]), end: key(pts.at(-1)[0], pts.at(-1)[2]), used: false };
  });
  const byStart = new Map();
  for (const it of items) { const k = it.name + '|' + it.start; if (!byStart.has(k)) byStart.set(k, []); byStart.get(k).push(it); }
  const ends = new Set(items.map((it) => it.name + '|' + it.end));
  const paths = [];
  // begin at lines nothing leads into, then sweep up any loops left over
  for (const it of [...items.filter((i) => !ends.has(i.name + '|' + i.start)), ...items]) {
    if (it.used) continue;
    const pts = [];
    for (let cur = it; cur && !cur.used; cur = (byStart.get(cur.name + '|' + cur.end) ?? []).find((n) => !n.used)) {
      cur.used = true;
      pts.push(...(pts.length ? cur.pts.slice(1) : cur.pts));
    }
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][2] - pts[i - 1][2]));
    if (cum.at(-1) >= MIN_PATH) paths.push({ name: it.name, pts, cum, length: cum.at(-1) });
  }
  return paths;
}

function pointAt(path, s, out) {
  const { pts, cum } = path;
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
  const t = (s - cum[lo]) / (cum[hi] - cum[lo] || 1), a = pts[lo], b = pts[hi];
  return out.set(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
}

export class Trains {
  constructor(lines) {
    this.group = new THREE.Group();
    this.group.name = 'trains';
    this.sets = [];
    const paths = chain(lines);
    this.beam = lampMaterial(beamTexture());
    const stocks = new Map(); // stock -> paths
    for (const p of paths) {
      const stock = STOCK.find((s) => p.name.includes(s.match)) ?? DEFAULT_STOCK;
      if (!stocks.has(stock)) stocks.set(stock, []);
      stocks.get(stock).push(p);
    }
    for (const [stock, list] of stocks) {
      const material = new THREE.MeshStandardMaterial({ ...carTextures(stock), roughness: 0.32, metalness: 0.55, emissive: 0xffffff, emissiveIntensity: 0 });
      const mesh = new THREE.InstancedMesh(carGeometry(stock.length), material, list.length * stock.cars);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false; // cars move across the whole area
      this.group.add(mesh);
      // the light of the leading car's headlamps on the track ahead (one pool per train; see the cars' in traffic.js)
      const pool = new THREE.BufferGeometry(), z0 = stock.length / 2 - 0.5, z1 = stock.length / 2 + 55;
      pool.setAttribute('position', new THREE.Float32BufferAttribute([-4.5, 0.12, z0, 4.5, 0.12, z0, 4.5, 0.12, z1, -4.5, 0.12, z0, 4.5, 0.12, z1, -4.5, 0.12, z1], 3));
      pool.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1], 2));
      const beams = new THREE.InstancedMesh(pool, this.beam, list.length);
      beams.frustumCulled = false;
      beams.layers.set(LAMP_LAYER);
      this.group.add(beams);
      this.sets.push({ stock, mesh, beams, material, trains: list.map((path, i) => ({ path, s: (i * 613) % (path.length + GAP) })) });
    }
    this.dummy = new THREE.Object3D();
    this.a = new THREE.Vector3(); this.b = new THREE.Vector3();
  }

  update(dt, night) {
    const { dummy, a, b } = this;
    this.beam.color.setRGB(2.2 * night, 2.1 * night, 1.8 * night);
    this.beam.visible = night > 0.02;
    for (const { stock, mesh, beams, material, trains } of this.sets) {
      material.emissiveIntensity = 0.2 + night * 2.2; // the saloon lights and the lamps are always on
      let n = 0;
      trains.forEach((t, ti) => {
        const span = t.path.length + stock.cars * stock.length + GAP;
        t.s = (t.s + SPEED * dt) % span; // distance of the train's nose from the start of the path
        for (let c = 0; c < stock.cars; c++, n++) {
          const centre = t.s - (c + 0.5) * stock.length, half = stock.length * 0.36;
          if (centre - half < 0 || centre + half > t.path.length) { dummy.scale.setScalar(0); dummy.updateMatrix(); mesh.setMatrixAt(n, dummy.matrix); if (c === 0) beams.setMatrixAt(ti, dummy.matrix); continue; }
          pointAt(t.path, centre + half, a); pointAt(t.path, centre - half, b); // the two bogies
          dummy.position.copy(a).add(b).multiplyScalar(0.5);
          dummy.position.y += 0.16; // on top of the rails
          dummy.scale.setScalar(1);
          dummy.lookAt(a.x, a.y + 0.16, a.z);
          dummy.updateMatrix();
          mesh.setMatrixAt(n, dummy.matrix);
          if (c === 0) beams.setMatrixAt(ti, dummy.matrix);
        }
      });
      mesh.instanceMatrix.needsUpdate = true;
      beams.instanceMatrix.needsUpdate = true;
    }
  }
}
