/**
 * The webview runtime's pure half (PRD Phase 4).
 *
 * A webview is the one place where an extension gets to put its own HTML, its own scripts and
 * its own network traffic inside AXIOM's window. Every real extension with a UI needs it —
 * Continue, Cline, Claude Code and GitHub Copilot Chat are all webviews — so this cannot be
 * refused the way an unimplemented namespace can. It has to be *contained* instead.
 *
 * The containment model is upstream's, for the same reasons:
 *
 *   - **A separate origin per webview.** Content is served from `axiom-webview://<token>`,
 *     where the token is minted per webview and never reused. Two webviews therefore cannot
 *     see each other's storage, and none of them shares an origin with the workbench
 *     (`axiom://renderer`), so no extension HTML can reach the workbench DOM, its IPC bridge
 *     or its storage.
 *   - **A sandboxed iframe.** Scripts and forms only. No top-level navigation, no popups, no
 *     modals, no plugins. `allow-same-origin` is present and is *not* a weakening here: the
 *     frame's origin is already foreign to the workbench, so keeping it means the frame gets a
 *     real origin (which the parent can then check on every message) instead of the opaque
 *     `"null"` that makes origin validation impossible.
 *   - **A filesystem allow-list.** A webview may read exactly the files under its
 *     `localResourceRoots`, resolved and compared in Main. There is no `file://` access, no
 *     directory listing and no traversal: a resource URL that escapes its roots is a 404.
 *   - **No Node, no Electron, no preload.** The frame is plain web content. The only channel
 *     out is `postMessage` to the parent, and the parent validates the origin, the frame
 *     identity and the payload before forwarding anything to the extension host.
 *
 * Everything in this file is pure so the interesting parts — URL translation, root
 * containment, CSP construction, HTML rewriting, message validation — are testable without a
 * window, and so Main and the renderer cannot drift on what a webview URL means.
 */

// ---------------------------------------------------------------------------
// Names and limits
// ---------------------------------------------------------------------------
/** The scheme webview content is served from. Deliberately not the renderer's own scheme. */
export const WEBVIEW_SCHEME = 'axiom-webview';
/** The only document path a webview origin serves. */
export const WEBVIEW_DOCUMENT_PATH = '/index.html';
/** Path prefix under which local resources are served, mirroring upstream's naming. */
export const WEBVIEW_RESOURCE_PREFIX = '/vscode-resource/';
/** The legacy schemes older extensions still spell inside their HTML. */
export const LEGACY_RESOURCE_SCHEMES = ['vscode-resource:', 'vscode-webview-resource:'] as const;

/** Webviews one extension may own at once, panels and views together. */
export const MAX_WEBVIEWS_PER_EXTENSION = 12;
/** Largest HTML document an extension may set. Cline's and Continue's are ~1 MB minified. */
export const MAX_WEBVIEW_HTML_CHARS = 4 * 1024 * 1024;
/** Largest single message in either direction. */
export const MAX_WEBVIEW_MESSAGE_CHARS = 1024 * 1024;
/** Largest `setState` blob retained per webview, for restoration. */
export const MAX_WEBVIEW_STATE_CHARS = 256 * 1024;
/** Local resource roots one webview may declare. */
export const MAX_LOCAL_RESOURCE_ROOTS = 32;
/** Largest file served through a webview resource URL. */
export const MAX_WEBVIEW_RESOURCE_BYTES = 64 * 1024 * 1024;
/** Resource authorization decisions cached per webview. */
export const MAX_RESOURCE_CACHE_ENTRIES = 512;
/** Panels remembered across restarts for a serializer to restore. */
export const MAX_PERSISTED_PANELS = 24;
export const MAX_VIEW_TYPE_CHARS = 128;
export const MAX_WEBVIEW_TITLE_CHARS = 200;

const TOKEN = /^[0-9a-f]{32}$/;
const NONCE = /^[A-Za-z0-9_-]{22,64}$/;
const VIEW_TYPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isWebviewToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

export function isWebviewNonce(value: unknown): value is string {
  return typeof value === 'string' && NONCE.test(value);
}

/**
 * A view type an extension may claim.
 *
 * Narrow because it is a registry key, an activation event subject (`onWebviewPanel:<type>`)
 * and part of what is written to disk for restoration — three places where a separator or a
 * control character could be spelled to look like another extension's entry.
 */
export function isWebviewViewType(value: unknown): value is string {
  return typeof value === 'string' && VIEW_TYPE.test(value);
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------
export function webviewOrigin(token: string): string {
  return `${WEBVIEW_SCHEME}://${token}`;
}

export function webviewDocumentUrl(token: string): string {
  return webviewOrigin(token) + WEBVIEW_DOCUMENT_PATH;
}

/** Normalize a filesystem path to the `/`-separated form used inside webview URLs. */
function toUrlPath(fsPath: string): string {
  return fsPath.replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * `Webview.asWebviewUri`.
 *
 * The extension calls this synchronously and expects a URL it can drop into `src=`. Because
 * the token is handed to the extension host when the webview is created, this needs no round
 * trip: the mapping is a pure function of the token and the path, and Main applies the same
 * function in reverse when the browser asks for the file. Whether the path is *allowed* is
 * decided at fetch time against `localResourceRoots`, not here — an extension can name a path
 * it may not read, and it gets a 404 rather than a lie at mint time.
 */
export function webviewResourceUrl(token: string, fsPath: string): string {
  const segments = toUrlPath(fsPath)
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment));
  return webviewOrigin(token) + WEBVIEW_RESOURCE_PREFIX + segments.join('/');
}

export type WebviewUrlTarget =
  { token: string; kind: 'document' } | { token: string; kind: 'resource'; fsPath: string };

/**
 * Recover what a webview URL is asking for.
 *
 * Anything that is not exactly the one document or one resource path is refused, so the
 * webview origin is not a general-purpose file server: no query, no fragment, no credentials,
 * no directory index, and no `..` — a traversal attempt cannot even be spelled, because every
 * segment is decoded and re-checked rather than passed through.
 */
export function parseWebviewUrl(rawUrl: string): WebviewUrlTarget | null {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 8 * 1024) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${WEBVIEW_SCHEME}:`) return null;
  if (url.username.length > 0 || url.password.length > 0 || url.port.length > 0) return null;
  if (url.search.length > 0 || url.hash.length > 0) return null;
  const token = url.hostname.toLowerCase();
  if (!isWebviewToken(token)) return null;
  const pathname = url.pathname;
  if (pathname === WEBVIEW_DOCUMENT_PATH || pathname === '/') {
    return { token, kind: 'document' };
  }
  if (!pathname.startsWith(WEBVIEW_RESOURCE_PREFIX)) return null;
  const raw = pathname.slice(WEBVIEW_RESOURCE_PREFIX.length);
  if (raw.length === 0) return null;
  const segments: string[] = [];
  for (const part of raw.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (decoded.length === 0 || decoded === '.' || decoded === '..') return null;
    if (hasControlCharacter(decoded)) return null;
    segments.push(decoded);
  }
  const first = segments[0] ?? '';
  // A Windows path arrives as its drive segment (`c:`); a POSIX path lost its leading slash to
  // the prefix and gets it back here.
  const fsPath = /^[A-Za-z]:$/.test(first) ? segments.join('/') : '/' + segments.join('/');
  return { token, kind: 'resource', fsPath };
}

/**
 * Reject C0/C1-adjacent bytes anywhere they could change how a later consumer reads a string.
 *
 * Spelled with `charCodeAt` rather than a regex literal so the guard survives every editor,
 * formatter and encoding this file passes through — the same reason `vscodeAuth.ts` checks
 * secret keys this way.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Filesystem containment
// ---------------------------------------------------------------------------
/**
 * Reduce a filesystem path to the one spelling containment checks are allowed to compare.
 *
 * Both sides of a `localResourceRoots` decision go through here, so `C:\Ext\media`, and
 * `c:/ext/./media` cannot disagree about whether a file is inside a root. `..` is resolved
 * textually and may not walk above the root of the path — a resource URL that tries is refused
 * rather than clamped, because clamping would silently turn an escape attempt into a hit.
 *
 * Returns `null` for anything that is not an absolute path: a relative path has no meaning
 * without a working directory, and guessing one is how allow-lists get bypassed.
 */
export function normalizeWebviewPath(fsPath: unknown): string | null {
  if (typeof fsPath !== 'string' || fsPath.length === 0 || fsPath.length > 4096) return null;
  if (hasControlCharacter(fsPath)) return null;
  const slashed = fsPath.replace(/\\/g, '/');
  let prefix = '';
  let rest = slashed;
  const drive = /^([A-Za-z]):/.exec(slashed);
  if (drive) {
    prefix = `${(drive[1] ?? '').toLowerCase()}:`;
    rest = slashed.slice(2);
    if (rest.length > 0 && !rest.startsWith('/')) return null;
  } else if (slashed.startsWith('//')) {
    // A UNC share keeps its double slash: `//server/share` is a different root from `/server`.
    prefix = '/';
  } else if (!slashed.startsWith('/')) {
    return null;
  }
  const segments: string[] = [];
  for (const segment of rest.split('/')) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `${prefix}/${segments.join('/')}`;
}

/**
 * `WebviewOptions.localResourceRoots`, reduced to a comparable, bounded, de-duplicated list.
 *
 * An extension may name anything; nothing here grants access. The list is only the set of
 * prefixes Main will later accept, and Main intersects it with what the extension is allowed to
 * reach in the first place (its own directory and the workspace), so a root pointing at
 * `C:/Users` still yields nothing.
 */
export function normalizeLocalResourceRoots(roots: unknown): string[] {
  if (!Array.isArray(roots)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of roots) {
    if (out.length >= MAX_LOCAL_RESOURCE_ROOTS) break;
    const raw =
      typeof entry === 'string'
        ? entry
        : entry !== null &&
            typeof entry === 'object' &&
            typeof (entry as { fsPath?: unknown }).fsPath === 'string'
          ? (entry as { fsPath: string }).fsPath
          : null;
    if (raw === null) continue;
    const normalized = normalizeWebviewPath(raw);
    if (normalized === null) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

/**
 * Is `fsPath` inside one of `roots`?
 *
 * The boundary is a separator, not a prefix: `/ext/media` contains `/ext/media/logo.png` and
 * does not contain `/ext/media-secrets/token`. Case sensitivity is a parameter rather than a
 * platform sniff so this stays pure and so the validators can exercise both behaviours.
 */
export function isPathInsideRoots(
  fsPath: unknown,
  roots: readonly string[],
  caseInsensitive: boolean,
): boolean {
  const target = normalizeWebviewPath(fsPath);
  if (target === null || roots.length === 0) return false;
  const fold = (value: string): string => (caseInsensitive ? value.toLowerCase() : value);
  const candidate = fold(target);
  for (const root of roots) {
    const normalizedRoot = normalizeWebviewPath(root);
    if (normalizedRoot === null) continue;
    const folded = fold(normalizedRoot);
    if (candidate === folded) return true;
    const boundary = folded.endsWith('/') ? folded : `${folded}/`;
    if (candidate.startsWith(boundary)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Content Security Policy
// ---------------------------------------------------------------------------
/** What `Webview.cspSource` returns: the one origin an extension's resources come from. */
export function webviewCspSource(token: string): string {
  return webviewOrigin(token);
}

export interface WebviewCspOptions {
  /** The webview's own token, which is also its origin. */
  token: string;
  /** `WebviewOptions.enableScripts`. When false, no script may execute in the frame at all. */
  enableScripts: boolean;
  /** `WebviewOptions.enableForms`. */
  enableForms: boolean;
  /** The workbench origin, the only document allowed to frame a webview. */
  workbenchOrigin: string;
}

/**
 * The policy sent as a *header* with every webview document.
 *
 * This is a floor, not the extension's policy. Two policies apply to a webview and the browser
 * enforces the intersection, so the header can only ever remove capability:
 *
 *   - The header pins the things an extension has no legitimate reason to change and that would
 *     otherwise be exploitable from injected content: no `<base>` rewriting, no plugins, no
 *     top-level form posts, and — the important one — `frame-ancestors`, so a webview document
 *     can only ever be framed by the workbench. That is what stops one extension's HTML from
 *     embedding another extension's webview and reading it through `allow-same-origin`.
 *   - The header deliberately does *not* carry a nonce for `script-src`. A nonce in the header
 *     would silently kill every inline script the extension itself wrote, because a nonce makes
 *     the browser ignore `'unsafe-inline'` in that directive. Extensions author their own
 *     `<meta http-equiv="Content-Security-Policy">` — VS Code's documented mechanism — and
 *     `patchWebviewMetaCsp` adds our bootstrap's nonce to it. Their policy is the tight one;
 *     ours cannot be tightened past it without breaking working extensions.
 *
 * `enableScripts: false` is honoured absolutely: `script-src 'none'` in the header cannot be
 * re-enabled by anything in the document.
 */
export function webviewDocumentCsp(options: WebviewCspOptions): string {
  const origin = webviewOrigin(options.token);
  const remote = ['https:', 'data:', 'blob:'];
  const local = ["'self'", origin];
  const directives: Array<[string, string[]]> = [
    ['default-src', ["'none'"]],
    ['base-uri', ["'none'"]],
    ['object-src', ["'none'"]],
    ['form-action', options.enableForms ? [...local, 'https:'] : ["'none'"]],
    ['frame-ancestors', [options.workbenchOrigin]],
    [
      'script-src',
      options.enableScripts ? [...local, "'unsafe-inline'", "'unsafe-eval'", 'blob:'] : ["'none'"],
    ],
    ['style-src', [...local, "'unsafe-inline'", 'https:', 'data:']],
    ['img-src', [...local, ...remote]],
    ['font-src', [...local, 'https:', 'data:']],
    ['media-src', [...local, ...remote]],
    ['connect-src', [...local, 'https:', 'wss:', 'data:', 'blob:', ...LOOPBACK_SOURCES]],
    ['frame-src', [...local, 'https:', ...LOOPBACK_SOURCES]],
    ['child-src', [...local, 'https:', ...LOOPBACK_SOURCES]],
    ['worker-src', [...local, 'blob:']],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}

/**
 * Loopback is reachable because AI extensions talk to a local model server (Continue's Ollama
 * default, Cline's LM Studio default). Restricted to loopback literals, so this is not a hole
 * for arbitrary plaintext traffic.
 */
const LOOPBACK_SOURCES = [
  'http://localhost:*',
  'http://127.0.0.1:*',
  'ws://localhost:*',
  'ws://127.0.0.1:*',
];

/**
 * Add `nonce-<value>` to one CSP directive's source list, but only when doing so cannot take
 * capability away from the extension.
 *
 * A nonce makes the browser ignore `'unsafe-inline'` in the same directive. So if the extension
 * already allows unrestricted inline content, our bootstrap is permitted and we must leave the
 * directive exactly as written — adding a nonce there would silently break every inline script
 * the extension wrote. Otherwise inline content is already gated on a nonce (or forbidden), and
 * adding ours grants our bootstrap alone, nothing else.
 */
function withNonce(sources: string, nonce: string): string {
  const hasUnsafeInline = /'unsafe-inline'/i.test(sources);
  const hasNonce = /'nonce-/i.test(sources);
  if (hasUnsafeInline && !hasNonce) return sources;
  if (sources.includes(`'nonce-${nonce}'`)) return sources;
  return `${sources.trim()} 'nonce-${nonce}'`;
}

/**
 * Teach an extension-authored meta CSP about our bootstrap's nonce.
 *
 * The extension's policy stays in charge of everything else. `script-src`/`style-src` are
 * derived from `default-src` when absent, because that is what the browser would have fallen
 * back to anyway — writing them out explicitly is the only way to attach a nonce to them.
 */
export function patchWebviewMetaCsp(html: string, nonce: string): string {
  if (!isWebviewNonce(nonce)) return html;
  return html.replace(
    /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi,
    (tag) =>
      tag.replace(/content\s*=\s*(?:"([^"]*)"|'([^']*)')/i, (_all, doubleQuoted, singleQuoted) => {
        const original = (doubleQuoted ?? singleQuoted ?? '') as string;
        return `content="${patchCspValue(original, nonce).replace(/"/g, '&quot;')}"`;
      }),
  );
}

/** The directive-list surgery behind `patchWebviewMetaCsp`, exported for the validators. */
export function patchCspValue(value: string, nonce: string): string {
  const parts = value
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  let sawScript = false;
  let sawStyle = false;
  const fallback = findCspSources(parts, 'default-src');
  const patched = parts.map((part) => {
    const space = part.search(/\s/);
    const name = (space === -1 ? part : part.slice(0, space)).toLowerCase();
    const sources = space === -1 ? '' : part.slice(space + 1);
    if (name === 'script-src' || name === 'script-src-elem') {
      sawScript = sawScript || name === 'script-src';
      return `${name} ${withNonce(sources, nonce)}`;
    }
    if (name === 'style-src' || name === 'style-src-elem') {
      sawStyle = sawStyle || name === 'style-src';
      return `${name} ${withNonce(sources, nonce)}`;
    }
    return part;
  });
  if (fallback !== null && !sawScript) patched.push(`script-src ${withNonce(fallback, nonce)}`);
  if (fallback !== null && !sawStyle) patched.push(`style-src ${withNonce(fallback, nonce)}`);
  return patched.join('; ');
}

/** Read one directive's source list out of an already-split policy, or `null` if absent. */
function findCspSources(parts: readonly string[], directive: string): string | null {
  for (const part of parts) {
    const space = part.search(/\s/);
    const name = (space === -1 ? part : part.slice(0, space)).toLowerCase();
    if (name === directive) return space === -1 ? '' : part.slice(space + 1);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
export type WebviewThemeKind = 'light' | 'dark' | 'high-contrast' | 'high-contrast-light';

const THEME_VARIABLE = /^--[a-z0-9-]{1,80}$/;
const THEME_BODY_CLASS: Readonly<Record<WebviewThemeKind, string>> = {
  light: 'vscode-light',
  dark: 'vscode-dark',
  'high-contrast': 'vscode-high-contrast',
  'high-contrast-light': 'vscode-high-contrast vscode-high-contrast-light',
};

export function webviewThemeBodyClass(kind: WebviewThemeKind): string {
  return THEME_BODY_CLASS[kind] ?? THEME_BODY_CLASS.dark;
}

/**
 * Filter a theme variable map down to what may be written into a stylesheet.
 *
 * Values land inside a CSS declaration block, so anything that could close that block early
 * (`;`, `{`, `}`) or open a comment or a tag is dropped rather than escaped: every legitimate
 * theme value is a colour, a length, or a font stack, and none of those need those characters.
 */
export function sanitizeWebviewThemeVariables(
  variables: unknown,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  if (variables === null || typeof variables !== 'object') return out;
  let count = 0;
  for (const [name, value] of Object.entries(variables as Record<string, unknown>)) {
    if (count >= 512) break;
    if (!THEME_VARIABLE.test(name)) continue;
    if (typeof value !== 'string' || value.length === 0 || value.length > 200) continue;
    if (hasControlCharacter(value)) continue;
    if (/[;{}<>\\]|\/\*|url\s*\(/i.test(value)) continue;
    out[name] = value;
    count += 1;
  }
  return out;
}

/** The stylesheet injected ahead of the extension's own: theme variables and VS Code defaults. */
export function buildWebviewThemeCss(
  variables: Readonly<Record<string, string>>,
  kind: WebviewThemeKind,
): string {
  const declarations = Object.entries(variables)
    .map(([name, value]) => `${name}: ${value};`)
    .join('\n  ');
  const foreground = 'var(--vscode-editor-foreground, var(--vscode-foreground, #cccccc))';
  const background = 'var(--vscode-editor-background, #1e1e1e)';
  return [
    `:root {\n  ${declarations}\n}`,
    `body { margin: 0; padding: 0 20px; color: ${foreground}; background: ${background};`,
    `  font-family: var(--vscode-font-family, system-ui); font-size: var(--vscode-font-size, 13px);`,
    `  font-weight: var(--vscode-font-weight, normal); color-scheme: ${kind === 'light' || kind === 'high-contrast-light' ? 'light' : 'dark'}; }`,
    `a { color: var(--vscode-textLink-foreground, #3794ff); }`,
    `a:hover, a:active { color: var(--vscode-textLink-activeForeground, #3794ff); }`,
    `code { font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 13px); }`,
    `:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; }`,
    `::-webkit-scrollbar { width: 10px; height: 10px; }`,
    `::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, rgba(121,121,121,0.4)); }`,
    `::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100,100,100,0.7)); }`,
  ].join('\n');
}

/**
 * Make the `codicon` font family resolvable inside a webview.
 *
 * Most extensions ship `@vscode/codicons` themselves and point at it with `asWebviewUri`, which
 * already works. This covers the other case — HTML that just writes `class="codicon codicon-x"`
 * and assumes the font is present, as it is in upstream's workbench — by registering the family
 * against the workbench's own font file. Glyph class names still come from the extension's CSS;
 * this only supplies the family, so nothing is faked.
 */
export function buildWebviewCodiconCss(fontUrl: string): string {
  return [
    `@font-face { font-family: "codicon"; font-display: block; src: url("${fontUrl.replace(/["\\]/g, '')}") format("truetype"); }`,
    `.codicon { font: normal normal normal 16px/1 codicon; display: inline-block; text-decoration: none;`,
    `  text-rendering: auto; text-align: center; text-transform: none; -webkit-font-smoothing: antialiased; user-select: none; }`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// HTML rewriting
// ---------------------------------------------------------------------------
/**
 * The URL forms extensions write for local files.
 *
 * `vscode-resource:` is the original scheme, `vscode-webview-resource://<uuid>/` the second, and
 * `https://file+.vscode-resource.vscode-cdn.net/` the current one. All three appear in shipped
 * extension HTML — some of it minified and out of the author's hands — so all three are
 * translated to this webview's own resource URL rather than left to fail as broken images.
 * Whether the file may actually be read is still decided against `localResourceRoots` in Main.
 */
const RESOURCE_URL_PATTERNS: readonly RegExp[] = [
  /vscode-webview-resource:(?:\/\/[^/"'\s>)]*)?\/([^"'\s>)]*)/gi,
  /vscode-resource:(?:\/\/[^/"'\s>)]*)?\/([^"'\s>)]*)/gi,
  /https:\/\/file\+?\.?[a-z0-9-]*\.?vscode-resource\.vscode-cdn\.net\/([^"'\s>)]*)/gi,
];

/** Rewrite every legacy resource URL in `html` onto this webview's origin. */
export function rewriteWebviewResourceUrls(html: string, token: string): string {
  let out = html;
  const prefix = webviewOrigin(token) + WEBVIEW_RESOURCE_PREFIX;
  for (const pattern of RESOURCE_URL_PATTERNS) {
    out = out.replace(pattern, (_match, path: string) => prefix + path.replace(/^\/+/, ''));
  }
  return out;
}

/** JSON that is safe to embed inside a `<script>` element. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export interface WebviewBootstrapOptions {
  /** The webview's handle, echoed on every message so the parent can attribute it. */
  handle: string;
  /** The workbench origin. Used as `postMessage`'s target origin — never `'*'`. */
  workbenchOrigin: string;
  /** The last `setState` value, so a reloaded or restored webview sees its state again. */
  state: unknown;
  /** Whether `command:` links may be forwarded at all. The allow-list is enforced by the parent. */
  enableCommandUris: boolean;
}

/**
 * The one script AXIOM injects into a webview document.
 *
 * It is the whole API surface the frame gets. There is no preload, no `require`, no `process`
 * and no Electron object in scope — the frame is ordinary web content, so `acquireVsCodeApi`
 * cannot be more than a `postMessage` wrapper, which is exactly what upstream's is too.
 *
 * Two details are worth stating because they are easy to get wrong:
 *
 *   - **Messages from the parent arrive wrapped.** Extension code expects `event.data` to be
 *     the object the extension host posted, not our envelope. The bootstrap therefore listens
 *     in the capture phase (it runs before any extension listener can be registered), calls
 *     `stopImmediatePropagation` on the envelope so no page listener ever sees it, and
 *     re-dispatches a synthetic `MessageEvent` carrying the payload alone. A re-entrancy flag
 *     keeps that synthetic event from being mistaken for another envelope.
 *   - **Clipboard access is the browser's, not ours.** `navigator.clipboard.writeText` works
 *     from a user gesture and reads are refused, matching upstream; no extra capability is
 *     handed out here, and extensions that need a read use `env.clipboard` in the host instead.
 */
export function webviewBootstrapScript(options: WebviewBootstrapOptions): string {
  return [
    '(function () {',
    '  "use strict";',
    `  var HANDLE = ${jsonForScript(options.handle)};`,
    `  var PARENT = ${jsonForScript(options.workbenchOrigin)};`,
    `  var COMMANDS = ${options.enableCommandUris ? 'true' : 'false'};`,
    `  var MAX_MESSAGE = ${MAX_WEBVIEW_MESSAGE_CHARS};`,
    `  var state = ${jsonForScript(options.state ?? null)};`,
    '  var acquired = false;',
    '  var forwarding = false;',
    '  function send(message) {',
    '    message.axiomWebview = HANDLE;',
    '    try {',
    '      window.parent.postMessage(message, PARENT);',
    '    } catch (error) {',
    '      /* The parent is gone; the webview is being torn down. */',
    '    }',
    '  }',
    '  var api = {',
    '    postMessage: function (message) {',
    '      var encoded;',
    '      try {',
    '        encoded = JSON.stringify(message === undefined ? null : message);',
    '      } catch (error) {',
    '        throw new Error("Webview messages must be JSON-serializable");',
    '      }',
    '      if (encoded.length > MAX_MESSAGE) {',
    '        throw new Error("Webview message is too large");',
    '      }',
    '      send({ kind: "message", payload: JSON.parse(encoded) });',
    '      return true;',
    '    },',
    '    getState: function () {',
    '      return state;',
    '    },',
    '    setState: function (next) {',
    '      state = next === undefined ? null : next;',
    '      var encoded;',
    '      try {',
    '        encoded = JSON.stringify(state);',
    '      } catch (error) {',
    '        return state;',
    '      }',
    '      send({ kind: "state", state: encoded });',
    '      return state;',
    '    },',
    '  };',
    '  Object.freeze(api);',
    '  Object.defineProperty(window, "acquireVsCodeApi", {',
    '    value: function acquireVsCodeApi() {',
    '      if (acquired) {',
    '        throw new Error("An instance of the VS Code API has already been acquired");',
    '      }',
    '      acquired = true;',
    '      return api;',
    '    },',
    '    writable: false,',
    '    configurable: false,',
    '  });',
    '  function deliver(payload) {',
    '    forwarding = true;',
    '    try {',
    '      window.dispatchEvent(',
    '        new MessageEvent("message", { data: payload, origin: location.origin, source: window }),',
    '      );',
    '    } finally {',
    '      forwarding = false;',
    '    }',
    '  }',
    '  function applyTheme(message) {',
    '    var variables = message.variables || {};',
    '    var root = document.documentElement;',
    '    for (var name in variables) {',
    '      if (Object.prototype.hasOwnProperty.call(variables, name)) {',
    '        try {',
    '          root.style.setProperty(name, String(variables[name]));',
    '        } catch (error) {',
    '          /* One bad value must not abandon the rest of the theme. */',
    '        }',
    '      }',
    '    }',
    '    if (typeof message.bodyClass === "string" && document.body) {',
    '      var keep = [];',
    '      var existing = document.body.className.split(/\\s+/);',
    '      for (var index = 0; index < existing.length; index += 1) {',
    '        if (existing[index] && existing[index].indexOf("vscode-") !== 0) keep.push(existing[index]);',
    '      }',
    '      document.body.className = keep.concat(message.bodyClass.split(" ")).join(" ").trim();',
    '    }',
    '    if (typeof message.themeKind === "string") {',
    '      root.setAttribute("data-vscode-theme-kind", message.bodyClass || "");',
    '      root.setAttribute("data-vscode-theme-name", message.themeName || "");',
    '    }',
    '  }',
    '  window.addEventListener(',
    '    "message",',
    '    function (event) {',
    '      if (forwarding) return;',
    '      if (event.source !== window.parent) return;',
    '      if (event.origin !== PARENT) return;',
    '      var data = event.data;',
    '      if (!data || typeof data !== "object" || data.axiomWebview !== HANDLE) return;',
    '      event.stopImmediatePropagation();',
    '      if (data.kind === "message") deliver(data.payload);',
    '      else if (data.kind === "state") state = data.state;',
    '      else if (data.kind === "theme") applyTheme(data);',
    '      else if (data.kind === "focus") {',
    '        try {',
    '          window.focus();',
    '        } catch (error) {',
    '          /* Focus is best effort. */',
    '        }',
    '      }',
    '    },',
    '    true,',
    '  );',
    '  document.addEventListener(',
    '    "click",',
    '    function (event) {',
    '      var node = event.target;',
    '      while (node && node.nodeType === 1 && String(node.tagName).toUpperCase() !== "A") {',
    '        node = node.parentNode;',
    '      }',
    '      if (!node || node.nodeType !== 1) return;',
    '      var href = node.getAttribute("href") || "";',
    '      if (href.slice(0, 8).toLowerCase() !== "command:") return;',
    '      event.preventDefault();',
    '      if (!COMMANDS) return;',
    '      send({ kind: "command", href: href.slice(0, 4096) });',
    '    },',
    '    true,',
    '  );',
    '  window.addEventListener("error", function (event) {',
    '    send({ kind: "error", message: String((event && event.message) || "error").slice(0, 500) });',
    '  });',
    '  if (document.readyState === "loading") {',
    '    document.addEventListener("DOMContentLoaded", function () {',
    '      send({ kind: "ready" });',
    '    });',
    '  } else {',
    '    send({ kind: "ready" });',
    '  }',
    '})();',
  ].join('\n');
}

export interface WebviewHtmlOptions {
  token: string;
  handle: string;
  nonce: string;
  workbenchOrigin: string;
  themeKind: WebviewThemeKind;
  themeVariables: Readonly<Record<string, string>>;
  /** The workbench's codicon font, translated to this webview's origin, or `null` if absent. */
  codiconFontUrl: string | null;
  /** The last `setState` value, replayed so a reload or a restore is invisible to the extension. */
  state: unknown;
  enableCommandUris: boolean;
}

/**
 * Turn the HTML an extension set into the document AXIOM serves.
 *
 * The extension's markup is never parsed or rebuilt — that would change working extensions in
 * ways nobody could predict. Four textual edits are made, in this order, and nothing else:
 *
 *   1. legacy `vscode-resource:` style URLs become URLs on this webview's origin;
 *   2. an extension-authored meta CSP learns our bootstrap's nonce (and only that);
 *   3. theme variables, the workbench's default styles and the bootstrap are injected at the top
 *      of `<head>`, so `acquireVsCodeApi` exists before any extension script runs;
 *   4. `<body>` gains the `vscode-dark`/`vscode-light` class extensions style against.
 *
 * A fragment with no `<head>` and no `<html>` is still handled: the injection is prepended, and
 * the browser's own parser puts it where it belongs.
 */
export function rewriteWebviewHtml(html: string, options: WebviewHtmlOptions): string {
  const source = typeof html === 'string' ? html.slice(0, MAX_WEBVIEW_HTML_CHARS) : '';
  let out = rewriteWebviewResourceUrls(source, options.token);
  out = patchWebviewMetaCsp(out, options.nonce);
  const styles =
    buildWebviewThemeCss(options.themeVariables, options.themeKind) +
    (options.codiconFontUrl === null ? '' : `\n${buildWebviewCodiconCss(options.codiconFontUrl)}`);
  const bootstrap = webviewBootstrapScript({
    handle: options.handle,
    workbenchOrigin: options.workbenchOrigin,
    state: options.state,
    enableCommandUris: options.enableCommandUris,
  });
  const injection =
    `<style nonce="${options.nonce}" data-axiom-webview="theme">\n${styles}\n</style>\n` +
    `<script nonce="${options.nonce}" data-axiom-webview="bootstrap">\n${bootstrap}\n</script>\n`;
  out = insertAfterFirst(out, /<head\b[^>]*>/i, injection);
  out = patchBodyClass(out, webviewThemeBodyClass(options.themeKind));
  return out;
}

/**
 * Insert `text` after the first match of `pattern`, falling back to `<html>` and then to the
 * start of the document. The fallbacks are why a webview that sets a bare `<div>` — several
 * status webviews do — still gets its API.
 */
function insertAfterFirst(html: string, pattern: RegExp, text: string): string {
  const head = pattern.exec(html);
  if (head !== null) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + text + html.slice(at);
  }
  const htmlTag = /<html\b[^>]*>/i.exec(html);
  if (htmlTag !== null) {
    const at = htmlTag.index + htmlTag[0].length;
    return `${html.slice(0, at)}<head>${text}</head>${html.slice(at)}`;
  }
  return text + html;
}

/** Merge the theme class into an existing `<body>` tag without disturbing its other attributes. */
function patchBodyClass(html: string, className: string): string {
  const body = /<body\b[^>]*>/i.exec(html);
  if (body === null) return html;
  const tag = body[0];
  const patched = /\bclass\s*=\s*("[^"]*"|'[^']*')/i.test(tag)
    ? tag.replace(/\bclass\s*=\s*("([^"]*)"|'([^']*)')/i, (_all, _quoted, dq, sq) => {
        const existing = ((dq ?? sq ?? '') as string).replace(/\bvscode-[\w-]+/g, '').trim();
        return `class="${existing.length > 0 ? `${existing} ` : ''}${className}"`;
      })
    : `${tag.slice(0, tag.length - 1)} class="${className}">`;
  return html.slice(0, body.index) + patched + html.slice(body.index + tag.length);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
const HANDLE = /^[0-9a-f]{16}$/;

/** A webview's identity inside the workbench. Distinct from its token, which is its origin. */
export function isWebviewHandle(value: unknown): value is string {
  return typeof value === 'string' && HANDLE.test(value);
}

export type WebviewFrameMessage =
  | { kind: 'ready' }
  | { kind: 'message'; payload: unknown }
  | { kind: 'state'; state: string | null }
  | { kind: 'command'; href: string }
  | { kind: 'error'; message: string };

/**
 * Validate one message that came out of a webview frame.
 *
 * This is the only entry point from extension-authored content into the workbench, so it is
 * closed by default: the envelope must name the handle the caller is expecting (proving the
 * message came from the frame the caller is talking to and not from a sibling webview), the kind
 * must be one of five, and every field is bounded. The origin and `event.source` checks happen
 * in the renderer before this is reached — they are properties of the DOM event, not the data,
 * and both are required.
 */
export function parseWebviewFrameMessage(
  raw: unknown,
  expectedHandle: string,
): WebviewFrameMessage | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!isWebviewHandle(expectedHandle) || record.axiomWebview !== expectedHandle) return null;
  switch (record.kind) {
    case 'ready':
      return { kind: 'ready' };
    case 'message': {
      let encoded: string;
      try {
        encoded = JSON.stringify(record.payload ?? null);
      } catch {
        return null;
      }
      if (encoded.length > MAX_WEBVIEW_MESSAGE_CHARS) return null;
      return { kind: 'message', payload: JSON.parse(encoded) as unknown };
    }
    case 'state': {
      const state = record.state;
      if (state === null || state === undefined) return { kind: 'state', state: null };
      if (typeof state !== 'string' || state.length > MAX_WEBVIEW_STATE_CHARS) return null;
      return { kind: 'state', state };
    }
    case 'command': {
      const href = record.href;
      if (typeof href !== 'string' || href.length === 0 || href.length > 4096) return null;
      if (hasControlCharacter(href)) return null;
      return { kind: 'command', href };
    }
    case 'error': {
      const message = record.message;
      if (typeof message !== 'string') return null;
      return { kind: 'error', message: message.slice(0, 500) };
    }
    default:
      return null;
  }
}

export type WebviewHostMessage =
  | { kind: 'message'; payload: unknown }
  | { kind: 'state'; state: unknown }
  | {
      kind: 'theme';
      variables: Readonly<Record<string, string>>;
      bodyClass: string;
      themeKind: WebviewThemeKind;
      themeName: string;
    }
  | { kind: 'focus' };

/** Stamp a host→frame message with the handle the bootstrap will check before accepting it. */
export function webviewHostEnvelope(
  handle: string,
  message: WebviewHostMessage,
): Record<string, unknown> {
  return { ...message, axiomWebview: handle };
}

/**
 * Bound an extension→webview `postMessage` before it leaves the host.
 *
 * Returns the re-parsed value so the object handed to the frame shares no structure with the
 * extension's, and `null` when the payload is unserializable or over budget — upstream resolves
 * `postMessage` to `false` in that case rather than throwing, which is what the caller does.
 */
export function normalizeWebviewMessagePayload(payload: unknown): { payload: unknown } | null {
  let encoded: string;
  try {
    encoded = JSON.stringify(payload ?? null);
  } catch {
    return null;
  }
  if (encoded.length > MAX_WEBVIEW_MESSAGE_CHARS) return null;
  return { payload: JSON.parse(encoded) as unknown };
}

// ---------------------------------------------------------------------------
// Command URIs
// ---------------------------------------------------------------------------
export interface WebviewCommandUri {
  command: string;
  args: unknown[];
}

/**
 * Parse a `command:` link clicked inside a webview.
 *
 * `enableCommandUris` is the extension's declaration that its own HTML uses these links; it is
 * not permission to run arbitrary workbench commands from injected markup, so the caller
 * additionally checks the command against the allow-list form of the option. Arguments are
 * JSON in the query string, exactly as upstream, and must be an array or a single value.
 */
export function parseWebviewCommandUri(href: unknown): WebviewCommandUri | null {
  if (typeof href !== 'string' || href.length === 0 || href.length > 4096) return null;
  if (hasControlCharacter(href)) return null;
  if (!/^command:/i.test(href)) return null;
  const body = href.slice('command:'.length);
  const queryAt = body.indexOf('?');
  const rawCommand = queryAt === -1 ? body : body.slice(0, queryAt);
  let command: string;
  try {
    command = decodeURIComponent(rawCommand);
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9][\w.:-]{0,199}$/.test(command)) return null;
  if (queryAt === -1) return { command, args: [] };
  let decoded: string;
  try {
    decoded = decodeURIComponent(body.slice(queryAt + 1));
  } catch {
    return null;
  }
  if (decoded.length === 0) return { command, args: [] };
  if (decoded.length > 64 * 1024) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  return { command, args: Array.isArray(parsed) ? (parsed as unknown[]) : [parsed] };
}

/** Is `command` permitted by this webview's `enableCommandUris` value? */
export function isCommandUriAllowed(
  command: string,
  enableCommandUris: boolean | readonly string[],
): boolean {
  if (enableCommandUris === false) return false;
  if (enableCommandUris === true) return true;
  return enableCommandUris.includes(command);
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
export interface WebviewContentOptions {
  enableScripts: boolean;
  enableForms: boolean;
  enableCommandUris: boolean | string[];
  /**
   * `null` means "the extension said nothing", which upstream treats as the default roots
   * (extension directory plus workspace). An empty array means "no local files at all" and is
   * therefore preserved as distinct from `null`.
   */
  localResourceRoots: string[] | null;
}

/** Coerce `WebviewOptions` from extension code into the bounded shape the host stores. */
export function sanitizeWebviewOptions(raw: unknown): WebviewContentOptions {
  const record =
    raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const enableScripts = record.enableScripts === true;
  const commandUris = record.enableCommandUris;
  let enableCommandUris: boolean | string[] = false;
  if (commandUris === true) enableCommandUris = true;
  else if (Array.isArray(commandUris)) {
    enableCommandUris = commandUris
      .filter((entry): entry is string => typeof entry === 'string' && entry.length <= 200)
      .slice(0, 200);
  }
  return {
    enableScripts,
    // Upstream defaults `enableForms` to whatever `enableScripts` is.
    enableForms: record.enableForms === undefined ? enableScripts : record.enableForms === true,
    enableCommandUris,
    localResourceRoots: Array.isArray(record.localResourceRoots)
      ? normalizeLocalResourceRoots(record.localResourceRoots)
      : null,
  };
}

export interface WebviewPanelBehaviour {
  enableFindWidget: boolean;
  retainContextWhenHidden: boolean;
}

export function sanitizeWebviewPanelOptions(raw: unknown): WebviewPanelBehaviour {
  const record = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    enableFindWidget: record.enableFindWidget === true,
    retainContextWhenHidden: record.retainContextWhenHidden === true,
  };
}

export function sanitizeWebviewTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let title = '';
  for (const char of raw.slice(0, MAX_WEBVIEW_TITLE_CHARS)) {
    title += hasControlCharacter(char) ? ' ' : char;
  }
  return title.trim();
}

/**
 * `ViewColumn`. Upstream's enum is 1-based with `-1` for "beside" and `-2` for "active"; AXIOM
 * has a single editor group per side, so anything outside the range collapses to the active one.
 */
export function sanitizeViewColumn(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return -1;
  const value = Math.trunc(raw);
  if (value === -2 || value === -1) return value;
  if (value >= 1 && value <= 9) return value;
  return -1;
}

// ---------------------------------------------------------------------------
// Frame isolation
// ---------------------------------------------------------------------------
/**
 * The `sandbox` attribute for a webview iframe.
 *
 * Only the capabilities a webview actually needs are listed, and the list shrinks with the
 * extension's own options: no scripts unless the extension asked for scripts, no forms unless it
 * asked for forms. Never present, in any configuration: `allow-top-navigation` (a webview cannot
 * move the workbench), `allow-popups` (no new windows), `allow-modals` (no `alert` deadlocks) and
 * `allow-downloads` (files leave through the host's own dialogs, which are auditable).
 *
 * `allow-same-origin` is present. Without it the frame's origin is the opaque `"null"`, every
 * webview shares that origin, `localStorage` throws, and — the decisive part — the parent cannot
 * distinguish one frame's messages from another's, because `event.origin` is `"null"` for all of
 * them. With it, each webview keeps the unique origin its token minted, which is what makes both
 * the origin check and the storage partitioning real.
 */
export function webviewSandboxAttribute(options: {
  enableScripts: boolean;
  enableForms: boolean;
}): string {
  const tokens = ['allow-same-origin', 'allow-pointer-lock'];
  if (options.enableScripts) tokens.push('allow-scripts');
  if (options.enableForms) tokens.push('allow-forms');
  return tokens.join(' ');
}

/** The `allow` attribute: a webview gets no device or payment capability at all. */
export const WEBVIEW_PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), display-capture=(), payment=(), usb=(), midi=(), hid=(), serial=(), xr-spatial-tracking=()';

// ---------------------------------------------------------------------------
// Snapshots the renderer draws from
// ---------------------------------------------------------------------------
export type WebviewKind = 'panel' | 'view';

/**
 * Everything the renderer needs to draw a webview, and nothing it does not.
 *
 * Deliberately without the HTML: the document is fetched by the frame from the webview origin,
 * so megabytes of extension markup never cross the IPC boundary and never enter the workbench's
 * own JavaScript context, where a string containing `<script>` would be one mistake away from
 * running. `htmlVersion` changes when the extension calls `set html`, which is the renderer's cue
 * to reload the frame.
 */
export interface WebviewSnapshot {
  handle: string;
  token: string;
  extensionId: string;
  displayName: string;
  kind: WebviewKind;
  viewType: string;
  title: string;
  /** A bounded `data:` URI resolved from `iconPath`, or `null`. */
  iconDataUri: string | null;
  badge: { value: number; tooltip: string } | null;
  documentUrl: string;
  origin: string;
  htmlVersion: number;
  hasHtml: boolean;
  visible: boolean;
  active: boolean;
  retainContextWhenHidden: boolean;
  enableScripts: boolean;
  enableForms: boolean;
  enableFindWidget: boolean;
  enableCommandUris: boolean;
  sandbox: string;
  viewColumn: number;
  /** A panel a serializer owns that has not been revealed yet: no frame, no cost. */
  restored: boolean;
}

// ---------------------------------------------------------------------------
// Serializer persistence
// ---------------------------------------------------------------------------
/**
 * What is written to disk for `registerWebviewPanelSerializer`.
 *
 * Only the description of a panel is persisted, never its HTML: the extension rebuilds the
 * document in `deserializeWebviewPanel`, exactly as upstream, so a stale document can never be
 * replayed into a newer extension version.
 */
export interface PersistedWebviewPanel {
  extensionId: string;
  viewType: string;
  title: string;
  /** The extension's own `setState` blob, opaque to AXIOM. */
  state: string | null;
  viewColumn: number;
  retainContextWhenHidden: boolean;
  enableScripts: boolean;
  enableForms: boolean;
  enableCommandUris: boolean;
  localResourceRoots: string[] | null;
}

export interface PersistedWebviewFile {
  version: 1;
  panels: PersistedWebviewPanel[];
}

/**
 * Read the persisted panel list back, treating the file as hostile input.
 *
 * It is JSON in the user data directory: another process can edit it, and a bad entry must cost
 * one panel rather than the whole restore. Every field is re-validated with the same functions
 * that validated it on the way in, and the list is capped.
 */
export function parsePersistedWebviewPanels(raw: unknown): PersistedWebviewPanel[] {
  const record = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (record === null || record.version !== 1 || !Array.isArray(record.panels)) return [];
  const out: PersistedWebviewPanel[] = [];
  for (const entry of record.panels) {
    if (out.length >= MAX_PERSISTED_PANELS) break;
    if (entry === null || typeof entry !== 'object') continue;
    const panel = entry as Record<string, unknown>;
    const extensionId = panel.extensionId;
    const viewType = panel.viewType;
    if (typeof extensionId !== 'string' || extensionId.length === 0 || extensionId.length > 256)
      continue;
    if (!isWebviewViewType(viewType)) continue;
    const state = panel.state;
    if (state !== null && (typeof state !== 'string' || state.length > MAX_WEBVIEW_STATE_CHARS))
      continue;
    out.push({
      extensionId,
      viewType,
      title: sanitizeWebviewTitle(panel.title),
      state: typeof state === 'string' ? state : null,
      viewColumn: sanitizeViewColumn(panel.viewColumn),
      retainContextWhenHidden: panel.retainContextWhenHidden === true,
      enableScripts: panel.enableScripts === true,
      enableForms: panel.enableForms === true,
      enableCommandUris: panel.enableCommandUris === true,
      localResourceRoots: Array.isArray(panel.localResourceRoots)
        ? normalizeLocalResourceRoots(panel.localResourceRoots)
        : null,
    });
  }
  return out;
}

export function serializePersistedWebviewPanels(
  panels: readonly PersistedWebviewPanel[],
): PersistedWebviewFile {
  return {
    version: 1,
    panels: panels.slice(0, MAX_PERSISTED_PANELS).map((panel) => ({ ...panel })),
  };
}

// ---------------------------------------------------------------------------
// Resource cache
// ---------------------------------------------------------------------------
/** Largest icon inlined into a snapshot. Panel icons are 16px; anything larger is a mistake. */
export const MAX_WEBVIEW_ICON_BYTES = 256 * 1024;

/**
 * The key an authorization decision is cached under.
 *
 * Scoped by token, so a decision made for one webview can never answer another webview's
 * request even for the same file — the roots differ per webview, and a shared key would let the
 * first webview to ask decide for everyone.
 */
export function webviewResourceCacheKey(token: string, fsPath: string): string {
  return `${token}\u0000${fsPath}`;
}

/**
 * Evict the oldest entries from an insertion-ordered cache until it fits.
 *
 * A `Map` iterates in insertion order, so this is the whole eviction policy: bounded memory per
 * webview, no timers, and nothing retained after the webview's cache is dropped on disposal.
 */
export function trimResourceCache<T>(
  cache: Map<string, T>,
  limit = MAX_RESOURCE_CACHE_ENTRIES,
): void {
  while (cache.size > limit) {
    const oldest = cache.keys().next();
    if (oldest.done === true) return;
    cache.delete(oldest.value);
  }
}
