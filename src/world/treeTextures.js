// ez-tree's textures, in place of the library's own module (see vite.config.js). The library's build carries every
// bark and leaf picture it has inside its code, as text: four megabytes of the page's script, all decoded at start.
// Here a picture is loaded when a tree first asks for it, from a file of its own. Only the colour of the bark is ever
// drawn (props.js makes its own materials from the trees' maps): the bark's other maps are left blank.
import * as THREE from 'three';

const loader = new THREE.TextureLoader();
const made = new Map();
const blank = new THREE.Texture();
const load = (key, url) => {
  if (!made.has(key)) {
    const texture = loader.load(url);
    texture.premultiplyAlpha = true;
    texture.colorSpace = THREE.SRGBColorSpace;
    made.set(key, texture);
  }
  return made.get(key);
};

export function getBarkTexture(barkType, fileType, scale = { x: 1, y: 1 }) {
  if (fileType !== 'color') return blank;
  const texture = load(`bark ${barkType}`, new URL(`../../node_modules/@dgreenheck/ez-tree/src/lib/assets/bark/${barkType}_color_1k.jpg`, import.meta.url).href);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.x = scale.x;
  texture.repeat.y = 1 / scale.y;
  return texture;
}

export function getLeafTexture(leafType) {
  return load(`leaves ${leafType}`, new URL(`../../node_modules/@dgreenheck/ez-tree/src/lib/assets/leaves/${leafType}_color.png`, import.meta.url).href);
}
