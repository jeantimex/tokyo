// Footbridges, station platforms and canopies (structures.json from tools/pipeline/extras.mjs), built once
// for the whole area.
import * as THREE from 'three/webgpu';
import { lampLit } from './lamplight.js';
import earcut from 'earcut';
import { Soup, sections } from './rails.js';

const CONCRETE = [0.66, 0.66, 0.64], STEEL = [0.4, 0.42, 0.44], PAVING = [0.56, 0.55, 0.52], ROOF = [0.8, 0.81, 0.82], EDGE = [0.9, 0.78, 0.2];

// Top and sides of a prism over a ring of [x, z], from y0 up to y1.
function prism(soup, ring, y0, y1, top, side) {
  const idx = earcut(ring.flat());
  for (let i = 0; i < idx.length; i += 3) {
    const [a, b, c] = [idx[i], idx[i + 1], idx[i + 2]].map((k) => [ring[k][0], y1, ring[k][1]]);
    soup.tri(a, b, c, top);
  }
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    soup.quad([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], side);
  }
}

export async function buildStructures(url, ground) {
  const { footbridges = [], platforms = [], canopies = [] } = await (await fetch(url)).json();
  const soup = new Soup();
  const at = (c, l, v) => [c.p[0] + c.n[0] * l, c.p[1] + v, c.p[2] + c.n[2] * l];
  const sweep = (a, b, profile, color) => { for (let j = 0; j + 1 < profile.length; j++) soup.quad(at(a, ...profile[j]), at(b, ...profile[j]), at(b, ...profile[j + 1]), at(a, ...profile[j + 1]), color); };

  // ---- footbridges and their stairs: a slab with railings, on piers where it is high
  for (const f of footbridges) {
    const cs = sections(f.pts, ground), w = f.width / 2;
    for (let i = 0; i + 1 < cs.length; i++) {
      const a = cs[i], b = cs[i + 1];
      if (Math.max(a.h, b.h) < 0.4) continue;
      sweep(a, b, [[-w, 0], [w, 0]], PAVING);                                  // deck
      sweep(a, b, [[-w, 0], [-w, -0.35], [w, -0.35], [w, 0]], CONCRETE);       // edges and underside
      for (const s of [-1, 1]) sweep(a, b, [[s * w, 0], [s * w, 1.1]], STEEL); // railings (seen from both sides)
    }
    if (!f.steps) for (const c of cs) {
      if (c.h > 3 && Math.round(c.s / 3) % 4 === 2) soup.box(c.p, c.t, c.n, 0.3, Math.min(0.5, w * 0.4), c.p[1] - c.h - 1, c.p[1] - 0.35, CONCRETE);
    }
  }

  // ---- platforms: a slab at train-floor height with a yellow safety edge; the big ones under a canopy
  for (const p of platforms) {
    const base = Math.min(...p.ring.map(([x, z]) => ground(x, z))) - 0.5;
    prism(soup, p.ring, Math.min(base, p.y - 1.2), p.y, PAVING, CONCRETE);
    // the tactile safety line just inside the edge, as a thin band on top
    const cx = p.ring.reduce((s, q) => s + q[0], 0) / p.ring.length, cz = p.ring.reduce((s, q) => s + q[1], 0) / p.ring.length;
    const inset = (k, d) => { const [x, z] = p.ring[k], l = Math.hypot(cx - x, cz - z) || 1; return [x + ((cx - x) / l) * d, p.y + 0.02, z + ((cz - z) / l) * d]; };
    for (let i = 0; i < p.ring.length; i++) { const j = (i + 1) % p.ring.length; soup.quad(inset(i, 0.6), inset(j, 0.6), inset(j, 0.95), inset(i, 0.95), EDGE); }
    if (p.covered) {
      const roof = p.ring.map((_, k) => { const q = inset(k, 0.4); return [q[0], q[2]]; });
      prism(soup, roof, p.y + 3.5, p.y + 3.7, ROOF, ROOF);
      for (let k = 0; k < p.ring.length; k += Math.max(1, Math.round(p.ring.length / 8))) { const q = inset(k, 1.6); soup.box([q[0], 0, q[2]], [1, 0, 0], [0, 0, 1], 0.08, 0.08, p.y, p.y + 3.5, STEEL); }
    }
  }

  // ---- canopies (building=roof): a roof slab on posts
  for (const c of canopies) {
    prism(soup, c.ring, c.y - 0.25, c.y, ROOF, ROOF);
    for (let k = 0; k < c.ring.length; k += Math.max(1, Math.ceil(c.ring.length / 6))) {
      const [x, z] = c.ring[k];
      soup.box([x, 0, z], [1, 0, 0], [0, 0, 1], 0.08, 0.08, ground(x, z), c.y - 0.25, STEEL);
    }
  }

  for (let i = 0; i < soup.col.length; i += 3) {
    const c = new THREE.Color().setRGB(soup.col[i], soup.col[i + 1], soup.col[i + 2], THREE.SRGBColorSpace);
    soup.col[i] = c.r; soup.col[i + 1] = c.g; soup.col[i + 2] = c.b;
  }
  const mesh = soup.mesh(lampLit(new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.05, side: THREE.DoubleSide })));
  mesh.name = 'structures';
  return mesh;
}
