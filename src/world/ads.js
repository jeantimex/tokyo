// Billboards, LED screens and vertical banners (sign styles 3-6, placed by tools/pipeline/signs.mjs).
// The artwork is invented and drawn here, once, into an atlas: neon-sign pictures on Japanese themes — an
// anime-style face, a lucky cat, Mount Fuji, a sports car, a robot, a bowl of ramen, a game pad ... — with
// sign words. No real character, brand or logo is used. A screen cycles through the posters with a wipe,
// seen through an LED grid. Everything glows at night; screens are bright all day.
import * as THREE from 'three/webgpu';
import { shared } from './materials.js';

const COLS = 8, ROWS = 4, SIZE = 512;
export const WIDE = 24, TALL = 8; // posters 0..23 fill their cell; 24..31 are banners in the left third of theirs
const FONT = '"Yu Gothic", "Meiryo", "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif';
const KANA = ['ラーメン', 'カラオケ', 'ゲーム', 'アニメ', 'ライブ', 'カフェ', 'ロボ', 'ネオン', 'ホテル', 'シネマ'];
const KANJI = ['寿司', '電気', '居酒屋', '東京', '祭', '夢', '未来', '新発売', '大特価', '音楽', '薬', '焼肉'];
const LATIN = ['TOKYO', 'NEON', 'GAME', 'LIVE', 'SALE', 'CAFE', 'MUSIC', 'ROBO', 'OPEN', 'KAWAII', 'TURBO', 'TECH'];
// neon tubes: pink, cyan, yellow, green, orange, violet, red, white
const NEON = ['#ff3d9a', '#22e6ff', '#ffe23d', '#4dff88', '#ff8a2b', '#b56bff', '#ff3838', '#f4f8ff'];
const NIGHT = ['#0b0620', '#06142b', '#1a0626', '#04181a', '#200a0a', '#0a0a18'];

// ---- the pictures: each draws in a box about 1 wide and 1 high centred on the origin, as glowing tubes
const tube = (g, colour, width = 0.05) => { g.strokeStyle = colour; g.fillStyle = colour; g.shadowColor = colour; g.shadowBlur = 26; g.lineWidth = width; g.lineCap = 'round'; g.lineJoin = 'round'; };
const line = (g, pts, close = false) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); if (close) g.closePath(); g.stroke(); };
const ring = (g, x, y, r, fill = false) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); if (fill) g.fill(); else g.stroke(); };
const PICTURES = [
  function face(g, a, b) { // an anime-style girl: fringe, big eyes, blush
    tube(g, a); ring(g, 0, 0.02, 0.36);
    line(g, [[-0.4, -0.02], [-0.36, -0.36], [-0.12, -0.46], [0.14, -0.46], [0.37, -0.34], [0.4, 0]]);       // hair
    line(g, [[-0.3, -0.2], [-0.18, -0.06], [-0.06, -0.24], [0.08, -0.07], [0.2, -0.24], [0.3, -0.1]]);       // fringe
    line(g, [[-0.4, 0], [-0.46, 0.34]]); line(g, [[0.4, 0], [0.46, 0.34]]);                                   // side locks
    tube(g, b); for (const s of [-1, 1]) { g.beginPath(); g.ellipse(s * 0.15, 0.06, 0.07, 0.1, 0, 0, Math.PI * 2); g.fill(); }
    tube(g, '#ffffff', 0.02); for (const s of [-1, 1]) ring(g, s * 0.15 - 0.025, 0.02, 0.022, true);
    tube(g, '#ff7aa8', 0.03); line(g, [[-0.06, 0.24], [0, 0.27], [0.06, 0.24]]); for (const s of [-1, 1]) line(g, [[s * 0.22, 0.2], [s * 0.3, 0.2]]);
  },
  function cat(g, a, b) { // maneki-neko, one paw raised
    tube(g, a); ring(g, 0, 0.08, 0.3); line(g, [[-0.26, -0.08], [-0.24, -0.34], [-0.08, -0.2]]); line(g, [[0.26, -0.08], [0.24, -0.34], [0.08, -0.2]]);
    line(g, [[0.3, 0.1], [0.44, -0.12], [0.44, -0.3]]); ring(g, 0.44, -0.36, 0.06);                          // the paw
    tube(g, b, 0.04); for (const s of [-1, 1]) line(g, [[s * 0.16, 0.02], [s * 0.1, 0.06], [s * 0.04, 0.02]]); // smiling eyes
    line(g, [[-0.05, 0.16], [0, 0.2], [0.05, 0.16]]); for (const s of [-1, 1]) { line(g, [[s * 0.12, 0.14], [s * 0.34, 0.1]]); line(g, [[s * 0.12, 0.18], [s * 0.34, 0.22]]); }
    tube(g, '#ffe23d', 0.04); ring(g, 0, 0.36, 0.05, true);
  },
  function fuji(g, a, b) { // the mountain under a red sun
    tube(g, '#ff3838'); ring(g, 0.2, -0.2, 0.16, true);
    tube(g, a); line(g, [[-0.48, 0.34], [-0.12, -0.2], [-0.04, -0.14], [0.04, -0.2], [0.48, 0.34]]);
    tube(g, b, 0.04); line(g, [[-0.2, -0.08], [-0.12, -0.02], [-0.04, -0.1], [0.04, -0.02], [0.12, -0.08]]);
    line(g, [[-0.48, 0.4], [0.48, 0.4]]);
  },
  function wave(g, a, b) { // a great wave
    tube(g, a); for (let k = 0; k < 3; k++) { g.beginPath(); g.arc(-0.2 + k * 0.22, 0.1 + k * 0.08, 0.26 - k * 0.04, Math.PI * 0.9, Math.PI * 2.1); g.stroke(); }
    tube(g, b, 0.04); for (let k = 0; k < 5; k++) ring(g, -0.42 + k * 0.05, -0.12 - k * 0.03, 0.02, true);
    line(g, [[-0.48, 0.38], [-0.24, 0.3], [0, 0.38], [0.24, 0.3], [0.48, 0.38]]);
  },
  function car(g, a, b) { // a sports car at speed
    tube(g, a); line(g, [[-0.46, 0.12], [-0.4, 0], [-0.16, -0.04], [0, -0.18], [0.24, -0.18], [0.36, -0.02], [0.47, 0.02], [0.47, 0.12], [-0.46, 0.12]]);
    line(g, [[-0.1, -0.03], [0.02, -0.13], [0.2, -0.13], [0.28, -0.03]], true);
    tube(g, b); for (const x of [-0.26, 0.28]) ring(g, x, 0.14, 0.09);
    tube(g, '#f4f8ff', 0.03); for (let k = 0; k < 3; k++) line(g, [[-0.5 - k * 0.04, -0.14 + k * 0.1], [-0.3 - k * 0.06, -0.14 + k * 0.1]]);
  },
  function robot(g, a, b) { // a robot's head
    tube(g, a); line(g, [[-0.3, -0.2], [0.3, -0.2], [0.34, 0.24], [-0.34, 0.24]], true); line(g, [[0, -0.2], [0, -0.36]]); ring(g, 0, -0.4, 0.04, true);
    for (const s of [-1, 1]) line(g, [[s * 0.34, -0.04], [s * 0.42, -0.04], [s * 0.42, 0.12], [s * 0.34, 0.12]]);
    tube(g, b); line(g, [[-0.22, -0.06], [0.22, -0.06], [0.2, 0.04], [-0.2, 0.04]], true);
    tube(g, '#ffe23d', 0.03); for (let k = -2; k <= 2; k++) line(g, [[k * 0.07, 0.13], [k * 0.07, 0.19]]);
  },
  function ramen(g, a, b) { // a steaming bowl
    tube(g, a); g.beginPath(); g.arc(0, 0.02, 0.36, 0, Math.PI); g.closePath(); g.stroke(); line(g, [[-0.14, 0.38], [0.14, 0.38]]);
    tube(g, '#ffe23d', 0.03); for (let k = 0; k < 4; k++) { g.beginPath(); g.moveTo(-0.24 + k * 0.14, 0.02); g.bezierCurveTo(-0.2 + k * 0.14, 0.1, -0.28 + k * 0.14, 0.14, -0.22 + k * 0.14, 0.2); g.stroke(); }
    tube(g, b, 0.035); line(g, [[0.1, -0.02], [0.44, -0.3]]); line(g, [[0.16, 0], [0.48, -0.24]]);
    tube(g, '#f4f8ff', 0.03); for (const x of [-0.16, 0, 0.14]) { g.beginPath(); g.moveTo(x, -0.1); g.bezierCurveTo(x + 0.08, -0.18, x - 0.08, -0.26, x, -0.36); g.stroke(); }
  },
  function pad(g, a, b) { // a game pad
    tube(g, a); line(g, [[-0.3, -0.16], [0.3, -0.16], [0.44, 0.2], [0.3, 0.24], [0.14, 0.06], [-0.14, 0.06], [-0.3, 0.24], [-0.44, 0.2]], true);
    tube(g, b, 0.045); line(g, [[-0.26, -0.02], [-0.14, -0.02]]); line(g, [[-0.2, -0.08], [-0.2, 0.04]]);
    tube(g, '#ffe23d'); ring(g, 0.16, -0.04, 0.03, true); tube(g, '#ff3d9a'); ring(g, 0.25, -0.08, 0.03, true); tube(g, '#22e6ff'); ring(g, 0.25, 0.02, 0.03, true);
  },
  function chip(g, a, b) { // a microchip
    tube(g, a); line(g, [[-0.2, -0.2], [0.2, -0.2], [0.2, 0.2], [-0.2, 0.2]], true);
    tube(g, b, 0.03); for (let k = -2; k <= 2; k++) { line(g, [[k * 0.09, -0.2], [k * 0.09, -0.34]]); line(g, [[k * 0.09, 0.2], [k * 0.09, 0.34]]); line(g, [[-0.2, k * 0.09], [-0.34, k * 0.09]]); line(g, [[0.2, k * 0.09], [0.34, k * 0.09]]); }
    line(g, [[-0.1, -0.1], [0.1, -0.1], [0.1, 0.1], [-0.1, 0.1]], true);
  },
  function torii(g, a, b) { // a shrine gate
    tube(g, a, 0.07); line(g, [[-0.42, -0.22], [-0.2, -0.16], [0.2, -0.16], [0.42, -0.22]]); line(g, [[-0.32, -0.04], [0.32, -0.04]]);
    line(g, [[-0.24, -0.16], [-0.28, 0.38]]); line(g, [[0.24, -0.16], [0.28, 0.38]]);
    tube(g, b, 0.03); for (let k = 0; k < 6; k++) ring(g, -0.4 + k * 0.16, -0.36 + ((k * 7) % 3) * 0.04, 0.016, true);
  },
  function sakura(g, a, b) { // cherry blossoms
    for (const [x, y, r, c] of [[-0.2, -0.1, 0.2, a], [0.22, 0.12, 0.16, b], [0.16, -0.26, 0.1, a], [-0.24, 0.26, 0.09, b]]) {
      tube(g, c, 0.035);
      for (let k = 0; k < 5; k++) { const t = (k * Math.PI * 2) / 5 - Math.PI / 2; g.beginPath(); g.ellipse(x + Math.cos(t) * r * 0.55, y + Math.sin(t) * r * 0.55, r * 0.42, r * 0.26, t, 0, Math.PI * 2); g.stroke(); }
      ring(g, x, y, r * 0.1, true);
    }
  },
  function lantern(g, a, b) { // a paper lantern
    tube(g, a); g.beginPath(); g.ellipse(0, 0.02, 0.26, 0.32, 0, 0, Math.PI * 2); g.stroke(); line(g, [[-0.12, -0.32], [0.12, -0.32]]); line(g, [[-0.12, 0.36], [0.12, 0.36]]); line(g, [[0, -0.32], [0, -0.44]]);
    tube(g, b, 0.03); for (const y of [-0.14, 0.02, 0.18]) { g.beginPath(); g.ellipse(0, y, 0.26 * Math.sqrt(1 - ((y - 0.02) / 0.32) ** 2), 0.03, 0, 0, Math.PI); g.stroke(); }
  },
];

function atlas() {
  const c = document.createElement('canvas');
  c.width = COLS * SIZE; c.height = ROWS * SIZE;
  const g = c.getContext('2d');
  let seed = 11;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const S = SIZE;
  const cell = (i, draw) => {
    g.save();
    g.translate((i % COLS) * S, Math.floor(i / COLS) * S);
    g.beginPath(); g.rect(0, 0, S, S); g.clip();
    draw();
    g.restore();
  };
  const backdrop = (w) => {
    const grad = g.createLinearGradient(0, 0, w, S);
    grad.addColorStop(0, pick(NIGHT)); grad.addColorStop(1, pick(NIGHT));
    g.shadowBlur = 0; g.fillStyle = grad; g.fillRect(0, 0, w, S);
  };
  const words = (text, x, y, size, colour, vertical) => {
    g.font = `900 ${size}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = colour; g.shadowBlur = 30; g.fillStyle = '#ffffff'; g.strokeStyle = colour; g.lineWidth = size * 0.09;
    const chars = vertical ? [...text] : [text];
    chars.forEach((ch, k) => { const yy = y + (k - (chars.length - 1) / 2) * size * 1.06; g.strokeText(ch, x, yy); g.fillText(ch, x, yy); });
  };
  // ---- wide posters: a picture on one side, words on the other, a tube round the edge
  for (let i = 0; i < WIDE; i++) cell(i, () => {
    const a = NEON[i % NEON.length], b = NEON[(i * 3 + 2) % NEON.length], w = NEON[(i * 5 + 4) % NEON.length], left = i % 2 === 0;
    backdrop(S);
    g.lineWidth = 10; g.strokeStyle = w; g.shadowColor = w; g.shadowBlur = 24; g.strokeRect(22, 22, S - 44, S - 44);
    g.save(); g.translate(S * (left ? 0.32 : 0.68), S * 0.5); g.scale(S * 0.5, S * 0.74); PICTURES[i % PICTURES.length](g, a, b); g.restore();
    const kanji = i % 3 !== 2;
    if (kanji) { const t = pick(i % 3 ? KANJI : KANA), size = Math.min(S * 0.19, (S * 0.8) / [...t].length); words(t, S * (left ? 0.78 : 0.22), S * 0.5, size, w, true); }
    else { const t = pick(LATIN); g.save(); g.translate(S * (left ? 0.74 : 0.26), S * 0.5); g.rotate(-Math.PI / 2); words(t, 0, 0, Math.min(S * 0.16, (S * 0.8) / (t.length * 0.62)), w, false); g.restore(); }
  });
  // ---- banners, for the sides of buildings: one column of big characters over a small picture, in the left third
  for (let i = 0; i < TALL; i++) cell(WIDE + i, () => {
    const a = NEON[(i * 3) % NEON.length], b = NEON[(i * 3 + 5) % NEON.length], W = S / 3;
    backdrop(W);
    g.lineWidth = 8; g.strokeStyle = a; g.shadowColor = a; g.shadowBlur = 22; g.strokeRect(12, 12, W - 24, S - 24);
    const t = pick(i % 2 ? KANA : KANJI), n = [...t].length;
    words(t, W / 2, S * 0.4, Math.min(W * 0.62, (S * 0.62) / n), a, true);
    g.save(); g.translate(W / 2, S * 0.84); g.scale(W * 0.7, S * 0.2); PICTURES[(i * 5 + 1) % PICTURES.length](g, b, a); g.restore();
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

export class Ads {
  constructor() {
    // uv: position within the board (0-1); aAd: x poster index, y 0 board / 1 screen / 2 banner, z seed
    this.material = new THREE.MeshStandardMaterial({ map: atlas(), roughness: 0.5 });
    this.material.onBeforeCompile = (shader) => {
    shader.uniforms.uLampOn = { value: 0 }; shader.uniforms.uLampMap = shared.uLampMap; // (no lamp light here; the sampler still needs its texture)
      shader.uniforms.uNight = shared.uNight;
      shader.uniforms.uTime = shared.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aAd;\nvarying vec3 vAd;\nvarying vec2 vBoard;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAd = aAd;\nvBoard = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <map_pars_fragment>', `#include <map_pars_fragment>
          uniform float uNight, uTime;
          varying vec3 vAd;
          varying vec2 vBoard;
          vec3 gAd;
          vec3 poster(float index, vec2 at) {
            float i = floor(index + 0.5); // the index is interpolated: round it
            vec2 cell = vec2(mod(i, ${COLS}.0), ${ROWS - 1}.0 - floor(i / ${COLS}.0));
            return texture2D(map, (cell + clamp(at, 0.004, 0.996)) / vec2(${COLS}.0, ${ROWS}.0)).rgb;
          }`)
        .replace('#include <map_fragment>', `
          if (vAd.y > 1.5) gAd = poster(vAd.x, vec2(vBoard.x / 3.0, vBoard.y));      // a banner: the left third of its cell
          else if (vAd.y > 0.5) {
            // a screen: the next poster wipes in every few seconds; LED pixels show close up
            float t = uTime * 0.16 + vAd.z * 9.0, wipe = smoothstep(0.86, 1.0, fract(t));
            float now = mod(vAd.x + floor(t), ${WIDE}.0), next = mod(now + 1.0, ${WIDE}.0);
            gAd = mix(poster(now, vBoard), poster(next, vBoard), step(vBoard.x, wipe));
            vec2 led = fract(vBoard * vec2(160.0, 90.0));
            float fine = max(fwidth(vBoard.x * 160.0), fwidth(vBoard.y * 90.0));
            gAd *= mix(0.72 + 0.5 * step(0.22, led.x) * step(0.22, led.y), 1.0, smoothstep(0.3, 1.0, fine));
          } else gAd = poster(vAd.x, vBoard);
          // by day an unlit neon sign is dull glass on a dark board: only its colour shows
          diffuseColor.rgb *= mix(gAd * 0.55 + 0.03, gAd, uNight);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += gAd * (vAd.y > 0.5 && vAd.y < 1.5 ? 1.0 + 0.9 * uNight : 0.1 + 2.2 * uNight);`);
    };
    this.material.customProgramCacheKey = () => 'ads-v2';
    this.frame = new THREE.MeshStandardMaterial({ color: 0x2a2c2f, roughness: 0.6, metalness: 0.4, side: THREE.DoubleSide });
  }

  // ads: signs of style 3 (billboard on a wall), 4 (screen on a wall), 5 (billboard on a frame on the roof),
  // 6 (vertical banner on a wall).
  build(ads) {
    const pos = [], uv = [], ad = [], frame = [];
    for (const s of ads) {
      const rx = s.nz, rz = -s.nx, out = 0.3; // reader's right; boards stand a little off the wall
      const P = (side, up, off = out) => [s.x + rx * side * s.w / 2 + s.nx * off, s.y + (up - 0.5) * s.h, s.z + rz * side * s.w / 2 + s.nz * off];
      const corners = [P(-1, 0), P(1, 0), P(1, 1), P(-1, 0), P(1, 1), P(-1, 1)];
      for (const c of corners) pos.push(...c);
      uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
      const seed = (Math.abs(s.x * 0.37 + s.z * 0.91) % 1);
      for (let i = 0; i < 6; i++) ad.push(s.color, s.style === 4 ? 1 : s.style === 6 ? 2 : 0, seed);
      // a dark casing behind the board, and legs under a rooftop one
      const back = [P(-1.03, -0.03, out - 0.08), P(1.03, -0.03, out - 0.08), P(1.03, 1.03, out - 0.08), P(-1.03, 1.03, out - 0.08)];
      frame.push(...back[0], ...back[1], ...back[2], ...back[0], ...back[2], ...back[3]);
      if (s.style === 5) for (const side of [-0.8, 0, 0.8]) {
        const a = P(side - 0.03, 0, out - 0.1), b = P(side + 0.03, 0, out - 0.1), legs = 1.6;
        frame.push(a[0], a[1] - legs, a[2], b[0], b[1] - legs, b[2], ...b, a[0], a[1] - legs, a[2], ...b, ...a);
      }
    }
    const group = new THREE.Group();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('aAd', new THREE.Float32BufferAttribute(ad, 3));
    geo.computeVertexNormals();
    const fgeo = new THREE.BufferGeometry();
    fgeo.setAttribute('position', new THREE.Float32BufferAttribute(frame, 3));
    fgeo.computeVertexNormals();
    group.add(new THREE.Mesh(fgeo, this.frame), new THREE.Mesh(geo, this.material));
    return group;
  }
}
