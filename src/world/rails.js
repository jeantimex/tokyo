// Railways: track bed, rails, viaducts with piers, retaining walls and overhead-line masts, built
// once for the whole area from rails.json (height profile from tools/pipeline/rails.mjs).
import * as THREE from 'three/webgpu';
import { Trains } from './trains.js';

const STEP = 3;            // metres between cross-sections
const GAUGE = 1.067;       // Japanese narrow gauge
const VIADUCT_ABOVE = 2.0; // rail level this far above the ground gets a deck on piers; lower, walled fill
const PIER_SPACING = 16, MAST_SPACING = 40;

// Flat list of triangles with a colour per vertex; normals come from the faces.
export class Soup {
  constructor() { this.pos = []; this.col = []; this.uv = []; }
  quad(a, b, c, d, color, uvs) { this.tri(a, b, c, color, uvs && [uvs[0], uvs[1], uvs[2]]); this.tri(a, c, d, color, uvs && [uvs[0], uvs[2], uvs[3]]); }
  tri(a, b, c, color, uvs) {
    this.pos.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) this.col.push(...color);
    if (uvs) this.uv.push(...uvs[0], ...uvs[1], ...uvs[2]);
  }
  // Axis-aligned-in-its-own-frame box: centre c, half extents along the unit vectors t (along), n (across) and up.
  box(c, t, n, ht, hn, y0, y1, color) {
    const P = (st, sn, y) => [c[0] + t[0] * ht * st + n[0] * hn * sn, y, c[2] + t[2] * ht * st + n[2] * hn * sn];
    for (const [s1, s2] of [[-1, -1], [1, -1], [1, 1], [-1, 1]].map((v, i, a) => [v, a[(i + 1) % 4]]))
      this.quad(P(s1[0], s1[1], y0), P(s2[0], s2[1], y0), P(s2[0], s2[1], y1), P(s1[0], s1[1], y1), color);
    this.quad(P(-1, -1, y1), P(1, -1, y1), P(1, 1, y1), P(-1, 1, y1), color);
  }
  mesh(material) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.uv.length) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, material);
    m.castShadow = m.receiveShadow = true;
    return m;
  }
}

// Ballast with two concrete sleepers per 1.3 m of track.
function bedTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d'), img = g.createImageData(128, 128);
  for (let i = 0; i < 128 * 128; i++) {
    const n = 0.75 + 0.5 * Math.random();
    img.data[i * 4] = 104 * n; img.data[i * 4 + 1] = 96 * n; img.data[i * 4 + 2] = 88 * n; img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  g.fillStyle = '#9d9c97';
  for (const y of [20, 84]) g.fillRect(16, y, 96, 22);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// Cross-sections every STEP metres along a polyline of [x, y, z] triples:
// { p: [x, y, z], t: unit tangent, n: unit right, s: distance along, h: height above the ground }.
export function sections(pts, ground) {
  const P = [];
  for (let i = 0; i < pts.length; i += 3) P.push([pts[i], pts[i + 1], pts[i + 2]]);
  const out = [];
  let s = 0, next = 0;
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i], len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (len < 0.01) continue;
    const t = [(b[0] - a[0]) / len, 0, (b[2] - a[2]) / len];
    while (next <= s + len + 1e-6) {
      const k = (next - s) / len, p = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
      out.push({ p, t, n: [-t[2], 0, t[0]], s: next, h: p[1] - ground(p[0], p[2]) });
      next += STEP;
    }
    s += len;
  }
  // always end exactly on the last point: the next way starts there, and a dropped partial step would
  // leave a gap between the two
  const end = P.at(-1), tail = out.at(-1);
  if (tail && Math.hypot(end[0] - tail.p[0], end[2] - tail.p[2]) > 0.05)
    out.push({ p: [...end], t: tail.t, n: tail.n, s, h: end[1] - ground(end[0], end[2]) });
  // smooth the direction across OSM vertices so the track does not kink
  for (let i = 1; i < out.length - 1; i++) {
    const tx = out[i + 1].p[0] - out[i - 1].p[0], tz = out[i + 1].p[2] - out[i - 1].p[2], l = Math.hypot(tx, tz) || 1;
    out[i].t = [tx / l, 0, tz / l]; out[i].n = [-tz / l, 0, tx / l];
  }
  return out;
}

// ground(x, z): terrain height; cover(x, z): what is overhead for a track passing there — the terrain, or a
// bridge deck (makeCover in src/shared/decks.js).
export async function buildRailways(url, ground, cover = ground) {
  const lines = await (await fetch(url)).json();
  const concrete = [0.64, 0.64, 0.62], steel = [0.33, 0.31, 0.3], white = [1, 1, 1];
  const bed = new Soup(), structure = new Soup(), wires = [];
  // point at lateral offset l and height v above the rail bed of a section
  const at = (c, l, v) => [c.p[0] + c.n[0] * l, c.p[1] + v, c.p[2] + c.n[2] * l];
  // sweep a cross-section profile ([lateral, vertical] points, or a function of the section) between sections
  const sweep = (soup, a, b, profile, color) => {
    const pa = typeof profile === 'function' ? profile(a) : profile, pb = typeof profile === 'function' ? profile(b) : profile;
    for (let j = 0; j + 1 < pa.length; j++)
      soup.quad(at(a, ...pa[j]), at(b, ...pb[j]), at(b, ...pb[j + 1]), at(a, ...pa[j + 1]), color);
  };

  // Which sections have another track right beside them? Those sides get deck instead of a parapet.
  const tracks = lines.map((line) => sections(line.pts, ground));
  const CELL = 6, near = new Map();
  tracks.forEach((cs, li) => cs.forEach((c) => {
    const k = Math.floor(c.p[0] / CELL) + ',' + Math.floor(c.p[2] / CELL);
    if (!near.has(k)) near.set(k, []);
    near.get(k).push([c, li]);
  }));
  const beside = (c, li, side) => { // another line's track 2.5 - 6 m to this side, at about the same level
    for (const d of [3.2, 4.6]) {
      const x = c.p[0] + c.n[0] * side * d, z = c.p[2] + c.n[2] * side * d, ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
      for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++)
        for (const [o, oi] of near.get(i + ',' + j) ?? [])
          if (oi !== li && Math.abs(o.p[1] - c.p[1]) < 1.2 && Math.hypot(o.p[0] - x, o.p[2] - z) < 2.3) return true;
    }
    return false;
  };
  tracks.forEach((cs, li) => cs.forEach((c) => { c.left = beside(c, li, -1); c.right = beside(c, li, 1); }));
  // on a bridge that the tiles bring as a model (line.deck: stretches in metres along the line): track only
  tracks.forEach((cs, li) => cs.forEach((c) => { c.deck = (lines[li].deck ?? []).some(([from, to]) => c.s >= from - 0.5 && c.s <= to + 0.5); }));

  lines.forEach((line, li) => {
    const cs = tracks[li];
    for (let i = 0; i + 1 < cs.length; i++) {
      const a = cs[i], b = cs[i + 1], h = Math.min(a.h, b.h);
      bed.quad(at(a, -1.4, 0), at(b, -1.4, 0), at(b, 1.4, 0), at(a, 1.4, 0), white,
        [[0, a.s / 1.3], [0, b.s / 1.3], [1, b.s / 1.3], [1, a.s / 1.3]]);
      for (const c of [-GAUGE / 2, GAUGE / 2])
        sweep(structure, a, b, [[c - 0.035, 0.0], [c - 0.035, 0.16], [c + 0.035, 0.16], [c + 0.035, 0.0]], steel);
      // per side (s = -1 left, 1 right): open to a neighbouring track, or closed by a parapet / wall
      const open = { '-1': a.left && b.left, 1: a.right && b.right };
      if (a.deck && b.deck) continue;
      if (h > VIADUCT_ABOVE) {
        sweep(structure, a, b, [[-(open[-1] ? 2.6 : 2.2), -0.9], [open[1] ? 2.6 : 2.2, -0.9]], concrete); // underside
        for (const s of [-1, 1]) {
          if (open[s]) sweep(structure, a, b, [[s * 1.4, -0.03], [s * 2.6, -0.03]], concrete);          // shared deck
          else sweep(structure, a, b, [[s * 1.4, -0.03], [s * 2.05, -0.03], [s * 2.05, 1.0], [s * 2.2, 1.0], [s * 2.2, -0.9]], concrete);
        }
      } else if (Math.max(a.h, b.h) > 0.6) {
        // low fill: level ground between tracks, a retaining wall on the outside
        for (const s of [-1, 1]) {
          if (open[s]) sweep(structure, a, b, [[s * 1.4, 0], [s * 2.6, -0.03]], concrete);
          else sweep(structure, a, b, (c) => [[s * 1.4, 0], [s * 1.95, -0.03], [s * 1.95, -Math.max(c.h, 0) - 0.3]], concrete);
        }
      }
    }
    // contact wire and the messenger wire sagging above it, from the previous support to this one
    // Under a road bridge the wires are fixed to the bridge instead of masts, as low as it takes to clear it.
    const headroom = (c) => { const top = cover(c.p[0], c.p[2]) - c.p[1]; return top > 2.5 ? top - 1.6 : Infinity; };
    const wire = (from, c) => {
      const lo = Math.min(5.2, headroom(c) - 0.6), hi = Math.min(5.9, headroom(c));
      c.wire = [lo, hi];
      if (from) {
        wires.push(...at(from, 0, from.wire[0]), ...at(c, 0, lo));
        const sag = Math.min(0.45, (from.wire[1] - from.wire[0] + hi - lo) / 4);
        const mid = [(from.p[0] + c.p[0]) / 2, (from.p[1] + c.p[1]) / 2 + (from.wire[1] + hi) / 2 - sag, (from.p[2] + c.p[2]) / 2];
        wires.push(...at(from, 0, from.wire[1]), ...mid, ...mid, ...at(c, 0, hi));
      }
      return c;
    };
    // piers under the deck, overhead-line masts beside the track
    const electrified = line.railway !== 'subway'; // the Ginza Line runs on a third rail
    let mastPrev = null;
    cs.forEach((c, i) => {
      if (!c.deck && c.h > VIADUCT_ABOVE + 0.5 && Math.round(c.s / STEP) % Math.round(PIER_SPACING / STEP) === 0)
        structure.box(c.p, c.t, c.n, 0.7, 1.3, c.p[1] - c.h - 1.5, c.p[1] - 0.9, concrete);
      if (electrified && headroom(c) < 7) { mastPrev = wire(mastPrev, c); return; } // under a bridge: no mast
      if (electrified && (Math.round(c.s / STEP) % Math.round(MAST_SPACING / STEP) === 0 || i === cs.length - 1)) {
        // the mast stands on the outer side; a track with neighbours on both sides hangs its wires from theirs
        const side = c.right && !c.left ? -2.45 : 2.45, foot = at(c, side, 0);
        if (c.left && c.right) { mastPrev = wire(mastPrev, c); return; }
        structure.box(foot, c.t, c.n, 0.09, 0.09, c.p[1] - (c.h > VIADUCT_ABOVE ? 0 : Math.max(c.h, 0)), c.p[1] + 6.4, steel);
        structure.box(at(c, side / 2 - Math.sign(side) * 0.2, 0), c.t, c.n, 0.05, Math.abs(side) / 2 + 0.2, c.p[1] + 5.95, c.p[1] + 6.05, steel);
        mastPrev = wire(mastPrev, c);
      }
    });
  });

  // Tunnel mouths where a track runs into a building (the station halls are solid blocks in the data):
  // a black opening set just proud of the wall, with a concrete lintel over it.
  const mouths = new Soup();
  for (const line of lines) for (const [x, y, z, dx, dz, tunnel] of line.portals ?? []) {
    const c = [x - dx * 0.35, y, z - dz * 0.35], t = [dx, 0, dz], n = [-dz, 0, dx];
    // Running under a road bridge or into rising ground, that is the portal: the opening fills the space beneath it.
    const top = cover(x + dx * 3, z + dz * 3) - y;
    if (top > 2.5 && top < 7.5) {
      mouths.box(c, t, n, 0.4, 2.25, y - 0.3, y + Math.min(5.4, top - 0.4), [0.012, 0.012, 0.015]);
      continue;
    }
    mouths.box(c, t, n, 0.4, 2.25, y - 0.3, y + 5.4, [0.012, 0.012, 0.015]);
    structure.box([x - dx * 0.5, y, z - dz * 0.5], t, n, 0.3, 2.6, y + 5.4, y + 6.0, concrete);
    // where the line goes underground in the open, the mouth needs something to be in: a concrete portal
    // (down to the ground, so a portal at viaduct height does not float)
    if (tunnel) structure.box([x + dx * 6, y, z + dz * 6], t, n, 6, 2.9, Math.min(y - 1.5, ground(x + dx * 6, z + dz * 6) - 1), y + 6.0, concrete);
  }

  const group = new THREE.Group();
  group.name = 'railways';
  if (mouths.pos.length) {
    const m = mouths.mesh(new THREE.MeshBasicMaterial({ vertexColors: true }));
    m.castShadow = false;
    group.add(m);
  }
  const lin = (c) => new THREE.Color().setRGB(...c, THREE.SRGBColorSpace);
  for (const soup of [bed, structure]) for (let i = 0; i < soup.col.length; i += 3) {
    const c = lin(soup.col.slice(i, i + 3));
    soup.col[i] = c.r; soup.col[i + 1] = c.g; soup.col[i + 2] = c.b;
  }
  group.add(bed.mesh(new THREE.MeshStandardMaterial({ map: bedTexture(), roughness: 0.95 })));
  group.add(structure.mesh(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0.05, side: THREE.DoubleSide })));
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3));
  group.add(new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x14161a })));
  const trains = new Trains(lines);
  group.add(trains.group);
  group.userData.trains = trains; // call trains.update(dt, night) every frame
  return group;
}
