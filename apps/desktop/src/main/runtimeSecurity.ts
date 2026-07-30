import { WEBVIEW_SCHEME } from '../common/vscodeWebview';

export const PRODUCTION_CSP_DIRECTIVES = {
  'default-src': ["'none'"], // Same-origin scripts, plus WebAssembly compilation for the TextMate highlighting
  // engine's Oniguruma matcher. `'wasm-unsafe-eval'` is a distinct Chromium capability
  // from `'unsafe-eval'`: it allows compiling WebAssembly and nothing else — no `eval`,
  // no `new Function`, no inline or remote script. Without it, Chromium refuses to
  // instantiate the module and grammar-based highlighting cannot run at all.
  'script-src': ["'self'", "'wasm-unsafe-eval'"],
  // Monaco measures and positions editor widgets with inline style attributes.
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'"],
  // Monaco creates language workers from local blob URLs.
  'worker-src': ["'self'", 'blob:'],
  'object-src': ["'none'"],
  // Extension webviews, and nothing else, may be framed by the workbench. Each one is served
  // from `axiom-webview://<token>`, a scheme that resolves to nothing but the allow-listed files
  // of a single webview (see `common/vscodeWebview.ts`), so widening these two directives to it
  // grants the workbench the ability to embed a webview and grants extension HTML nothing: the
  // frame's own document carries a stricter policy, and its `frame-ancestors` keeps it embeddable
  // only here. Without this the workbench could not host webviews at all.
  'frame-src': [`${WEBVIEW_SCHEME}:`],
  'child-src': [`${WEBVIEW_SCHEME}:`],
  'form-action': ["'none'"],
  'media-src': ["'none'"],
  'base-uri': ["'none'"],
  'frame-ancestors': ["'none'"],
} as const;

export function serializeCsp(directives: Readonly<Record<string, readonly string[]>>): string {
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

export const PRODUCTION_CSP = serializeCsp(PRODUCTION_CSP_DIRECTIVES);

// Development alone permits Vite's local module graph, eval sourcemaps, and HMR socket.
export const DEVELOPMENT_CSP =
  "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: http://localhost:* ws://localhost:*; " +
  `frame-src ${WEBVIEW_SCHEME}:; child-src ${WEBVIEW_SCHEME}:; ` +
  "worker-src 'self' blob: data: http://localhost:*";

export const RENDERER_PROTOCOL_SCHEME = 'axiom';
export const RENDERER_PROTOCOL_HOST = 'renderer';
export const RENDERER_ENTRY_URL = `${RENDERER_PROTOCOL_SCHEME}://${RENDERER_PROTOCOL_HOST}/index.html`;

const RENDERER_ASSET_PATH = /^\/(assets|chunks)\/([A-Za-z0-9][A-Za-z0-9._-]{0,255})$/;

/** Map an app-protocol URL to the only files the production renderer may request. */
export function rendererAssetRelativePath(rawUrl: string): string | null {
  if (rawUrl.length > 2_048) return null;
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== `${RENDERER_PROTOCOL_SCHEME}:` ||
      url.hostname !== RENDERER_PROTOCOL_HOST ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === '/index.html') return 'index.html';
    const match = RENDERER_ASSET_PATH.exec(pathname);
    return match ? `${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
}

export function isProductionRuntime(isPackaged: boolean, rendererUrl: string | undefined): boolean {
  return isPackaged || !rendererUrl;
}

/** Accept only the canonical renderer entry, including its exact query and fragment. */
export function isExactRendererNavigation(rawUrl: string, expectedUrl: string): boolean {
  try {
    const actual = new URL(rawUrl);
    const expected = new URL(expectedUrl);
    return !actual.username && !actual.password && actual.href === expected.href;
  } catch {
    return false;
  }
}

const CREDENTIAL_PARAMETER =
  /^(?:token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|password|passcode|secret|signature|credential|authorization)$/i;

function hasCredentialParameters(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (CREDENTIAL_PARAMETER.test(key)) return true;
  }
  const fragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  if (!fragment) return false;
  try {
    for (const key of new URLSearchParams(fragment).keys()) {
      if (CREDENTIAL_PARAMETER.test(key)) return true;
    }
  } catch {
    return true;
  }
  return false;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized === '[::1]' || normalized === '::1') return true;
  const octets = normalized.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/** Return a canonical shell-openable URL, or null when renderer input is not allowed. */
export function externalUrlForOpen(rawUrl: string, development: boolean): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password || hasCredentialParameters(url)) return null;
    if (url.protocol === 'https:') return url.href;
    if (development && url.protocol === 'http:' && isLoopbackHostname(url.hostname)) {
      return url.href;
    }
    return null;
  } catch {
    return null;
  }
}

export interface DevToolsInput {
  type?: string;
  key: string;
  code?: string;
  control: boolean;
  shift: boolean;
  meta: boolean;
  alt?: boolean;
}

/**
 * Blocks only DevTools accelerators; ordinary copy and editor shortcuts remain
 * available.
 *
 * Chromium's DevTools accelerators are exactly BARE F12 and Ctrl/Cmd+Shift+I/J/C.
 * A modified F12 chord (Ctrl+F12, Shift+F12, Alt+F12) does not open DevTools, and
 * those chords are the standard editor bindings for Go to Definition, Find All
 * References and Peek Definition. Blocking every F12 regardless of modifiers took
 * those bindings away without protecting anything, so the F12 rule is scoped to
 * the unmodified key.
 */
export function isBlockedDevToolsInput(input: DevToolsInput): boolean {
  if (input.type && input.type !== 'keyDown' && input.type !== 'rawKeyDown') return false;
  const key = input.key.toLowerCase();
  const code = (input.code ?? '').toLowerCase();
  const modified = input.control || input.meta || input.shift || input.alt === true;
  if ((key === 'f12' || code === 'f12') && !modified) return true;
  return (input.control || input.meta) && input.shift && ['i', 'j', 'c'].includes(key);
}

export type RuntimeDiagnosticDetails = Record<string, string | number | undefined>;

/** Production reports classification only; development retains actionable diagnostics. */
export function runtimeErrorDetails(value: unknown, production: boolean): RuntimeDiagnosticDetails {
  if (production) {
    return {
      kind:
        value instanceof Error
          ? 'error'
          : value === null
            ? 'null'
            : typeof value === 'object'
              ? 'non-error-object'
              : 'non-error-value',
    };
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return { kind: typeof value, message: String(value) };
}

export function windowLoadFailureDetails(
  code: number,
  description: string,
  production: boolean,
): RuntimeDiagnosticDetails {
  const safeCode = Number.isSafeInteger(code) ? code : 0;
  return production ? { code: safeCode } : { code: safeCode, description };
}
