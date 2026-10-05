// Signboards (tools/pipeline/signs.mjs). Far away a sign is a coloured panel; when its tile comes near,
// the names are drawn into a texture atlas for that tile. All of them glow at night.
import * as THREE from 'three/webgpu';
import { diffuseColor } from 'three/tsl';
import { shared } from './materials.js';
import { Ads } from './ads.js';

// [background, text] — the same list, in the same order, as SIGN_COLORS in tools/pipeline/signs.mjs.
const COLORS = [
  ['#c8102e', '#ffffff'], ['#f6c400', '#1a1a1a'], ['#f4f1ea', '#1a1a1a'], ['#151515', '#ffffff'],
  ['#1757a6', '#ffffff'], ['#16794c', '#ffffff'], ['#e8650a', '#ffffff'], ['#d93b7e', '#ffffff'],
  ['#3a2414', '#e9c46a'], ['#14213d', '#ffffff'], ['#ffffff', '#e8650a'], ['#ffffff', '#0a8f4f'],
  ['#0f6fc6', '#ffffff'], ['#5a5d61', '#ffffff'],
];
const STYLE = { FASCIA: 0, BLADE: 1, TITLE: 2 };
const FONT = '"Yu Gothic", "Meiryo", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif';
const PX = 48;              // texture pixels across a sign's short side
const ATLAS_W = 2048, ATLAS_MAX_H = 4096;
export const SIGN_LOD_DISTANCE = 230;

const isWide = (ch) => ch.charCodeAt(0) > 0x2e7f;

function drawSign(g, s, x, y, w, h) {
  const [bg, fg] = COLORS[s.color] ?? COLORS[2];
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.fillStyle = bg; g.fillRect(x, y, w, h);
  g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 3; g.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
  // convenience-store stripes for the three big chains
  if (s.color === 10) { g.fillStyle = '#e8650a'; g.fillRect(x, y, w, 7); g.fillStyle = '#0a8f4f'; g.fillRect(x, y + h - 14, w, 7); g.fillStyle = '#c8102e'; g.fillRect(x, y + h - 7, w, 7); }
  if (s.color === 11) { g.fillStyle = '#0a8f4f'; g.fillRect(x, y + h - 14, w, 8); g.fillStyle = '#1757a6'; g.fillRect(x, y + h - 6, w, 6); }
  g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
  const chars = [...s.text];
  if (s.style === STYLE.BLADE && chars.some(isWide)) {
    // vertical writing: one character per cell, top to bottom; the long-vowel mark turns upright
    const cellH = (h - 12) / chars.length, size = Math.min(w * 0.72, cellH * 0.94);
    g.font = `900 ${size}px ${FONT}`;
    chars.forEach((ch, i) => g.fillText(ch === 'ー' ? '｜' : ch, x + w / 2, y + 6 + cellH * (i + 0.5)));
  } else {
    // one line, squeezed to fit; on a blade it runs down the board, rotated
    const turn = s.style === STYLE.BLADE, long = turn ? h : w, short = turn ? w : h;
    g.translate(x + w / 2, y + h / 2);
    if (turn) g.rotate(Math.PI / 2);
    g.font = `900 ${short * 0.62}px ${FONT}`;
    const tw = g.measureText(s.text).width, room = long - 16;
    if (tw > room) g.scale(room / tw, 1);
    g.fillText(s.text, 0, short * 0.03);
  }
  g.restore();
}

export class Signs {
  constructor() {
    // far: coloured panels, lit at night through their own colour
    this.panel = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide });
    this.panel.emissiveNode = diffuseColor.rgb.mul(shared.uNight).mul(1.3);
    this.live = new Set(); // textured materials currently in use
    this.ads = new Ads();
  }

  update() {
    const glow = 0.12 + shared.uNight.value * 1.25; // a lit sign is a little brighter than its surroundings by day too
    for (const m of this.live) m.emissiveIntensity = glow;
  }

  // signs: [{ style, color, x, y, z, nx, nz, w, h, text }]. Returns { group, setNear(bool), dispose() }.
  build(all) {
    const group = new THREE.Group();
    // billboards and screens (styles 3+) are drawn from a shared poster atlas, at any distance
    const ads = all.filter((s) => s.style >= 3), signs = all.filter((s) => s.style < 3);
    if (ads.length) group.add(this.ads.build(ads));
    const pos = [], col = [], uv = [], quads = []; // quads: [sign, first vertex] for the uv pass
    const c = new THREE.Color();
    const quad = (s, a, b, cc, d) => { // corners: bottom-left, bottom-right, top-right, top-left as read
      quads.push([s, pos.length / 3]);
      pos.push(...a, ...b, ...cc, ...a, ...cc, ...d);
      c.set((COLORS[s.color] ?? COLORS[2])[0]);
      for (let i = 0; i < 6; i++) col.push(c.r, c.g, c.b);
    };
    for (const s of signs) {
      const rx = s.nz, rz = -s.nx; // the reader's right when facing the wall
      if (s.style === STYLE.BLADE) {
        // perpendicular to the wall, readable from both directions along the street
        const P = (out, up) => [s.x + s.nx * (0.15 + out * s.w), s.y + (up - 0.5) * s.h, s.z + s.nz * (0.15 + out * s.w)];
        quad(s, P(0, 0), P(1, 0), P(1, 1), P(0, 1));
        quad(s, P(1, 0), P(0, 0), P(0, 1), P(1, 1));
      } else {
        const P = (side, up) => [s.x + rx * side * s.w / 2, s.y + (up - 0.5) * s.h, s.z + rz * side * s.w / 2];
        quad(s, P(-1, 0), P(1, 0), P(1, 1), P(-1, 1));
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const far = new THREE.Mesh(geo, this.panel);
    group.add(far);

    let near = null;
    const makeNear = () => {
      // shelf-pack one cell per sign; identical boards share a cell
      const cells = new Map();
      let cx = 0, cy = 0, rowH = 0;
      for (const s of signs) {
        const key = `${s.style}|${s.color}|${s.text}|${s.w}|${s.h}`;
        if (cells.has(key)) continue;
        const vertical = s.style === STYLE.BLADE, long = Math.min(384, Math.round(PX * Math.max(s.w / s.h, s.h / s.w)));
        const w = vertical ? PX : long, h = vertical ? long : PX;
        if (cx + w > ATLAS_W) { cx = 0; cy += rowH + 2; rowH = 0; }
        if (cy + h > ATLAS_MAX_H) break; // out of room: the remaining signs stay plain panels
        cells.set(key, { x: cx, y: cy, w, h, s });
        cx += w + 2; rowH = Math.max(rowH, h);
      }
      const H = Math.min(ATLAS_MAX_H, 2 ** Math.ceil(Math.log2(Math.max(64, cy + rowH))));
      const canvas = document.createElement('canvas');
      canvas.width = ATLAS_W; canvas.height = H;
      const g = canvas.getContext('2d');
      for (const cell of cells.values()) drawSign(g, cell.s, cell.x, cell.y, cell.w, cell.h);
      // the lettered boards lie over the plain panels; a sign that found no room in the atlas keeps its panel
      const tpos = [];
      uv.length = 0;
      for (const [s, first] of quads) {
        const cell = cells.get(`${s.style}|${s.color}|${s.text}|${s.w}|${s.h}`);
        if (!cell) continue;
        for (let i = first * 3; i < (first + 6) * 3; i++) tpos.push(pos[i]);
        const u0 = cell.x / ATLAS_W, u1 = (cell.x + cell.w) / ATLAS_W, v1 = 1 - cell.y / H, v0 = 1 - (cell.y + cell.h) / H;
        uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
      }
      const tgeo = new THREE.BufferGeometry();
      tgeo.setAttribute('position', new THREE.Float32BufferAttribute(tpos, 3));
      tgeo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      tgeo.computeVertexNormals();
      const map = new THREE.CanvasTexture(canvas);
      map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8;
      const material = new THREE.MeshStandardMaterial({
        map, emissiveMap: map, emissive: 0xffffff, emissiveIntensity: 0.12, roughness: 0.55,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, // drawn over the panel behind it
      });
      this.live.add(material);
      const mesh = new THREE.Mesh(tgeo, material);
      group.add(mesh);
      return { mesh, material, map, tgeo };
    };
    const dropNear = () => {
      group.remove(near.mesh);
      this.live.delete(near.material);
      near.map.dispose(); near.material.dispose(); near.tgeo.dispose();
      near = null;
    };
    return {
      group,
      // near: draw the names (built on demand, freed when the tile is far again)
      setNear: (on) => {
        if (on && !near) near = makeNear(); else if (!on && near) dropNear();
      },
      dispose: () => { if (near) dropNear(); geo.dispose(); },
    };
  }
}
