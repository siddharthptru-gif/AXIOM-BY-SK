export type BundleKind = 'main' | 'preload' | 'renderer';

export const ELECTRON_NODE_TARGET = 'node20.18';
export const ELECTRON_CHROMIUM_TARGET = 'chrome130';

export interface ProductionBundleSettings {
  target: string;
  sourcemap: false;
  minify: 'esbuild';
  cssMinify: 'esbuild';
  reportCompressedSize: false;
  esbuild: {
    drop: ['debugger'];
    legalComments: 'none';
  };
  output: {
    compact: true;
    entryFileNames: string;
    chunkFileNames: string;
    assetFileNames: string;
  };
}

/** Build-only policy. Returning null leaves the development server and HMR untouched. */
export function productionBundleSettings(
  kind: BundleKind,
  production: boolean,
): ProductionBundleSettings | null {
  if (!production) return null;
  const renderer = kind === 'renderer';
  return {
    target: renderer ? ELECTRON_CHROMIUM_TARGET : ELECTRON_NODE_TARGET,
    sourcemap: false,
    minify: 'esbuild',
    cssMinify: 'esbuild',
    reportCompressedSize: false,
    esbuild: {
      // Keep console and the structured logger; remove only debugger statements.
      drop: ['debugger'],
      legalComments: 'none',
    },
    output: {
      compact: true,
      entryFileNames: renderer ? 'assets/[name]-[hash].js' : '[name].js',
      chunkFileNames: 'chunks/[name]-[hash].js',
      assetFileNames: 'assets/[name]-[hash][extname]',
    },
  };
}
