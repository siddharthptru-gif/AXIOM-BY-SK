import { useEffect, useState } from 'react';
import { useSettings } from './store';
import {
  APPEARANCE_CHANGED_EVENT,
  resolveAccentForTheme,
  applyAppearance,
  applyContributedAppearance,
  coerceAccentId,
  coerceCornerStyle,
  coerceThemeId,
  THEMES,
  titleBarOverlayForContributed,
  titleBarOverlayForTheme,
} from './themes';
import { setMonacoContributedTheme, setMonacoTheme } from '../editor/monacoEnv';
import { useWorkspace } from '../state/workspace';
import { setActiveIconTheme } from '../workbench/iconTheme';
import type { ConvertedTheme } from '../../../common/vscodeTheme';
import {
  parseDensity,
  parseZoom,
  resolveReducedMotion,
  uiPrefClasses,
  UI_ZOOM_CHANGED_EVENT,
} from '../../../common/uiPrefs';
import { checkThemeContrast } from '../../../common/theme';
import { notifyInfo } from '../notifications/bus';
import { setLocale, setPseudoLocale } from '../i18n';
import { dirAttributes } from '../../../common/rtl';

/**
 * Applies the selected color theme + accent (PRD Part IX §154) and the visual-
 * accessibility preferences — UI density, zoom, and reduced motion (Phases 248 /
 * 255) — whenever appearance settings change, and runs the WCAG contrast linter
 * (Phase 247) on the active theme + accent, warning once if a key pair fails AA.
 * Writes CSS custom properties / root classes; renders nothing.
 */
/**
 * Theme+accent combinations already reported as failing WCAG AA.
 *
 * The linter is worth running on extension themes — a third-party theme is exactly where
 * an unreadable pair shows up — but repeating the notice every time the accent moves or
 * the workspace changes turns useful information into noise. One report per combination
 * per session says it once.
 */
const contrastReported = new Set<string>();

function reportContrast(
  tokens: Record<string, string>,
  accent: { accent: string; accentHover: string; accentPress: string; onAccent: string },
  signature: string,
): void {
  if (contrastReported.has(signature)) return;
  contrastReported.add(signature);
  const issues = checkThemeContrast(tokens, accent.accent, accent.onAccent, {
    hover: accent.accentHover,
    press: accent.accentPress,
  });
  if (issues.length === 0) return;
  notifyInfo(
    `Contrast check: ${issues.length} theme pair(s) below WCAG AA (${issues
      .map((issue) => `${issue.pair} ${issue.ratio}:1`)
      .join('; ')}).`,
    { source: 'Appearance' },
  );
}

export function ThemeController() {
  const { values } = useSettings();
  const { rootPath } = useWorkspace();
  const themeId = coerceThemeId(values['workbench.colorTheme']);
  const accentId = coerceAccentId(values['workbench.accentColor']);
  const cornerStyle = coerceCornerStyle(values['workbench.cornerStyle']);
  const contributedKeyRaw = values['workbench.extensionColorTheme'];
  const contributedKey = typeof contributedKeyRaw === 'string' ? contributedKeyRaw.trim() : '';
  const iconThemeKeyRaw = values['workbench.extensionIconTheme'];
  const iconThemeKey = typeof iconThemeKeyRaw === 'string' ? iconThemeKeyRaw.trim() : '';
  const [contributed, setContributed] = useState<ConvertedTheme | null>(null);
  const densityRaw = values['workbench.density'];
  const zoomRaw = values['workbench.uiZoom'];
  const motionRaw = values['workbench.reducedMotion'];
  const localeRaw = values['workbench.locale'];
  const pseudoRaw = values['workbench.pseudoLocale'];

  useEffect(() => {
    const locale = typeof localeRaw === 'string' ? localeRaw : 'en';
    setLocale(locale);
    setPseudoLocale(pseudoRaw === true);
    const { dir, lang } = dirAttributes(locale);
    document.documentElement.dir = dir;
    document.documentElement.lang = lang;
  }, [localeRaw, pseudoRaw]);

  /**
   * Resolve the selected extension theme.
   *
   * Kept in a separate effect from applying it because the two have different triggers: a
   * theme is re-read when the selection, the workspace, or the set of installed extensions
   * changes, while it is re-applied whenever any appearance setting moves. Loading is also
   * the only step that can fail — an extension can be uninstalled while still selected —
   * and that failure has to fall back to a built-in theme rather than leave the workbench
   * unpainted.
   */
  useEffect(() => {
    if (contributedKey === '') {
      setContributed(null);
      return undefined;
    }
    let cancelled = false;
    const load = (): void => {
      void window.axiom.market
        .loadTheme(contributedKey, rootPath ?? null)
        .then((theme) => {
          if (cancelled) return;
          setContributed(theme);
          if (theme === null) {
            notifyInfo(
              'The selected extension color theme is no longer available. Using the built-in theme.',
              { source: 'Appearance' },
            );
          }
        })
        .catch(() => {
          if (!cancelled) setContributed(null);
        });
    };
    load();
    // Installing, updating or disabling an extension can add or remove the selected theme.
    const stop = window.axiom.market.onChanged(() => load());
    return () => {
      cancelled = true;
      stop();
    };
  }, [contributedKey, rootPath]);

  /**
   * Resolve and publish the selected file-icon theme.
   *
   * Separate from the colour theme because the two are independent choices — a user can
   * keep AXIOM's colours and take an extension's file icons, or the reverse — and because
   * the icon payload is large enough (inlined images for up to a couple of thousand file
   * types) that it should only be fetched when the selection actually names one.
   */
  useEffect(() => {
    if (iconThemeKey === '') {
      setActiveIconTheme(null);
      return undefined;
    }
    let cancelled = false;
    const load = (): void => {
      void window.axiom.market
        .loadIconTheme(iconThemeKey, rootPath ?? null)
        .then((theme) => {
          if (!cancelled) setActiveIconTheme(theme);
        })
        .catch(() => {
          if (!cancelled) setActiveIconTheme(null);
        });
    };
    load();
    const stop = window.axiom.market.onChanged(() => load());
    return () => {
      cancelled = true;
      stop();
    };
  }, [iconThemeKey, rootPath]);

  useEffect(() => {
    const root = document.documentElement;
    // A selected extension theme that has not resolved yet paints nothing rather than
    // painting a built-in theme first: the alternative is a visible theme flip on every
    // start, which looks like a fault even though both states are correct.
    if (contributedKey !== '' && contributed === null) return;

    if (contributed !== null) {
      applyContributedAppearance(root, contributed, cornerStyle);
      void window.axiom.window
        .setTitleBarOverlay(titleBarOverlayForContributed(contributed))
        .catch(() => undefined);
      setMonacoContributedTheme(contributedKey, contributed);
      window.dispatchEvent(new Event(APPEARANCE_CHANGED_EVENT));
      reportContrast(contributed.tokens, contributed.accent, `${contributedKey}::contrast`);
      return;
    }

    applyAppearance(root, themeId, accentId, cornerStyle);
    void window.axiom.window
      .setTitleBarOverlay(titleBarOverlayForTheme(themeId))
      .catch(() => undefined);
    const theme = THEMES[themeId];
    if (theme) {
      const accent = resolveAccentForTheme(themeId, accentId);
      setMonacoTheme(themeId, theme, accent);
      window.dispatchEvent(new Event(APPEARANCE_CHANGED_EVENT));
      // Contrast linter (Phase 247): warn if the active theme+accent fails WCAG AA.
      reportContrast(theme.tokens, accent, `${themeId}::${accentId}`);
    }
  }, [themeId, accentId, cornerStyle, contributed, contributedKey]);

  useEffect(() => {
    const root = document.documentElement;
    const motionQuery =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    const applyVisualPreferences = (): void => {
      const prefs = {
        density: parseDensity(densityRaw),
        zoom: parseZoom(zoomRaw),
        reducedMotion: resolveReducedMotion(motionRaw, motionQuery?.matches === true),
      };
      root.classList.remove(
        'density-comfortable',
        'density-compact',
        'reduce-motion',
        'motion-enabled',
      );
      for (const cls of uiPrefClasses(prefs)) root.classList.add(cls);
      if (!prefs.reducedMotion) root.classList.add('motion-enabled');
      root.style.setProperty('--ui-zoom', String(prefs.zoom));
      root.style.setProperty('zoom', String(prefs.zoom));
      window.dispatchEvent(new Event(UI_ZOOM_CHANGED_EVENT));
    };

    applyVisualPreferences();
    motionQuery?.addEventListener('change', applyVisualPreferences);
    return () => motionQuery?.removeEventListener('change', applyVisualPreferences);
  }, [densityRaw, zoomRaw, motionRaw]);

  return null;
}
