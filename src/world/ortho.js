// Aerial photo of the area (GSI seamlessphoto tiles fetched by tools/pipeline/fetch.mjs into
// public/ortho/<area>/), stitched into one texture that the terrain material drapes over the open ground.
import * as THREE from 'three/webgpu';
import { shared } from './materials.js';

const MAX = 4096; // texture pixels along the longer side (about 0.8 m per pixel for Shibuya)

// Web Mercator tile corner -> lon / lat
const tileLon = (x, z) => (x / 2 ** z) * 360 - 180;
const tileLat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

// proj: makeProjection() of the area; bounds: manifest.bounds. Resolves to true if a photo was loaded.
export async function loadOrtho(base, proj, bounds, renderer) {
  // no photo fetched for this area: a dev server answers a missing file with its HTML page, hence the catch
  const index = await fetch(`${base}/index.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!index) return false;
  const { z, x0, x1, y0, y1 } = index;
  const sizeX = bounds.maxX - bounds.minX, sizeZ = bounds.maxZ - bounds.minZ, k = MAX / Math.max(sizeX, sizeZ);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sizeX * k); canvas.height = Math.round(sizeZ * k);
  const g = canvas.getContext('2d');
  g.fillStyle = '#6f6e68'; g.fillRect(0, 0, canvas.width, canvas.height);
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    jobs.push(fetch(`${base}/${z}_${x}_${y}.jpg`).then((r) => (r.ok ? r.blob() : null)).then((b) => b && createImageBitmap(b)).then((img) => {
      if (!img) return;
      // over a 150 m tile the Mercator grid is as good as linear in our local metres
      const [ax, az] = proj.project(tileLon(x, z), tileLat(y, z)), [bx, bz] = proj.project(tileLon(x + 1, z), tileLat(y + 1, z));
      g.drawImage(img, (ax - bounds.minX) * k, (az - bounds.minZ) * k, (bx - ax) * k + 0.5, (bz - az) * k + 0.5);
    }).catch(() => {}));
  }
  await Promise.all(jobs);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = Math.min(8, renderer.getMaxAnisotropy());
  shared.uOrtho.value = texture;
  shared.uOrthoRect.value.set(bounds.minX, bounds.minZ, sizeX, sizeZ);
  shared.uOrthoOn.value = 1;
  return true;
}
