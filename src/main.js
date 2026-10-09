// Procedural Tokyo client: streams the compiled city and renders it, under a free camera.
//
// URL parameters: ?area=tokyo  ?time=18.5 (Tokyo hour; default: now)  ?night=1  ?cam=x,z,distance,azimuthDeg,elevationDeg  ?radius=3000  ?traffic=0  ?ortho=0  ?clouds=0.25 (on, with that cover)  ?birds=150  ?cars=600
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import GUI from 'lil-gui';
import { makeProjection } from './shared/geo.js';
import { createMaterials, shared, variant, setVariant, ABSTRACT } from './world/materials.js';
import { loadTextures } from './world/textures.js';
import { Streamer } from './world/streamer.js';
import { Props } from './world/props.js';
import { Signs } from './world/signs.js';
import { buildRailways } from './world/rails.js';
import { buildFlyovers } from './world/flyovers.js';
import { Traffic, MAX_CARS } from './world/traffic.js';
import { buildStructures } from './world/structures.js';
import { loadOrtho } from './world/ortho.js';
import { Environment, installSkyLight } from './world/environment.js';
import { Atmosphere } from './world/atmosphere.js';
import { createBirds, MAX_BIRDS } from './world/birds.js';
import { loadBackdrop } from './world/backdrop.js';
import { WaterMirror } from './world/mirror.js';
import { ContactShadows, asGround } from './world/contact.js';
import { LampLight, installLampLight } from './world/lamplight.js';

installLampLight(); // (before any material is compiled)
installSkyLight();

const params = new URLSearchParams(location.search);
const AREA = params.get('area') || 'tokyo'; // (the first of the city switch)

// The loading screen (index.html): the city's name, a bar and what is being done.
const loader = {
  el: document.getElementById('loader'),
  show(city, step = '') { this.el.classList.remove('done'); if (city) this.el.querySelector('.city').textContent = city; this.set(0, step); },
  set(fraction, step) { this.el.querySelector('.fill').style.width = `${Math.round(fraction * 100)}%`; if (step != null) this.el.querySelector('.step').textContent = step; },
  hide() { this.el.classList.add('done'); },
};
loader.show(null, 'textures'); // (index.html has already written the city's name)
const USAGE = {
  401: 'office', 402: 'commercial', 403: 'hotel', 404: 'commercial complex', 411: 'house', 412: 'apartments',
  413: 'house + shop', 414: 'apartments + shop', 415: 'house + workshop', 421: 'government', 422: 'school / hospital / culture',
  431: 'transport / warehouse', 441: 'factory', 452: 'utility', 454: 'other', 461: 'unknown',
};

// ---------------------------------------------------------------- renderer, scene, camera
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.info.autoReset = false; // the composer renders several passes; count the whole frame
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// The scene is drawn several times per frame (shadows, the water mirror, the lamp light, the picture): where its
// things stand is worked out once, in tick(), and not again at every render.
scene.matrixWorldAutoUpdate = false;
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 1, 60000);
const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.3; // (the view keeps close to the hand; how it glides on after a drag is worked out below: glide)
controls.maxPolarAngle = THREE.MathUtils.degToRad(88);
controls.minDistance = 8;
controls.maxDistance = 3500;
controls.enableZoom = false; // the wheel is handled below, with inertia

const env = new Environment(scene, renderer);
// Time of day, as Tokyo's clock (JST = UTC + 9 h): the real time, or an hour set by hand.
const clockTime = {
  live: params.get('time') == null && params.get('night') !== '1',
  hour: params.get('time') != null ? Number(params.get('time')) : params.get('night') === '1' ? 22 : 12,
  // the day played through: `speed` minutes of Tokyo's clock go by in every second (1: a day in 24 minutes,
  // 100: in about a quarter of a minute)
  play: params.get('play') != null, speed: Number(params.get('play')) || 10,
  advance(dt) { if (this.play) { this.live = false; this.hour = (this.hour + dt * this.speed / 60) % 24; } },
  // the moment on today's Tokyo date at which its clock shows `hour`
  date() {
    const JST = 9 * 3600e3, now = Date.now();
    if (this.live) { const t = new Date(now + JST); this.hour = t.getUTCHours() + t.getUTCMinutes() / 60 + t.getUTCSeconds() / 3600; return new Date(now); }
    const midnight = Math.floor((now + JST) / 864e5) * 864e5 - JST;
    return new Date(midnight + this.hour * 3600e3);
  },
  // the hour and the minute on their own, for the panel; setting either stops the live clock
  get h() { return Math.floor(this.hour) % 24; },
  set h(v) { this.live = false; this.hour = v + this.m / 60; },
  get m() { return Math.floor((this.hour % 1) * 60 + 1e-6); },
  set m(v) { this.live = false; this.hour = this.h + v / 60; },
  label() { const h = this.h, m = this.m; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; },
};

const materials = createMaterials(await loadTextures(renderer));
const props = new Props();
props.root = scene;
const signs = new Signs();
const streamer = new Streamer(scene, materials, props, signs, { base: `tiles/${AREA}`, radius: Number(params.get('radius')) || 900 }); // (what lies round the view by default: the control panel can ask for the whole city)
loader.set(0.08, 'terrain');
const manifest = await streamer.init();
loader.set(0.14, 'railways and roads');
const proj = makeProjection(manifest.origin.lon, manifest.origin.lat);
// Beyond the area: plain ground in the grey of the area's own unbuilt land, out to the haze of the horizon.
{
  const b = manifest.bounds, plain = new THREE.Mesh(new THREE.CircleGeometry(50000, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x8a8a86, roughness: 0.95, metalness: 0 }));
  plain.position.set((b.minX + b.maxX) / 2, manifest.terrain.min - 1, (b.minZ + b.maxZ) / 2); // just under the lowest ground
  plain.receiveShadow = true;
  plain.name = 'plain';
  scene.add(asGround(plain));
  // an area with the land around it (mountains on the horizon): the plain becomes the sea, at sea level
  if (manifest.backdrop) {
    plain.position.y = -0.5; plain.material.color.set(0x2c4a5e); plain.material.roughness = 0.35;
    loadBackdrop(`tiles/${AREA}`, `ortho/${AREA}/backdrop`, manifest, proj, renderer).then((mesh) => scene.add(asGround(mesh)));
  }
}
const birds = createBirds();
if (params.get('birds') != null) birds.geometry.instanceCount = Math.min(MAX_BIRDS, Number(params.get('birds')) || 0);
scene.add(birds);
const lampLight = new LampLight(renderer);
const waterMirror = new WaterMirror(renderer);
// post-processing: ambient occlusion, sky, aerial perspective, volumetric clouds, bloom, tone mapping
const atmosphere = new Atmosphere(renderer, scene, camera, manifest.origin, manifest.bounds);
const ao = atmosphere.ao;
if (params.get('reflect') === '0') atmosphere.reflect = false;
// the abstract model (see materials.js): the city as a plain model of itself, with the light as it is
// (the clouds throw the same shadow on it as on the city: see the slider in the Clouds folder)
// How dark the clouds' shadow lies on the city (0: none). The pale model shows a shadow less than the city
// does (bright surfaces stay bright), so on it the shadow is made deeper.
let cloudShadow = 0.58, shadeTimer = 0;
const applyShade = () => { atmosphere.shade = Math.round((1 - cloudShadow) * (variant.abstract ? 0.6 : 1) * 100) / 100; };
const setAbstract = (on) => { setVariant({ abstract: on }); streamer.setAbstract(on); applyShade(); };
env.lightFromSky(atmosphere.textures, atmosphere.worldToECEF, atmosphere.environmentSky(), () => atmosphere.ready);
shared.uSeason.value = Math.max(0, ['summer', 'autumn', 'spring'].indexOf(params.get('season')));
atmosphere.antialias = params.get('aa') ?? 'smaa';
const contact = new ContactShadows(renderer);
if (Number(params.get('contact')) > 0) { shared.uContact.value = Number(params.get('contact')); setVariant({ contact: true }); }
if (Number(params.get('fog')) > 0) atmosphere.fog = Number(params.get('fog')); // (no haze but the atmosphere's own, unless asked for)
shared.uGlintOn.value = params.get('glint') != null ? Number(params.get('glint')) : 2; // (1: as it was designed; brighter by default)
env.brightness = Number(params.get('brightness')) || 1;
if (params.get('abstract') === '1') setAbstract(true);
if (params.get('landmarks') !== '0') setVariant({ landmarks: true }); // (the abstract model keeps its landmarks in detail, unless ?landmarks=0)
if (params.get('windows') === '0') setVariant({ windows: false });
if (params.get('relief') !== '0') setVariant({ relief: true }); // (on, unless asked not to)
// clouds, unless ?clouds=0 (a number: on, with that cover)
if (Number(params.get('clouds')) > 0) atmosphere.coverage = Number(params.get('clouds'));
atmosphere.cloudsOn = params.get('clouds') !== '0';
let orthoLoaded = false, orthoWanted = true; // (the photo fills in when the tiles arrive; the panel may have switched it off by then)
if (params.get('ortho') !== '0') loadOrtho(`ortho/${AREA}`, proj, manifest.bounds, renderer).then((ok) => { orthoLoaded = ok; shared.uOrthoOn.value = ok && orthoWanted ? 1 : 0; });
const railways = await buildRailways(`tiles/${AREA}/${manifest.rails}`, (x, z) => streamer.ground(x, z), streamer.cover);
scene.add(railways);
scene.add(await buildFlyovers(`tiles/${AREA}/${manifest.roads}`, (x, z) => streamer.ground(x, z)));
if (manifest.structures) scene.add(await buildStructures(`tiles/${AREA}/${manifest.structures}`, (x, z) => streamer.ground(x, z)));
const traffic = new Traffic(await (await fetch(`tiles/${AREA}/${manifest.roads}`)).json(), streamer.surface);
if (params.get('cars') != null) traffic.count = Math.min(MAX_CARS, Number(params.get('cars')) || 0);
if (params.get('traffic') !== '0') scene.add(traffic.group); else traffic.lamps.visible = false;
document.getElementById('credits').textContent = manifest.attribution.map((a) => a.split(' (')[0]).join(' · ');

// initial view: the area's own, or over its origin looking north-west (Shibuya: across the Scramble Crossing to the station)
const [cx, cz, dist, az, el] = (params.get('cam') || manifest.view || '0,0,420,215,32').split(',').map(Number);
controls.target.set(cx, streamer.ground(cx, cz), cz);
camera.position.copy(controls.target).add(new THREE.Vector3().setFromSphericalCoords(
  dist, THREE.MathUtils.degToRad(90 - el), THREE.MathUtils.degToRad(az)));
controls.update();

// ---------------------------------------------------------------- control panel
let guiState, clockText;
// The picture on the switch in the corner (see drawOtherMode): kept up with the view all the time (live), or made
// anew whenever the view has come to rest; stale: something has changed since it was made.
// The histogram of the finished picture (in the panel's Picture folder: see drawHistogram)
const histogram = { canvas: Object.assign(document.createElement('canvas'), { id: 'histogram' }), count: 0 };
Object.assign(histogram.canvas, { width: 512, height: 180 });
Object.assign(histogram.canvas.style, { display: 'block', width: 'calc(100% - 12px)', margin: '6px', borderRadius: '3px', background: '#101216' });
const previewMode = { on: params.get('preview') !== '0', live: params.get('preview') === '1', stale: true, now: false };
{
  // the compiled areas (tools/pipeline/compile.mjs keeps the list); another city is another page load
  const areas = await fetch('tiles/areas.json').then((r) => (r.ok ? r.json() : null)).catch(() => null) ?? [{ id: AREA, name: manifest.name }];
  const trains = railways.userData.trains.group, AO = ao.configuration.intensity;
  const state = {
    city: AREA,
    get info() { return document.getElementById('hud').style.display !== 'none'; }, set info(v) { document.getElementById('hud').style.display = v ? '' : 'none'; },

    get traffic() { return !!traffic.group.parent; }, set traffic(v) { if (v) scene.add(traffic.group); else scene.remove(traffic.group); traffic.lamps.visible = v; },
    get trains() { return trains.visible; }, set trains(v) { trains.visible = railways.userData.trains.lamps.visible = v; },
    get photo() { return orthoWanted; }, set photo(v) { orthoWanted = v; shared.uOrthoOn.value = v && orthoLoaded ? 1 : 0; },
    get shadows() { return env.sun.castShadow; }, set shadows(v) { env.sun.castShadow = v; },
    get occlusion() { return ao.configuration.intensity > 0; }, set occlusion(v) { ao.configuration.intensity = v ? AO : 0; },
    bloom: true,
    get abstract() { return variant.abstract; }, set abstract(v) { if (v !== variant.abstract) setAbstract(v); },
    get landmarks() { return variant.landmarks; }, set landmarks(v) { if (v !== variant.landmarks) setVariant({ landmarks: v }); },
    // how dark the clouds' shadow lies on the city (0: none; the number is written into a shader, so it is set
    // when the slider is let go)
    // (the number is written into a shader: it is set a moment after the slider has come to rest)
    get cloudShadow() { return cloudShadow; }, set cloudShadow(v) { cloudShadow = v; clearTimeout(shadeTimer); shadeTimer = setTimeout(applyShade, 250); },
    windowPace: 6, // how fast the lit rooms come and go (1: a room may change every 1.5 to 5.5 minutes)
    // contact shadows: the soft dark on the ground round the foot of things (0: none, and nothing is drawn for it)
    get contact() { return shared.uContact.value; }, set contact(v) { shared.uContact.value = v; if ((v > 0) !== variant.contact) setVariant({ contact: v > 0 }); },
    // facade relief: windows set back into the wall (materials.js)
    get relief() { return variant.relief; }, set relief(v) { if (v !== variant.relief) setVariant({ relief: v }); },
    // the season of the trees (props.js)
    get season() { return ['summer', 'autumn', 'spring'][shared.uSeason.value]; }, set season(v) { shared.uSeason.value = Math.max(0, ['summer', 'autumn', 'spring'].indexOf(v)); },
    get windows() { return variant.windows; }, set windows(v) { if (v !== variant.windows) setVariant({ windows: v }); },
    // the whole city at once, or only what lies within the view radius of the point looked at (fewer tiles: more frames)
    wholeCity: false, near: Number(params.get('radius')) || 900,
    get whole() { return this.wholeCity; }, set whole(v) { this.wholeCity = v; streamer.radius = v ? 1e5 : this.near; },
    get radius() { return this.near; }, set radius(v) { this.near = v; if (!this.wholeCity) streamer.radius = v; },
  };
  guiState = state;
  // the names of the cities, for the loading screen of the next visit (index.html reads them)
  try { for (const a of areas) localStorage.setItem(`procedural-tokyo:name:${a.id}`, a.name); } catch { /* storage unavailable */ }
  const gui = new GUI({ title: 'Settings' });
  gui.close(); // (out of the way until it is asked for)
  gui.add(state, 'city', Object.fromEntries(areas.map((a) => [a.name, a.id]))).onChange((id) => {
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('area', id);
    loader.show(areas.find((a) => a.id === id)?.name ?? id, 'leaving for the next city');
    setTimeout(() => { location.href = url.href; }, 60); // (let the screen appear first)
  });
  const time = gui.addFolder('Time (Tokyo)');
  time.add(clockTime, 'live').name('live clock').listen().onChange((v) => { if (v) clockTime.play = false; });
  time.add(clockTime, 'play').name('auto play').listen();
  time.add(clockTime, 'speed', 1, 100, 1).name('speed (min / s)');
  // one slider over the day, with the clock time written beside it in place of the number box
  const slider = time.add(clockTime, 'hour', 0, 24, 1 / 60).name('time').listen().onChange(() => { clockTime.live = false; });
  slider.$input.style.display = 'none';
  clockText = document.createElement('span');
  clockText.style.cssText = 'min-width: 3.4em; padding-left: 8px; text-align: right; font-variant-numeric: tabular-nums;';
  slider.$widget.appendChild(clockText);
  // (every folder ends with a button that puts its settings back as they are at the start)
  const withReset = (folder) => { folder.add({ reset() { folder.reset(); } }, 'reset').name('back to the defaults'); return folder; };
  withReset(time);

  // the light itself: each against what the atmosphere gives
  const light = gui.addFolder('Light');
  light.add(env, 'sunStrength', 0, 2, 0.01).name('sun');
  light.add(env, 'skyStrength', 0, 3, 0.01).name('sky (blue fill)');
  light.add(env, 'bounceStrength', 0, 3, 0.01).name('sunlight sent on by the city');
  light.add(env, 'moonStrength', 0, 4, 0.01).name('moonlight');
  light.add(env, 'glowStrength', 0, 4, 0.01).name('glow of the city by night');
  light.add(env, 'nightBrightness', 0.3, 3, 0.01).name('night exposure');
  withReset(light);

  // the finished picture, as in a photo editor
  const picture = gui.addFolder('Picture'), look = atmosphere.picture;
  picture.$children.prepend(histogram.canvas);
  picture.add(atmosphere, 'curve', ['bruneton', 'agx', 'aces', 'neutral']).name('tone curve');
  picture.add(env, 'brightness', 0.4, 2.5, 0.01).name('exposure');
  picture.add(look.contrast, 'value', 0.6, 1.6, 0.01).name('contrast');
  picture.add(look.highlights, 'value', -1, 1, 0.01).name('highlights');
  picture.add(look.shadows, 'value', -1, 1, 0.01).name('shadows');
  picture.add(look.saturation, 'value', 0, 2, 0.01).name('saturation');
  picture.add(look.vibrance, 'value', -1, 1, 0.01).name('vibrance');
  picture.add(look.temperature, 'value', -1, 1, 0.01).name('temperature');
  picture.add(look.tint, 'value', -1, 1, 0.01).name('tint');
  picture.add(look.vignette, 'value', 0, 1, 0.01).name('vignette');
  picture.add(state, 'bloom');
  withReset(picture);

  const shade = gui.addFolder('Shadows');
  shade.add(state, 'shadows');
  shade.add(env.sun.shadow, 'radius', 0, 12, 0.1).name('softness');
  shade.add(state, 'contact', 0, 1, 0.01).name('contact shadows');
  shade.add(contact, 'softness', 0.5, 20, 0.1).name('contact shadow blur (m)');
  shade.add(state, 'occlusion').name('ambient occlusion');
  withReset(shade);

  const sky = gui.addFolder('Sky');
  sky.add(atmosphere, 'cloudsOn').name('clouds');
  sky.add(atmosphere, 'coverage', 0, 1, 0.05).name('cloud cover');
  sky.add(state, 'cloudShadow', 0, 0.85, 0.01).name('cloud shadow on the city');
  sky.add(atmosphere, 'base', 200, 2000, 50).name('cloud base (m)');
  sky.add(atmosphere, 'overCity').name('clouds over the city only');
  sky.add(atmosphere, 'quality', ['low', 'medium', 'high', 'ultra']).name('cloud quality');
  sky.add(atmosphere.clouds.localWeatherVelocity, 'x', 0, 0.02, 0.0005).name('wind');
  sky.add(atmosphere, 'fog', 0, 1, 0.01);
  withReset(sky);

  const city = gui.addFolder('City');
  city.add(state, 'windows');
  city.add(state, 'relief').name('recessed windows');
  city.add(shared.uGlass, 'value', 0, 3, 0.05).name('window glass');
  city.add(shared.uGlintOn, 'value', 0, 5, 0.1).name('sun in the windows');
  city.add(shared.uPhotoMix, 'value', 0, 1, 0.05).name('wall photos');
  city.add(shared.uPhotoRange.value, 'x', 0, 1000, 10).name('wall photos from (m)');
  city.add(shared.uPhotoRange.value, 'y', 10, 2000, 10).name('wall photos full at (m)');
  city.add(state, 'photo').name('aerial photo on the ground').listen();
  city.add(state, 'season', ['summer', 'autumn', 'spring']);
  withReset(city);

  // the abstract model, and the switch in the corner that shows the city it changes to
  const model = gui.addFolder('Abstract model');
  const abstractSwitch = model.add(state, 'abstract').name('abstract model');
  const modeButton = document.getElementById('mode');
  const showMode = () => {
    modeButton.style.backgroundImage = `url(assets/ui/mode-${variant.abstract ? 'photo' : 'abstract'}.jpg)`;
    modeButton.title = variant.abstract ? 'Photorealistic city' : 'Abstract model';
  };
  modeButton.addEventListener('click', () => abstractSwitch.setValue(!variant.abstract));
  abstractSwitch.onChange(() => { showMode(); previewMode.stale = previewMode.now = true; });
  showMode();
  model.add(state, 'landmarks').name('landmarks in detail');
  model.add(previewMode, 'live').name('live preview on the switch');
  withReset(model);
  gui.onChange(() => { previewMode.stale = true; }); // (any setting may change the picture)

  const streets = gui.addFolder('Traffic');
  streets.add(state, 'traffic').name('cars');
  streets.add(traffic, 'count', 0, MAX_CARS, 10).name('how many cars');
  streets.add(traffic, 'highway', 0, 20, 0.5).name('highway traffic');
  streets.add(state, 'trains');
  streets.add(birds.geometry, 'instanceCount', 0, MAX_BIRDS, 10).name('birds');
  withReset(streets);

  const night = gui.addFolder('Night lights');
  night.add(props, 'streetLights', 0, 3, 0.05).name('street lights');
  night.add(props, 'parkLights', 0, 3, 0.05).name('park lights');
  night.add(traffic, 'headlights', 0, 20, 0.5).name('car headlights');
  night.add(shared.uRoomLight, 'value', 0, 4, 0.05).name('window light');
  night.add(shared.uSoft, 'value', 0, 1, 0.05).name('window light softness');
  night.add(shared.uWindowLife.value, 'x', 0, 1, 0.05).name('rooms that change');
  night.add(state, 'windowPace', 0, 60, 0.5).name('pace of the change');
  night.add(shared.uCityGlass, 'value', 0, 3, 0.05).name('drawn city lights in tower glass');
  night.add(shared.uNightBlue, 'value', 0, 1, 0.05).name('blue lights');
  withReset(night);

  const quality = gui.addFolder('Rendering');
  quality.add(state, 'whole').name('whole city');
  quality.add(state, 'radius', 300, 3000, 50).name('view radius (m), if not');
  quality.add(atmosphere, 'antialias', ['off', 'smaa', 'msaa', 'both']).name('smooth edges');
  quality.add(atmosphere, 'reflect').name('window and water reflections');
  quality.add(state, 'info').name('info panel');
  withReset(quality);
  for (const folder of gui.folders) if (folder !== time) folder.close(); // (the list of folders is the panel: one is opened at a time)

  // The panel's settings are kept (in this browser) and are the same for every city: what is switched off in
  // one is off in the next. A URL that sets something itself (?time=, ?cars=, ...) is taken as it stands.
  const KEY = 'procedural-tokyo:settings:14'; // (a new number when the defaults change: what was kept before is left behind)
  const explicit = [...params.keys()].some((k) => k !== 'area');
  // (the city is the page's, not a setting; and the abstract model is never kept: the page always opens on the city as it is)
  const strip = (saved) => { delete saved.controllers?.city; delete saved.folders?.['Abstract model']?.controllers?.['abstract model'];
    // (nor is the hour: the page always opens on Tokyo's own time, the live clock running)
    for (const k of ['live clock', 'auto play', 'time']) delete saved.folders?.['Time (Tokyo)']?.controllers?.[k];
    return saved;
  };
  if (!explicit) {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
      if (saved) {
        gui.load(strip(saved));
        // (loading the time moved the slider, which stops the live clock: put the saved choice back)
        const live = saved.folders?.['Time (Tokyo)']?.controllers?.['live clock'];
        if (live != null) clockTime.live = live;
      }
    } catch (e) { console.warn('settings not restored:', e.message); }
  }
  const keep = () => { try { localStorage.setItem(KEY, JSON.stringify(strip(gui.save()))); } catch { /* storage unavailable: nothing is kept */ } };
  // (a page opened with settings in its URL is a one-off view: it does not overwrite what is kept)
  if (!explicit) { gui.onFinishChange(keep); addEventListener('pagehide', keep); }
}

// ---------------------------------------------------------------- input
const keys = new Set();
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
addEventListener('keydown', (e) => {
  const el = document.activeElement, typing = el?.tagName === 'INPUT' && (el.type === 'text' || el.type === 'number');
  if (typing) return; // a number being typed into the panel
  // A panel control that was clicked keeps the keyboard: the arrow keys would then step its slider or its
  // city list instead of moving the view. Movement keys always belong to the scene.
  if (MOVE_KEYS.has(e.code)) { e.preventDefault(); if (el && el !== document.body) el.blur(); }
  if (e.code === 'KeyN') { clockTime.live = false; clockTime.hour = env.dark > 0.5 ? 12 : 22; } // noon <-> night
  keys.add(e.code);
}, { capture: true });
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

// WASD / arrows move the focus point over the ground; speed scales with the camera distance.
function keyboardPan(dt) {
  const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
  const r = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
  if (!f && !r) return;
  const fwd = new THREE.Vector3().subVectors(controls.target, camera.position).setY(0).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, THREE.Object3D.DEFAULT_UP);
  const speed = Math.max(20, camera.position.distanceTo(controls.target)) * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 2.5 : 0.9);
  const move = fwd.multiplyScalar(f).addScaledVector(right, r).normalize().multiplyScalar(speed * dt);
  controls.target.add(move);
  camera.position.add(move);
}

// Wheel zoom with inertia: each notch adds to a pending amount that is paid out over the next frames,
// towards the point of the ground under the cursor.
const zoom = { pending: 0, pivot: new THREE.Vector3(), ray: new THREE.Raycaster(), plane: new THREE.Plane() };
renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  const notches = (e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY) / 100;
  zoom.pending = THREE.MathUtils.clamp(zoom.pending + notches * 0.16, -1.6, 1.6);
  zoom.ray.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  zoom.plane.set(THREE.Object3D.DEFAULT_UP, -controls.target.y);
  const hit = zoom.ray.ray.intersectPlane(zoom.plane, new THREE.Vector3());
  // looking at the sky, or at ground far beyond the view: zoom on the focus point instead
  zoom.pivot.copy(hit && hit.distanceTo(controls.target) < camera.position.distanceTo(controls.target) * 3 ? hit : controls.target);
}, { passive: false });
function wheelZoom(dt) {
  if (Math.abs(zoom.pending) < 1e-4) { zoom.pending = 0; return; }
  const step = zoom.pending * (1 - Math.exp(-dt * 6));
  zoom.pending -= step;
  const dist = camera.position.distanceTo(controls.target), scale = THREE.MathUtils.clamp(Math.exp(step), controls.minDistance / dist, controls.maxDistance / dist);
  camera.position.sub(zoom.pivot).multiplyScalar(scale).add(zoom.pivot);
  controls.target.sub(zoom.pivot).multiplyScalar(scale).add(zoom.pivot);
}

// Gliding on after a drag: as fast as the view was moving when it was let go. A quick flick sends it far, a slow
// drag leaves it where it was put (and so does a drag that stopped before the button was released).
const glide = {
  dragging: false, pan: new THREE.Vector3(), turn: new THREE.Vector2(),   // speeds: metres and radians per second
  focus: new THREE.Vector3(), angles: new THREE.Spherical(), known: false, // where the view was a frame ago
  go: new THREE.Vector3(), spin: new THREE.Vector2(), slow: 4,           // the glide itself, and how fast it dies away
};
const glideStop = () => { glide.go.set(0, 0, 0); glide.spin.set(0, 0); };
renderer.domElement.addEventListener('pointerdown', () => { glide.dragging = true; glide.pan.set(0, 0, 0); glide.turn.set(0, 0); glideStop(); });
renderer.domElement.addEventListener('wheel', glideStop, { passive: true });
const glideRelease = () => {
  if (!glide.dragging) return;
  glide.dragging = false;
  // how fast it went, by the measure of the view: its own width per second for a pan, radians per second for a turn
  const dist = camera.position.distanceTo(controls.target);
  const flick = Math.max(THREE.MathUtils.smoothstep(glide.pan.length() / dist, 0.2, 1.2), THREE.MathUtils.smoothstep(glide.turn.length(), 0.4, 2));
  glide.go.copy(glide.pan).multiplyScalar(flick);
  glide.spin.copy(glide.turn).multiplyScalar(flick);
  glide.slow = THREE.MathUtils.lerp(6, 2.4, flick); // (the quicker the flick, the longer it runs)
};
addEventListener('pointerup', glideRelease);
addEventListener('pointercancel', glideRelease);
const _angles = new THREE.Spherical(), _arm = new THREE.Vector3();
function glideStep(dt) {
  if (dt <= 0) return;
  _angles.setFromVector3(_arm.subVectors(camera.position, controls.target));
  if (glide.dragging && glide.known) {
    // the speed of the drag, over the last few hundredths of a second (so that a pause before letting go counts)
    const k = 1 - Math.exp(-dt / 0.05);
    glide.pan.lerp(_arm.subVectors(controls.target, glide.focus).setY(0).divideScalar(dt), k);
    let turned = _angles.theta - glide.angles.theta;
    turned -= Math.round(turned / (2 * Math.PI)) * 2 * Math.PI;
    glide.turn.x += (turned / dt - glide.turn.x) * k;
    glide.turn.y += ((_angles.phi - glide.angles.phi) / dt - glide.turn.y) * k;
  } else if (!glide.dragging && (glide.go.lengthSq() > 1e-6 || glide.spin.lengthSq() > 1e-8)) {
    controls.target.addScaledVector(glide.go, dt);
    camera.position.addScaledVector(glide.go, dt);
    if (glide.spin.lengthSq() > 1e-8) {
      _angles.theta += glide.spin.x * dt;
      _angles.phi = THREE.MathUtils.clamp(_angles.phi + glide.spin.y * dt, 0.02, controls.maxPolarAngle);
      camera.position.copy(controls.target).add(_arm.setFromSpherical(_angles));
    }
    const fade = Math.exp(-dt * glide.slow);
    glide.go.multiplyScalar(fade); glide.spin.multiplyScalar(fade);
  }
  glide.focus.copy(controls.target);
  glide.angles.setFromVector3(_arm.subVectors(camera.position, controls.target));
  glide.known = true;
}

// Click a building to inspect it.
let picked = null;
const raycaster = new THREE.Raycaster();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  raycaster.setFromCamera(new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1), camera);
  const hit = raycaster.intersectObjects(scene.children, true).find((h) => h.object.userData.facade);
  picked = hit ? streamer.buildingAt(hit) : null;
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  atmosphere.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- loop
const hud = document.getElementById('hud');
const clock = new THREE.Clock();
let frames = 0, fpsTime = 0, fps = 0;

let loading = true;
// one frame: everything that moves, then the picture
function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  clockTime.advance(dt);
  renderer.info.reset();
  keyboardPan(dt);
  wheelZoom(dt);
  glideStep(dt);
  controls.update();

  // The view keeps its height: the focus stays at the level it was given at the start (the ground there), whatever
  // the ground does under it as the view is moved — following the terrain made the picture bob up and down.
  // (Only this is seen to: the camera never goes under the ground.)
  const floor = streamer.ground(camera.position.x, camera.position.z) + 2;
  if (camera.position.y < floor) camera.position.y = floor;

  streamer.update(controls.target, camera.position);
  // the loading screen stays until the tiles around the view are in
  if (loading) {
    const size = manifest.tileSize, wanted = manifest.tiles.filter((t) => Math.hypot((t.x + 0.5) * size - controls.target.x, (t.z + 0.5) * size - controls.target.z) <= Math.min(streamer.radius, 900)).length || 1;
    const got = Math.min(1, streamer.stats.loaded / wanted);
    loader.set(0.2 + 0.8 * got, `city tiles ${streamer.stats.loaded} / ${manifest.tiles.length}`);
    if (got >= 1) { loading = false; loader.hide(); }
  }
  // the clock the lit windows go by: it runs at their pace (and is kept small: the shader counts in floats)
  shared.uWindowLife.value.y = (shared.uWindowLife.value.y + dt * (guiState?.windowPace ?? 6)) % 1e5;
  props.update(dt);
  if (birds.geometry.instanceCount) birds.userData.update(dt, controls.target, camera, streamer);
  signs.update();
  railways.userData.trains.update(dt, env.night);
  if (traffic.group.parent) traffic.update(dt, controls.target);
  env.setSky(...Object.values(atmosphere.setDate(clockTime.date())));
  clockText.textContent = clockTime.label();
  env.update(dt);
  env.follow(controls.target, camera);
  scene.updateMatrixWorld(); // (once for all of the frame's renders: see matrixWorldAutoUpdate above)
  lampLight.update(controls.target, camera.position, env.night);
  contact.update(scene, controls.target, camera.position, [birds]);
  shared.uTreeGlow.value.setRGB(...ABSTRACT.night.tree).multiplyScalar(variant.abstract ? env.dark : 0);
  atmosphere.bloom.intensity = guiState.bloom ? env.bloom * 3 : 0;
  if (env.plain !== (atmosphere.curve === 'bruneton')) { env.plain = atmosphere.curve === 'bruneton'; env.apply(); }
  atmosphere.balance.uniforms.get('gain').value.copy(env.balance);
  atmosphere.curveEffect.uniforms.get('exposure').value = renderer.toneMappingExposure;
  waterMirror.enabled = atmosphere.reflect && !variant.abstract; // (the abstract model's water mirrors nothing)
  waterMirror.update(scene, camera, streamer.tiles, controls.target, [traffic.group.parent ? null : traffic.group]);
  atmosphere.lightFog(env.dark, env.warmth * env.daylight, controls.target.y);
  atmosphere.render(dt);

  frames++; fpsTime += dt;
  if (fpsTime >= 0.5) { fps = frames / fpsTime; frames = 0; fpsTime = 0; }
  const s = streamer.stats, info = renderer.info.render;
  const [lon, lat] = proj.unproject(controls.target.x, controls.target.z);
  hud.textContent =
    `${manifest.name}  ${lat.toFixed(5)}N ${lon.toFixed(5)}E  ${controls.target.y.toFixed(1)} m\n` +
    `Tokyo ${clockTime.label()}${clockTime.live ? ' (live)' : ''} · sun ${env.elevation.toFixed(0)}°\n` +
    `${fps.toFixed(0)} fps · ${info.calls} draws · ${(info.triangles / 1e6).toFixed(2)}M tris\n` +
    `tiles ${s.loaded}/${manifest.tiles.length}${streamer.pending ? ` (+${streamer.pending})` : ''} · ${s.buildings} buildings\n` +
    (picked ? `\n▸ ${USAGE[picked.usage] ?? 'usage ' + picked.usage}, ${picked.height.toFixed(1)} m` +
      `${picked.storeys ? `, ${picked.storeys} floors` : ''}, base ${picked.base.toFixed(1)} m\n` : '') +
    `\ndrag pan · right-drag rotate · wheel zoom\nWASD move (shift fast) · N day/night · click building`;
}
// The switch in the corner shows this very view as the other mode draws it: as it moves (the panel's live preview:
// every few frames), or else each time the view has come to rest. For that the
// city is drawn once more in the other mode (the whole picture, where the frame is about to be drawn: it is
// never shown), and the middle of that picture is scaled down into a small texture — all on the graphics card,
// nothing is read back. Then the frame is drawn as it should be, and the small picture is drawn over the corner
// of it, under the switch (which is a frame around it and takes the click).
const PREVIEW_EVERY = 3;                 // live: the other mode is drawn at one frame in so many
const PREVIEW_REST = 300;                // otherwise: so many milliseconds after the view has stopped moving
const PREVIEW_BOX = { left: 14, bottom: 14, size: 64, radius: 10 }; // CSS pixels: the inside of the switch (index.html)
const preview = { steps: [1152, 576, 288, 144].map((n) => new THREE.WebGLRenderTarget(n, n, { depthBuffer: false })), count: 0, ready: false, moved: 0, eye: new THREE.Vector3(), turn: new THREE.Quaternion(), hour: -1, loaded: -1 };
preview.whole = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: false });
preview.whole.texture.generateMipmaps = false;
for (const t of preview.steps) { t.texture.generateMipmaps = false; renderer.initRenderTarget(t); }
preview.scene = new THREE.Scene();
preview.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
preview.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
  uniforms: { map: { value: preview.steps.at(-1).texture }, corner: { value: PREVIEW_BOX.radius / PREVIEW_BOX.size } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  // (the picture as it stands: it was scaled down from the finished frame; the corners are rounded like the switch)
  fragmentShader: `uniform sampler2D map; uniform float corner; varying vec2 vUv;
    void main() { vec2 q = abs(vUv - 0.5) - (0.5 - corner); if (length(max(q, 0.0)) > corner) discard; gl_FragColor = vec4(texture2D(map, vUv).rgb, 1.0); }`,
  depthTest: false, depthWrite: false, toneMapped: false,
}));
preview.quad.frustumCulled = false;
preview.scene.add(preview.quad);
function drawOtherMode() {
  const on = variant.abstract, set = (abstract) => { setVariant({ abstract }); streamer.setAbstract(abstract); };
  set(!on);
  tick(); frames--; // (not a frame of its own)
  // the middle square of the picture, halved step by step down to the small one
  const gl = renderer.getContext(), state = renderer.state, c = renderer.domElement, side = Math.min(c.width, c.height);
  let x0 = (c.width - side) >> 1, y0 = (c.height - side) >> 1, size = side;
  state.setScissorTest(false);
  // (the screen's own buffer is multisampled: it can only be copied as it lies, into a buffer of the screen's size)
  if (preview.whole.width !== c.width || preview.whole.height !== c.height) { preview.whole.setSize(c.width, c.height); renderer.initRenderTarget(preview.whole); }
  let from = renderer.properties.get(preview.whole).__webglFramebuffer;
  state.bindFramebuffer(gl.READ_FRAMEBUFFER, null); state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, from);
  gl.blitFramebuffer(x0, y0, x0 + size, y0 + size, x0, y0, x0 + size, y0 + size, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  for (const t of preview.steps) {
    if (t.width * 2 > size && t !== preview.steps.at(-1)) continue; // (the screen is smaller than this step)
    const to = renderer.properties.get(t).__webglFramebuffer;
    state.bindFramebuffer(gl.READ_FRAMEBUFFER, from); state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, to);
    gl.blitFramebuffer(x0, y0, x0 + size, y0 + size, 0, 0, t.width, t.height, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    from = to; x0 = y0 = 0; size = t.width;
  }
  state.bindFramebuffer(gl.READ_FRAMEBUFFER, null); state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  set(on);
  if (!preview.ready) { preview.ready = true; document.getElementById('mode').classList.add('live'); }
}
function drawPreview() {
  if (!preview.ready) return;
  const auto = renderer.autoClear, b = PREVIEW_BOX;
  renderer.setRenderTarget(null);
  renderer.autoClear = false;
  renderer.setViewport(b.left, b.bottom, b.size, b.size);
  renderer.render(preview.scene, preview.camera);
  renderer.setViewport(0, 0, innerWidth, innerHeight);
  renderer.autoClear = auto;
}
// Is the picture on the switch to be made now?
function previewDue() {
  const m = previewMode, p = preview, now = performance.now();
  if (!m.on || loading) return false;
  if (m.live) return p.count++ % PREVIEW_EVERY === 0;
  // (at rest: within a centimetre and a hair's turn of where it was — the view settles ever more slowly, without end)
  if (p.eye.distanceToSquared(camera.position) > 1e-4 || 1 - Math.abs(p.turn.dot(camera.quaternion)) > 1e-9) { p.eye.copy(camera.position); p.turn.copy(camera.quaternion); p.moved = now; m.stale = true; }
  if (streamer.stats.loaded !== p.loaded) { p.loaded = streamer.stats.loaded; m.stale = true; } // (tiles came or went)
  if (Math.abs(clockTime.hour - p.hour) > 0.2) m.stale = true;                                   // (the light has changed)
  if (m.now) { m.now = m.stale = false; p.hour = clockTime.hour; return true; }                   // (the switch was used: at once)
  if (!m.stale || streamer.pending || now - p.moved < PREVIEW_REST || Math.abs(zoom.pending) > 0) return false;
  m.stale = false; p.hour = clockTime.hour;
  return true;
}
// The histogram: how the picture's pixels are spread from dark (left) to bright (right) — red, green and blue each,
// and their brightness in white. A few times a second the frame just drawn is scaled down on the graphics card,
// read back small and counted. A pile at either end is what is lost: black shadows on the left, burnt-out lights
// on the right (the marks in the corners light up when more than a little of the picture is there).
const HISTOGRAM = { w: 256, h: 144, every: 8 };
histogram.target = new THREE.WebGLRenderTarget(HISTOGRAM.w, HISTOGRAM.h, { depthBuffer: false });
histogram.target.texture.generateMipmaps = false;
renderer.initRenderTarget(histogram.target);
histogram.pixels = new Uint8Array(HISTOGRAM.w * HISTOGRAM.h * 4);
histogram.bins = [0, 1, 2, 3].map(() => new Float32Array(256));
function drawHistogram() {
  const h = histogram, c = renderer.domElement;
  if (h.count++ % HISTOGRAM.every || !h.canvas.offsetParent) return; // (not while the folder is closed)
  const gl = renderer.getContext(), state = renderer.state;
  // (the screen's own buffer is multisampled: copied as it lies first, then scaled down — as for the switch's picture)
  if (preview.whole.width !== c.width || preview.whole.height !== c.height) { preview.whole.setSize(c.width, c.height); renderer.initRenderTarget(preview.whole); }
  const whole = renderer.properties.get(preview.whole).__webglFramebuffer, small = renderer.properties.get(h.target).__webglFramebuffer;
  state.setScissorTest(false);
  state.bindFramebuffer(gl.READ_FRAMEBUFFER, null); state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, whole);
  gl.blitFramebuffer(0, 0, c.width, c.height, 0, 0, c.width, c.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  state.bindFramebuffer(gl.READ_FRAMEBUFFER, whole); state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, small);
  gl.blitFramebuffer(0, 0, c.width, c.height, 0, 0, HISTOGRAM.w, HISTOGRAM.h, gl.COLOR_BUFFER_BIT, gl.LINEAR);
  state.bindFramebuffer(gl.READ_FRAMEBUFFER, small);
  gl.readPixels(0, 0, HISTOGRAM.w, HISTOGRAM.h, gl.RGBA, gl.UNSIGNED_BYTE, h.pixels);
  state.bindFramebuffer(gl.READ_FRAMEBUFFER, null); state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);

  const [red, green, blue, light] = h.bins, px = h.pixels;
  for (const b of h.bins) b.fill(0);
  for (let i = 0; i < px.length; i += 4) { red[px[i]]++; green[px[i + 1]]++; blue[px[i + 2]]++; light[Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2])]++; }
  const g = h.canvas.getContext('2d'), W = h.canvas.width, H = h.canvas.height, n = px.length / 4;
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  for (let k = 1; k < 4; k++) { g.beginPath(); g.moveTo((k * W) / 4, 0); g.lineTo((k * W) / 4, H); g.stroke(); }
  // (the ends are left out of the scale — a burnt-out sky would flatten all the rest — and tall piles are drawn lower: a root)
  let top = 1;
  for (const b of h.bins) for (let i = 2; i < 254; i++) top = Math.max(top, b[i]);
  const curve = (b, fill) => {
    g.beginPath(); g.moveTo(0, H);
    for (let i = 0; i < 256; i++) g.lineTo((i / 255) * W, H - Math.min(1, Math.sqrt(b[i] / top)) * (H - 4));
    g.lineTo(W, H); g.closePath(); g.fillStyle = fill; g.fill();
  };
  g.globalCompositeOperation = 'lighter';
  curve(red, 'rgba(235, 60, 60, 0.75)'); curve(green, 'rgba(60, 210, 80, 0.75)'); curve(blue, 'rgba(70, 110, 255, 0.75)');
  g.globalCompositeOperation = 'source-over';
  curve(light, 'rgba(255, 255, 255, 0.28)');
  // lost at the ends: more than half a percent of the picture quite black, or quite white
  const lost = (b) => (b[0] + b[1]) / n, burnt = (b) => (b[254] + b[255]) / n, mark = (x, on) => { g.fillStyle = on ? '#ffd24a' : 'rgba(255, 255, 255, 0.18)'; g.beginPath(); g.moveTo(x, 4); g.lineTo(x + (x < W / 2 ? 14 : -14), 4); g.lineTo(x, 18); g.closePath(); g.fill(); };
  mark(4, lost(light) > 0.005); mark(W - 4, Math.max(burnt(red), burnt(green), burnt(blue)) > 0.005);
}
function frame() {
  if (previewDue()) drawOtherMode();
  tick();
  drawHistogram();
  drawPreview();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// (for the console and for tools: tick() draws a frame by hand, clockTime sets the hour)
window.__app = { scene, camera, controls, streamer, env, renderer, materials, ao, atmosphere, traffic, shared, tick, clockTime, waterMirror, lampLight, contact, props, birds, railways, variant, setVariant };
