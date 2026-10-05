// Water as a real mirror: the city is drawn a second time, upside down below the water's level, into a texture
// that the ground shader lays on the water (materials.js). Unlike reflections found on the screen (reflections.js,
// which the window panes use), this shows what stands above the water from any angle — also what is out of the
// picture. One level for the whole view: that of the water nearest to the point looked at.
import * as THREE from 'three/webgpu';
import { shared } from './materials.js';

const SCALE = 0.5;   // size of the mirror picture, as a share of the screen
const CLIP = 0.3;    // metres below the water level that are still drawn (the banks, which stand a little into it)

export class WaterMirror {
  constructor(renderer) {
    this.renderer = renderer;
    this.target = new THREE.RenderTarget(4, 4, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.camera = new THREE.PerspectiveCamera();
    this.blank = shared.uMirror.value;
    this.size = new THREE.Vector2();
    this.clear = new THREE.Color(0, 0, 0);
    this.frustum = new THREE.Frustum();
    this.enabled = true;
  }

  // The level of the water nearest to `focus` among the tiles in view, or null if no water is to be seen.
  level(tiles, camera, focus) {
    this.frustum.setFromProjectionMatrix(_m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camera.coordinateSystem);
    let best = null, bestD = Infinity;
    for (const t of tiles.values()) {
      const w = t.water;
      if (!w || !this.frustum.intersectsSphere(w.sphere)) continue;
      const d = Math.hypot(w.sphere.center.x - focus.x, w.sphere.center.z - focus.z);
      if (d < bestD) { bestD = d; best = w.y; }
    }
    return best;
  }

  // Draws the mirror picture for this frame. hide: objects that are left out of it.
  update(scene, camera, tiles, focus, hide = []) {
    const y = this.enabled ? this.level(tiles, camera, focus) : null;
    if (y == null) { shared.uMirrorOn.value = 0; return; }
    const r = this.renderer;
    r.getDrawingBufferSize(this.size).multiplyScalar(SCALE).floor();
    if (this.target.width !== this.size.x || this.target.height !== this.size.y) this.target.setSize(this.size.x, this.size.y);

    // the camera, mirrored in the water (as three's Reflector does it)
    const cam = this.camera, plane = _plane.set(_up, -y);
    _pos.setFromMatrixPosition(camera.matrixWorld);
    _look.set(0, 0, -1).applyMatrix4(_rot.extractRotation(camera.matrixWorld)).add(_pos);
    cam.position.set(_pos.x, 2 * y - _pos.y, _pos.z);
    cam.up.set(0, 1, 0).applyMatrix4(_rot).reflect(_up);
    cam.lookAt(_look.x, 2 * y - _look.y, _look.z);
    cam.near = camera.near; cam.far = camera.far;
    cam.updateMatrixWorld();
    cam.coordinateSystem = camera.coordinateSystem; // (or the renderer would work the projection out again)
    cam.projectionMatrix.copy(camera.projectionMatrix);
    cam.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    // an oblique near plane: nothing below the water is drawn (Lengyel's method, for depths from 0 to 1)
    _clip.copy(plane); _clip.constant += CLIP;
    _clip.applyMatrix4(cam.matrixWorldInverse);
    const p = cam.projectionMatrix.elements, c = _v4.set(_clip.normal.x, _clip.normal.y, _clip.normal.z, _clip.constant);
    _q.x = (Math.sign(c.x) + p[8]) / p[0]; _q.y = (Math.sign(c.y) + p[9]) / p[5]; _q.z = -1; _q.w = (1 + p[10]) / p[14];
    c.multiplyScalar(1 / c.dot(_q));
    p[2] = c.x; p[6] = c.y; p[10] = c.z; p[14] = c.w;

    // from a point of the world to its place in the mirror picture
    shared.uMirrorMatrix.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);

    const hidden = hide.filter((o) => o && o.visible);
    for (const o of hidden) o.visible = false;
    const state = { target: r.getRenderTarget(), background: scene.background, clear: r.getClearColor(new THREE.Color()), alpha: r.getClearAlpha() };
    shared.uMirror.value = this.blank; shared.uMirrorOn.value = 0; // (the picture cannot show itself)
    scene.background = null;
    r.setRenderTarget(this.target);
    r.setClearColor(this.clear, 0);
    r.render(scene, cam);
    r.setRenderTarget(state.target);
    r.setClearColor(state.clear, state.alpha);
    scene.background = state.background;
    for (const o of hidden) o.visible = true;
    shared.uMirror.value = this.target.texture; shared.uMirrorOn.value = 1;
  }
}

const _m = new THREE.Matrix4(), _rot = new THREE.Matrix4(), _up = new THREE.Vector3(0, 1, 0), _pos = new THREE.Vector3(), _look = new THREE.Vector3();
const _plane = new THREE.Plane(), _clip = new THREE.Plane(), _v4 = new THREE.Vector4(), _q = new THREE.Vector4();
