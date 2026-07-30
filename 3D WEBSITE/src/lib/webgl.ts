/**
 * Probe for a usable WebGL context once, before mounting the canvas.
 *
 * React Three Fiber throws if it cannot get a context, which would take the whole
 * page down over decoration. The scene is `aria-hidden` and purely visual, so the
 * correct behaviour when WebGL is missing is to render the HTML and move on.
 */
let cached: boolean | null = null;

export function hasWebGL(): boolean {
  if (cached !== null) return cached;
  if (typeof document === 'undefined') {
    cached = false;
    return cached;
  }
  try {
    const canvas = document.createElement('canvas');
    const context =
      canvas.getContext('webgl2') ??
      canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl');
    cached = context !== null;
  } catch {
    cached = false;
  }
  return cached;
}
