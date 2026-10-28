import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// ez-tree is taken from its source rather than its build, with its texture module replaced by one that loads only
// the pictures the trees use (src/world/treeTextures.js): the build inlines all of them into the page's script.
const ezTree = {
  name: 'ez-tree-textures',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source === '@dgreenheck/ez-tree') return fileURLToPath(new URL('./node_modules/@dgreenheck/ez-tree/src/lib/index.js', import.meta.url));
    if (source === './textures' && importer?.includes('/@dgreenheck/ez-tree/src/lib/')) return fileURLToPath(new URL('./src/world/treeTextures.js', import.meta.url));
  },
};

export default defineConfig({
  base: './', // (relative: the site also works under a path, as on GitHub Pages)
  plugins: [ezTree],
  server: { port: 5280 },
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
