import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WebviewSnapshot, WebviewThemeKind } from '../../../common/vscodeWebview';
import {
  WEBVIEW_PERMISSIONS_POLICY,
  parseWebviewFrameMessage,
} from '../../../common/vscodeWebview';
import { APPEARANCE_CHANGED_EVENT } from '../settings/themes';

/**
 * The window's half of the webview runtime.
 *
 * An extension's webview is a document served from its own `axiom-webview://` origin, and this
 * component is the only place in AXIOM that puts one on screen. It draws iframes from the
 * snapshots Main publishes — never from HTML, which does not cross this boundary in either
 * direction — and it is the side that can see the two facts Main cannot: which `window` a
 * message came from and what origin sent it. Both are checked here before anything is forwarded,
 * and Main validates the payload again on arrival.
 *
 * It renders as a floating pane rather than inside the editor or the sidebar, because those are
 * AXIOM's own surfaces and a webview is a guest. A hidden webview is unmounted unless the
 * extension asked for `retainContextWhenHidden`, which is the whole point of that option: with
 * it the document keeps running, without it the memory goes back.
 */
const MAX_TABS = 12;

/**
 * AXIOM design tokens → the `--vscode-*` names extension stylesheets expect.
 *
 * Extensions hard-code these variable names, so a webview that is not told about them renders
 * as unstyled black text on white inside a dark workbench. Mapping AXIOM's own tokens is what
 * makes a third-party webview look like it belongs, and it keeps the active theme — including a
 * contributed one — the single source of colour.
 */
const THEME_SOURCES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['--bg-editor', ['--vscode-editor-background', '--vscode-sideBar-background']],
  ['--bg-default', ['--vscode-panel-background', '--vscode-editorWidget-background']],
  ['--bg-raised', ['--vscode-dropdown-background', '--vscode-input-background']],
  ['--bg-hover', ['--vscode-list-hoverBackground', '--vscode-toolbar-hoverBackground']],
  ['--bg-active', ['--vscode-list-activeSelectionBackground']],
  ['--fg-default', ['--vscode-editor-foreground', '--vscode-foreground']],
  ['--fg-muted', ['--vscode-descriptionForeground', '--vscode-disabledForeground']],
  ['--border', ['--vscode-panel-border', '--vscode-widget-border']],
  ['--border-default', ['--vscode-input-border', '--vscode-dropdown-border']],
  ['--accent', ['--vscode-button-background', '--vscode-textLink-foreground']],
  ['--accent-hover', ['--vscode-button-hoverBackground', '--vscode-textLink-activeForeground']],
  ['--fg-on-accent', ['--vscode-button-foreground']],
  ['--focus-border', ['--vscode-focusBorder']],
  ['--danger', ['--vscode-errorForeground', '--vscode-inputValidation-errorBorder']],
  ['--warning', ['--vscode-editorWarning-foreground']],
  ['--info', ['--vscode-editorInfo-foreground']],
  ['--font-ui', ['--vscode-font-family']],
  ['--font-mono', ['--vscode-editor-font-family']],
];

function readThemeVariables(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const [source, targets] of THEME_SOURCES) {
    const value = style.getPropertyValue(source).trim();
    if (value.length === 0) continue;
    for (const target of targets) out[target] = value;
  }
  const fontSize = style.getPropertyValue('--font-size-base').trim();
  if (fontSize.length > 0) out['--vscode-font-size'] = fontSize;
  return out;
}

/** `#rgb`, `#rrggbb` and `rgb()/rgba()` are the forms a computed colour actually arrives in. */
function relativeLuminance(color: string): number | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  let rgb: [number, number, number] | null = null;
  if (hex) {
    const digits = hex[1] ?? '';
    const wide =
      digits.length === 3
        ? [...digits].map((digit) => `${digit}${digit}`)
        : [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 6)];
    rgb = [
      Number.parseInt(wide[0] ?? '0', 16),
      Number.parseInt(wide[1] ?? '0', 16),
      Number.parseInt(wide[2] ?? '0', 16),
    ];
  } else {
    const parts = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
    if (parts) {
      const numbers = (parts[1] ?? '')
        .split(/[\s,/]+/)
        .map((entry) => Number.parseFloat(entry))
        .filter((entry) => Number.isFinite(entry));
      if (numbers.length >= 3) rgb = [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0];
    }
  }
  if (rgb === null) return null;
  const [r, g, b] = rgb.map((channel) => channel / 255);
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/**
 * Which of the four `vscode-*` body classes this theme is.
 *
 * Measured from the editor background rather than read from a setting, because a contributed
 * theme decides its own kind and the measurement is right for both. Extensions branch on the
 * body class, so an inverted answer is visible; a missing one is not.
 */
function readThemeKind(): WebviewThemeKind {
  const style = getComputedStyle(document.documentElement);
  const background =
    style.getPropertyValue('--bg-editor').trim() || style.getPropertyValue('--bg-default').trim();
  const luminance = relativeLuminance(background);
  const light = luminance !== null && luminance > 0.5;
  const contrast = document.documentElement.classList.contains('high-contrast');
  if (contrast) return light ? 'high-contrast-light' : 'high-contrast';
  return light ? 'light' : 'dark';
}

export function WebviewLayer() {
  const [snapshots, setSnapshots] = useState<WebviewSnapshot[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const snapshotsRef = useRef<WebviewSnapshot[]>([]);

  const reload = useCallback(async () => {
    try {
      setSnapshots(await window.axiom.webview.list());
    } catch {
      setSnapshots([]);
    }
  }, []);

  useEffect(() => {
    snapshotsRef.current = snapshots;
  }, [snapshots]);

  useEffect(() => {
    void reload();
    const stop = window.axiom.webview.onChanged(() => void reload());
    // Once per window: extensions that persisted panels last session get their
    // `onWebviewPanel:` activation event. Nothing is drawn until one is actually revealed, so a
    // workspace with twenty remembered panels costs twenty titles.
    void window.axiom.webview.restore().catch(() => undefined);
    return stop;
  }, [reload]);

  useEffect(() => {
    const push = (): void => {
      void window.axiom.webview
        .theme({
          kind: readThemeKind(),
          name: document.documentElement.getAttribute('data-theme') ?? '',
          variables: readThemeVariables(),
        })
        .catch(() => undefined);
    };
    push();
    window.addEventListener(APPEARANCE_CHANGED_EVENT, push);
    return () => window.removeEventListener(APPEARANCE_CHANGED_EVENT, push);
  }, []);

  const open = useMemo(() => snapshots.slice(0, MAX_TABS), [snapshots]);
  const current = useMemo(() => {
    const chosen = selected === null ? undefined : open.find((item) => item.handle === selected);
    return (
      chosen ??
      open.find((item) => item.active) ??
      open.find((item) => item.visible) ??
      open[0] ??
      null
    );
  }, [open, selected]);
  const currentHandle = current === null ? null : current.handle;

  // One webview is on screen at a time, so this is where `onDidChangeViewState` and
  // `WebviewView.onDidChangeVisibility` come from: the renderer is the only side that knows.
  useEffect(() => {
    if (currentHandle === null) return;
    void window.axiom.webview.visibility(currentHandle, true, true).catch(() => undefined);
    for (const item of snapshotsRef.current) {
      if (item.handle !== currentHandle && (item.visible || item.active)) {
        void window.axiom.webview.visibility(item.handle, false, false).catch(() => undefined);
      }
    }
  }, [currentHandle]);

  /**
   * The frame → workbench edge, and the reason it is here rather than in Main.
   *
   * `event.source` proves which document sent the message and `event.origin` proves which origin
   * it came from; neither survives a trip through IPC. A message that fails either check, or that
   * does not parse as this webview's own envelope, is dropped without telling the sender why.
   */
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const source = event.source;
      if (source === null || source === window) return;
      let handle: string | null = null;
      for (const [key, frame] of frames.current) {
        if (frame.contentWindow !== null && frame.contentWindow === source) {
          handle = key;
          break;
        }
      }
      if (handle === null) return;
      const snapshot = snapshotsRef.current.find((item) => item.handle === handle);
      if (snapshot === undefined || event.origin !== snapshot.origin) return;
      if (parseWebviewFrameMessage(event.data, handle) === null) return;
      void window.axiom.webview.frameMessage(handle, event.data).catch(() => undefined);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Host → frame: the extension's own `postMessage`, a state echo, a theme change, a focus
  // request. Targeted at the webview's exact origin so a mis-keyed envelope reaches no one.
  useEffect(
    () =>
      window.axiom.webview.onPost((handle, envelope) => {
        const frame = frames.current.get(handle);
        const snapshot = snapshotsRef.current.find((item) => item.handle === handle);
        if (frame === undefined || snapshot === undefined) return;
        frame.contentWindow?.postMessage(envelope, snapshot.origin);
        if (envelope['kind'] === 'focus') frame.focus();
      }),
    [],
  );

  const select = useCallback((item: WebviewSnapshot) => {
    setSelected(item.handle);
    // A restored panel is a title until someone asks for it; asking is what runs the
    // extension's serializer and gives the panel its document.
    if (item.restored) void window.axiom.webview.reveal(item.handle).catch(() => undefined);
  }, []);

  if (open.length === 0) return null;

  return (
    <section className="webview-layer" aria-label="Extension webviews">
      <header className="webview-tabs" role="tablist">
        {open.map((item) => (
          <button
            key={item.handle}
            type="button"
            role="tab"
            aria-selected={item.handle === currentHandle}
            className={item.handle === currentHandle ? 'webview-tab active' : 'webview-tab'}
            title={`${item.displayName}${item.title.length > 0 ? ` — ${item.title}` : ''}`}
            onClick={() => select(item)}
          >
            {item.iconDataUri === null ? null : (
              <img className="webview-tab-icon" src={item.iconDataUri} alt="" />
            )}
            <span className="webview-tab-label">
              {item.title.length > 0 ? item.title : item.displayName}
            </span>
            {item.badge === null ? null : (
              <span className="webview-tab-badge" title={item.badge.tooltip}>
                {item.badge.value}
              </span>
            )}
          </button>
        ))}
        <button
          type="button"
          className="icon-btn webview-close"
          aria-label="Close this webview"
          disabled={currentHandle === null}
          onClick={() => {
            if (currentHandle !== null) {
              void window.axiom.webview.close(currentHandle).catch(() => undefined);
            }
          }}
        >
          ×
        </button>
      </header>
      {renderBody(open, currentHandle, frames)}
    </section>
  );
}

/**
 * The frames themselves.
 *
 * Three states, and the difference between them is memory. The webview on screen has a frame. A
 * hidden one keeps its frame only if the extension asked for `retainContextWhenHidden`, which is
 * what that option buys: its scripts keep running and its scroll position survives. Everything
 * else is unmounted, so a webview nobody is looking at costs a row in a map.
 *
 * The `key` carries the document version, so `setHtml` replaces the frame rather than reusing a
 * document that has already run the previous script.
 */
function renderBody(
  open: readonly WebviewSnapshot[],
  currentHandle: string | null,
  frames: { current: Map<string, HTMLIFrameElement> },
) {
  return (
    <div className="webview-body">
      {open.map((item) => {
        const isCurrent = item.handle === currentHandle;
        if (item.restored || !item.hasHtml) {
          return isCurrent ? (
            <p key={item.handle} className="webview-empty">
              {item.displayName} has not rendered anything yet.
            </p>
          ) : null;
        }
        if (!isCurrent && !item.retainContextWhenHidden) return null;
        return (
          <iframe
            key={`${item.handle}:${String(item.htmlVersion)}`}
            className={isCurrent ? 'webview-frame' : 'webview-frame hidden'}
            title={item.title.length > 0 ? item.title : item.displayName}
            src={item.documentUrl}
            sandbox={item.sandbox}
            allow={WEBVIEW_PERMISSIONS_POLICY}
            ref={(node) => {
              if (node === null) frames.current.delete(item.handle);
              else frames.current.set(item.handle, node);
            }}
          />
        );
      })}
    </div>
  );
}
