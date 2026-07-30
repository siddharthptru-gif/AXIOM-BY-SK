/**
 * VS Code colour theme conversion.
 *
 * A VS Code theme is two independent things wearing one file: a `colors` map that paints
 * the workbench, and a `tokenColors` list of TextMate scope rules that paints code. AXIOM
 * needs both, expressed in its own vocabulary — CSS custom properties for the chrome, and
 * Monaco token rules for the editor.
 *
 * The hard part is not translation, it is absence. Real themes define anywhere from ten to
 * two hundred colour keys, and a theme that omits `sideBar.background` still has to
 * produce a sidebar that looks deliberate. So every AXIOM token is resolved in three
 * stages: an explicit key if the theme sets one, then a documented VS Code fallback chain,
 * then a value *derived* from the theme's own base colours by mixing toward its light or
 * dark pole. The result is a complete token set from an incomplete theme, and it stays
 * recognisably the author's palette rather than AXIOM's defaults leaking through.
 *
 * Pure: colour maths only, no I/O.
 *
 * (`theme.ts` carries an older ten-key `importVsCodeTheme` from an earlier phase. It maps
 * a fraction of this and ignores `tokenColors` entirely; this module supersedes it.)
 */
import { parseHexColor, relativeLuminance, type Rgb } from './theme';

export type ThemeKind = 'dark' | 'light';

export interface MonacoTokenRule {
  /** TextMate scope, e.g. `comment.line`. Empty string is the default rule. */
  token: string;
  foreground?: string;
  fontStyle?: string;
}

export interface ConvertedTheme {
  /** The theme's own display name, or the contribution label when it omits one. */
  label: string;
  kind: ThemeKind;
  /** AXIOM design tokens: CSS custom property name -> colour value. */
  tokens: Record<string, string>;
  /** Accent trio derived from the theme's own interactive colours. */
  accent: { accent: string; accentHover: string; accentPress: string; accentSoft: string; onAccent: string };
  /** Monaco editor token rules built from `tokenColors`. */
  rules: MonacoTokenRule[];
  /** Monaco base to layer on, chosen from the resolved kind. */
  base: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
  /** Editor-surface colours Monaco needs by name rather than as CSS. */
  editorColors: Record<string, string>;
  /** Keys the theme defined that this converter does not consume. Diagnostic only. */
  unusedColorKeys: number;
}

const MAX_COLOR_KEYS = 1_000;
const MAX_TOKEN_RULES = 2_000;
const MAX_SCOPES_PER_RULE = 100;

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------
function toHex(rgb: Rgb): string {
  const part = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`;
}

/** Alpha from an `#rrggbbaa` value, or 1 when the colour is opaque or invalid. */
function alphaOf(input: string): number {
  const raw = input.trim().replace(/^#/, '');
  if (raw.length !== 8) return 1;
  const alpha = Number.parseInt(raw.slice(6, 8), 16);
  return Number.isFinite(alpha) ? alpha / 255 : 1;
}

/** Mix two colours; `amount` is how much of `b` to take. */
function mix(a: Rgb, b: Rgb, amount: number): Rgb {
  const t = Math.max(0, Math.min(1, amount));
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

const BLACK: Rgb = { r: 0, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };

/** Move a colour away from the background pole: darker on dark themes, lighter on light. */
function lift(base: Rgb, kind: ThemeKind, amount: number): Rgb {
  return mix(base, kind === 'dark' ? WHITE : BLACK, amount);
}

/** Move a colour toward the background pole. */
function sink(base: Rgb, kind: ThemeKind, amount: number): Rgb {
  return mix(base, kind === 'dark' ? BLACK : WHITE, amount);
}

// ---------------------------------------------------------------------------
// Theme reading
// ---------------------------------------------------------------------------
interface ColorLookup {
  /** Opaque hex for a key, following the fallback chain. Null when nothing resolves. */
  hex: (keys: readonly string[]) => string | null;
  /** `rgba(...)` preserving alpha, for tokens that are meant to be translucent. */
  rgba: (keys: readonly string[]) => string | null;
  defined: Set<string>;
  used: Set<string>;
}

function readColors(raw: unknown): ColorLookup {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  const colors = new Map<string, string>();
  for (const [key, value] of Object.entries(source).slice(0, MAX_COLOR_KEYS)) {
    if (typeof value !== 'string') continue;
    if (parseHexColor(value) === null) continue;
    colors.set(key, value.trim());
  }
  const used = new Set<string>();
  const find = (keys: readonly string[]): { key: string; value: string } | null => {
    for (const key of keys) {
      const value = colors.get(key);
      if (value !== undefined) {
        used.add(key);
        return { key, value };
      }
    }
    return null;
  };
  return {
    hex: (keys) => {
      const found = find(keys);
      if (!found) return null;
      const rgb = parseHexColor(found.value);
      return rgb === null ? null : toHex(rgb);
    },
    rgba: (keys) => {
      const found = find(keys);
      if (!found) return null;
      const rgb = parseHexColor(found.value);
      if (rgb === null) return null;
      const alpha = alphaOf(found.value);
      return alpha >= 1
        ? toHex(rgb)
        : `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}, ${alpha.toFixed(3)})`;
    },
    defined: new Set(colors.keys()),
    used,
  };
}

/**
 * Decide whether a theme is light or dark.
 *
 * The declared `uiTheme` from the manifest contribution is authoritative and comes first,
 * because theme files frequently omit their own `type` — Dracula does. When neither is
 * present, the editor background's luminance decides, which is the only signal left and
 * the one that actually determines legibility.
 */
export function resolveThemeKind(
  themeJson: unknown,
  uiTheme: string | undefined,
): { kind: ThemeKind; base: ConvertedTheme['base'] } {
  if (uiTheme === 'vs') return { kind: 'light', base: 'vs' };
  if (uiTheme === 'hc-light') return { kind: 'light', base: 'hc-light' };
  if (uiTheme === 'hc-black') return { kind: 'dark', base: 'hc-black' };
  if (uiTheme === 'vs-dark') return { kind: 'dark', base: 'vs-dark' };
  const record = themeJson && typeof themeJson === 'object' ? (themeJson as Record<string, unknown>) : {};
  if (record.type === 'light') return { kind: 'light', base: 'vs' };
  if (record.type === 'dark') return { kind: 'dark', base: 'vs-dark' };
  if (record.type === 'hc' || record.type === 'hcDark') return { kind: 'dark', base: 'hc-black' };
  const colors = record.colors && typeof record.colors === 'object'
    ? (record.colors as Record<string, unknown>)
    : {};
  const background = typeof colors['editor.background'] === 'string'
    ? parseHexColor(colors['editor.background'])
    : null;
  if (background && relativeLuminance(background) > 0.4) return { kind: 'light', base: 'vs' };
  return { kind: 'dark', base: 'vs-dark' };
}

// ---------------------------------------------------------------------------
// tokenColors -> Monaco rules
// ---------------------------------------------------------------------------
/**
 * Normalize a `tokenColors` entry.
 *
 * `scope` may be a single string, a comma-separated string, or an array; each scope
 * becomes its own Monaco rule because Monaco matches one scope per rule. A rule with no
 * usable foreground and no font style is dropped rather than emitted as a no-op.
 */
function tokenRulesFrom(raw: unknown): MonacoTokenRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: MonacoTokenRule[] = [];
  for (const item of raw.slice(0, MAX_TOKEN_RULES)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const settings = entry.settings && typeof entry.settings === 'object'
      ? (entry.settings as Record<string, unknown>)
      : null;
    if (!settings) continue;
    const foregroundRaw = typeof settings.foreground === 'string' ? settings.foreground : null;
    const foregroundRgb = foregroundRaw === null ? null : parseHexColor(foregroundRaw);
    // Monaco rejects alpha in token colours, so it is dropped rather than passed through
    // and silently ignored.
    const foreground = foregroundRgb === null ? null : toHex(foregroundRgb).slice(1);
    const fontStyleRaw = typeof settings.fontStyle === 'string' ? settings.fontStyle.trim() : '';
    const fontStyle = fontStyleRaw
      .split(/\s+/)
      .filter((style) => style === 'italic' || style === 'bold' || style === 'underline')
      .join(' ');
    if (foreground === null && fontStyle === '') continue;

    const scopes: string[] = [];
    if (typeof entry.scope === 'string') {
      for (const scope of entry.scope.split(',')) {
        const trimmed = scope.trim();
        if (trimmed.length > 0) scopes.push(trimmed);
      }
    } else if (Array.isArray(entry.scope)) {
      for (const scope of entry.scope.slice(0, MAX_SCOPES_PER_RULE)) {
        if (typeof scope === 'string' && scope.trim().length > 0) scopes.push(scope.trim());
      }
    } else {
      // A rule with no scope is the theme's default text style.
      scopes.push('');
    }
    for (const token of scopes) {
      rules.push({
        token,
        ...(foreground !== null ? { foreground } : {}),
        ...(fontStyle !== '' ? { fontStyle } : {}),
      });
      if (rules.length >= MAX_TOKEN_RULES) break;
    }
    if (rules.length >= MAX_TOKEN_RULES) break;
  }
  return rules;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------
/**
 * Convert a parsed VS Code theme file into AXIOM tokens, an accent, and Monaco rules.
 *
 * `uiTheme` and `label` come from the manifest contribution, which is the only place a
 * theme's light/dark intent is reliably declared.
 */
export function convertVsCodeTheme(
  themeJson: unknown,
  options: { label: string; uiTheme?: string },
): ConvertedTheme | null {
  const record = themeJson && typeof themeJson === 'object' && !Array.isArray(themeJson)
    ? (themeJson as Record<string, unknown>)
    : null;
  if (!record) return null;

  const { kind, base } = resolveThemeKind(record, options.uiTheme);
  const colors = readColors(record.colors);
  const rules = tokenRulesFrom(record.tokenColors);
  // A file with neither workbench colours nor token rules is not a usable theme.
  if (colors.defined.size === 0 && rules.length === 0) return null;

  const editorBackgroundHex =
    colors.hex(['editor.background']) ?? (kind === 'dark' ? '#1e1e1e' : '#ffffff');
  const editorForegroundHex =
    colors.hex(['editor.foreground', 'foreground']) ?? (kind === 'dark' ? '#d4d4d4' : '#333333');
  const bg = parseHexColor(editorBackgroundHex) ?? BLACK;
  const fg = parseHexColor(editorForegroundHex) ?? WHITE;

  /** Resolve a background token: explicit key, else derived from the editor background. */
  const background = (keys: readonly string[], derive: number): string =>
    colors.hex(keys) ?? toHex(derive >= 0 ? lift(bg, kind, derive) : sink(bg, kind, -derive));

  /** Resolve a foreground token: explicit key, else the editor foreground faded back. */
  const foreground = (keys: readonly string[], fade: number): string =>
    colors.hex(keys) ?? toHex(mix(fg, bg, fade));

  const tokens: Record<string, string> = {
    // Surfaces, from furthest-back to furthest-forward.
    '--bg-void': background(['titleBar.activeBackground', 'activityBar.background'], -0.35),
    '--bg-canvas': background(['sideBar.background', 'activityBar.background'], -0.15),
    '--bg-editor': editorBackgroundHex,
    '--bg-surface': background(['sideBar.background', 'panel.background'], 0.04),
    '--bg-raised': background(['panel.background', 'editorWidget.background'], 0.07),
    '--bg-overlay': background(['editorWidget.background', 'quickInput.background', 'menu.background'], 0.1),
    '--bg-overlay-strong': background(['quickInput.background', 'dropdown.background'], 0.14),
    '--bg-hover':
      colors.rgba(['list.hoverBackground', 'toolbar.hoverBackground']) ??
      (kind === 'dark' ? 'rgba(255, 255, 255, 0.07)' : 'rgba(0, 0, 0, 0.05)'),
    '--bg-active':
      colors.rgba(['list.activeSelectionBackground', 'list.inactiveSelectionBackground']) ??
      (kind === 'dark' ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.09)'),
    '--bg-scrim': kind === 'dark' ? 'rgba(0, 0, 0, 0.72)' : 'rgba(30, 30, 30, 0.34)',

    // Foreground ramp. Each step fades further toward the background.
    '--fg-max': foreground(['editor.foreground'], -0.15),
    '--fg-strong': foreground(['editor.foreground', 'foreground'], 0),
    '--fg-default': editorForegroundHex,
    '--fg-muted': foreground(['descriptionForeground', 'sideBar.foreground'], 0.25),
    '--fg-subtle': foreground(['disabledForeground', 'editorLineNumber.foreground'], 0.4),
    '--fg-faint': foreground(['editorLineNumber.foreground', 'disabledForeground'], 0.5),

    // Borders.
    '--border-subtle': background(['panel.border', 'editorGroup.border'], 0.12),
    '--border': colors.hex(['panel.border', 'editorWidget.border', 'contrastBorder']) ??
      toHex(lift(bg, kind, 0.18)),
    '--border-strong': colors.hex(['contrastBorder', 'focusBorder']) ?? toHex(lift(bg, kind, 0.3)),

    // Status colours.
    '--info': colors.hex(['editorInfo.foreground', 'notificationsInfoIcon.foreground']) ??
      (kind === 'dark' ? '#7FB0FF' : '#1F6FEB'),
    '--success': colors.hex(['gitDecoration.addedResourceForeground', 'testing.iconPassed', 'charts.green']) ??
      (kind === 'dark' ? '#63CE90' : '#1A7F37'),
    '--warning': colors.hex(['editorWarning.foreground', 'notificationsWarningIcon.foreground', 'charts.yellow']) ??
      (kind === 'dark' ? '#E6C36A' : '#9A6700'),
    '--danger': colors.hex(['editorError.foreground', 'errorForeground', 'charts.red']) ??
      (kind === 'dark' ? '#F58494' : '#D1242F'),
  };

  // Text placed on top of a status colour has to be legible against it, so the pole is
  // chosen by the status colour's own luminance rather than by the theme's kind.
  const onColor = (value: string): string => {
    const rgb = parseHexColor(value);
    if (rgb === null) return '#000000';
    return relativeLuminance(rgb) > 0.45 ? '#12121A' : '#FFFFFF';
  };
  const dangerToken = tokens['--danger'] ?? '#F58494';
  const warningToken = tokens['--warning'] ?? '#E6C36A';
  const subtleToken = tokens['--fg-subtle'] ?? '#9B93C2';
  tokens['--fg-on-danger'] = onColor(dangerToken);
  tokens['--fg-on-warning'] = onColor(warningToken);
  tokens['--fg-on-subtle'] = onColor(subtleToken);
  tokens['--ai'] =
    colors.hex(['symbolIcon.functionForeground', 'textLink.foreground', 'charts.purple']) ??
    (kind === 'dark' ? '#C6B7F0' : '#6E40C9');
  tokens['--warning-soft'] = translucent(warningToken, 0.16);

  const accentBase =
    colors.hex(['button.background', 'focusBorder', 'textLink.foreground', 'progressBar.background']) ??
    (kind === 'dark' ? '#7FB0FF' : '#1F6FEB');
  const accentRgb = parseHexColor(accentBase) ?? { r: 127, g: 176, b: 255 };
  const accent = {
    accent: accentBase,
    accentHover: colors.hex(['button.hoverBackground']) ?? toHex(lift(accentRgb, kind, 0.12)),
    accentPress: toHex(sink(accentRgb, kind, 0.14)),
    accentSoft: translucent(accentBase, 0.16),
    onAccent: colors.hex(['button.foreground']) ?? onColor(accentBase),
  };

  /**
   * Monaco reads its surface colours by name, not from CSS, so the ones it needs are
   * passed through explicitly. Only opaque values are forwarded: Monaco's theme
   * validation rejects several of these with alpha.
   */
  const editorColors: Record<string, string> = {
    'editor.background': editorBackgroundHex,
    'editor.foreground': editorForegroundHex,
  };
  for (const key of [
    'editor.lineHighlightBackground',
    'editor.selectionBackground',
    'editor.inactiveSelectionBackground',
    'editorCursor.foreground',
    'editorLineNumber.foreground',
    'editorLineNumber.activeForeground',
    'editorIndentGuide.background',
    'editorWhitespace.foreground',
    'editorGutter.background',
    'editorBracketMatch.background',
    'editorBracketMatch.border',
  ]) {
    const value = colors.hex([key]);
    if (value !== null) editorColors[key] = value;
  }

  const label =
    typeof record.name === 'string' && record.name.trim().length > 0
      ? record.name.trim().slice(0, 200)
      : options.label;

  return {
    label,
    kind,
    tokens,
    accent,
    rules,
    base,
    editorColors,
    unusedColorKeys: colors.defined.size - colors.used.size,
  };
}

/** An `rgba()` string at a fixed alpha, for the soft/tinted tokens. */
function translucent(hex: string, alpha: number): string {
  const rgb = parseHexColor(hex);
  if (rgb === null) return `rgba(255, 255, 255, ${alpha})`;
  return `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}, ${alpha})`;
}

/**
 * Merge a theme file with the one it extends via `include`.
 *
 * Themes routinely ship a base file plus a thin override — `include` is how VS Code
 * expresses that, and ignoring it produces a theme missing most of its colours. The child
 * wins key by key; `tokenColors` concatenate with the child last, which is the precedence
 * Monaco applies when two rules match the same scope.
 */
export function mergeIncludedTheme(base: unknown, child: unknown): unknown {
  const baseRecord = base && typeof base === 'object' && !Array.isArray(base)
    ? (base as Record<string, unknown>)
    : {};
  const childRecord = child && typeof child === 'object' && !Array.isArray(child)
    ? (child as Record<string, unknown>)
    : {};
  const baseColors = baseRecord.colors && typeof baseRecord.colors === 'object' ? baseRecord.colors : {};
  const childColors = childRecord.colors && typeof childRecord.colors === 'object' ? childRecord.colors : {};
  const baseTokens = Array.isArray(baseRecord.tokenColors) ? baseRecord.tokenColors : [];
  const childTokens = Array.isArray(childRecord.tokenColors) ? childRecord.tokenColors : [];
  return {
    ...baseRecord,
    ...childRecord,
    colors: { ...(baseColors as object), ...(childColors as object) },
    tokenColors: [...baseTokens, ...childTokens],
  };
}
