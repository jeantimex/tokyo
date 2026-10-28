// Keeps the tiles within `radius` of a focus point loaded, nearest first, and drops the ones
// that fall beyond radius + hysteresis. Meshing happens in a small pool of workers.
import * as THREE from 'three';
import { tileKey, makeProjection } from '../shared/geo.js';
import { LANDMARKS } from './landmarks.js';
import { asGround } from './contact.js';
import { sampleGrid } from '../shared/terrain.js';
import { makeSurface, makeCover } from '../shared/decks.js';
import { SIGN_LOD_DISTANCE } from './signs.js';
import { shared, variant, varies, ABSTRACT, neutralShade } from './materials.js';

const WORKERS = Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) >> 1));
const MAX_IN_FLIGHT = WORKERS * 2;
// Distance (m) from the eye within which a tile shows its full-size photo atlas instead of the small one.
const ROOFS_FULL = 600, WALLS_FULL = 900;
const SHOW_BYTES = 3e6; // of a new tile's meshes shown per frame (see onResult)

// Things that never change keep their vertices on the graphics card only: once they have been sent there, the
// page's own copy is let go. For a city that is hundreds of megabytes the page held twice over (on a phone, whose
// graphics card shares the one memory, a page that holds that much is closed by the browser). Nothing reads them
// again; nor are they picked (only the facades are: they keep theirs).
function letGo() { this.array = null; }
export function gpuOnly(root) {
  root.traverse((o) => {
    if (!(o.isMesh || o.isLine) || o.isInstancedMesh || o.userData.facade) return;
    o.raycast = () => {};
    for (const a of Object.values(o.geometry.attributes)) a.onUpload(letGo);
    o.geometry.index?.onUpload(letGo);
  });
  return root;
}

function geometry(arrays, attrs) {
  const g = new THREE.BufferGeometry();
  for (const [name, size] of attrs) if (arrays[name]?.length) g.setAttribute(name, new THREE.BufferAttribute(arrays[name], size));
  if (arrays.index) g.setIndex(new THREE.BufferAttribute(arrays.index, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

export class Streamer {
  constructor(scene, materials, props, signs, { base, radius = 1100, hysteresis = 250 } = {}) {
    this.shown = []; // meshes of new tiles not yet shown (see onResult)
    this.scene = scene;
    this.materials = materials;
    this.props = props;
    this.signs = signs;
    this.base = base;
    this.radius = radius;
    this.hysteresis = hysteresis;
    // How far out the full-size photos are used, as a share of ROOFS_FULL and WALLS_FULL: on a screen of fewer pixels
    // the small photo is as sharp as the screen out to a shorter distance (see main.js).
    this.photoReach = 1;
    this.tiles = new Map(); // key -> { state, group, info, ends, tris }
    this.inFlight = 0;
    this.stats = { loaded: 0, buildings: 0, triangles: 0 };
  }

  // The signs of the tiles that are there, for the abstract model (which has none) or back.
  setAbstract(on) { for (const t of this.tiles.values()) if (t.signs) t.signs.group.visible = !on; }

  async init() {
    this.manifest = await (await fetch(`${this.base}/manifest.json`)).json();
    const t = this.manifest.terrain;
    const data = new Float32Array(await (await fetch(`${this.base}/${t.file}`)).arrayBuffer());
    this.grid = { x0: t.x0, z0: t.z0, step: t.step, w: t.w, h: t.h, data };
    const decks = this.manifest.decks ?? [];
    this.surface = makeSurface(this.grid, decks);
    this.cover = makeCover(this.grid, decks);
    this.available = new Map(this.manifest.tiles.map((tl) => [tileKey(tl.x, tl.z), tl]));
    // the landmarks of the area, as points of the world (the workers flag the buildings they stand in)
    const proj = makeProjection(this.manifest.origin.lon, this.manifest.origin.lat);
    const marks = (LANDMARKS[this.manifest.area] ?? []).map(([, lon, lat]) => proj.project(lon, lat));
    this.workers = Array.from({ length: WORKERS }, () => {
      const w = new Worker(new URL('./tileWorker.js', import.meta.url), { type: 'module' });
      w.postMessage({ type: 'init', decks, marks, grid: { ...this.grid, data: data.slice().buffer } });
      w.onmessage = (e) => this.onResult(e.data);
      return w;
    });
    this.nextWorker = 0;
    return this.manifest;
  }

  // Terrain height, and the height of whatever one stands on (the terrain, or a bridge deck).
  ground(x, z) { return sampleGrid(this.grid, x, z); }

  // focus: the point tiles are streamed around; eye: the camera position, for level of detail.
  update(focus, eye = focus) {
    // (the meshes waiting to be shown: up to so many bytes of them per frame, one at the least)
    for (let budget = SHOW_BYTES; this.shown.length && (budget > 0 || budget === SHOW_BYTES);) { const { o, bytes, group } = this.shown.shift(); if (group.parent) o.visible = true; budget -= bytes; }
    const size = this.manifest.tileSize;
    for (const [key, t] of this.tiles) {
      if (t.state !== 'ready' || (!t.trees && !t.signs && !t.atlases.length)) continue;
      // Distance from the eye to the nearest point of the tile, so things next to the camera are never the
      // simple versions; a margin on the way out stops a tile flickering at the threshold.
      const tl = this.available.get(key), x0 = tl.x * size, z0 = tl.z * size;
      const dx = Math.max(x0 - eye.x, 0, eye.x - (x0 + size)), dz = Math.max(z0 - eye.z, 0, eye.z - (z0 + size));
      const dy = Math.max(0, eye.y - this.ground(x0 + size / 2, z0 + size / 2) - 25);
      const d = Math.hypot(dx, dy, dz);
      if (t.trees) {
        // a tile full of trees (a wood) keeps its detailed ones closer: thousands of them are too much to draw
        const limit = this.props.constructor.lodDistance * (t.trees.count > 120 ? 0.5 : 1);
        // (the abstract model keeps the simple trees at any distance)
        const near = !variant.abstract && (t.trees.near.visible ? d < limit * 1.25 : d < limit);
        t.trees.near.visible = near; t.trees.far.visible = !near;
      }
      for (const a of t.atlases) {
        const want = d < a.dist * this.photoReach * (a.full || a.loading ? 1.3 : 1);
        if (want && !a.full && !a.loading) {
          a.loading = true;
          this.loadTexture(a.file, (map) => {
            a.loading = false;
            if (this.tiles.get(key) !== t || a.gone) { map.dispose(); a.gone = false; return; }
            a.full = map; a.apply(map);
          });
        } else if (!want && a.loading) a.gone = true;      // arrived too late: drop it on arrival
        else if (want && a.loading) a.gone = false;
        else if (!want && a.full) { if (a.small) a.apply(a.small); a.full.dispose(); a.full = null; }
      }
      if (t.signs) {
        // sign text is drawn into a texture when the tile comes near, and freed when it is far again
        const near = t.signNear ? d < SIGN_LOD_DISTANCE * 1.3 : d < SIGN_LOD_DISTANCE;
        if (near !== t.signNear) { t.signNear = near; t.signs.setNear(near); }
      }
    }
    const dist = (tl) => Math.hypot((tl.x + 0.5) * size - focus.x, (tl.z + 0.5) * size - focus.z);
    // unload
    for (const [key, t] of this.tiles) {
      if (t.state === 'ready' && dist(this.available.get(key)) > this.radius + this.hysteresis) this.unload(key);
    }
    // load, nearest first
    if (this.inFlight >= MAX_IN_FLIGHT) return;
    const wanted = [];
    for (const [key, tl] of this.available) {
      if (this.tiles.has(key)) continue;
      const d = dist(tl);
      if (d <= this.radius) wanted.push([d, key, tl]);
    }
    wanted.sort((a, b) => a[0] - b[0]);
    for (const [, key, tl] of wanted) {
      if (this.inFlight >= MAX_IN_FLIGHT) break;
      this.tiles.set(key, { state: 'loading' });
      this.inFlight++;
      const w = this.workers[this.nextWorker++ % this.workers.length];
      const url = (file) => new URL(`${this.base}/${file}`, location.href).href;
      w.postMessage({ type: 'tile', key, url: url(tl.file), meshUrl: tl.mesh && url(tl.mesh), tileSize: size });
    }
  }

  onResult(msg) {
    this.inFlight--;
    const t = this.tiles.get(msg.key);
    // a tile that cannot be read stays marked as failed: asking for it again every frame would only repeat the error
    if (msg.type === 'error') { console.warn(`tile ${msg.key}: ${msg.message}`); if (t) t.state = 'failed'; return; }
    if (!t) return; // unloaded while in flight
    const { terrain, roads, paint, decals, buildings, info, props, wires, signs: signList, models } = msg.mesh;
    const group = new THREE.Group();
    group.name = `tile ${msg.key}`;
    const atlases = [];

    const ground = new THREE.Mesh(geometry(terrain, [['position', 3], ['normal', 3]]), this.materials.terrain);
    ground.receiveShadow = true;
    group.add(asGround(ground));

    if (roads.position.length) {
      const m = new THREE.Mesh(geometry(roads, [['position', 3], ['normal', 3], ['color', 3], ['aLayer', 1]]), this.materials.road);
      m.receiveShadow = true;
      group.add(asGround(m));
      // the tile's water (for the mirror): the sphere around it, and its level
      const box = new THREE.Box3(), v = new THREE.Vector3();
      let sum = 0, n = 0;
      for (let i = 0; i < roads.aLayer.length; i++) if (roads.aLayer[i] > 3.5) { box.expandByPoint(v.fromArray(roads.position, i * 3)); sum += v.y; n++; }
      if (n) t.water = { y: sum / n, sphere: box.getBoundingSphere(new THREE.Sphere()), box: box.clone() };
    }
    if (paint.position.length) {
      const m = new THREE.Mesh(geometry(paint, [['position', 3], ['normal', 3], ['color', 3], ['aLayer', 1]]), this.materials.paint);
      m.receiveShadow = true;
      group.add(asGround(m));
    }
    if (decals.position.length) {
      const m = new THREE.Mesh(geometry(decals, [['position', 3], ['normal', 3], ['uv', 2]]), this.props.mats.decal);
      m.receiveShadow = true;
      m.renderOrder = 2;
      group.add(asGround(m));
    }
    let trees = null;
    if (props.length || wires.length) {
      trees = this.props.build(props, wires, this.surface);
      trees.near.visible = false; // update() picks the level of detail on the next frame
      group.add(trees.group);
    }
    let signs = null;
    if (signList.length) {
      signs = this.signs.build(signList);
      if (variant.abstract) signs.group.visible = false; // (a plain model carries no signs: see setAbstract)
      group.add(signs.group);
    }
    if (buildings.position.length) {
      const walls = this.available.get(msg.key).walls;
      const m = new THREE.Mesh(
        geometry(buildings, [['position', 3], ['normal', 3], ['color', 3], ['aFacade', 4], ['aBldg', 4], ['aPhoto', 2], ['aMark', 1]]),
        walls ? this.materials.facadeFor() : this.materials.facade,
      );
      if (walls) { // the tile's wall photos, blended in by the facade shader with distance
        group.userData.own = [m.material]; // (kept off the mesh: its userData is the picking record)
        atlases.push(this.atlas(msg.key, t, walls, WALLS_FULL, (map) => { m.material.userData.photo.value = map; m.material.userData.photoOn.value = 1; }));
      }
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData = { tile: msg.key, info, ends: buildings.ends, facade: true };
      group.add(m);
    }
    if (models) { // PLATEAU's own models of bridges, street furniture and trees
      const m = new THREE.Mesh(geometry(models, [['position', 3], ['normal', 3], ['color', 3]]), this.materials.models);
      m.castShadow = m.receiveShadow = true;
      group.add(m);
    }
    if (buildings.photo.position.length) { // LOD2 roofs under their aerial photo (the tile's atlas)
      // plain grey until the photo has arrived
      const m = new THREE.Mesh(geometry(buildings.photo, [['position', 3], ['normal', 3], ['uv', 2], ['aMark', 1]]), new THREE.MeshStandardMaterial({ color: 0x777776, roughness: 0.9, metalness: 0 }));
      m.castShadow = m.receiveShadow = true;
      m.material.onBeforeCompile = (shader) => {
        shader.uniforms.uLampOn = { value: 0 }; shader.uniforms.uLampMap = shared.uLampMap; // (no lamp light up here: see lamplight.js)
        if (variant.abstract) { // the abstract model: plain roofs, but for the landmarks where they keep their look
          shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute float aMark;\nvarying float vMark;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvMark = aMark;');
          shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vMark;')
            .replace('#include <lights_fragment_end>', neutralShade(variant.landmarks ? '0.92 * (1.0 - step(0.5, vMark))' : '0.92'))
            .replace('#include <map_fragment>', `#include <map_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(${ABSTRACT.home.map((c) => (c * 1.14).toFixed(3)).join(', ')}), ${variant.landmarks ? '1.0 - step(0.5, vMark)' : '1.0'});`);
        }
      };
      m.material.customProgramCacheKey = () => 'roof-photo' + (variant.abstract ? (variant.landmarks ? '-al' : '-a') : '');
      varies(m.material);
      m.userData.own = [m.material]; // freed with the tile
      atlases.push(this.atlas(msg.key, t, this.available.get(msg.key).atlas, ROOFS_FULL, (map) => {
        const first = !m.material.map;
        m.material.map = map; m.material.color.set(0xffffff);
        if (first) m.material.needsUpdate = true;
      }));
      group.add(m);
    }
    const tris = terrain.index.length / 3 + roads.position.length / 9 + buildings.triangles;
    Object.assign(t, { state: 'ready', group, trees, signs, atlases, signNear: false, buildings: info.length, tris });
    // nothing in a tile is placed or moved (its points are the world's own): its matrices are never worked out
    group.matrixAutoUpdate = false;
    group.updateMatrixWorld = () => {};
    t.sphere = new THREE.Box3().setFromObject(group).getBoundingSphere(new THREE.Sphere()); // (all of the tile: for the water mirror, which leaves out the tiles it cannot show)
    // A tile's meshes are megabytes of vertices, sent to the graphics card when each is first drawn: all in one
    // frame, that frame stood for a tenth of a second. They are shown a few at a time instead (update()).
    group.traverse((o) => { const a = o.geometry?.attributes; if (!a || !o.visible || o.isInstancedMesh) return; let bytes = 0; for (const k in a) bytes += a[k].array.byteLength; if (bytes > 2e5) { o.visible = false; this.shown.push({ o, bytes, group }); } });
    for (const o of group.children) if (o.isMesh) gpuOnly(o); // (the tile's own meshes: its trees and signs are the props' and the signs')
    this.scene.add(group);
    this.stats.loaded++; this.stats.buildings += info.length; this.stats.triangles += tris;
  }

  // A photo atlas of a tile: its small version is loaded now and stays; update() swaps the full one in
  // while the eye is within `dist` of the tile. apply(map) puts a texture on the material.
  atlas(key, t, file, dist, apply) {
    const a = { file, dist, apply, small: null, full: null, loading: false };
    this.loadTexture(file.replace(/\.jpg$/, '_s.jpg'), (map) => {
      if (this.tiles.get(key) !== t) { map.dispose(); return; } // unloaded meanwhile
      a.small = map;
      if (!a.full) apply(map);
    });
    return a;
  }

  loadTexture(file, done) {
    // (as a bitmap: the picture is decoded off the main thread — an <img> is decoded when it is first drawn, which
    // held a frame up for a tenth of a second and more)
    this.bitmaps ??= new THREE.ImageBitmapLoader().setOptions({ imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    this.bitmaps.load(`${this.base}/${file}`, (bitmap) => {
      const map = new THREE.Texture(bitmap);
      map.flipY = false; // (the bitmap is the right way up already)
      map.colorSpace = THREE.SRGBColorSpace;
      map.anisotropy = 4;
      map.needsUpdate = true;
      map.addEventListener('dispose', () => bitmap.close());
      done(map);
    });
  }

  unload(key) {
    const t = this.tiles.get(key);
    for (const a of t.atlases ?? []) { a.small?.dispose(); a.full?.dispose(); }
    this.scene.remove(t.group);
    if (t.trees) this.props.release(t.trees);
    t.signs?.dispose();
    // prop models are shared between tiles; only per-tile geometry is freed
    t.group.traverse((o) => { if (o.isInstancedMesh) o.dispose(); else if (!o.isGroup) o.geometry?.dispose(); o.userData.own?.forEach((r) => r.dispose()); });
    this.tiles.delete(key);
    this.stats.loaded--; this.stats.buildings -= t.buildings; this.stats.triangles -= t.tris;
  }

  // Building under a raycast hit on a facade mesh: { usage, storeys, height, base }.
  buildingAt(hit) {
    const { info, ends } = hit.object.userData ?? {};
    if (!info || !hit.face) return null;
    const v = hit.face.a;
    let lo = 0, hi = ends.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ends[mid] > v) hi = mid; else lo = mid + 1; }
    const [usage, storeys, height, base] = info[lo];
    return { usage, storeys, height, base };
  }

  get pending() { return this.inFlight; }
}
