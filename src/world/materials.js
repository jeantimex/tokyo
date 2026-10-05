// Materials. Buildings and ground are MeshStandardNodeMaterials whose colour, roughness, normal and emitted
// light come from procedural detail written in TSL, so they keep three's lighting and shadows.
//
// Building vertex attributes (see meshing.js):
//   color    surface colour (linear); the wall texture only adds detail on top
//   aFacade  x: window column coordinate (integer = bay edge), y: height above the base (m),
//            z: floor height (m), w: building seed in [0, 1)
//   aBldg    x: building height (m), y: category + 8 * texture layer, z: kind (KIND), w: bay width (m, 0 = no windows)
import * as THREE from 'three/webgpu';
import {
  Fn, If, uniform, uniformArray, texture, attribute, property, float, int, vec2, vec3, vec4, select, mix, step, smoothstep, floor, fract, abs, max, min,
  dot, cross, normalize, length, reflect, pow, exp, sin, clamp, fwidth, distance, positionWorld, normalWorldGeometry, cameraPosition, transformNormalToView,
  materialColor, output,
} from 'three/tsl';
import { lampLit } from './lamplight.js';

// (a texture node needs a texture from the start: one grey texel until the real one arrives)
const blank = () => { const t = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1); t.needsUpdate = true; return t; };

// Values shared by the materials, as node uniforms: set them through .value.
export const shared = {
  uNight: uniform(0), // 0 day .. 1 night: how far the lights are on
  uDark: uniform(0),  // 0 day .. 1 night: how dark it is
  uTime: uniform(0),  // seconds, for wind and signals
  // aerial photo over the area: texture, and its rectangle in world x/z as (minX, minZ, sizeX, sizeZ)
  uOrtho: texture(blank()), uOrthoRect: uniform(new THREE.Vector4(0, 0, 1, 1)), uOrthoOn: uniform(0),
  // lit windows at night: the share of rooms whose light comes and goes, and how fast (1: every 1.5 to 5.5 minutes)
  uWindowLife: uniform(new THREE.Vector2(0.5, 4)),
  // how strongly the glass of tall buildings mirrors the lights of the city at night (0: off)
  uCityGlass: uniform(1),
  // how blue the lights of the city are at night (0: mostly warm, 1: a cool blue city)
  uNightBlue: uniform(0.55),
  // the sun in the window glass: direction to the sun (world), and its colour times how much of it there is
  uSunDir: uniform(new THREE.Vector3(0, 1, 0)), uSunGlint: uniform(new THREE.Color(0, 0, 0)), uGlintOn: uniform(1),
  // wall photos: the distances (m) between which a facade goes from generated to photo, and how much photo at most
  uPhotoRange: uniform(new THREE.Vector2(140, 420)), uPhotoMix: uniform(1),
  // the mirror picture of the world in the water (mirror.js), and the matrix from a world point to its place in it
  uMirror: texture(blank()), uMirrorMatrix: uniform(new THREE.Matrix4()), uMirrorOn: uniform(0),
};

// ---------------------------------------------------------------- noise
export const hash12 = Fn(([p]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
}).setLayout({ name: 'hash12', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

export const vnoise = Fn(([p]) => {
  const i = floor(p).toVar(), f0 = fract(p).toVar();
  const f = f0.mul(f0).mul(f0.mul(-2).add(3)).toVar();
  return mix(mix(hash12(i), hash12(i.add(vec2(1, 0))), f.x), mix(hash12(i.add(vec2(0, 1))), hash12(i.add(vec2(1, 1))), f.x), f.y);
}).setLayout({ name: 'vnoise', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

// Anti-aliased box [a, b] in x with filter width w.
const box = (x, a, b, w) => smoothstep(float(a).sub(w), float(a).add(w), x).sub(smoothstep(float(b).sub(w), float(b).add(w), x));
const hue = (h) => clamp(abs(fract(vec3(0, 2 / 3, 1 / 3).add(h)).mul(6).sub(3)).sub(1), 0, 1);

// What a material's colour node works out besides the colour (it runs first): read by the other nodes.
const pRough = property('float', 'pRough'), pMetal = property('float', 'pMetal'), pEmissive = property('vec3', 'pEmissive');
const pNormal = property('vec3', 'pNormal'); // the shading normal, world space
const pGlint = property('vec3', 'pGlint'), pSunlit = property('float', 'pSunlit'); // the sun in a pane, and how much sun reaches it
export const pPane = property('float', 'pPane'); // how much of a mirror this fragment is: window glass

// ---------------------------------------------------------------- facade
const NO_PHOTO = blank();

// One instance per tile that has a wall photo atlas; set it with material.userData.photo.value / photoOn.value.
function facadeMaterial(tex) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  const photo = m.userData.photo = texture(NO_PHOTO), photoOn = m.userData.photoOn = uniform(0);
  const wallScale = uniformArray(tex.wall.scales), wallDetail = uniformArray(tex.wall.details);
  const { uNight, uTime, uWindowLife, uCityGlass, uNightBlue, uSunDir, uSunGlint, uGlintOn, uPhotoRange, uPhotoMix } = shared;

  m.colorNode = Fn(() => {
    const vColor = attribute('color', 'vec3'), aF = attribute('aFacade', 'vec4'), aB = attribute('aBldg', 'vec4'), aPhoto = attribute('aPhoto', 'vec2');
    const pos = positionWorld, V = normalize(pos.sub(cameraPosition)).toVar();
    const gN = normalize(normalWorldGeometry).toVar();
    const gT = select(gN.y.abs().greaterThan(0.95), vec3(1, 0, 0), normalize(cross(vec3(0, 1, 0), gN))).toVar();
    const gB = cross(gN, gT).toVar();
    const seed = aF.w.toVar(), height = aB.x.toVar(), kind = aB.z.toVar(), cellW = aB.w.toVar();
    const layer = floor(aB.y.div(8).add(0.01)).toVar(), cat = aB.y.sub(layer.mul(8)).toVar();
    const u = aF.x.toVar(), v = aF.y.toVar(), floorH = aF.z.toVar();

    // surface texture: detail (mean 1) over the vertex colour, plus a normal map
    const st = vec2(dot(pos, gT), dot(pos, gB)).toVar(), li = int(layer);
    const tuv = st.div(wallScale.element(li)).toVar();
    const wall = vColor.mul(mix(vec3(1), texture(tex.wall.albedo, tuv).depth(li).rgb.mul(2), wallDetail.element(li))).toVar();
    wall.mulAssign(vnoise(st.mul(0.11).add(seed.mul(50))).mul(0.2).add(0.9)); // breaks up tiling over large walls
    const nmTex = texture(tex.wall.normal, tuv).depth(li).xyz.mul(2).sub(1);
    const nm = normalize(vec3(nmTex.xy.mul(0.7), nmTex.z)).toVar();
    const rough = float(0.82).toVar(), metal = float(0).toVar(), emis = vec3(0).toVar(), glint = vec3(0).toVar(), paneOut = float(0).toVar();
    If(layer.greaterThan(3.5).and(layer.lessThan(4.5)), () => { rough.assign(0.5); metal.assign(0.35); }); // metal siding and roofs

    // weathering on walls: rain streaks, a dirty base, run-off under the roofline
    If(kind.lessThan(0.5).or(kind.greaterThan(1.5).and(kind.lessThan(2.5))), () => {
      const streak = vnoise(vec2(st.x.mul(2.2), st.y.mul(0.13).add(seed.mul(40)))).toVar();
      const grime = smoothstep(0.55, 0.95, streak).mul(0.1)
        .add(smoothstep(0, 1.6, v).oneMinus().mul(0.1))
        .add(smoothstep(height.sub(2.5), height, v).mul(streak).mul(0.14));
      wall.mulAssign(grime.oneMinus());
    });
    const diffuse = vec3(wall).toVar();

    // steelwork of a lattice tower (src/world/tower.js): painted steel in the vertex colour, floodlit at night
    If(kind.greaterThan(3.5), () => {
      // (a colour brighter than 1 is a lamp: dark glass by day, lit at night; the steel keeps its own paint
      // under the floodlights)
      const lampOn = step(1.5, max(vColor.r, max(vColor.g, vColor.b)));
      diffuse.assign(mix(vColor.mul(vnoise(st.mul(0.7)).mul(0.12).add(0.94)), vec3(0.12), lampOn));
      rough.assign(0.5); metal.assign(0.25); nm.assign(vec3(0, 0, 1));
      emis.assign(mix(vColor.mul(0.75), vColor.mul(1.6), lampOn).mul(uNight));
    });

    If(kind.lessThan(0.5).and(cellW.greaterThan(0.5)), () => {
      const fyAll = v.div(floorH).toVar(), row = floor(fyAll).toVar(), col = floor(u).toVar();
      // Per-room random numbers. The seed is interpolated, so it carries rounding noise: hash only
      // integers derived from it (meshing.js stores seeds as multiples of 1/4096).
      const sid = floor(seed.mul(4096).add(0.5)).toVar();
      const room = vec2(col.add(sid.mod(61).mul(17)), row.add(sid.mod(53).mul(13))).toVar();
      const fx = fract(u).toVar(), fy = fract(fyAll).toVar();
      const wx = max(fwidth(u), 1e-4).toVar(), wy = max(fwidth(fyAll), 1e-4).toVar();
      const far = smoothstep(0.2, 0.6, max(wx, wy)).toVar(); // the grid aliases far away

      // window rectangle within one bay: [x0, x1] x [y0, y1]
      const r = vec4(0.14, 0.86, 0.3, 0.82).toVar();                                                      // apartments, offices
      If(cat.lessThan(0.5), () => { r.assign(vec4(0.26, 0.74, 0.36, 0.78)); })                             // houses
        .ElseIf(cat.greaterThan(3.5).and(cat.lessThan(4.5)), () => { r.assign(vec4(0.16, 0.84, 0.3, 0.8)); }) // public
        .ElseIf(cat.greaterThan(4.5), () => { r.assign(vec4(0, 1, 0.26, 1)); });                           // curtain wall: glass above a spandrel
      const shop = row.lessThan(0.5).and(cat.greaterThan(1.5)).and(cat.lessThan(3.5)).toVar();
      If(shop, () => { r.assign(vec4(0.05, 0.95, 0.03, 0.8)); });                                          // ground-floor shopfront
      const valid = step(0, v).mul(step(v, height.sub(0.9))).toVar();
      // houses and apartments: some bays are plain wall
      If(cat.lessThan(2.5).and(shop.not()), () => { valid.mulAssign(step(0.2, hash12(room.add(41)))); });
      const inWin = box(fx, r.x, r.y, wx).mul(box(fy, r.z, r.w, wy)).mul(valid).toVar();

      // frame and mullions, measured in metres from the window edge
      const wmin = vec2(r.x.mul(cellW), r.z.mul(floorH)).toVar(), wmax = vec2(r.y.mul(cellW), r.w.mul(floorH)).toVar();
      const pm = vec2(fx.mul(cellW), fy.mul(floorH)).toVar();
      const edge = min(min(pm.x.sub(wmin.x), wmax.x.sub(pm.x)), min(pm.y.sub(wmin.y), wmax.y.sub(pm.y))).toVar();
      const fw = select(cat.greaterThan(4.5), 0.045, 0.065), ew = max(fwidth(edge), 1e-4);
      const frame = smoothstep(fw.sub(ew), fw.add(ew), edge).oneMinus().toVar();
      const panes = max(1, floor(wmax.x.sub(wmin.x).div(1.25).add(0.5))).toVar();
      const mx = fract(pm.x.sub(wmin.x).div(wmax.x.sub(wmin.x)).mul(panes)).toVar();
      const mw = panes.mul(0.03).div(wmax.x.sub(wmin.x)).toVar();
      const mullion = box(mx, mw, mw.oneMinus(), max(fwidth(mx), 1e-4)).oneMinus();
      frame.assign(max(frame, select(panes.greaterThan(1.5), mullion, 0)));
      frame.mulAssign(far.oneMinus());
      const pane = inWin.mul(frame.oneMinus()).toVar();

      // interior mapping: intersect the view ray with a room box behind the glass
      const rd = vec3(dot(V, gT).div(cellW), dot(V, gB).div(floorH), dot(V, gN).div(4.5)).add(vec3(1e-5, 1e-5, 0)).toVar();
      const ro = vec3(fx, fy, 0);
      const tA = step(vec2(0), rd.xy).sub(ro.xy).div(rd.xy).toVar();
      const tz = float(-1).div(min(rd.z, -1e-4)).toVar();
      const tHit = min(min(tA.x, tA.y), tz).toVar();
      const hp = ro.add(rd.mul(tHit)).toVar();
      const rh = hash12(room).toVar();
      const interior = mix(vec3(0.74, 0.69, 0.6), vec3(0.6, 0.63, 0.68), rh).toVar();
      const shade = select(tHit.equal(tz), step(0.42, hp.y).mul(0.28).add(0.5),               // back wall above a furniture band
        select(tHit.equal(tA.y), select(rd.y.greaterThan(0), 1, 0.38), 0.62));                 // ceiling, floor; side walls
      interior.mulAssign(shade.mul(mix(1, 0.5, clamp(hp.z.negate(), 0, 1))));
      // blinds or curtains pulled part-way down some windows
      const blind = step(0.5, hash12(room.add(7.7))).mul(hash12(room.add(3.1)));
      const wyLocal = fy.sub(r.z).div(r.w.sub(r.z));
      If(shop.not().and(wyLocal.greaterThan(blind.mul(0.85).oneMinus())), () => { interior.assign(mix(vec3(0.8, 0.78, 0.72), vec3(0.68, 0.7, 0.74), rh).mul(0.75)); });
      interior.assign(mix(interior, vec3(0.42, 0.42, 0.4), far)); // far away: the average room

      // lit rooms at night: shops and offices more often than homes
      const onRate = select(shop, 0.75, select(cat.greaterThan(2.5), 0.32, 0.22)).toVar();
      // No two buildings alike: one is asleep and the next is busy; many offices are lit by the floor (a whole
      // storey working late, the one above dark).
      const b1 = fract(seed.mul(11.7)), b2 = fract(seed.mul(17.3)).toVar(), b3 = fract(seed.mul(23.9)).toVar();
      onRate.mulAssign(mix(0.35, 1.9, b1));
      If(shop.not().and(cat.greaterThan(2.5)).and(b2.greaterThan(0.4)), () => {
        onRate.assign(mix(0.05, 0.9, step(0.5, hash12(vec2(row.mul(3).add(sid.mod(37)), sid.mod(53))))));
      });
      // A tower at night is mostly dark glass: a few storeys lit as bands, the rest a mirror for the city.
      const tall = smoothstep(70, 110, height).toVar();
      If(shop.not(), () => { onRate.assign(mix(onRate, step(0.9, hash12(vec2(row.mul(5).add(sid.mod(41)), sid.mod(59)))).mul(0.8).add(0.02), tall)); });
      onRate.assign(clamp(onRate, 0, 0.95));
      // Some rooms stay as they are all night. The others (uWindowLife.x of them) are lived in: every so often,
      // each room on its own clock (90 to 330 s, divided by the pace uWindowLife.y), someone may come in or
      // leave, and the light goes on or off over a second.
      const fickle = step(uWindowLife.x.oneMinus(), hash12(room.add(31)));
      const period = hash12(room.add(37)).mul(240).add(90).div(max(uWindowLife.y, 0.01)).toVar();
      const clock = uTime.div(period).add(hash12(room.add(41))).toVar(), slot = floor(clock).toVar();
      const litNow = mix(step(onRate.oneMinus(), hash12(room.add(43).add(slot.sub(1).mul(7)))), step(onRate.oneMinus(), hash12(room.add(43).add(slot.mul(7)))),
        smoothstep(0, float(1.2).div(period), fract(clock)));
      const on = mix(step(onRate.oneMinus(), hash12(room.add(23))), litNow, fickle).toVar();
      // The colour of the light: homes mostly warm bulbs, some cool, the odd blue of a television; an office
      // building one kind of tube throughout, cool white more often than warm. Brightness varies room by room
      // and building by building.
      const tint = hash12(room.add(61)).toVar(), office = step(2.5, cat).toVar();
      const warm = mix(vec3(1, 0.6, 0.3), vec3(1, 0.82, 0.6), hash12(room.add(67)));
      // (uNightBlue leans the city towards blue: bluer cool lamps, more of them, more rooms in screen light)
      const cool = mix(vec3(1, 0.95, 0.86), mix(vec3(0.78, 0.9, 1), vec3(0.42, 0.66, 1), uNightBlue), hash12(room.add(71)));
      const coolShare = mix(0.25, mix(0.12, 0.95, step(0.35, b2)), office).add(uNightBlue.mul(0.45));
      const lamp = mix(warm, cool, step(coolShare.oneMinus(), mix(tint, b3.mul(0.5).add(tint.mul(0.5)), office))).toVar();
      lamp.assign(mix(lamp, vec3(0.3, 0.55, 1), step(float(0.93).sub(uNightBlue.mul(0.22)), tint).mul(mix(office.oneMinus(), 1, uNightBlue))));
      const glow = mix(0.3, 1.35, hash12(room.add(1.3))).mul(mix(0.65, 1.25, b3));

      // glass: mostly a mirror of the sky; the room behind shows through as emitted light
      const glassTint = select(cat.greaterThan(4.5), mix(vec3(0.2, 0.3, 0.38), vec3(0.3, 0.33, 0.34), fract(seed.mul(5.7))), vec3(0.1, 0.11, 0.12));
      const frameCol = select(fract(seed.mul(3.3)).lessThan(0.5), vec3(0.16, 0.17, 0.18), vec3(0.62, 0.63, 0.63));
      diffuse.assign(mix(diffuse, frameCol, inWin.mul(frame)));
      diffuse.assign(mix(diffuse, glassTint, pane));
      rough.assign(mix(rough, 0.45, inWin.mul(frame)));
      rough.assign(mix(rough, 0.05, pane));
      metal.assign(mix(metal, 0.92, pane));
      nm.assign(mix(nm, normalize(vec3(hash12(room.add(5.1)).sub(0.5).mul(0.03), hash12(room.add(9.4)).sub(0.5).mul(0.03), 1)), inWin));
      const daylight = uNight.oneMinus().mul(select(shop, 0.3, select(cat.greaterThan(4.5), 0.06, 0.12)));
      emis.assign(interior.mul(pane).mul(lamp.mul(uNight.mul(on).mul(glow).mul(1.25)).add(daylight)));
      // The sun in the glass. Each pane sits a little out of true and float glass is never quite flat, so the
      // mirrored sun is a hot core with a glare around it that wanders from pane to pane as the view moves. The
      // third, wide term is not physics: the true mirror image is only seen from below the sun's own height, and
      // this lets glass facing the sun catch some of its light from the air too.
      {
        const wobble = vec2(vnoise(st.mul(0.8).add(seed.mul(9))).sub(0.5), vnoise(st.mul(0.8).add(31).add(seed.mul(9))).sub(0.5)).mul(0.035);
        const paneN = normalize(gT.mul(nm.x.add(wobble.x)).add(gB.mul(nm.y.add(wobble.y))).add(gN.mul(nm.z)));
        const s = max(dot(reflect(V, paneN), uSunDir), 0).toVar();
        glint.assign(uSunGlint.mul(pane).mul(uGlintOn).mul(pow(s, 1400).mul(14).add(pow(s, 90).mul(0.35)).add(pow(s, 7).mul(0.1))).mul(step(0, dot(gN, uSunDir))));
      }
      // Some towers (more of them as uNightBlue rises) are lit in one colour throughout: their lit rooms shine
      // blue or golden yellow — a few cyan or violet — instead of white.
      {
        const pickA = fract(seed.mul(31.7)), hueA = fract(seed.mul(47.3)).toVar();
        const accent = tall.mul(step(float(0.7).sub(uNightBlue.mul(0.45)), pickA)).mul(uNight);
        const accentCol = select(hueA.lessThan(0.42), vec3(0.12, 0.38, 1), select(hueA.lessThan(0.76), vec3(1, 0.72, 0.16), select(hueA.lessThan(0.89), vec3(0.1, 0.85, 1), vec3(0.75, 0.3, 1))));
        emis.assign(mix(emis, accentCol.mul(dot(emis, vec3(0.9))), accent.mul(0.8)));
      }
      // The city in the glass of a tower at night. The mirrored view ray is followed down to street level, where
      // the lights of the city lie as a field of points fixed to the ground (a lamp or a window every 26 m or
      // so, warm or cool), so the reflection slides over the glass as the view moves, as a real one does.
      If(tall.greaterThan(0).and(uNight.greaterThan(0.01)).and(uCityGlass.greaterThan(0)), () => {
        const paneN = normalize(gT.mul(nm.x).add(gB.mul(nm.y)).add(gN.mul(nm.z))).toVar(), R = reflect(V, paneN).toVar();
        const fresnel = pow(max(dot(V.negate(), paneN), 0).oneMinus(), 4).mul(0.9).add(0.1);
        const city = vec3(0).toVar();
        If(R.y.lessThan(-0.015), () => {
          const reach = pos.y.sub(12).div(R.y.negate()).toVar(); // metres along the ray to street level
          const g = pos.xz.add(R.xz.mul(reach)).div(26).toVar(), cell = floor(g).toVar();
          const at = vec2(hash12(cell.add(3.1)), hash12(cell.add(7.7)));
          const d = length(fract(g).sub(at)).mul(26).toVar(), k = hash12(cell.add(13)).toVar();
          const spot = exp(d.mul(d).negate().div(reach.mul(0.03).add(3))).mul(step(0.3, k));
          const tintC = select(k.greaterThan(float(0.8).sub(uNightBlue.mul(0.3))), mix(vec3(0.8, 0.9, 1), vec3(0.4, 0.65, 1), uNightBlue),
            select(k.greaterThan(0.42).and(k.lessThan(0.5)), vec3(1, 0.25, 0.2), vec3(1, 0.72, 0.42)));
          city.assign(tintC.mul(spot).mul(5).div(reach.mul(reach).div(4.0e5).add(1)));
          city.addAssign(vec3(1, 0.75, 0.5).mul(0.035).mul(smoothstep(0, 900, reach))); // and their haze towards the horizon
        });
        emis.addAssign(city.mul(fresnel).mul(pane).mul(tall).mul(uNight).mul(uCityGlass).mul(on.mul(0.9).oneMinus()));
      });
      paneOut.assign(pane.mul(far.mul(0.7).oneMinus()).mul(uNight.mul(on).mul(0.85).oneMinus())); // (a lit room shows itself, not a reflection)
      // the lintel shades the top of the opening
      diffuse.mulAssign(inWin.mul(0.35).mul(smoothstep(0, 0.18, wmax.y.sub(pm.y)).oneMinus()).mul(far.oneMinus()).oneMinus());

      // sign band over shopfronts
      If(shop, () => {
        const sign = box(fy, 0.84, 0.985, wy).mul(box(fx, 0.03, 0.97, wx)).mul(valid).mul(step(0.25, hash12(room.add(57)))).toVar();
        const sc = mix(hue(hash12(room.add(71))), vec3(0.95), step(0.6, hash12(room.add(83))).mul(0.35)).toVar();
        diffuse.assign(mix(diffuse, sc.mul(0.75), sign));
        emis.addAssign(sc.mul(sign).mul(uNight).mul(1.6));
        rough.assign(mix(rough, 0.4, sign));
      });
    });

    // The real wall, from PLATEAU's aerial photo: too smeared to stand in front of, right from across the city.
    const photoRgb = photo.sample(aPhoto).rgb; // (sampled outside any branch: derivatives)
    const k = photoOn.mul(uPhotoMix).mul(step(0, aPhoto.x)).mul(smoothstep(uPhotoRange.x, uPhotoRange.y, distance(cameraPosition, pos))).toVar();
    diffuse.assign(mix(diffuse, photoRgb.mul(1.12), k));
    rough.assign(mix(rough, 0.85, k));
    metal.mulAssign(k.oneMinus());

    pRough.assign(rough); pMetal.assign(metal); pPane.assign(paneOut);
    pEmissive.assign(emis); pGlint.assign(glint); pSunlit.assign(1);
    pNormal.assign(normalize(gT.mul(nm.x).add(gB.mul(nm.y)).add(gN.mul(nm.z))));
    return diffuse;
  })();
  m.roughnessNode = pRough;
  m.metalnessNode = pMetal;
  m.emissiveNode = pEmissive;
  m.normalNode = transformNormalToView(pNormal);
  // the sun mirrored in a pane shows only where the sun reaches the pane
  m.receivedShadowNode = Fn(([shadow]) => { pSunlit.assign(shadow.r); return shadow; });
  // (the panes are marked in alpha for the reflection pass)
  m.outputNode = vec4(output.rgb.add(pGlint.mul(pSunlit)), pPane.mul(-0.95).add(1));
  return m;
}

// ---------------------------------------------------------------- ground
// Calm harbour water: the height of its ripples (in units of about 3.5 cm) at a point of the ground plan. Long
// low waves from several quarters crossing each other, bent out of line so they never look ruled.
const ripple = Fn(([p0, t]) => {
  const p = p0.add(vec2(vnoise(p0.mul(0.11).add(t.mul(0.03))), vnoise(p0.mul(0.11).add(9).sub(t.mul(0.03)))).mul(3.2))
    .add(vec2(vnoise(p0.mul(0.45).sub(t.mul(0.05))), vnoise(p0.mul(0.45).add(23).add(t.mul(0.05)))).mul(0.9)).toVar();
  const h = sin(dot(p, vec2(0.92, 0.39)).mul(1.1).add(t.mul(1.1))).mul(0.3).toVar();
  h.addAssign(sin(dot(p, vec2(-0.45, 0.89)).mul(1.6).sub(t.mul(1.4)).add(1.3)).mul(0.28));
  h.addAssign(sin(dot(p, vec2(0.2, -0.98)).mul(2.7).add(t.mul(1.9)).add(4)).mul(0.22));
  h.addAssign(sin(dot(p, vec2(-0.8, -0.6)).mul(4.3).sub(t.mul(2.6))).mul(0.14));
  h.addAssign(vnoise(p.mul(0.8).add(vec2(t.mul(0.25), t.mul(-0.18)))).sub(0.5).mul(0.9));
  h.addAssign(vnoise(p.mul(1.9).sub(vec2(t.mul(0.4), t.mul(0.3)))).sub(0.5).mul(0.45));
  return h;
}).setLayout({ name: 'ripple', type: 'float', inputs: [{ name: 'p0', type: 'vec2' }, { name: 't', type: 'float' }] });

// Terrain and road surfaces: a tint (the vertex colour, or the material's) x texture detail; the texture layer
// from the aLayer attribute (roads) or fixed (terrain).
function groundMaterial(tex, { fixedLayer = -1, vertexColors = false, ...params } = {}) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, ...params });
  const groundScale = uniformArray(tex.ground.scales);
  const { uOrtho, uOrthoRect, uOrthoOn, uTime, uDark } = shared;
  const pWater = property('float', 'pWater'), pWaveN = property('vec3', 'pWaveN');

  m.colorNode = Fn(() => {
    const pos = positionWorld;
    const gN = normalize(normalWorldGeometry).toVar();
    const gT = normalize(cross(gN, vec3(0, 0, 1)).add(vec3(1e-4, 0, 0))).toVar();
    const gB = cross(gT, gN).toVar(); // +z on flat ground, matching the texture's v axis
    const tint = (vertexColors ? attribute('color', 'vec3') : materialColor.rgb).toVar();
    const rawLayer = fixedLayer >= 0 ? float(fixedLayer) : floor(attribute('aLayer', 'float').add(0.5)).toVar();
    const layer = min(rawLayer, 3).toVar(), li = int(layer);
    const sc = groundScale.element(li).toVar();
    const st = select(gN.y.abs().greaterThan(0.5), pos.xz, vec2(pos.x.add(pos.z), pos.y)).toVar();
    const a = texture(tex.ground.albedo, st.div(sc)).depth(li).rgb.mul(2).toVar();
    // a second, larger sample hides the repeat
    const b = texture(tex.ground.albedo, st.div(sc.mul(3.7)).add(0.37)).depth(li).rgb.mul(2);
    const blotch = vnoise(st.mul(0.045)).toVar();
    const detail = mix(a, b, 0.4).toVar();
    const colour = tint.mul(detail).mul(blotch.mul(0.28).add(0.86)).toVar();
    const nmTex = texture(tex.ground.normal, st.div(sc)).depth(li).xyz.mul(2).sub(1);
    const nm = normalize(vec3(nmTex.xy.mul(0.8), nmTex.z)).toVar();
    const rough = select(layer.lessThan(0.5), blotch.mul(-0.12).add(0.86), 0.93).toVar();
    pWater.assign(0); pWaveN.assign(vec3(0, 1, 0));

    if (fixedLayer >= 0) {
      // the open ground (not roads, which have their own surface) shows the aerial photo: car parks, yards, gardens
      const ouv = pos.xz.sub(uOrthoRect.xy).div(uOrthoRect.zw).toVar();
      const photoRgb = uOrtho.sample(vec2(ouv.x, ouv.y.oneMinus())).rgb;
      const inside = uOrthoOn.greaterThan(0.5).and(ouv.x.greaterThan(0)).and(ouv.x.lessThan(1)).and(ouv.y.greaterThan(0)).and(ouv.y.lessThan(1));
      colour.assign(select(inside, photoRgb.mul(detail.g.sub(0.5).mul(0.2).add(0.9)), colour));
      nm.assign(select(inside, vec3(0, 0, 1), nm));
    } else {
      If(rawLayer.greaterThan(3.5), () => {
        // Water: dark and a little green in itself (what is seen of it is mostly what it mirrors, see the output
        // below); its ripples flatten out with distance, where they are smaller than a pixel.
        colour.assign(tint.mul(0.5));
        const e = 0.12, amp = clamp(float(260).div(distance(cameraPosition, pos)), 0.25, 1).mul(0.045);
        const slope = vec2(ripple(pos.xz.add(vec2(e, 0)), uTime).sub(ripple(pos.xz.sub(vec2(e, 0)), uTime)), ripple(pos.xz.add(vec2(0, e)), uTime).sub(ripple(pos.xz.sub(vec2(0, e)), uTime))).mul(amp.div(2 * e)).toVar();
        const waveN = normalize(vec3(slope.x.negate(), 1, slope.y.negate())).toVar();
        pWaveN.assign(waveN);
        nm.assign(vec3(waveN.x, waveN.z, waveN.y));
        rough.assign(0.08);
        pWater.assign(1);
      });
    }
    pRough.assign(rough);
    pNormal.assign(normalize(gT.mul(nm.x).add(gB.mul(nm.y)).add(gN.mul(nm.z))));
    return colour;
  })();
  m.roughnessNode = pRough;
  m.normalNode = transformNormalToView(pNormal);
  lampLit(m);

  if (fixedLayer < 0) {
    // What water shows is what it mirrors, by Fresnel's share: hardly anything looking straight down (the dark
    // water itself), nearly everything at a glancing angle. Every ripple turns its sides to different parts of
    // the sky, which is what draws the ripples: light streaks and dark.
    const { uMirror, uMirrorMatrix, uMirrorOn } = shared;
    m.outputNode = Fn(() => {
      const lit = vec4(output).toVar();
      // (taken outside the branch: derivatives)
      const mc = uMirrorMatrix.mul(vec4(positionWorld, 1)).toVar();
      const near = clamp(float(70).div(distance(cameraPosition, positionWorld)), 0.12, 1.6).toVar();
      const muv = mc.xy.div(mc.w).mul(0.5).add(0.5).add(pWaveN.xz.mul(vec2(0.5, 0.9)).mul(near)).toVar();
      If(pWater.greaterThan(0.5), () => {
        const wv = normalize(positionWorld.sub(cameraPosition)).toVar(), wr = reflect(wv, pWaveN);
        const fresnel = pow(max(dot(wv.negate(), pWaveN), 0).oneMinus(), 4).mul(0.95).add(0.05);
        const seen = mix(vec3(0.8, 0.86, 0.92), vec3(0.3, 0.48, 0.74), pow(clamp(wr.y.abs(), 0, 1), 0.5)).mul(uDark.oneMinus().mul(0.97).add(0.03)).mul(0.9).toVar();
        const thing = float(0).toVar();
        If(uMirrorOn.greaterThan(0.5), () => {
          // the city in the mirror picture (mirror.js), shifted by the ripples and drawn out lengthwise
          const mirrored = vec4(0).toVar();
          for (let i = -1; i <= 1; i++) {
            const q = clamp(muv.add(vec2(0, near.mul(i * 0.004))), 0.001, 0.999);
            mirrored.addAssign(uMirror.sample(vec2(q.x, q.y.oneMinus())));
          }
          mirrored.divAssign(3);
          thing.assign(smoothstep(0, 0.3, mirrored.a.add(mirrored.r).add(mirrored.g).add(mirrored.b)));
          seen.assign(mix(seen, mirrored.rgb.mul(vec3(0.88, 0.93, 0.95)), thing));
        });
        // (the city is wanted in the water from above as well: more of it than Fresnel would give)
        lit.rgb.assign(mix(lit.rgb, seen, max(fresnel, thing.mul(0.42))));
      });
      // Without a mirror picture, alpha 0 leaves the water to the reflections found on the screen (reflections.js).
      return vec4(lit.rgb, pWater.mul(uMirrorOn.oneMinus()).oneMinus());
    })();
  }
  return m;
}

export function createMaterials(tex) {
  return {
    facade: facadeMaterial(tex),
    facadeFor: () => facadeMaterial(tex), // a tile's own instance, for its wall photos
    // Ground not covered by roads or buildings: private lots, car parks, yards.
    terrain: groundMaterial(tex, { fixedLayer: 3, color: new THREE.Color().setRGB(0.2, 0.2, 0.185) }),
    road: groundMaterial(tex, { vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
    // lane lines and crossings: drawn over the road surface, with a stronger depth bias so they never flicker
    paint: groundMaterial(tex, { vertexColors: true, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -8 }),
    // PLATEAU models (bridges, street furniture, trees): plain painted surfaces, seen from both sides
    models: new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide }),
  };
}
