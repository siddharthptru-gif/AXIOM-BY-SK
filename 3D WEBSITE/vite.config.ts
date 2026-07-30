import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Static build only. There is no server, no API route and no environment secret, so
 * the output of `vite build` is a self-contained folder any static host can serve.
 *
 * The installer in `public/downloads` is large, so it is copied rather than inlined
 * and the chunk-size warning limit is raised — three.js is legitimately big and
 * splitting it further would only add round trips.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2020',
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 1400,
    /*
     * No manual chunking. A `manualChunks` entry names modules explicitly, which forces
     * them into the bundle whether or not anything imports them — with the 3D layer
     * unwired, listing three.js here would ship about 1 MB of JavaScript that nothing
     * executes. Rollup's automatic splitting is correct for a page this size.
     *
     * If the scene in `src/three/` is ever wired back in, restore:
     *   rollupOptions: { output: { manualChunks: { three: ['three', '@react-three/fiber', '@react-three/drei'] } } }
     * so three.js caches separately from the app code.
     */
  },
  server: {
    port: 5173,
    open: true,
  },
});
