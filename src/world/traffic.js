// Cars on the road graph (roads.json), kept around the camera only: a car that falls too far behind is
// put back on a road near the focus.
//
// Rules of the road, as far as this goes:
//   - keep left; one-way streets one way only; speed from the limit of the road
//   - follow the vehicle ahead with a time gap, including the one just past the next junction
//   - stop at red and yellow lights (the same cycle as the signal heads in props.js)
//   - a junction is crossed by one approach at a time (opposing traffic going straight on may cross
//     together); without lights, a side street gives way to the bigger road and slows right down first (止まれ)
//   - where lanes merge, vehicles queue instead of entering side by side
//   - never enter a junction without room on the far side
import * as THREE from 'three/webgpu';
import { attribute, varyingProperty, select, vec3, vec4, float, max, output } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { shared } from './materials.js';
import { LAMP_LAYER, lampMaterial } from './lamplight.js';

const LANE = 3.0;
const CAR_RADIUS = 330, CARS = 260; // the default number of cars, and the distance from the focus they keep within
export const MAX_CARS = 1500;
const CYCLE = 64, GREEN = 27; // seconds: must match the lens shader in props.js

// ---------------------------------------------------------------- models
// Parts carry a colour and a code per vertex (aGlow): 0 paint, 1 headlamp, 2 tail lamp, 3 glass, 4 rubber and
// trim. Paint of colour 1,1,1 is tinted per car by the instance colour; glass and trim are dark, so the tint
// barely shows on them.
function finish(g, rgb, code) {
  g = g.index ? g.toNonIndexed() : g;
  const n = g.attributes.position.count, c = new Float32Array(n * 3), e = new Float32Array(n);
  for (let i = 0; i < n; i++) { c.set(rgb, i * 3); e[i] = code; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  g.setAttribute('aGlow', new THREE.BufferAttribute(e, 1));
  g.deleteAttribute('uv');
  return g;
}
const part = (w, h, d, x, y, z, rgb, code = 0) => finish(new THREE.BoxGeometry(w, h, d).translate(x, y, z), rgb, code);
// A block that narrows and shortens towards its top: width w0 and length zA0..zB0 at y0, w1 and zA1..zB1 at y1.
function taper(w0, w1, y0, y1, zA0, zB0, zA1, zB1, rgb, code = 0) {
  const g = new THREE.BoxGeometry(1, 1, 1), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const top = p.getY(i) > 0, front = p.getZ(i) > 0;
    p.setXYZ(i, p.getX(i) * (top ? w1 : w0), top ? y1 : y0, top ? (front ? zB1 : zA1) : (front ? zB0 : zA0));
  }
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  return finish(flat, rgb, code);
}
const wheel = (r, x, z) => [
  finish(new THREE.CylinderGeometry(r, r, 0.24, 14).rotateZ(Math.PI / 2).translate(x, r, z), TYRE, 4),
  finish(new THREE.CylinderGeometry(r * 0.58, r * 0.58, 0.25, 10).rotateZ(Math.PI / 2).translate(x, r, z), [0.55, 0.56, 0.58], 4),
];
const PAINT = [1, 1, 1], GLASS = [0.03, 0.04, 0.05], TYRE = [0.015, 0.015, 0.015], TRIM = [0.05, 0.05, 0.055], LAMP = [1, 1, 1];
// A vehicle along +z: length L, width W, body up to `belt`, cabin from z0 to z1 (fractions of L) up to `roof`,
// its windscreen leaning back by `rake` metres.
function vehicle({ L, W, belt, roof, z0, z1, box, rake = 0.5, tyre = 0.31 }) {
  const zr = -L / 2, zf = L / 2, sill = 0.24, parts = [];
  parts.push(taper(W * 0.97, W, sill, belt, zr + 0.06, zf - 0.06, zr, zf - 0.02, PAINT));                 // body
  parts.push(part(W * 1.01, 0.16, L + 0.06, 0, sill + 0.04, 0, TRIM, 4));                                // bumpers and sills
  const c0 = zr + z0 * L, c1 = zr + z1 * L, back = rake * 0.6, zm = (c0 + c1) / 2;
  parts.push(taper(W * 0.9, W * 0.76, belt, roof, c0, c1, c0 + back, c1 - rake, GLASS, 3));               // glasshouse
  parts.push(taper(W * 0.78, W * 0.72, roof - 0.02, roof + 0.05, c0 + back - 0.02, c1 - rake + 0.02, c0 + back + 0.1, c1 - rake - 0.1, PAINT)); // roof
  if (c1 - c0 > 2.2) parts.push(taper(W * 0.905, W * 0.765, belt, roof, zm - 0.07, zm + 0.07, zm - 0.07, zm + 0.07, PAINT)); // the pillar between the doors
  if (box) parts.push(part(W, box.h, box.len * L, 0, belt + box.h / 2, (box.z - 0.5) * L, [0.92, 0.92, 0.9])); // cargo body (not tinted much)
  parts.push(part(W * 0.5, 0.16, 0.05, 0, belt - 0.3, zf, TRIM, 4));                                      // grille
  for (const z of [zf + 0.01, zr - 0.01]) parts.push(part(0.34, 0.13, 0.03, 0, sill + 0.22, z, [0.9, 0.9, 0.86], 4)); // number plates
  for (const sx of [-1, 1]) {
    const far = L > 8 ? 0.34 : 0.31;
    for (const wz of [far, -far]) parts.push(...wheel(tyre, sx * (W / 2 - 0.1), wz * L));
    parts.push(part(0.38, 0.15, 0.07, sx * (W / 2 - 0.26), belt - 0.2, zf - 0.02, LAMP, 1));
    parts.push(part(0.36, 0.13, 0.07, sx * (W / 2 - 0.24), belt - 0.18, zr + 0.02, LAMP, 2));
    parts.push(part(0.1, 0.1, 0.16, sx * (W / 2 + 0.03), belt + 0.08, c1 - rake * 0.5, PAINT));           // mirrors
  }
  return mergeGeometries(parts);
}
// What the lamps throw on the road: a long pool ahead of the car and a short red one behind it, as one
// instanced mesh per vehicle type that shares the cars' own matrices. Like the street lamps' pools
// (props.js), it multiplies the road under it.
export function beamTexture() {
  const W = 128, H = 128, data = new Uint8Array(W * H * 4), step = THREE.MathUtils.smoothstep;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    // A fan opening from the lamps (the middle of the near edge) to the full width of the quad at its far
    // end: straight sides that fade softly, a rounded far edge, brightest near the car.
    const u = ((i + 0.5) / W) * 2 - 1, v = (j + 0.5) / H;
    const side = 1 - step(Math.abs(u) / Math.max(v, 0.03), 0.3, 0.98);   // inside the two straight edges, which fade out widely
    const reach = 1 - step(Math.hypot(u * 0.55, v), 0.55, 0.99);          // the arc at the far end
    const value = side * reach * step(v, 0, 0.06) * (0.1 + 0.9 * Math.exp(-v * 3.4));
    data.set([value * 255, value * 255, value * 255, 255], (j * W + i) * 4);
  }
  const t = new THREE.DataTexture(data, W, H);
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
function beamGeometry(L) {
  const g = new THREE.BufferGeometry(), y = 0.14, pos = [], uv = [], col = []; // (held clear of the road: it must never dip under it)
  const quad = (x, zNear, zFar, rgb) => {
    pos.push(-x, y, zNear, x, y, zNear, x, y, zFar, -x, y, zNear, x, y, zFar, -x, y, zFar);
    uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
    for (let i = 0; i < 6; i++) col.push(...rgb);
  };
  quad(7.5, L / 2 - 0.3, L / 2 + 24, [1, 0.95, 0.84]);       // headlamps, dipped: a fan 24 m long, 35 degrees wide
  quad(-3.2, -L / 2 + 0.3, -L / 2 - 6, [0.34, 0.02, 0.012]);  // tail lamps
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}
const TYPES = [
  { name: 'kei', share: 0.3, L: 3.4, spec: { L: 3.4, W: 1.48, belt: 1.0, roof: 1.72, z0: 0.12, z1: 0.86, rake: 0.42, tyre: 0.28 } },
  { name: 'sedan', share: 0.3, L: 4.6, spec: { L: 4.6, W: 1.76, belt: 0.92, roof: 1.44, z0: 0.2, z1: 0.72, rake: 0.75 } },
  { name: 'van', share: 0.2, L: 4.8, spec: { L: 4.8, W: 1.82, belt: 1.05, roof: 1.9, z0: 0.06, z1: 0.86, rake: 0.5 } },
  { name: 'truck', share: 0.12, L: 6.2, spec: { L: 6.2, W: 2.1, belt: 1.0, roof: 2.2, z0: 0.74, z1: 0.97, rake: 0.18, tyre: 0.4, box: { h: 2.0, len: 0.68, z: 0.36 } } },
  { name: 'bus', share: 0.08, L: 10.4, spec: { L: 10.4, W: 2.5, belt: 1.25, roof: 3.0, z0: 0.02, z1: 0.98, rake: 0.14, tyre: 0.46 } },
];
const CAR_COLORS = [0xd4d4d0, 0xd4d4d0, 0x111214, 0x111214, 0xa4a7ab, 0xa4a7ab, 0x6d7278, 0x1f3a6e, 0x8c1c1c, 0xc4b68f]; // (white kept off full brightness: it blooms)
const BUS_COLORS = [0x2e8b57, 0xe8e4d8, 0xc0392b];

// Vehicle models for cars parked in car parks (props.js): geometries by type, the paint material, colours.
let parkedKit = null;
export function parkedVehicles() {
  parkedKit ??= { models: TYPES.slice(0, 3).map((t) => vehicle(t.spec)), material: carMaterial(false), colors: [0xd4d4d0, 0x111214, 0xa4a7ab, 0x1f3a6e] };
  return parkedKit;
}

function carMaterial(lit = true) {
  const m = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.28, metalness: 0.5 });
  const glow = attribute('aGlow', 'float'); // 1 headlamp, 2 tail lamp, 3 glass, 4 rubber and trim
  const isLamp = glow.greaterThan(0.5).and(glow.lessThan(2.5));
  const lamp = select(glow.greaterThan(1.5), vec3(0.9, 0.03, 0.02), vec3(1, 0.96, 0.85));
  // lamps keep their own colour instead of the body paint (the vertex colour and the car's own colour are
  // multiplied in afterwards: they are divided out here), and shine at night
  const paint = attribute('color', 'vec3').mul(varyingProperty('vec3', 'vInstanceColor'));
  m.colorNode = select(isLamp, lamp.mul(0.6).div(max(paint, vec3(1e-3))), vec3(1));
  // glass is a dark mirror, rubber and trim are matt, the paint has a hard shine
  m.roughnessNode = select(glow.greaterThan(3.5), 0.85, select(glow.greaterThan(2.5), 0.06, 0.28));
  m.metalnessNode = select(glow.greaterThan(3.5), 0, select(glow.greaterThan(2.5), 0.9, 0.5));
  m.emissiveNode = select(isLamp, lamp.mul(lit ? shared.uNight.mul(select(glow.greaterThan(1.5), 2.0, 3.6)).add(0.15) : float(0.15)), vec3(0));
  // (the windows are marked in alpha for the reflection pass, like those of the buildings)
  m.outputNode = vec4(output.rgb, select(glow.greaterThan(2.5).and(glow.lessThan(3.5)), 0.1, 1));
  return m;
}

// ---------------------------------------------------------------- the graph, as directed lanes
function buildGraph({ nodes, edges, signals }, surface) {
  const signalled = new Set(signals), out = nodes.map(() => []), into = nodes.map(() => []), lanes = [];
  for (const e of edges) {
    if (e.highway === 'service' && e.lanes <= 1) continue; // driveways and yards: not through traffic
    const pts = [];
    for (let i = 0; i < e.pts.length; i += 3) pts.push(new THREE.Vector3(e.pts[i], e.pts[i + 1], e.pts[i + 2]));
    const minor = ['residential', 'unclassified', 'living_street', 'service'].includes(e.highway);
    const speed = Math.min(15, Math.max(4.5, (e.maxspeed * (minor ? 0.6 : 0.8)) / 3.6));
    const weight = e.highway.startsWith('motorway') ? 5 : ['trunk', 'primary'].includes(e.highway) ? 4 : ['secondary', 'tertiary'].includes(e.highway) ? 2.5 : 1;
    for (const fwd of [true, false]) {
      if (fwd ? e.oneway === -1 : e.oneway === 1) continue;
      const p = fwd ? pts : [...pts].reverse(), cum = [0];
      for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z));
      if (cum.at(-1) < 1) continue;
      const n = e.oneway ? Math.max(1, e.lanes) : Math.max(1, Math.floor(e.lanes / 2));
      // lateral offset of lane k, to the right of travel: one-way roads centred on the line; two-way ones
      // on its left half (left-hand traffic). A two-way single-lane street is shared down the middle.
      const offset = (k) => (e.oneway ? (k - (n - 1) / 2) * LANE : e.lanes >= 2 ? -(k + 0.5) * LANE : -1.15);
      // An expressway ramp climbing to its flyover is a structure of its own (flyovers.js builds it where the
      // road's level stands 1.5 m above the ground somewhere): cars follow the road's level there too.
      let ramp = false;
      if (!e.flyover && !e.span && !e.tunnel && e.highway.startsWith('motorway')) {
        for (let i = 1; i < p.length && !ramp; i++) for (let s = 0; s <= 1; s += Math.min(1, 3 / (cum[i] - cum[i - 1] || 1))) {
          if (p[i - 1].y + (p[i].y - p[i - 1].y) * s - surface(p[i - 1].x + (p[i].x - p[i - 1].x) * s, p[i - 1].z + (p[i].z - p[i - 1].z) * s) > 1.5) { ramp = true; break; }
        }
      }
      const lane = {
        ramp, pts: p, cum, length: cum.at(-1), from: fwd ? e.a : e.b, to: fwd ? e.b : e.a, n, offset, speed, weight, motorway: e.highway.startsWith('motorway'),
        raised: !!e.flyover, hidden: !!e.tunnel, signal: signalled.has(fwd ? e.b : e.a), edge: e, cars: [],
      };
      // which way the signal for this approach is phased (see lensMaterial in props.js)
      const a = p.at(-2), b = p.at(-1);
      const facing = (Math.atan2(-(b.x - a.x), -(b.z - a.z)) + Math.PI * 2) % (Math.PI * 2); // the signal head faces the traffic
      lane.phase = Math.round(facing / (Math.PI / 2)) % 2;
      lane.hx = (b.x - a.x) / (Math.hypot(b.x - a.x, b.z - a.z) || 1); lane.hz = (b.z - a.z) / (Math.hypot(b.x - a.x, b.z - a.z) || 1);
      lanes.push(lane); out[lane.from].push(lane); into[lane.to].push(lane);
    }
  }
  // a junction: where a driver meets traffic from another road (three or more road ends)
  const junction = nodes.map((_, i) => new Set([...out[i], ...into[i]].map((l) => l.edge)).size >= 3);
  // OSM draws a big crossing as several nodes a few metres apart (one per carriageway that meets there).
  // Junction nodes joined by a short road form one junction: `group` is its id, shared by its nodes.
  const group = nodes.map((_, i) => i);
  const find = (i) => { while (group[i] !== i) { group[i] = group[group[i]]; i = group[i]; } return i; };
  for (const l of lanes) if (l.length < 26 && junction[l.from] && junction[l.to]) group[find(l.from)] = find(l.to);
  nodes.forEach((_, i) => { group[i] = find(i); });
  for (const l of lanes) {
    l.inside = group[l.from] === group[l.to] && junction[l.to]; // a link within one junction: no stopping on it
    if (l.inside) l.signal = false;
  }
  // The stop line: the junction node is the centre of the crossing, so a waiting vehicle stands back from
  // it by half the width of the widest road that meets there (plus the pedestrian crossing).
  const reach = nodes.map(() => 0);
  for (const l of lanes) {
    const half = (l.edge.oneway ? l.n : Math.max(1, l.edge.lanes)) * LANE / 2;
    reach[l.to] = Math.max(reach[l.to], half); reach[l.from] = Math.max(reach[l.from], half);
  }
  for (const l of lanes) l.stop = Math.min(reach[l.to] + 5.5, l.length * 0.45);
  return { lanes, out, into, junction, group };
}

const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
// Position and unit heading at distance s along a lane.
function along(lane, s, pos, dir) {
  const { pts, cum } = lane;
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
  const t = Math.min(1, Math.max(0, (s - cum[lo]) / (cum[hi] - cum[lo] || 1)));
  pos.lerpVectors(pts[lo], pts[hi], t);
  dir.subVectors(pts[hi], pts[lo]);
  const l = Math.hypot(dir.x, dir.z) || 1;
  dir.multiplyScalar(1 / l);
}

export class Traffic {
  // roads: parsed roads.json; surface(x, z): height of the road surface there.
  constructor(roads, surface) {
    this.surface = surface;
    this.graph = buildGraph(roads, surface);
    // which approach holds each junction: { lane, until, straight (everyone crossing is going straight on) }
    this.crossing = roads.nodes.map(() => ({ lane: null, until: 0, straight: false }));
    this.group = new THREE.Group();
    this.group.name = 'traffic';
    this.time = 0;
    this.seed = 12345;

    const material = carMaterial();
    // what the lamps throw on the road, for the light map (lamplight.js)
    this.beam = lampMaterial(beamTexture(), { vertexColors: true });
    this.fleets = TYPES.map((t) => {
      const mesh = new THREE.InstancedMesh(vehicle(t.spec), material, Math.ceil(MAX_CARS * t.share * 1.25) + 8);
      mesh.castShadow = true; mesh.frustumCulled = false; mesh.count = 0;
      const beams = new THREE.InstancedMesh(beamGeometry(t.L), this.beam, mesh.instanceMatrix.count);
      beams.instanceMatrix = mesh.instanceMatrix; // the lamps go where the cars go
      beams.frustumCulled = false; beams.count = 0;
      beams.layers.set(LAMP_LAYER);
      this.group.add(mesh, beams);
      return { ...t, mesh, beams };
    });
    this.cars = [];
    this.count = CARS;   // how many cars there are (the panel changes it)
    this.highway = 5;    // how much busier the expressway is than its class alone would make it
    this.headlights = 5; // strength of the light the lamps throw on the road at night
    this.dummy = new THREE.Object3D();
    this.dummy.rotation.order = 'YXZ'; // heading first, then pitch about the car's own axle
    this.color = new THREE.Color();
  }

  rnd() { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296; }

  // A lane with some part within `radius` of the focus, picked by weight; null if the area has none.
  pick(focus, radius, filter) {
    let best = null, bestKey = -1;
    for (const l of this.graph.lanes) {
      if (!filter(l)) continue;
      const m = l.pts[l.pts.length >> 1];
      if (Math.hypot(m.x - focus.x, m.z - focus.z) > radius) continue;
      // weighted reservoir sampling: by the importance of the road, its length and its lanes; the expressway busier still
      const key = Math.pow(this.rnd(), 1 / (l.weight * Math.min(l.length, 120) * l.n * (l.motorway ? this.highway : 1)));
      if (key > bestKey) { bestKey = key; best = l; }
    }
    return best;
  }

  spawnCar(car, focus) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const lane = this.pick(focus, this.radius ?? CAR_RADIUS, (l) => !l.hidden && l.length > 20);
      if (!lane) return false;
      // a clear stretch, away from the ends of the road
      const s = 8 + this.rnd() * (lane.length - 16);
      if (lane.cars.some((o) => o !== car && Math.abs(o.s - s) < 16)) continue;
      if (car.lane) car.lane.cars.splice(car.lane.cars.indexOf(car), 1);
      Object.assign(car, { lane, s, k: Math.floor(this.rnd() * lane.n), v: lane.speed * 0.5, next: undefined, waited: 0 });
      lane.cars.push(car);
      return true;
    }
    return false;
  }

  // The road a car will take after `lane`: not straight back; straighter and bigger roads preferred.
  chooseNext(lane) {
    const a = lane.pts.at(-2), b = lane.pts.at(-1), hx = b.x - a.x, hz = b.z - a.z, hl = Math.hypot(hx, hz) || 1;
    let next = null, key = -1;
    for (const o of this.graph.out[lane.to]) {
      if (o.edge === lane.edge) continue;
      const ox = o.pts[1].x - o.pts[0].x, oz = o.pts[1].z - o.pts[0].z, ol = Math.hypot(ox, oz) || 1;
      const straight = (hx * ox + hz * oz) / (hl * ol);
      if (straight < -0.6) continue;
      const k = Math.pow(this.rnd(), 1 / (o.weight * (0.4 + Math.max(0, straight) * 1.6)));
      if (k > key) { key = k; next = o; }
    }
    return next;
  }

  // May `car` cross the junction at the end of `lane` now? Claims the junction if so. The junction belongs
  // to one approach at a time; a vehicle going straight on may share it with oncoming traffic doing the same.
  mayCross(car, lane, toEnd) {
    const node = lane.to, x = this.crossing[this.graph.group[node]], now = shared.uTime.value, next = car.next;
    const straight = !!next && lane.hx * (next.pts[1].x - next.pts[0].x) + lane.hz * (next.pts[1].z - next.pts[0].z) > 0.8 * (next.cum[1] || 1);
    if (x.lane && x.lane !== lane && now < x.until) {
      const oncoming = lane.hx * x.lane.hx + lane.hz * x.lane.hz < -0.8;
      if (!(oncoming && straight && x.straight)) return false;
    }
    // without lights, give way to anyone arriving soon on a bigger road
    if (!lane.signal) for (const o of this.graph.into[node]) {
      if (o === lane || o.edge === lane.edge || o.weight <= lane.weight) continue;
      for (const c of o.cars) if (c.v > 0.5 && (o.length - c.s) / Math.max(c.v, 2) < 4.5) return false;
    }
    const until = now + toEnd / Math.max(car.v, 2) + 3.5; // time to get there and across
    if (x.lane === lane && now < x.until) { x.until = Math.max(x.until, until); x.straight = x.straight && straight; }
    else { x.lane = lane; x.until = until; x.straight = straight; }
    return true;
  }

  // red or yellow for a lane's approach? (27 s green, 3 s yellow, the rest red; the cross street 32 s later)
  stopLight(lane) { return lane.signal && (shared.uTime.value + lane.phase * 32) % CYCLE > GREEN; }

  update(dt, focus) {
    this.time += dt;
    const d = this.dummy;

    // ---- cars
    // more cars are spread over a wider circle, so the streets do not simply jam
    this.radius = CAR_RADIUS * Math.min(2.4, Math.max(1, Math.sqrt(this.count / CARS)));
    while (this.cars.length > this.count) { const gone = this.cars.pop(); if (gone.lane) gone.lane.cars.splice(gone.lane.cars.indexOf(gone), 1); }
    while (this.cars.length < this.count) {
      const r = this.rnd(); let acc = 0, type = 0;
      for (let i = 0; i < TYPES.length; i++) { acc += TYPES[i].share; if (r < acc) { type = i; break; } }
      const palette = TYPES[type].name === 'bus' ? BUS_COLORS : CAR_COLORS;
      const car = { type, color: palette[Math.floor(this.rnd() * palette.length)], lane: null };
      if (!this.spawnCar(car, focus)) break;
      this.cars.push(car);
    }
    const counts = this.fleets.map(() => 0);
    const { junction, into } = this.graph;
    for (const car of this.cars) {
      if (!car.lane && !this.spawnCar(car, focus)) continue; // nowhere to drive near the focus right now
      const lane = car.lane, L = TYPES[car.type].L;
      if (car.next === undefined) car.next = this.chooseNext(lane); // null at a dead end
      const next = car.next, toEnd = lane.length - car.s - L / 2; // front bumper to the end of this road

      // 1. the vehicle ahead: in this lane, or the last one on the road it is about to join
      let gap = Infinity, lead = 0;
      const kNext = next ? Math.min(car.k, next.n - 1) : car.k;
      for (const o of lane.cars) {
        if (o === car) continue;
        // same lane, or merging into the same lane at the end of this road (ties go to the left lane)
        const merging = next && toEnd < 35 && o.k !== car.k && Math.min(o.k, next.n - 1) === kNext && o.next === next;
        if (o.k === car.k ? o.s <= car.s : !(merging && (o.s > car.s + 0.5 || (Math.abs(o.s - car.s) <= 0.5 && o.k < car.k)))) continue;
        const g = o.s - car.s - (TYPES[o.type].L + L) / 2;
        if (g < gap) { gap = Math.max(g, 0); lead = o.v; }
      }
      let roomAhead = true;
      if (next) {
        for (const o of next.cars) {
          if (o.k !== kNext) continue;
          const g = toEnd + o.s - TYPES[o.type].L / 2;
          if (g < gap) { gap = g; lead = o.v; }
          if (o.s < TYPES[o.type].L / 2 + L + 3) roomAhead = false; // the far side is still occupied
        }
      }
      // 2. the junction: a red light, no room beyond it, or the turn of another vehicle
      const stopAt = toEnd - lane.stop, braking = (car.v * car.v) / 7 + 5;
      const past = stopAt < -1; // already over the stop line: committed to crossing
      // (on a link inside a junction the car is already crossing: it only keeps clear of the vehicle ahead)
      let hold = !lane.inside && !past && (this.stopLight(lane) || (junction[lane.to] && !roomAhead));
      const giveWay = junction[lane.to] && !lane.signal && into[lane.to].some((o) => o.edge !== lane.edge && o.weight > lane.weight);
      if (!hold && !lane.inside && junction[lane.to] && stopAt < braking + 8) hold = !this.mayCross(car, lane, toEnd) && !past;
      if (hold && stopAt < gap) { gap = Math.max(0, stopAt); lead = 0; }

      // 3. speed: the limit, slower into a junction, a crawl up to a give-way line, a time gap behind the leader
      let want = lane.speed * (toEnd < 14 ? 0.55 : 1);
      if (giveWay && toEnd < 14) want = Math.min(want, 1.2 + toEnd * 0.35);
      if (gap < Infinity) want = Math.min(want, Math.max(0, lead + (gap - 2.5) / 1.4));
      if (gap < 0.6) want = 0;
      car.v = Math.max(0, car.v + THREE.MathUtils.clamp(want - car.v, -6 * dt, 2.2 * dt));
      car.s += car.v * dt;
      // stuck for a long time (a jam that cannot clear): start again somewhere else
      car.waited = car.v < 0.2 ? (car.waited ?? 0) + dt : 0;
      if (car.waited > 45 && !this.stopLight(lane)) { if (!this.spawnCar(car, focus)) continue; }

      if (car.lane === lane && car.s >= lane.length) {
        lane.cars.splice(lane.cars.indexOf(car), 1);
        const x = this.crossing[this.graph.group[lane.to]];
        // still clearing the junction; longer if the way on is another link inside it
        if (x.lane === lane) x.until = Math.max(x.until, shared.uTime.value + 2.2 + (next?.inside ? next.length / Math.max(car.v, 3) : 0));
        if (next) { car.lane = next; car.s -= lane.length; car.k = Math.min(car.k, next.n - 1); car.next = undefined; next.cars.push(car); }
        else { car.lane = null; if (!this.spawnCar(car, focus)) continue; }
      }
      // left behind by the camera: start again nearby
      along(car.lane, car.s, tmp, tmp2);
      if (Math.hypot(tmp.x - focus.x, tmp.z - focus.z) > (this.radius ?? CAR_RADIUS) + 90) { if (!this.spawnCar(car, focus)) continue; along(car.lane, car.s, tmp, tmp2); }
      if (car.lane.hidden) continue;

      const off = car.lane.offset(car.k), px = tmp.x - tmp2.z * off, pz = tmp.z + tmp2.x * off;
      const fleet = this.fleets[car.type];
      if (counts[car.type] >= fleet.mesh.instanceMatrix.count) continue; // (more of this type than there are instances for)
      const i = counts[car.type]++;
      // (a ramp comes down to the ground: the higher of its level and the ground)
      const onRamp = car.lane.ramp && tmp.y > this.surface(px, pz) + 0.03;
      d.position.set(px, car.lane.raised || onRamp ? tmp.y + 0.04 : this.surface(px, pz) + 0.07, pz);
      // nose up or down with the road (and with it the light the lamps throw on it): the slope over the car's length
      const slope = car.lane.raised || onRamp ? tmp2.y : (this.surface(px + tmp2.x * 5, pz + tmp2.z * 5) - this.surface(px - tmp2.x * 5, pz - tmp2.z * 5)) / 10;
      d.rotation.set(-Math.atan(slope), Math.atan2(tmp2.x, tmp2.z), 0);
      d.updateMatrix();
      fleet.mesh.setMatrixAt(i, d.matrix);
      fleet.mesh.setColorAt(i, this.color.setHex(car.color));
    }
    const night = shared.uNight.value;
    this.beam.color.setScalar(0.36 * this.headlights * night); // the light on the road just ahead of a car
    this.beam.visible = night > 0.02;
    this.fleets.forEach((f, i) => {
      f.mesh.count = f.beams.count = counts[i];
      f.mesh.instanceMatrix.needsUpdate = true;
      if (f.mesh.instanceColor) f.mesh.instanceColor.needsUpdate = true;
    });
  }
}
