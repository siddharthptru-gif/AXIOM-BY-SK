/**
 * Color theme + contrast core (PRD Epoch I §154.7 / Phases 247 + 255). Pure color
 * math: parse hex, WCAG relative luminance + contrast ratio + AA/AAA level (the
 * "contrast linter"), validate a theme's colors, import a VS Code color theme into
 * Axiom tokens, and check a theme's key foreground/background pairs. No I/O — the
 * renderer's ThemeController + settings use these. Smoke-tested.
 */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parse `#rgb`, `#rrggbb`, or `#rrggbbaa` (alpha ignored) into 0–255 RGB, or null. */
export function parseHexColor(input: string): Rgb | null {
  const s = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    const r = parseInt(s[0]! + s[0]!, 16);
    const g = parseInt(s[1]! + s[1]!, 16);
    const b = parseInt(s[2]! + s[2]!, 16);
    return { r, g, b };
  }
  if (/^[0-9a-fA-F]{6}$/.test(s) || /^[0-9a-fA-F]{8}$/.test(s)) {
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16),
    };
  }
  return null;
}

/** Whether a string is a valid hex color. */
export function isHexColor(input: string): boolean {
  return parseHexColor(input) !== null;
}

function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance (0..1) of an RGB color. */
export function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * channelLuminance(rgb.r) +
    0.7152 * channelLuminance(rgb.g) +
    0.0722 * channelLuminance(rgb.b)
  );
}

/** WCAG contrast ratio (1..21) between two colors. Returns 1 if either is invalid. */
export function contrastRatio(fg: string, bg: string): number {
  const f = parseHexColor(fg);
  const b = parseHexColor(bg);
  if (!f || !b) return 1;
  const lf = relativeLuminance(f);
  const lb = relativeLuminance(b);
  const lighter = Math.max(lf, lb);
  const darker = Math.min(lf, lb);
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

export type WcagLevel = 'AAA' | 'AA' | 'fail';

/** WCAG 2.1 level for a contrast ratio (large text uses the relaxed thresholds). */
export function wcagLevel(ratio: number, largeText = false): WcagLevel {
  if (largeText) {
    if (ratio >= 4.5) return 'AAA';
    if (ratio >= 3) return 'AA';
    return 'fail';
  }
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  return 'fail';
}

/** Whether a foreground/background pair meets WCAG AA. */
export function meetsAA(fg: string, bg: string, largeText = false): boolean {
  return wcagLevel(contrastRatio(fg, bg), largeText) !== 'fail';
}

/** Validate a map of token→color: all values must be valid hex. Returns invalid keys. */
export function validateThemeColors(colors: Record<string, string>): {
  ok: boolean;
  invalid: string[];
} {
  const invalid = Object.entries(colors)
    .filter(([, v]) => !isHexColor(v))
    .map(([k]) => k);
  return { ok: invalid.length === 0, invalid };
}

// VS Code theme `colors` keys → Axiom design tokens (a curated subset).
const VSCODE_TOKEN_MAP: Record<string, string> = {
  'editor.background': '--bg-canvas',
  'editorWidget.background': '--bg-surface',
  'sideBar.background': '--bg-surface',
  'panel.background': '--bg-raised',
  'editor.foreground': '--fg-default',
  descriptionForeground: '--fg-muted',
  disabledForeground: '--fg-subtle',
  focusBorder: '--accent',
  'panel.border': '--border',
  errorForeground: '--danger',
};

export interface ImportedTheme {
  name: string;
  kind: 'dark' | 'light';
  tokens: Record<string, string>;
}

/**
 * Import a VS Code color theme (its parsed JSON) into Axiom tokens. Maps a curated
 * subset of `colors` keys; ignores hex values with alpha issues; returns null when
 * there is nothing usable.
 */
export function importVsCodeTheme(json: unknown): ImportedTheme | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  const colors = o.colors;
  if (!colors || typeof colors !== 'object') return null;
  const src = colors as Record<string, unknown>;
  const tokens: Record<string, string> = {};
  for (const [vsKey, token] of Object.entries(VSCODE_TOKEN_MAP)) {
    const v = src[vsKey];
    if (typeof v === 'string' && isHexColor(v)) tokens[token] = v.trim();
  }
  if (Object.keys(tokens).length === 0) return null;
  const name =
    typeof o.name === 'string' && o.name.trim().length > 0 ? o.name.trim() : 'Imported theme';
  const kind: 'dark' | 'light' = o.type === 'light' ? 'light' : 'dark';
  return { name, kind, tokens };
}

export interface ContrastIssue {
  pair: string;
  ratio: number;
  level: WcagLevel;
}

/**
 * Check a theme's key foreground/background pairs against WCAG AA (the contrast
 * linter for Phase 247's "contrast validated"). Returns the pairs that fail AA.
 */
export function checkThemeContrast(
  tokens: Record<string, string>,
  accent: string,
  onAccent?: string,
  interaction?: { hover: string; press: string },
): ContrastIssue[] {
  const bgCanvas = tokens['--bg-canvas'] ?? '#000000';
  const bgSurface = tokens['--bg-surface'] ?? bgCanvas;
  const resolvedOnAccent = onAccent ?? tokens['--fg-on-accent'] ?? '#17141f';
  const danger = tokens['--danger'] ?? '#f0808b';
  const onDanger = tokens['--fg-on-danger'] ?? '#211015';
  const warning = tokens['--warning'] ?? '#ddb667';
  const onWarning = tokens['--fg-on-warning'] ?? '#15141d';
  const subtle = tokens['--fg-subtle'] ?? '#918ba2';
  const onSubtle = tokens['--fg-on-subtle'] ?? '#15141d';
  const pairs: Array<{ pair: string; fg: string; bg: string }> = [
    { pair: 'fg-default on bg-canvas', fg: tokens['--fg-default'] ?? '#ffffff', bg: bgCanvas },
    { pair: 'fg-muted on bg-surface', fg: tokens['--fg-muted'] ?? '#ffffff', bg: bgSurface },
    { pair: 'fg-faint on bg-surface', fg: tokens['--fg-faint'] ?? '#928ca0', bg: bgSurface },
    { pair: 'accent on bg-surface', fg: accent, bg: bgSurface },
    { pair: 'fg-on-accent on accent', fg: resolvedOnAccent, bg: accent },
    { pair: 'fg-on-danger on danger', fg: onDanger, bg: danger },
    { pair: 'fg-on-warning on warning', fg: onWarning, bg: warning },
    { pair: 'fg-on-subtle on fg-subtle', fg: onSubtle, bg: subtle },
    ...(interaction
      ? [
          { pair: 'fg-on-accent on accent-hover', fg: resolvedOnAccent, bg: interaction.hover },
          { pair: 'fg-on-accent on accent-press', fg: resolvedOnAccent, bg: interaction.press },
        ]
      : []),
  ];
  const issues: ContrastIssue[] = [];
  for (const p of pairs) {
    const ratio = contrastRatio(p.fg, p.bg);
    const level = wcagLevel(ratio);
    if (level === 'fail') issues.push({ pair: p.pair, ratio, level });
  }
  return issues;
}
