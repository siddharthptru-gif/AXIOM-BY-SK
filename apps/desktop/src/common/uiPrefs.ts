/**
 * Visual-accessibility UI preferences core (PRD Epoch I §168 / Phases 248 + 255).
 * Pure parsing/clamping for UI density, zoom, and reduced-motion — applied to the
 * document root by the ThemeController. No I/O. Smoke-tested.
 */
export type Density = 'comfortable' | 'compact';
export const DENSITIES: readonly Density[] = ['comfortable', 'compact'];

export const MIN_ZOOM = 0.8;
export const MAX_ZOOM = 1.6;
export const UI_ZOOM_CHANGED_EVENT = 'axiom:ui-zoom-changed';

/** Coerce input to a valid density (default comfortable). */
export function parseDensity(value: unknown): Density {
  return value === 'compact' ? 'compact' : 'comfortable';
}

/** Clamp a UI zoom factor into [MIN_ZOOM, MAX_ZOOM]; non-numbers default to 1. */
export function parseZoom(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(n * 100) / 100));
}

/** Whether reduced motion is requested (explicit setting OR the OS preference). */
export function resolveReducedMotion(setting: unknown, osPrefers: boolean): boolean {
  if (setting === true || setting === 'on') return true;
  if (setting === false || setting === 'off') return false;
  // 'auto'/undefined → follow the OS.
  return osPrefers === true;
}

export interface UiPrefs {
  density: Density;
  zoom: number;
  reducedMotion: boolean;
}

/** The document-root class names for a set of UI prefs (density + reduced motion). */
export function uiPrefClasses(prefs: UiPrefs): string[] {
  const classes: string[] = [`density-${prefs.density}`];
  if (prefs.reducedMotion) classes.push('reduce-motion');
  return classes;
}
