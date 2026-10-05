// Materials. Buildings and ground are MeshStandardMaterials patched with procedural detail, so they keep
// three's lighting, shadows, fog and environment reflections.
//
// Building vertex attributes (see meshing.js):
//   color    surface colour (linear); the wall texture only adds detail on top
//   aFacade  x: window column coordinate (integer = bay edge), y: height above the base (m),
//            z: floor height (m), w: building seed in [0, 1)
//   aBldg    x: building height (m), y: category + 8 * texture layer, z: kind (KIND), w: bay width (m, 0 = no windows)
import * as THREE from 'three/webgpu';
import { uniform, texture } from 'three/tsl';

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
  // lamp light on the ground (src/world/lamplight.js): on at night, the light map, where it lies
  uLampOn: uniform(0), uLampMap: texture(blank()), uLampRect: uniform(new THREE.Vector4(0, 0, 1, 0)),
  // the sun in the window glass: direction to the sun (world), and its colour times how much of it there is
  uSunDir: uniform(new THREE.Vector3(0, 1, 0)), uSunGlint: uniform(new THREE.Color(0, 0, 0)), uGlintOn: uniform(1),
  // wall photos: the distances (m) between which a facade goes from generated to photo, and how much photo at most
  uPhotoRange: uniform(new THREE.Vector2(140, 420)), uPhotoMix: uniform(1),
};


const NOISE = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}
// Anti-aliased box [a, b] in x with filter width w.
float box(float x, float a, float b, float w) {
  return smoothstep(a - w, a + w, x) - smoothstep(b - w, b + w, x);
}
vec3 hue(float h) { return clamp(abs(fract(h + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0) - 1.0, 0.0, 1.0); }
`;

const WORLD_VARYINGS_VERT = 'varying vec3 vWPos;\nvarying vec3 vWNrm;';
const WORLD_VARYINGS_SET = 'vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNrm = normalize(mat3(modelMatrix) * normal);';
// Replaces the shading normal with the tangent-space normal gNm in the world frame (gT, gB, gN).
const APPLY_NORMAL = /* glsl */ `
normal = normalize((viewMatrix * vec4(normalize(gT * gNm.x + gB * gNm.y + gN * gNm.z), 0.0)).xyz);
`;

// ---------------------------------------------------------------- facade
const FACADE_PARS = /* glsl */ `
uniform float uNight;
uniform float uTime;
uniform vec2 uWindowLife;
uniform float uCityGlass;
uniform float uNightBlue;
uniform vec3 uSunDir;
uniform vec3 uSunGlint;
uniform float uGlintOn;
uniform sampler2DArray uWallAlb;
uniform sampler2DArray uWallNor;
uniform float uWallScale[6];
uniform float uWallDetail[6];
varying vec4 vFacade;
varying vec4 vBldg;
varying vec3 vWPos;
varying vec3 vWNrm;
float gRough, gMetal;
vec3 gGlint = vec3(0.0); // the sun mirrored in a pane (added to the specular light where the sun reaches it)
float gPane = 0.0; // how much of a mirror this fragment is: window glass (written to alpha for the reflection pass)
vec3 gEmissive, gT, gB, gN, gNm;
${NOISE}
`;

const FACADE_MAIN = /* glsl */ `
{
  gN = normalize(vWNrm);
  gT = abs(gN.y) > 0.95 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), gN));
  gB = cross(gN, gT);
  float seed = vFacade.w, height = vBldg.x, kind = vBldg.z, cellW = vBldg.w;
  float layer = floor(vBldg.y / 8.0 + 0.01), cat = vBldg.y - layer * 8.0;
  float u = vFacade.x, v = vFacade.y, floorH = vFacade.z;

  // surface texture: detail (mean 1) over the vertex colour, plus a normal map
  vec2 st = vec2(dot(vWPos, gT), dot(vWPos, gB));
  vec3 tuv = vec3(st / uWallScale[int(layer)], layer);
  vec3 wall = diffuseColor.rgb * mix(vec3(1.0), texture(uWallAlb, tuv).rgb * 2.0, uWallDetail[int(layer)]);
  wall *= 0.9 + 0.2 * vnoise(st * 0.11 + seed * 50.0);          // breaks up tiling over large walls
  gNm = texture(uWallNor, tuv).xyz * 2.0 - 1.0;
  gNm = normalize(vec3(gNm.xy * 0.7, gNm.z));
  gRough = 0.82; gMetal = 0.0; gEmissive = vec3(0.0);
  if (layer > 3.5 && layer < 4.5) { gRough = 0.5; gMetal = 0.35; }  // metal siding and roofs

  // weathering on walls: rain streaks, a dirty base, run-off under the roofline
  if (kind < 0.5 || (kind > 1.5 && kind < 2.5)) {
    float streak = vnoise(vec2(st.x * 2.2, st.y * 0.13 + seed * 40.0));
    float grime = smoothstep(0.55, 0.95, streak) * 0.1
      + (1.0 - smoothstep(0.0, 1.6, v)) * 0.1
      + smoothstep(height - 2.5, height, v) * streak * 0.14;
    wall *= 1.0 - grime;
  }
  diffuseColor.rgb = wall;

  // steelwork of a lattice tower (src/world/tower.js): painted steel in the vertex colour, floodlit at night
  if (kind > 3.5) {
    // (a colour brighter than 1 is a lamp: dark glass by day, lit at night; the steel keeps its own paint
    // under the floodlights)
    float lampOn = step(1.5, max(vColor.r, max(vColor.g, vColor.b)));
    diffuseColor.rgb = mix(vColor.rgb * (0.94 + 0.12 * vnoise(st * 0.7)), vec3(0.12), lampOn);
    gRough = 0.5; gMetal = 0.25; gNm = vec3(0.0, 0.0, 1.0);
    gEmissive = mix(vColor.rgb * 0.75, vColor.rgb * 1.6, lampOn) * uNight;
  }

  if (kind < 0.5 && cellW > 0.5) {
    float fyAll = v / floorH, row = floor(fyAll), col = floor(u);
    // Per-room random numbers. The seed is interpolated, so it carries rounding noise: hash only
    // integers derived from it (meshing.js stores seeds as multiples of 1/4096).
    float sid = floor(seed * 4096.0 + 0.5);
    vec2 room = vec2(col + mod(sid, 61.0) * 17.0, row + mod(sid, 53.0) * 13.0);
    float fx = fract(u), fy = fract(fyAll);
    float wx = max(fwidth(u), 1e-4), wy = max(fwidth(fyAll), 1e-4);
    float far = smoothstep(0.2, 0.6, max(wx, wy));                   // the grid aliases far away

    // window rectangle within one bay: [x0, x1] x [y0, y1]
    vec4 r = vec4(0.14, 0.86, 0.3, 0.82);                            // apartments, offices
    if (cat < 0.5) r = vec4(0.26, 0.74, 0.36, 0.78);                 // houses
    else if (cat > 3.5 && cat < 4.5) r = vec4(0.16, 0.84, 0.3, 0.8); // public
    else if (cat > 4.5) r = vec4(0.0, 1.0, 0.26, 1.0);               // curtain wall: glass above a spandrel
    bool shop = row < 0.5 && cat > 1.5 && cat < 3.5;
    if (shop) r = vec4(0.05, 0.95, 0.03, 0.8);                       // ground-floor shopfront
    float valid = step(0.0, v) * step(v, height - 0.9);
    // houses and apartments: some bays are plain wall
    if (cat < 2.5 && !shop) valid *= step(0.2, hash12(room + 41.0));
    float inWin = box(fx, r.x, r.y, wx) * box(fy, r.z, r.w, wy) * valid;

    // frame and mullions, measured in metres from the window edge
    vec2 wmin = vec2(r.x * cellW, r.z * floorH), wmax = vec2(r.y * cellW, r.w * floorH);
    vec2 pm = vec2(fx * cellW, fy * floorH);
    float edge = min(min(pm.x - wmin.x, wmax.x - pm.x), min(pm.y - wmin.y, wmax.y - pm.y));
    float fw = cat > 4.5 ? 0.045 : 0.065, ew = max(fwidth(edge), 1e-4);
    float frame = 1.0 - smoothstep(fw - ew, fw + ew, edge);
    float panes = max(1.0, floor((wmax.x - wmin.x) / 1.25 + 0.5));
    float mx = fract((pm.x - wmin.x) / (wmax.x - wmin.x) * panes);
    float mw = 0.03 * panes / (wmax.x - wmin.x);
    frame = max(frame, panes > 1.5 ? 1.0 - box(mx, mw, 1.0 - mw, max(fwidth(mx), 1e-4)) : 0.0);
    frame *= 1.0 - far;
    float pane = inWin * (1.0 - frame);

    // interior mapping: intersect the view ray with a room box behind the glass
    vec3 V = normalize(vWPos - cameraPosition);
    vec3 rd = vec3(dot(V, gT) / cellW, dot(V, gB) / floorH, dot(V, gN) / 4.5) + vec3(1e-5, 1e-5, 0.0);
    vec3 ro = vec3(fx, fy, 0.0);
    vec2 tA = (step(0.0, rd.xy) - ro.xy) / rd.xy;
    float tz = -1.0 / min(rd.z, -1e-4);
    float tHit = min(min(tA.x, tA.y), tz);
    vec3 hp = ro + rd * tHit;
    float rh = hash12(room);
    vec3 interior = mix(vec3(0.74, 0.69, 0.6), vec3(0.6, 0.63, 0.68), rh);
    float shade = 0.62;                                              // side walls
    if (tHit == tz) shade = 0.5 + 0.28 * step(0.42, hp.y);          // back wall above a furniture band
    else if (tHit == tA.y) shade = rd.y > 0.0 ? 1.0 : 0.38;         // ceiling, floor
    interior *= shade * mix(1.0, 0.5, clamp(-hp.z, 0.0, 1.0));
    // blinds or curtains pulled part-way down some windows
    float blind = step(0.5, hash12(room + 7.7)) * hash12(room + 3.1);
    float wyLocal = (fy - r.z) / (r.w - r.z);
    if (!shop && wyLocal > 1.0 - blind * 0.85) interior = mix(vec3(0.8, 0.78, 0.72), vec3(0.68, 0.7, 0.74), rh) * 0.75;
    interior = mix(interior, vec3(0.42, 0.42, 0.4), far);            // far away: the average room

    // lit rooms at night: shops and offices more often than homes
    float onRate = shop ? 0.75 : cat > 2.5 ? 0.32 : 0.22;
    // No two buildings alike: one is asleep and the next is busy; many offices are lit by the floor (a whole
    // storey working late, the one above dark).
    float b1 = fract(seed * 11.7), b2 = fract(seed * 17.3), b3 = fract(seed * 23.9);
    onRate *= mix(0.35, 1.9, b1);
    if (!shop && cat > 2.5 && b2 > 0.4) onRate = mix(0.05, 0.9, step(0.5, hash12(vec2(row * 3.0 + mod(sid, 37.0), mod(sid, 53.0)))));
    // A tower at night is mostly dark glass: a few storeys lit as bands, the rest a mirror for the city.
    float tall = smoothstep(70.0, 110.0, height);
    if (!shop) onRate = mix(onRate, 0.02 + 0.8 * step(0.9, hash12(vec2(row * 5.0 + mod(sid, 41.0), mod(sid, 59.0)))), tall);
    onRate = clamp(onRate, 0.0, 0.95);
    // Some rooms stay as they are all night. The others (uWindowLife.x of them) are lived in: every so often,
    // each room on its own clock (90 to 330 s, divided by the pace uWindowLife.y), someone may come in or
    // leave, and the light goes on or off over a second.
    float fickle = step(1.0 - uWindowLife.x, hash12(room + 31.0));
    float period = (90.0 + 240.0 * hash12(room + 37.0)) / max(uWindowLife.y, 0.01);
    float clock = uTime / period + hash12(room + 41.0), slot = floor(clock);
    float lit = mix(step(1.0 - onRate, hash12(room + 43.0 + (slot - 1.0) * 7.0)), step(1.0 - onRate, hash12(room + 43.0 + slot * 7.0)), smoothstep(0.0, 1.2 / period, fract(clock)));
    float on = mix(step(1.0 - onRate, hash12(room + 23.0)), lit, fickle);
    // The colour of the light: homes mostly warm bulbs, some cool, the odd blue of a television; an office
    // building one kind of tube throughout, cool white more often than warm. Brightness varies room by room
    // and building by building.
    float tint = hash12(room + 61.0), office = step(2.5, cat);
    vec3 warm = mix(vec3(1.0, 0.6, 0.3), vec3(1.0, 0.82, 0.6), hash12(room + 67.0));
    // (uNightBlue leans the city towards blue: bluer cool lamps, more of them, more rooms in screen light)
    vec3 cool = mix(vec3(1.0, 0.95, 0.86), mix(vec3(0.78, 0.9, 1.0), vec3(0.42, 0.66, 1.0), uNightBlue), hash12(room + 71.0));
    float coolShare = mix(0.25, mix(0.12, 0.95, step(0.35, b2)), office) + 0.45 * uNightBlue;
    vec3 lamp = mix(warm, cool, step(1.0 - coolShare, mix(tint, 0.5 * b3 + 0.5 * tint, office)));
    lamp = mix(lamp, vec3(0.3, 0.55, 1.0), step(0.93 - 0.22 * uNightBlue, tint) * mix(1.0 - office, 1.0, uNightBlue));
    float glow = mix(0.3, 1.35, hash12(room + 1.3)) * mix(0.65, 1.25, b3);

    // glass: mostly a mirror of the sky; the room behind shows through as emitted light
    vec3 glassTint = cat > 4.5 ? mix(vec3(0.2, 0.3, 0.38), vec3(0.3, 0.33, 0.34), fract(seed * 5.7)) : vec3(0.1, 0.11, 0.12);
    vec3 frameCol = fract(seed * 3.3) < 0.5 ? vec3(0.16, 0.17, 0.18) : vec3(0.62, 0.63, 0.63);
    diffuseColor.rgb = mix(diffuseColor.rgb, frameCol, inWin * frame);
    diffuseColor.rgb = mix(diffuseColor.rgb, glassTint, pane);
    gRough = mix(gRough, 0.45, inWin * frame);
    gRough = mix(gRough, 0.05, pane);
    gMetal = mix(gMetal, 0.92, pane);
    gNm = mix(gNm, normalize(vec3((hash12(room + 5.1) - 0.5) * 0.03, (hash12(room + 9.4) - 0.5) * 0.03, 1.0)), inWin);
    float daylight = (1.0 - uNight) * (shop ? 0.3 : cat > 4.5 ? 0.06 : 0.12);
    gEmissive = pane * interior * (daylight + uNight * on * glow * 1.25 * lamp);
    // The sun in the glass. Each pane sits a little out of true and float glass is never quite flat, so the
    // mirrored sun is a hot core with a glare around it that wanders from pane to pane as the view moves. The
    // third, wide term is not physics: the true mirror image is only seen from below the sun's own height, and
    // this lets glass facing the sun catch some of its light from the air too.
    {
      vec3 wobble = vec3(vnoise(st * 0.8 + seed * 9.0) - 0.5, vnoise(st * 0.8 + 31.0 + seed * 9.0) - 0.5, 0.0) * 0.035;
      vec3 paneN = normalize(gT * (gNm.x + wobble.x) + gB * (gNm.y + wobble.y) + gN * gNm.z);
      float s = max(dot(reflect(normalize(vWPos - cameraPosition), paneN), uSunDir), 0.0);
      gGlint = pane * uGlintOn * uSunGlint * (pow(s, 1400.0) * 14.0 + pow(s, 90.0) * 0.35 + pow(s, 7.0) * 0.1) * step(0.0, dot(gN, uSunDir));
    }
    // Some towers (more of them as uNightBlue rises) are lit in one colour throughout: their lit rooms shine
    // blue or golden yellow — a few cyan or violet — instead of white. (Window light only: thin lines of light
    // along edges and floors shimmer at a distance.)
    {
      float pickA = fract(seed * 31.7), hue = fract(seed * 47.3);
      float accent = tall * step(0.7 - 0.45 * uNightBlue, pickA) * uNight;
      vec3 accentCol = hue < 0.42 ? vec3(0.12, 0.38, 1.0) : hue < 0.76 ? vec3(1.0, 0.72, 0.16) : hue < 0.89 ? vec3(0.1, 0.85, 1.0) : vec3(0.75, 0.3, 1.0);
      gEmissive = mix(gEmissive, accentCol * dot(gEmissive, vec3(0.9)), accent * 0.8);
    }
    // The city in the glass of a tower at night. The mirrored view ray is followed down to street level, where
    // the lights of the city lie as a field of points fixed to the ground (a lamp or a window every 26 m or
    // so, warm or cool), so the reflection slides over the glass as the view moves, as a real one does.
    if (tall > 0.0 && uNight > 0.01 && uCityGlass > 0.0) {
      vec3 paneN = normalize(gT * gNm.x + gB * gNm.y + gN * gNm.z), R = reflect(V, paneN);
      float fresnel = 0.1 + 0.9 * pow(1.0 - max(dot(-V, paneN), 0.0), 4.0);
      vec3 city = vec3(0.0);
      if (R.y < -0.015) {
        float reach = (vWPos.y - 12.0) / -R.y;                      // metres along the ray to street level
        vec2 g = (vWPos.xz + R.xz * reach) / 26.0, cell = floor(g);
        vec2 at = vec2(hash12(cell + 3.1), hash12(cell + 7.7));
        float d = length(fract(g) - at) * 26.0, kind = hash12(cell + 13.0);
        float spot = exp(-d * d / (3.0 + reach * 0.03)) * step(0.3, kind);
        vec3 tintC = kind > 0.8 - 0.3 * uNightBlue ? mix(vec3(0.8, 0.9, 1.0), vec3(0.4, 0.65, 1.0), uNightBlue) : kind > 0.42 && kind < 0.5 ? vec3(1.0, 0.25, 0.2) : vec3(1.0, 0.72, 0.42);
        city = tintC * spot * 5.0 / (1.0 + reach * reach / 4.0e5);
        city += vec3(1.0, 0.75, 0.5) * 0.035 * smoothstep(0.0, 900.0, reach);  // and their haze towards the horizon
      }
      gEmissive += city * fresnel * pane * tall * uNight * uCityGlass * (1.0 - on * 0.9);
    }
    gPane = pane * (1.0 - 0.7 * far) * (1.0 - 0.85 * uNight * on); // (a lit room shows itself, not a reflection)
    // the lintel shades the top of the opening
    diffuseColor.rgb *= 1.0 - 0.35 * inWin * (1.0 - smoothstep(0.0, 0.18, wmax.y - pm.y)) * (1.0 - far);

    // sign band over shopfronts
    if (shop) {
      float sign = box(fy, 0.84, 0.985, wy) * box(fx, 0.03, 0.97, wx) * valid * step(0.25, hash12(room + 57.0));
      vec3 sc = mix(hue(hash12(room + 71.0)), vec3(0.95), 0.35 * step(0.6, hash12(room + 83.0)));
      diffuseColor.rgb = mix(diffuseColor.rgb, sc * 0.75, sign);
      gEmissive += sign * sc * uNight * 1.6;
      gRough = mix(gRough, 0.4, sign);
    }
  }
}
`;

const NO_PHOTO = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
NO_PHOTO.needsUpdate = true;

// One instance per tile that has a wall photo atlas (they share the program); set it with material.userData.photo.
// The real wall, from PLATEAU's aerial photo: too smeared to stand in front of, right from across the city.
const PHOTO_PARS = /* glsl */ `
uniform sampler2D uPhoto;
uniform float uPhotoOn;
uniform vec2 uPhotoRange;
uniform float uPhotoMix;
varying vec2 vPhoto;
`;
const PHOTO_MAIN = /* glsl */ `
{
  vec3 photo = texture2D(uPhoto, vPhoto).rgb; // (sampled outside the branch: derivatives)
  float k = uPhotoOn * uPhotoMix * step(0.0, vPhoto.x) * smoothstep(uPhotoRange.x, uPhotoRange.y, distance(cameraPosition, vWPos));
  diffuseColor.rgb = mix(diffuseColor.rgb, photo * 1.12, k);
  gRough = mix(gRough, 0.85, k);
  gMetal *= 1.0 - k;
}
`;

function facadeMaterial(tex) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.0 });
  m.userData.photo = { value: NO_PHOTO }; m.userData.photoOn = { value: 0 };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uLampOn: { value: 0 }, uLampMap: shared.uLampMap, // (no lamp light on buildings; the sampler still needs its texture)
      uPhoto: m.userData.photo, uPhotoOn: m.userData.photoOn, uPhotoRange: shared.uPhotoRange, uPhotoMix: shared.uPhotoMix,
      uNight: shared.uNight, uTime: shared.uTime, uWindowLife: shared.uWindowLife, uCityGlass: shared.uCityGlass, uNightBlue: shared.uNightBlue, uSunDir: shared.uSunDir, uSunGlint: shared.uSunGlint, uGlintOn: shared.uGlintOn, uWallAlb: { value: tex.wall.albedo }, uWallNor: { value: tex.wall.normal },
      uWallScale: { value: tex.wall.scales }, uWallDetail: { value: tex.wall.details },
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec4 aFacade;\nattribute vec4 aBldg;\nattribute vec2 aPhoto;\nvarying vec4 vFacade;\nvarying vec4 vBldg;\nvarying vec2 vPhoto;\n${WORLD_VARYINGS_VERT}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvFacade = aFacade;\nvBldg = aBldg;\nvPhoto = aPhoto;\n${WORLD_VARYINGS_SET}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FACADE_PARS + PHOTO_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FACADE_MAIN + PHOTO_MAIN)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = gRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = gMetal;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + APPLY_NORMAL)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gEmissive;')
      // (the direct diffuse light is zero in shadow: it tells whether the sun reaches this pane)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.directSpecular += gGlint * smoothstep(0.0, 0.002, dot(reflectedLight.directDiffuse, vec3(0.333)));')
      .replace('#include <opaque_fragment>', '#include <opaque_fragment>\ngl_FragColor.a = 1.0 - 0.95 * gPane;');
  };
  m.customProgramCacheKey = () => 'facade-v21';
  return m;
}

// ---------------------------------------------------------------- ground
// Terrain and road surfaces: vertex colour x texture detail, layer from the aLayer attribute
// (roads) or fixed (terrain).
const GROUND_PARS = /* glsl */ `
uniform sampler2DArray uGroundAlb;
uniform sampler2DArray uGroundNor;
uniform float uGroundScale[4];
uniform float uFixedLayer;
uniform sampler2D uOrtho;
uniform vec4 uOrthoRect;
uniform float uOrthoOn;
uniform float uTime;
uniform sampler2D uMirror;
uniform mat4 uMirrorMatrix;
uniform float uMirrorOn;
uniform float uDark;
uniform sampler2D uCloudMap;
uniform vec2 uCloudOffset;
uniform float uCloudCover, uCloudBase, uCloudsOn, uCloudFade;
uniform mat4 uWorldToECEF;
uniform vec4 uCloudRect;
varying float vLayer;
varying vec3 vWPos;
varying vec3 vWNrm;
vec3 gT, gB, gN, gNm;
float gRough;
float gMetal = 0.0;
float gWater = 0.0; // 1 on water: written to alpha for the reflection pass, which mirrors the world in it
vec3 gWaveN = vec3(0.0, 1.0, 0.0); // the water's surface normal with its ripples (world space)
${NOISE}
// Where a point of the globe lies in the clouds' weather map (as the cloud pass maps it: three-clouds, clouds.glsl).
vec2 cloudMapUv(vec3 position) {
  vec3 n = normalize(position), f = abs(n), c = n / max(f.x, max(f.y, f.z));
  vec2 m;
  if (all(greaterThan(f.yy, f.xz))) m = c.y > 0.0 ? vec2(-n.x, n.z) : n.xz;
  else if (all(greaterThan(f.xx, f.yz))) m = c.x > 0.0 ? n.yz : vec2(-n.y, n.z);
  else m = c.z > 0.0 ? n.xy : vec2(n.x, -n.y);
  vec2 m2 = m * m;
  float q = dot(m2.xy, vec2(-2.0, 2.0)) - 3.0;
  vec2 uv;
  uv.x = sqrt(1.5 + m2.x - m2.y - 0.5 * sqrt(-24.0 * m2.x + q * q)) * (m.x > 0.0 ? 1.0 : -1.0);
  uv.y = sqrt(6.0 / (3.0 - uv.x * uv.x)) * m.y;
  return uv * 0.5 + 0.5;
}
// How much cloud a ray from p towards dir (upwards) meets: 0 clear sky .. 1 cloud. The same weather map and
// cover as the cloud pass, without its fine shapes: the clouds are where they are in the sky, a little softer.
float cloudAbove(vec3 p, vec3 dir) {
  if (uCloudsOn < 0.5 || dir.y < 0.03) return 0.0;
  vec3 at = p + dir * ((uCloudBase + 320.0 - p.y) / dir.y);
  vec2 weather = texture2D(uCloudMap, cloudMapUv((uWorldToECEF * vec4(at, 1.0)).xyz) * 100.0 + uCloudOffset).rg;
  vec2 beyond = max(uCloudRect.xy - at.xz, at.xz - uCloudRect.zw);
  weather *= 1.0 - smoothstep(0.0, uCloudFade, max(beyond.x, beyond.y));
  // (the cloud pass wears the weather map down with its shape noise: only the thicker parts are cloud)
  float edge = 1.0 - 1.25 * uCloudCover;
  return smoothstep(edge, edge + 0.22, max(weather.r, weather.g)) * smoothstep(0.03, 0.14, dir.y);
}
// Calm harbour water: the height of its ripples (in units of about 3.5 cm) at a point of the ground plan. Long
// low waves from several quarters crossing each other, bent out of line so they never look ruled.
float ripple(vec2 p, float t) {
  p += 3.2 * vec2(vnoise(p * 0.11 + t * 0.03), vnoise(p * 0.11 + 9.0 - t * 0.03)) + 0.9 * vec2(vnoise(p * 0.45 - t * 0.05), vnoise(p * 0.45 + 23.0 + t * 0.05));
  float h = 0.3 * sin(dot(p, vec2(0.92, 0.39)) * 1.1 + t * 1.1);
  h += 0.28 * sin(dot(p, vec2(-0.45, 0.89)) * 1.6 - t * 1.4 + 1.3);
  h += 0.22 * sin(dot(p, vec2(0.2, -0.98)) * 2.7 + t * 1.9 + 4.0);
  h += 0.14 * sin(dot(p, vec2(-0.8, -0.6)) * 4.3 - t * 2.6);
  h += 0.9 * (vnoise(p * 0.8 + vec2(t * 0.25, -t * 0.18)) - 0.5) + 0.45 * (vnoise(p * 1.9 - vec2(t * 0.4, t * 0.3)) - 0.5);
  return h;
}
`;
const GROUND_MAIN = /* glsl */ `
{
  gN = normalize(vWNrm);
  gT = normalize(cross(gN, vec3(0.0, 0.0, 1.0)) + vec3(1e-4, 0.0, 0.0));
  gB = cross(gT, gN); // +z on flat ground, matching the texture's v axis
  vec3 tint = diffuseColor.rgb;
  float layer = uFixedLayer >= 0.0 ? uFixedLayer : floor(vLayer + 0.5);
  bool water = layer > 3.5;
  layer = min(layer, 3.0);
  float sc = uGroundScale[int(layer)];
  vec2 st = abs(gN.y) > 0.5 ? vWPos.xz : vec2(vWPos.x + vWPos.z, vWPos.y);
  vec3 a = texture(uGroundAlb, vec3(st / sc, layer)).rgb * 2.0;
  // a second, larger sample hides the repeat
  vec3 b = texture(uGroundAlb, vec3(st / (sc * 3.7) + 0.37, layer)).rgb * 2.0;
  float blotch = vnoise(st * 0.045);
  diffuseColor.rgb *= mix(a, b, 0.4) * (0.86 + 0.28 * blotch);
  gNm = texture(uGroundNor, vec3(st / sc, layer)).xyz * 2.0 - 1.0;
  gNm = normalize(vec3(gNm.xy * 0.8, gNm.z));
  gRough = layer < 0.5 ? 0.86 - 0.12 * blotch : 0.93;
  // the open ground (not roads, which have their own surface) shows the aerial photo: car parks, yards, gardens
  if (uFixedLayer >= 0.0 && uOrthoOn > 0.5) {
    vec2 ouv = (vWPos.xz - uOrthoRect.xy) / uOrthoRect.zw;
    if (ouv.x > 0.0 && ouv.x < 1.0 && ouv.y > 0.0 && ouv.y < 1.0) {
      vec3 photo = texture2D(uOrtho, vec2(ouv.x, 1.0 - ouv.y)).rgb;
      diffuseColor.rgb = photo * (0.9 + 0.2 * (mix(a, b, 0.4).g - 0.5));
      gNm = vec3(0.0, 0.0, 1.0);
    }
  }
  if (water) {
    // Water: dark and a little green in itself (what is seen of it is mostly what it mirrors, see the end of the
    // shader); its ripples flatten out with distance, where they are smaller than a pixel.
    diffuseColor.rgb = tint * 0.5;
    float t = uTime, e = 0.12, amp = 0.045 * clamp(260.0 / distance(cameraPosition, vWPos), 0.25, 1.0);
    vec2 slope = vec2(ripple(vWPos.xz + vec2(e, 0.0), t) - ripple(vWPos.xz - vec2(e, 0.0), t), ripple(vWPos.xz + vec2(0.0, e), t) - ripple(vWPos.xz - vec2(0.0, e), t)) * (amp / (2.0 * e));
    gWaveN = normalize(vec3(-slope.x, 1.0, -slope.y));
    gNm = vec3(gWaveN.x, gWaveN.z, gWaveN.y);
    gRough = 0.08;
    gMetal = 0.0;
    gWater = 1.0;
  }
}
`;

function groundMaterial(tex, { fixedLayer = -1, ...params } = {}) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.92, ...params });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uGroundAlb: { value: tex.ground.albedo }, uGroundNor: { value: tex.ground.normal },
      uGroundScale: { value: tex.ground.scales }, uFixedLayer: { value: fixedLayer },
      uOrtho: shared.uOrtho, uOrthoRect: shared.uOrthoRect, uOrthoOn: shared.uOrthoOn, uTime: shared.uTime,
      uMirror: shared.uMirror, uMirrorMatrix: shared.uMirrorMatrix, uMirrorOn: shared.uMirrorOn, uDark: shared.uDark,
      uCloudMap: shared.uCloudMap, uCloudOffset: shared.uCloudOffset, uCloudCover: shared.uCloudCover, uCloudBase: shared.uCloudBase, uCloudsOn: shared.uCloudsOn,
      uWorldToECEF: shared.uWorldToECEF, uCloudRect: shared.uCloudRect, uCloudFade: shared.uCloudFade,
      uLampOn: shared.uLampOn, uLampMap: shared.uLampMap, uLampRect: shared.uLampRect,
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float aLayer;\nvarying float vLayer;\n${WORLD_VARYINGS_VERT}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvLayer = aLayer;\n${WORLD_VARYINGS_SET}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GROUND_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + GROUND_MAIN)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = gRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = gMetal;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + APPLY_NORMAL)
      // Water mirrors the city: the mirror picture (mirror.js) where there is one, laid on by Fresnel's share and
      // a good deal more (a clear mirror is wanted), its ripples shifting it a little. Without one, alpha 0 leaves
      // the water to the reflections found on the screen (reflections.js).
      .replace('#include <opaque_fragment>', `
        if (gWater > 0.5) {
          // What water shows is what it mirrors, by Fresnel's share: hardly anything looking straight down
          // (the dark water itself), nearly everything at a glancing angle. Every ripple turns its sides to
          // different parts of the sky, which is what draws the ripples: light streaks and dark.
          vec3 wv = normalize(vWPos - cameraPosition), wr = reflect(wv, gWaveN);
          float fresnel = 0.05 + 0.95 * pow(1.0 - max(dot(-wv, gWaveN), 0.0), 4.0);
          vec3 seen = mix(vec3(0.8, 0.86, 0.92), vec3(0.3, 0.48, 0.74), pow(clamp(abs(wr.y), 0.0, 1.0), 0.5)) * (0.03 + 0.97 * (1.0 - uDark)) * 0.9;
          // the clouds in it: white where the sun is on them, grey towards the night
          float cloud = cloudAbove(vWPos, vec3(wr.x, abs(wr.y), wr.z));
          seen = mix(seen, vec3(0.96, 0.97, 0.98) * (0.05 + 0.95 * (1.0 - uDark)), 0.9 * cloud);
          float thing = 0.0;
          if (uMirrorOn > 0.5) {
            // the city in the mirror picture (mirror.js), shifted by the ripples and drawn out lengthwise
            vec4 mc = uMirrorMatrix * vec4(vWPos, 1.0);
            float near = clamp(70.0 / distance(cameraPosition, vWPos), 0.12, 1.6);
            vec2 muv = mc.xy / mc.w * 0.5 + 0.5 + gWaveN.xz * vec2(0.5, 0.9) * near;
            vec4 mirrored = vec4(0.0);
            for (int i = -1; i <= 1; i++) mirrored += texture2D(uMirror, clamp(muv + vec2(0.0, float(i) * 0.004 * near), 0.001, 0.999));
            mirrored /= 3.0;
            thing = smoothstep(0.0, 0.3, mirrored.a + dot(mirrored.rgb, vec3(1.0)));
            seen = mix(seen, mirrored.rgb * vec3(0.88, 0.93, 0.95), thing);
          }
          // (the city is wanted in the water from above as well: more of it than Fresnel would give)
          outgoingLight = mix(outgoingLight, seen, max(fresnel, max(0.42 * thing, 0.3 * cloud * (1.0 - thing))));
        }
        #include <opaque_fragment>
        gl_FragColor.a = 1.0 - gWater * (1.0 - uMirrorOn);`);
  };
  m.customProgramCacheKey = () => 'ground-v13';
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
    models: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.05, side: THREE.DoubleSide }),
  };
}
