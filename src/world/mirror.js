// Water as a mirror: where the water lies, for the reflector the ground material draws with (materials.js).
// One level for the whole view: that of the water nearest to the point looked at.
import * as THREE from 'three/webgpu';

const _m = new THREE.Matrix4();

export class WaterMirror {
  constructor() {
    this.frustum = new THREE.Frustum();
    this.enabled = true;
  }

  // The level of the water nearest to `focus` among the tiles in view, or null if no water is to be seen.
  level(tiles, camera, focus) {
    this.frustum.setFromProjectionMatrix(_m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    let best = null, bestD = Infinity;
    for (const t of tiles.values()) {
      const w = t.water;
      if (!w || !this.frustum.intersectsSphere(w.sphere)) continue;
      const d = Math.hypot(w.sphere.center.x - focus.x, w.sphere.center.z - focus.z);
      if (d < bestD) { bestD = d; best = w.y; }
    }
    return best;
  }

  update() { /* (stage D of the WebGPU port: the reflector) */ }
}
