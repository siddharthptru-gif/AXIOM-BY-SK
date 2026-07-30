import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { productionBundleSettings, type BundleKind } from './src/common/buildHardening';

// Shared kernel is consumed as source and bundled (not externalized) so there
// is no ESM/CJS runtime mismatch at the process boundary.
const sharedAlias = {
  '@axiom/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
};

function bundleConfig(
  kind: BundleKind,
  input: string,
  production: boolean,
  extraInputs: Record<string, string> = {},
) {
  const security = productionBundleSettings(kind, production);
  return {
    ...(security ? { esbuild: security.esbuild } : {}),
    build: {
      ...(security
        ? {
            target: security.target,
            sourcemap: security.sourcemap,
            minify: security.minify,
            cssMinify: security.cssMinify,
            reportCompressedSize: security.reportCompressedSize,
          }
        : {}),
      rollupOptions: {
        input: { index: input, ...extraInputs },
        ...(security ? { output: security.output } : {}),
      },
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const production = command === 'build' && mode === 'production';
  return {
    main: {
      plugins: [externalizeDepsPlugin({ exclude: ['@axiom/shared'] })],
      resolve: { alias: sharedAlias },
      ...bundleConfig('main', resolve(__dirname, 'src/main/bootstrap.ts'), production, {
        extensionSandboxWorker: resolve(__dirname, 'src/main/extensionSandboxWorker.ts'),
        // A second entry point, not a chunk of the first: this file is forked as its own
        // process, so it must be an independently loadable bundle.
        extensionHostWorker: resolve(__dirname, 'src/main/extensionHostWorker.ts'),
      }),
    },
    preload: {
      plugins: [externalizeDepsPlugin({ exclude: ['@axiom/shared'] })],
      resolve: { alias: sharedAlias },
      ...bundleConfig('preload', resolve(__dirname, 'src/preload/index.ts'), production),
    },
    renderer: {
      root: resolve(__dirname, 'src/renderer'),
      resolve: {
        alias: {
          ...sharedAlias,
          '@renderer': resolve(__dirname, 'src/renderer/src'),
        },
      },
      plugins: [react()],
      ...bundleConfig('renderer', resolve(__dirname, 'src/renderer/index.html'), production),
    },
  };
});
