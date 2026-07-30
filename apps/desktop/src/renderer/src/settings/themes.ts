import type { TitleBarOverlayAppearance } from '../../../common/ipc';
import type { ConvertedTheme } from '../../../common/vscodeTheme';

/**
 * Color themes + accent presets (PRD Part IX §154). Themes override the color
 * design tokens at runtime by setting CSS custom properties on the document root;
 * structural tokens (radius, spacing, typography, chrome sizing) stay in tokens.css.
 * The dark values in :root act as a pre-JS fallback so there is no flash.
 */
export type ThemeId =
  | 'axiom-royal'
  | 'axiom-royal-light'
  | 'axiom-dark'
  | 'axiom-light'
  | 'axiom-midnight'
  | 'axiom-high-contrast';
export type AccentId =
  'gold' | 'sapphire' | 'emerald' | 'mono' | 'violet' | 'blue' | 'green' | 'amber' | 'rose';

/**
 * Corner rounding is the one structural token worth exposing: it changes the whole
 * product's character (regal and soft vs technical and sharp) without touching
 * spacing or type, so it cannot break layout.
 */
export type CornerStyle = 'sharp' | 'soft' | 'round';

export const CORNER_STYLES: Record<CornerStyle, Record<string, string>> = {
  sharp: { '--radius-sm': '2px', '--radius-md': '3px', '--radius-lg': '4px' },
  soft: { '--radius-sm': '4px', '--radius-md': '6px', '--radius-lg': '8px' },
  round: { '--radius-sm': '7px', '--radius-md': '10px', '--radius-lg': '14px' },
};

const CORNER_IDS: readonly CornerStyle[] = ['sharp', 'soft', 'round'];

export function coerceCornerStyle(value: unknown): CornerStyle {
  return typeof value === 'string' && (CORNER_IDS as readonly string[]).includes(value)
    ? (value as CornerStyle)
    : 'soft';
}

export const APPEARANCE_CHANGED_EVENT = 'axiom:appearance-changed';

export interface Theme {
  label: string;
  kind: 'dark' | 'light';
  tokens: Record<string, string>;
}

export interface Accent {
  accent: string;
  accentHover: string;
  accentPress: string;
  accentSoft: string;
  onAccent: string;
}

/**
 * The default. A deep royal indigo canvas with a gold-leaning active state — regal
 * without being loud, and dark enough that syntax colour carries the emphasis.
 * Every foreground/background pair here clears WCAG AA against the canvas.
 */
const AXIOM_ROYAL: Theme = {
  label: 'Royal Indigo',
  kind: 'dark',
  tokens: {
    '--bg-void': '#100C24',
    '--bg-canvas': '#171233',
    '--bg-editor': '#1B1539',
    '--bg-surface': '#211A45',
    '--bg-raised': '#281F52',
    '--bg-overlay': '#302562',
    '--bg-overlay-strong': '#3A2D74',
    '--bg-hover': 'rgba(226, 214, 255, 0.07)',
    '--bg-active': 'rgba(217, 180, 90, 0.16)',
    '--bg-scrim': 'rgba(8, 6, 20, 0.78)',
    '--fg-faint': '#9088B8',
    '--fg-subtle': '#9B93C2',
    '--fg-muted': '#BDB5DC',
    '--fg-default': '#E4DEF7',
    '--fg-strong': '#F4F0FF',
    '--fg-max': '#FCFAFF',
    '--border-subtle': '#2A2153',
    '--border': '#372C68',
    '--border-strong': '#4E3F8C',
    '--info': '#7FB0FF',
    '--success': '#63CE90',
    '--warning': '#E6C36A',
    '--danger': '#F58494',
    '--fg-on-danger': '#24101A',
    '--fg-on-warning': '#171233',
    '--fg-on-subtle': '#171233',
    '--ai': '#C6B7F0',
    '--warning-soft': 'rgba(230, 195, 106, 0.16)',
  },
};

/** The daylight counterpart: warm ivory paper with royal-violet ink. */
const AXIOM_ROYAL_LIGHT: Theme = {
  label: 'Royal Indigo Light',
  kind: 'light',
  tokens: {
    '--bg-void': '#E7E1F5',
    '--bg-canvas': '#F6F2FF',
    '--bg-editor': '#FDFCFF',
    '--bg-surface': '#EFEAFB',
    '--bg-raised': '#FAF8FF',
    '--bg-overlay': '#E6DFF7',
    '--bg-overlay-strong': '#D8CFEE',
    '--bg-hover': 'rgba(52, 34, 96, 0.06)',
    '--bg-active': 'rgba(122, 78, 8, 0.12)',
    '--bg-scrim': 'rgba(26, 19, 48, 0.36)',
    '--fg-faint': '#6B6288',
    '--fg-subtle': '#665D86',
    '--fg-muted': '#564E76',
    '--fg-default': '#2E2650',
    '--fg-strong': '#1F1840',
    '--fg-max': '#150F30',
    '--border-subtle': '#E0D8F2',
    '--border': '#C8BEE2',
    '--border-strong': '#A79BC8',
    '--info': '#2A5EAE',
    '--success': '#23724A',
    '--warning': '#8A5B0D',
    '--danger': '#B4324A',
    '--fg-on-danger': '#FFFFFF',
    '--fg-on-warning': '#FFFFFF',
    '--fg-on-subtle': '#FFFFFF',
    '--ai': '#5B4B8A',
    '--warning-soft': 'rgba(138, 91, 13, 0.14)',
  },
};

const AXIOM_DARK: Theme = {
  label: 'Royal Graphite',
  kind: 'dark',
  tokens: {
    '--bg-void': '#15141D',
    '--bg-canvas': '#1A1923',
    '--bg-editor': '#1E1D28',
    '--bg-surface': '#24232F',
    '--bg-raised': '#2A2937',
    '--bg-overlay': '#312F41',
    '--bg-overlay-strong': '#3A3850',
    '--bg-hover': 'rgba(203, 198, 232, 0.07)',
    '--bg-active': 'rgba(151, 129, 255, 0.14)',
    '--bg-scrim': 'rgba(11, 10, 17, 0.76)',
    '--fg-faint': '#928CA0',
    '--fg-subtle': '#918BA2',
    '--fg-muted': '#B3ADBF',
    '--fg-default': '#DDD8E7',
    '--fg-strong': '#F2EEF7',
    '--fg-max': '#FBF9FD',
    '--border-subtle': '#302E3D',
    '--border': '#3B384B',
    '--border-strong': '#504B65',
    '--info': '#76A8F8',
    '--success': '#62C88A',
    '--warning': '#DDB667',
    '--danger': '#F0808B',
    '--fg-on-danger': '#211015',
    '--fg-on-warning': '#15141D',
    '--fg-on-subtle': '#15141D',
    '--ai': '#A7ADB7',
    '--warning-soft': 'rgba(221, 182, 103, 0.16)',
  },
};

const AXIOM_LIGHT: Theme = {
  label: 'Royal Graphite Light',
  kind: 'light',
  tokens: {
    '--bg-void': '#E9E7EF',
    '--bg-canvas': '#F1EFF5',
    '--bg-editor': '#FAF9FC',
    '--bg-surface': '#EAE7F0',
    '--bg-raised': '#F7F5FA',
    '--bg-overlay': '#E1DDE9',
    '--bg-overlay-strong': '#D5D0DF',
    '--bg-hover': 'rgba(48, 40, 68, 0.06)',
    '--bg-active': 'rgba(100, 73, 202, 0.12)',
    '--bg-scrim': 'rgba(28, 24, 38, 0.36)',
    '--fg-faint': '#655E72',
    '--fg-subtle': '#6D667A',
    '--fg-muted': '#554E62',
    '--fg-default': '#312B3B',
    '--fg-strong': '#1F1A28',
    '--fg-max': '#15111C',
    '--border-subtle': '#DDD8E5',
    '--border': '#C9C3D2',
    '--border-strong': '#AAA2B7',
    '--info': '#2F67B4',
    '--success': '#28784C',
    '--warning': '#986212',
    '--danger': '#B63543',
    '--fg-on-danger': '#FFFFFF',
    '--fg-on-warning': '#FFFFFF',
    '--fg-on-subtle': '#FFFFFF',
    '--ai': '#535866',
    '--warning-soft': 'rgba(142, 91, 13, 0.14)',
  },
};

const AXIOM_MIDNIGHT: Theme = {
  label: 'Axiom Midnight',
  kind: 'dark',
  tokens: {
    '--bg-void': '#000000',
    '--bg-canvas': '#0a0e17',
    '--bg-editor': '#0b101c',
    '--bg-surface': '#0f1524',
    '--bg-raised': '#161d30',
    '--bg-overlay': '#1d2740',
    '--bg-overlay-strong': '#25324f',
    '--bg-hover': 'rgba(255, 255, 255, 0.05)',
    '--bg-active': 'rgba(255, 255, 255, 0.09)',
    '--bg-scrim': 'rgba(0, 0, 0, 0.78)',
    '--fg-faint': '#7F8BA8',
    '--fg-subtle': '#62708f',
    '--fg-muted': '#9aa6c0',
    '--fg-default': '#e6ebf5',
    '--fg-strong': '#f4f7fc',
    '--fg-max': '#ffffff',
    '--border-subtle': '#172136',
    '--border': '#1e2942',
    '--border-strong': '#2c3a5c',
    '--info': '#4C8DD8',
    '--success': '#3DA56A',
    '--warning': '#E2A336',
    '--danger': '#E5484D',
    '--fg-on-danger': '#16080A',
    '--fg-on-warning': '#15141D',
    '--fg-on-subtle': '#FFFFFF',
    '--ai': '#9FA8BC',
    '--warning-soft': 'rgba(221, 182, 103, 0.16)',
  },
};

const AXIOM_HIGH_CONTRAST: Theme = {
  label: 'Axiom High Contrast',
  kind: 'dark',
  tokens: {
    '--bg-void': '#000000',
    '--bg-canvas': '#000000',
    '--bg-editor': '#000000',
    '--bg-surface': '#0a0a0a',
    '--bg-raised': '#141414',
    '--bg-overlay': '#1a1a1a',
    '--bg-overlay-strong': '#242424',
    '--bg-hover': 'rgba(255, 255, 255, 0.1)',
    '--bg-active': 'rgba(255, 255, 255, 0.18)',
    '--bg-scrim': 'rgba(0, 0, 0, 0.88)',
    '--fg-faint': '#a0a0a0',
    '--fg-subtle': '#a0a0a0',
    '--fg-muted': '#d0d0d0',
    '--fg-default': '#ffffff',
    '--fg-strong': '#ffffff',
    '--fg-max': '#ffffff',
    '--border-subtle': '#5a5a5a',
    '--border': '#6b6b6b',
    '--border-strong': '#9a9a9a',
    '--info': '#5AA0E8',
    '--success': '#48B87A',
    '--warning': '#F0B84A',
    '--danger': '#F05A60',
    '--fg-on-danger': '#000000',
    '--fg-on-warning': '#000000',
    '--fg-on-subtle': '#000000',
    '--ai': '#FFFFFF',
    '--warning-soft': 'rgba(255, 255, 0, 0.22)',
  },
};

export const THEMES: Record<ThemeId, Theme> = {
  'axiom-royal': AXIOM_ROYAL,
  'axiom-royal-light': AXIOM_ROYAL_LIGHT,
  'axiom-dark': AXIOM_DARK,
  'axiom-light': AXIOM_LIGHT,
  'axiom-midnight': AXIOM_MIDNIGHT,
  'axiom-high-contrast': AXIOM_HIGH_CONTRAST,
};

/**
 * Native caption colours. Main rejects any overlay whose symbol/background contrast
 * is below AA, so every entry here is checked against that bar.
 */
export const TITLE_BAR_OVERLAYS: Record<ThemeId, TitleBarOverlayAppearance> = {
  'axiom-royal': { color: '#171233', symbolColor: '#EDE7FF' },
  'axiom-royal-light': { color: '#F6F2FF', symbolColor: '#2A1E4F' },
  'axiom-dark': { color: '#1A1923', symbolColor: '#DDD8E7' },
  'axiom-light': { color: '#F1EFF5', symbolColor: '#312B3B' },
  'axiom-midnight': { color: '#0A0E17', symbolColor: '#E6EBF5' },
  'axiom-high-contrast': { color: '#000000', symbolColor: '#FFFFFF' },
};

export function titleBarOverlayForTheme(themeId: ThemeId): TitleBarOverlayAppearance {
  return TITLE_BAR_OVERLAYS[themeId] ?? TITLE_BAR_OVERLAYS['axiom-royal'];
}

/** Theme-aware accents keep both accent-on-surface and text-on-accent at WCAG AA. */
const BLUE_DARK: Accent = {
  accent: '#5797FF',
  accentHover: '#75AAFF',
  accentPress: '#3F7FE0',
  accentSoft: 'rgba(87, 151, 255, 0.18)',
  onAccent: '#17141F',
};
const BLUE_LIGHT: Accent = {
  accent: '#1E5AB6',
  accentHover: '#174A99',
  accentPress: '#123D80',
  accentSoft: 'rgba(30, 90, 182, 0.14)',
  onAccent: '#FFFFFF',
};

const VIOLET_DARK: Accent = {
  accent: '#9277FF',
  accentHover: '#A995FF',
  accentPress: '#9175FF',
  accentSoft: 'rgba(146, 119, 255, 0.18)',
  onAccent: '#17141F',
};
const VIOLET_LIGHT: Accent = {
  accent: '#6344E6',
  accentHover: '#5635C8',
  accentPress: '#4D31B8',
  accentSoft: 'rgba(99, 68, 230, 0.14)',
  onAccent: '#FFFFFF',
};

/** Universal black & white accent (Cursor/Windsurf style). */
const MONO_DARK: Accent = {
  accent: '#E1E4EA',
  accentHover: '#F2F4F7',
  accentPress: '#C4CAD3',
  accentSoft: 'rgba(255, 255, 255, 0.1)',
  onAccent: '#0B0C0E',
};
const MONO_LIGHT: Accent = {
  accent: '#2B303A',
  accentHover: '#12151A',
  accentPress: '#3A4049',
  accentSoft: 'rgba(0, 0, 0, 0.08)',
  onAccent: '#FFFFFF',
};

const GREEN_DARK: Accent = {
  accent: '#22C55E',
  accentHover: '#4ADE80',
  accentPress: '#16A34A',
  accentSoft: 'rgba(34, 197, 94, 0.16)',
  onAccent: '#052E16',
};
const GREEN_LIGHT: Accent = {
  accent: '#19733D',
  accentHover: '#145F32',
  accentPress: '#104C29',
  accentSoft: 'rgba(25, 115, 61, 0.14)',
  onAccent: '#FFFFFF',
};

const AMBER_DARK: Accent = {
  accent: '#F59E0B',
  accentHover: '#FBBF24',
  accentPress: '#D97706',
  accentSoft: 'rgba(245, 158, 11, 0.16)',
  onAccent: '#231A00',
};
const AMBER_LIGHT: Accent = {
  accent: '#895700',
  accentHover: '#754A00',
  accentPress: '#633F00',
  accentSoft: 'rgba(137, 87, 0, 0.14)',
  onAccent: '#FFFFFF',
};

const ROSE_DARK: Accent = {
  accent: '#FF5C78',
  accentHover: '#FF7890',
  accentPress: '#E63F60',
  accentSoft: 'rgba(255, 92, 120, 0.18)',
  onAccent: '#210A10',
};
const ROSE_LIGHT: Accent = {
  accent: '#C12449',
  accentHover: '#A91E3F',
  accentPress: '#911936',
  accentSoft: 'rgba(193, 36, 73, 0.14)',
  onAccent: '#FFFFFF',
};

/** Royal jewel accents. Gold is the default — the regal counterpart to the indigo. */
const GOLD_DARK: Accent = {
  accent: '#D9B45A',
  accentHover: '#E7C978',
  accentPress: '#BE9A44',
  accentSoft: 'rgba(217, 180, 90, 0.18)',
  onAccent: '#1A1330',
};
const GOLD_LIGHT: Accent = {
  accent: '#7A4E08',
  accentHover: '#684108',
  accentPress: '#563607',
  accentSoft: 'rgba(122, 78, 8, 0.14)',
  onAccent: '#FFFFFF',
};

const SAPPHIRE_DARK: Accent = {
  accent: '#6C9BFF',
  accentHover: '#88AFFF',
  accentPress: '#5482E4',
  accentSoft: 'rgba(108, 155, 255, 0.18)',
  onAccent: '#0C1330',
};
const SAPPHIRE_LIGHT: Accent = {
  accent: '#1B4FA8',
  accentHover: '#164191',
  accentPress: '#123679',
  accentSoft: 'rgba(27, 79, 168, 0.14)',
  onAccent: '#FFFFFF',
};

const EMERALD_DARK: Accent = {
  accent: '#2FB37A',
  accentHover: '#45C88E',
  accentPress: '#249766',
  accentSoft: 'rgba(47, 179, 122, 0.17)',
  onAccent: '#06251A',
};
const EMERALD_LIGHT: Accent = {
  accent: '#17694A',
  accentHover: '#12573D',
  accentPress: '#0E4632',
  accentSoft: 'rgba(23, 105, 74, 0.14)',
  onAccent: '#FFFFFF',
};

/** Dark variants remain the stable preset exports; resolution below is theme-aware. */
export const ACCENTS: Record<AccentId, Accent> = {
  gold: GOLD_DARK,
  sapphire: SAPPHIRE_DARK,
  emerald: EMERALD_DARK,
  mono: MONO_DARK,
  violet: VIOLET_DARK,
  blue: BLUE_DARK,
  green: GREEN_DARK,
  amber: AMBER_DARK,
  rose: ROSE_DARK,
};

const LIGHT_ACCENTS: Record<AccentId, Accent> = {
  gold: GOLD_LIGHT,
  sapphire: SAPPHIRE_LIGHT,
  emerald: EMERALD_LIGHT,
  mono: MONO_LIGHT,
  violet: VIOLET_LIGHT,
  blue: BLUE_LIGHT,
  green: GREEN_LIGHT,
  amber: AMBER_LIGHT,
  rose: ROSE_LIGHT,
};

export const THEME_IDS: readonly ThemeId[] = [
  'axiom-royal',
  'axiom-royal-light',
  'axiom-dark',
  'axiom-light',
  'axiom-midnight',
  'axiom-high-contrast',
];
export const ACCENT_IDS: readonly AccentId[] = [
  'gold',
  'sapphire',
  'emerald',
  'mono',
  'violet',
  'blue',
  'green',
  'amber',
  'rose',
];

export function coerceThemeId(value: unknown): ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value)
    ? (value as ThemeId)
    : 'axiom-royal';
}

export function coerceAccentId(value: unknown): AccentId {
  return typeof value === 'string' && (ACCENT_IDS as readonly string[]).includes(value)
    ? (value as AccentId)
    : 'gold';
}

function resolveAccent(theme: Theme, accentId: AccentId): Accent {
  const palette = theme.kind === 'light' ? LIGHT_ACCENTS : ACCENTS;
  return palette[accentId] ?? (theme.kind === 'light' ? GOLD_LIGHT : GOLD_DARK);
}

export function resolveAccentForTheme(themeId: ThemeId, accentId: AccentId): Accent {
  return resolveAccent(THEMES[themeId] ?? AXIOM_ROYAL, accentId);
}

/** Display label for a theme, for settings + onboarding pickers. */
export function themeLabel(themeId: ThemeId): string {
  return THEMES[themeId]?.label ?? themeId;
}

export function accentColorForTheme(themeId: ThemeId, accentId: AccentId): string {
  return resolveAccentForTheme(themeId, accentId).accent;
}

function accentSofter(accent: Accent, theme: Theme): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(accent.accent);
  if (!match) return accent.accentSoft;
  const red = Number.parseInt(match[1] ?? '0', 16);
  const green = Number.parseInt(match[2] ?? '0', 16);
  const blue = Number.parseInt(match[3] ?? '0', 16);
  const alpha = theme.kind === 'light' ? 0.07 : 0.09;
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

/**
 * Applies a theme + accent (+ optional corner rounding) by writing CSS custom
 * properties onto `root`. Corner style is optional so existing callers are unchanged.
 */
export function applyAppearance(
  root: HTMLElement,
  themeId: ThemeId,
  accentId: AccentId,
  cornerStyle: CornerStyle = 'soft',
): void {
  const theme = THEMES[themeId] ?? AXIOM_ROYAL;
  for (const [name, value] of Object.entries(CORNER_STYLES[cornerStyle])) {
    root.style.setProperty(name, value);
  }
  for (const [name, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(name, value);
  }
  const accent = resolveAccent(theme, accentId);
  root.style.setProperty('--accent', accent.accent);
  root.style.setProperty('--accent-hover', accent.accentHover);
  root.style.setProperty('--accent-press', accent.accentPress);
  root.style.setProperty('--accent-soft', accent.accentSoft);
  root.style.setProperty('--accent-softer', accentSofter(accent, theme));
  root.style.setProperty('--focus', accent.accent);
  root.style.setProperty('--fg-on-accent', accent.onAccent);
  root.style.colorScheme = theme.kind;
}

/**
 * The part of a converted VS Code theme the workbench needs to paint itself.
 *
 * Declared as a projection of `ConvertedTheme` rather than a new interface so the
 * converter stays the single definition of what a contributed theme is.
 */
export type ContributedAppearance = Pick<ConvertedTheme, 'kind' | 'tokens' | 'accent'>;

/**
 * Apply a colour theme contributed by an installed extension.
 *
 * Overlaid on the built-in theme of the same kind rather than applied on its own. A VS
 * Code theme file defines the colours VS Code asks for, which is not the set AXIOM's CSS
 * asks for; the converter closes most of the gap by deriving surfaces and borders from the
 * editor background, but any token it cannot derive would otherwise keep whatever the
 * previously selected theme wrote — these are inline properties on the document root and
 * nothing clears them. Starting from a complete theme of the right kind means every token
 * ends up with a deliberate value, and a partial theme degrades into a coherent one
 * instead of a mixture of two.
 */
export function applyContributedAppearance(
  root: HTMLElement,
  contributed: ContributedAppearance,
  cornerStyle: CornerStyle = 'soft',
): void {
  const base = contributed.kind === 'light' ? AXIOM_ROYAL_LIGHT : AXIOM_ROYAL;
  for (const [name, value] of Object.entries(CORNER_STYLES[cornerStyle])) {
    root.style.setProperty(name, value);
  }
  for (const [name, value] of Object.entries(base.tokens)) root.style.setProperty(name, value);
  for (const [name, value] of Object.entries(contributed.tokens)) {
    root.style.setProperty(name, value);
  }
  const accent: Accent = contributed.accent;
  root.style.setProperty('--accent', accent.accent);
  root.style.setProperty('--accent-hover', accent.accentHover);
  root.style.setProperty('--accent-press', accent.accentPress);
  root.style.setProperty('--accent-soft', accent.accentSoft);
  root.style.setProperty('--accent-softer', accentSofter(accent, base));
  root.style.setProperty('--focus', accent.accent);
  root.style.setProperty('--fg-on-accent', accent.onAccent);
  root.style.colorScheme = contributed.kind;
}

/**
 * Native title-bar colours for a contributed theme.
 *
 * The overlay is drawn by Windows, not by CSS, so it cannot inherit a custom property and
 * has to be handed concrete colours. Both come from the same tokens the workbench just
 * applied, which is what keeps the system buttons from sitting on a strip of the previous
 * theme.
 */
export function titleBarOverlayForContributed(
  contributed: ContributedAppearance,
): TitleBarOverlayAppearance {
  const fallback = titleBarOverlayForTheme(
    contributed.kind === 'light' ? 'axiom-royal-light' : 'axiom-royal',
  );
  const color = contributed.tokens['--bg-void'] ?? contributed.tokens['--bg-canvas'];
  const symbolColor = contributed.tokens['--fg-strong'] ?? contributed.tokens['--fg-default'];
  return {
    color: /^#[0-9a-f]{6}$/i.test(color ?? '') ? color! : fallback.color,
    symbolColor: /^#[0-9a-f]{6}$/i.test(symbolColor ?? '') ? symbolColor! : fallback.symbolColor,
  };
}
