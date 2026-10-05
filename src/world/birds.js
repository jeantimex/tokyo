// Birds over the city: flocks of white pigeons that keep to the part of the city in view. A flock circles above
// a tree for a while, comes down into it and is gone, and later flies out of it again (or out of another tree,
// if the view has moved on meanwhile). One instanced mesh; where a flock's tree is and how far the flock has
// settled in it is kept per flock in a small texture, everything else comes out of the vertex shader from the
// time and a few random numbers per bird, so a thousand birds cost the CPU next to nothing.
import * as THREE from 'three/webgpu';
import { Fn, attribute, texture, float, vec2, vec3, select, mix, clamp, max, smoothstep, fract, sin, cos, pow, normalize, cross, positionGeometry } from 'three/tsl';
import { shared } from './materials.js';

export const MAX_BIRDS = 2000;
const FLOCK = 14;  // birds per flock
const FLOCKS = Math.ceil(MAX_BIRDS / FLOCK);
const SPAN = 3.2;  // wingspan in metres: a good deal larger than life, or they would not be seen from the air
const LAND = 13, TAKE_OFF = 9; // seconds a flock takes to settle in its tree, and to leave it
const CRUISE = 28;             // metres per second: a flock moving over to another tree

// A bird flying towards +z: a slim body and two wings of two panels each. aWing: 0 on the body, 1 at the tip.
function birdGeometry() {
  const pos = [], wing = [];
  const tri = (a, b, c) => { for (const [x, y, z, w] of [a, b, c]) { pos.push(x, y, z); wing.push(w); } };
  const h = SPAN / 2;
  tri([0, 0, 0.42, 0], [0.09, 0, -0.1, 0], [-0.09, 0, -0.1, 0]);       // head and chest
  tri([0.09, 0, -0.1, 0], [0, 0, -0.5, 0], [-0.09, 0, -0.1, 0]);       // tail
  for (const s of [-1, 1]) {
    tri([s * 0.06, 0, 0.2, 0], [s * h * 0.5, 0, 0.16, 0.5], [s * 0.06, 0, -0.16, 0]);         // inner panel
    tri([s * h * 0.5, 0, 0.16, 0.5], [s * h * 0.5, 0, -0.1, 0.5], [s * 0.06, 0, -0.16, 0]);
    tri([s * h * 0.5, 0, 0.16, 0.5], [s * h, 0, -0.02, 1], [s * h * 0.5, 0, -0.1, 0.5]);      // outer panel
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 1));
  const seed = new Float32Array(MAX_BIRDS * 4);
  for (let i = 0; i < MAX_BIRDS; i++) seed.set([Math.floor(i / FLOCK), Math.random(), Math.random(), Math.random()], i * 4);
  g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4)); // flock, and three random numbers
  return g;
}

// The mesh; call mesh.userData.update(dt, focus, camera, streamer) every frame.
export function createBirds() {
  // per flock: row 0 = its tree (x, y of the crown, z) and how far it has settled there (0 flying .. 1 in the
  // tree); row 1 = how fast that changes (per second), for the way the birds face while they come down
  const data = new Float32Array(FLOCKS * 2 * 4);
  const flockTex = new THREE.DataTexture(data, FLOCKS, 2, THREE.RGBAFormat, THREE.FloatType);
  flockTex.minFilter = flockTex.magFilter = THREE.NearestFilter;
  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  const aSeed = attribute('aSeed', 'vec4'), aWing = attribute('aWing', 'float');
  const hash1 = (n) => fract(sin(n.mul(127.1)).mul(43758.5453));
  // how much of the bird is still in the air (1), with the flock settled by 'perch': one bird after another
  const aloft = (perch) => { const b = clamp(perch.mul(1.4).sub(aSeed.w.mul(0.4)), 0, 1); return b.mul(b).mul(b.mul(-2).add(3)).oneMinus(); };
  // where the bird is at time t
  const place = (t, flock, perch) => {
    const f = aSeed.x;
    // the flock: a slow, never-repeating loop above its tree, at a height of its own
    const reach = vec2(hash1(f.add(1)), hash1(f.add(5))).mul(170).add(45);
    const c = vec3(
      reach.x.mul(sin(t.mul(hash1(f.add(8)).mul(0.06).add(0.05)).add(hash1(f.add(2)).mul(6.28)))),
      pow(hash1(f.add(3)), 2).mul(230).add(22).add(sin(t.mul(0.05).add(hash1(f.add(4)).mul(6.28))).mul(14)),
      reach.y.mul(sin(t.mul(hash1(f.add(10)).mul(0.06).add(0.05)).add(hash1(f.add(6)).mul(6.28)))));
    // the bird: round the flock on its own circle, rising and falling a little
    const radius = aSeed.y.mul(55).add(8), turn = aSeed.z.add(0.5).mul(4.5).div(radius).mul(select(hash1(f.add(7)).lessThan(0.5), -1, 1));
    const a = t.mul(turn).add(aSeed.w.mul(6.28));
    const ownY = max(sin(t.mul(0.21).add(aSeed.z.mul(6.28))).mul(9).add(aSeed.w.sub(0.5).mul(50)), float(4).sub(c.y));
    const own = vec3(cos(a).mul(radius), ownY, sin(a).mul(radius).mul(0.8));
    // settled, it sits somewhere in the crown
    const twig = vec3(aSeed.y, aSeed.z, aSeed.w).sub(0.5).mul(vec3(3, 2, 3));
    return flock.xyz.add(mix(twig, c.add(own), aloft(perch)));
  };
  material.positionNode = Fn(() => {
    const u = aSeed.x.add(0.5).div(FLOCKS), t = shared.uTime;
    const flock = texture(flockTex, vec2(u, 0.25)).toVar(), rate = texture(flockTex, vec2(u, 0.75)).x;
    const p = place(t, flock, flock.w).toVar(), ahead = place(t.add(0.25), flock, clamp(flock.w.add(rate.mul(0.25)), 0, 1));
    const fwd = normalize(ahead.sub(p).add(vec3(0, 0, 1e-4))).toVar(), right = normalize(cross(vec3(0, 1, 0), fwd)).toVar(), up = cross(fwd, right);
    // wings: beat for a while, then glide with the wings held a little up
    const beat = smoothstep(-0.2, 0.3, sin(t.mul(0.35).add(aSeed.y.mul(6.28))));
    const lift = mix(0.18, sin(t.mul(8).mul(aSeed.z.mul(0.3).add(0.85)).add(aSeed.w.mul(6.28))), beat).mul(0.55).toVar();
    // (a bird in the tree is not seen: it shrinks away among the leaves as it arrives)
    const local = positionGeometry.mul(0.7).mul(smoothstep(0, 0.05, aloft(flock.w))).toVar();
    local.y.addAssign(local.x.abs().mul(lift).mul(aWing));
    local.x.mulAssign(lift.abs().mul(aWing).mul(0.22).oneMinus());
    return p.add(right.mul(local.x)).add(up.mul(local.y)).add(fwd.mul(local.z));
  })();
  material.colorNode = vec3(0.82, 0.82, 0.84).mul(aWing.mul(0.25).add(0.75)).mul(mix(1, 0.5, shared.uDark)); // (still white against the night sky)
  const mesh = new THREE.Mesh(birdGeometry(), material);
  mesh.frustumCulled = false; // (they are placed in the shader)
  mesh.name = 'birds';
  mesh.castShadow = true; // (the shadow pass places the birds with the same position node)
  mesh.geometry.instanceCount = 100;

  // ---- the flocks: which tree, and flying / coming down / in the tree / leaving it
  const flocks = Array.from({ length: FLOCKS }, () => ({ state: 'new', timer: 0, perch: 0, rate: 0, anchor: new THREE.Vector3(), target: null }));
  const rnd = (a, b) => a + Math.random() * (b - a);
  mesh.userData.flocks = flocks;
  mesh.userData.update = (dt, focus, camera, streamer) => {
    const reach = THREE.MathUtils.clamp(camera.position.distanceTo(focus) * 0.7, 120, 650); // how far from the focus is still "in view"
    // a tree within reach of the focus: the place of its crown, or null if none is found
    const tiles = [...streamer.tiles.values()].filter((t) => t.trees?.roosts.length);
    const pickTree = () => {
      for (let tries = 0; tries < 12 && tiles.length; tries++) {
        const r = tiles[Math.floor(Math.random() * tiles.length)].trees.roosts, i = Math.floor(Math.random() * (r.length / 3)) * 3;
        if (Math.hypot(r[i] - focus.x, r[i + 2] - focus.z) < reach) return new THREE.Vector3(r[i], r[i + 1], r[i + 2]);
      }
      return null;
    };
    const far = (p) => Math.hypot(p.x - focus.x, p.z - focus.z) > reach * 1.5;
    const count = Math.ceil(mesh.geometry.instanceCount / FLOCK);
    for (let i = 0; i < count; i++) {
      const f = flocks[i];
      f.rate = 0;
      if (f.state === 'new') {
        // at the start some are in the air and some in the trees
        f.target = pickTree();
        f.anchor.copy(f.target ?? new THREE.Vector3(focus.x + rnd(-reach, reach) * 0.6, streamer.ground(focus.x, focus.z) + 12, focus.z + rnd(-reach, reach) * 0.6));
        if (f.target && Math.random() < 0.3) { f.state = 'perched'; f.perch = 1; f.timer = rnd(2, 25); } else { f.state = 'fly'; f.perch = 0; f.timer = rnd(8, 70); }
      } else if (f.state === 'fly') {
        f.timer -= dt;
        if (!f.target || far(f.target)) f.target = pickTree() ?? f.target; // the view has moved on: over to a tree there
        if (f.target) {
          const d = f.anchor.distanceTo(f.target);
          if (d > 0.01) f.anchor.lerp(f.target, Math.min(1, (CRUISE * dt) / d));
          else if (f.timer <= 0) f.state = 'land';
        }
      } else if (f.state === 'land') {
        f.rate = 1 / LAND; f.perch += dt / LAND;
        if (f.perch >= 1) { f.perch = 1; f.state = 'perched'; f.timer = rnd(6, 26); }
      } else if (f.state === 'perched') {
        f.timer -= dt;
        // (nobody sees a bird in a tree: if the view has moved on, the flock is in a tree there instead)
        if (far(f.anchor)) { const tree = pickTree(); if (tree) { f.target = tree; f.anchor.copy(tree); } }
        if (f.timer <= 0) f.state = 'takeoff';
      } else {
        f.rate = -1 / TAKE_OFF; f.perch -= dt / TAKE_OFF;
        if (f.perch <= 0) { f.perch = 0; f.state = 'fly'; f.timer = rnd(30, 85); }
      }
      data.set([f.anchor.x, f.anchor.y, f.anchor.z, f.perch], i * 4);
      data[(FLOCKS + i) * 4] = f.rate;
    }
    flockTex.needsUpdate = true;
  };
  return mesh;
}
