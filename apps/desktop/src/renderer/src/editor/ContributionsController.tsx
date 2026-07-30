import { useEffect } from 'react';
import { useWorkspace } from '../state/workspace';
import { applyContributedLanguages, clearContributedLanguages } from './contributedLanguages';
import { applyContributedGrammars, setTextMateTheme } from './textmate';
import { applyEncodedTokensColors, currentThemeRules } from './monacoEnv';
import { APPEARANCE_CHANGED_EVENT } from '../settings/themes';

/**
 * Keeps the editor's language, snippet and grammar registrations in step with what is
 * installed.
 *
 * Mounted once for the whole window, next to the appearance controller, for the same reason:
 * these are global editor registrations, not per-editor state, and registering them from a
 * view would tie them to that view being open. Renders nothing.
 *
 * Two independent syncs live here because they have different triggers. The catalog is
 * re-read when the workspace changes (enablement can be workspace-scoped) and on every
 * install, update, enable or remove broadcast from Main. The grammar engine's theme is
 * re-pushed whenever the appearance changes, so highlighting produced by a TextMate grammar
 * uses the same palette as the rest of the editor rather than the palette that happened to be
 * active when the engine started.
 */
export function ContributionsController() {
  const { rootPath } = useWorkspace();

  useEffect(() => {
    let cancelled = false;
    const root = rootPath ?? null;
    const load = (): void => {
      void window.axiom.market
        .contributions(root)
        .then((catalog) => {
          if (cancelled) return;
          applyContributedLanguages(catalog, root);
          applyContributedGrammars(catalog.grammars, root);
        })
        .catch(() => {
          // Without a catalog the editor keeps Monaco's built-in languages and Monarch
          // highlighting, which is the correct fallback: fewer languages, none of them wrong.
          if (cancelled) return;
          clearContributedLanguages();
          applyContributedGrammars([], root);
        });
    };
    load();
    const stop = window.axiom.market.onChanged(() => load());
    return () => {
      cancelled = true;
      stop();
      clearContributedLanguages();
      applyContributedGrammars([], root);
    };
  }, [rootPath]);

  useEffect(() => {
    const sync = (): void => setTextMateTheme(currentThemeRules(), applyEncodedTokensColors);
    sync();
    window.addEventListener(APPEARANCE_CHANGED_EVENT, sync);
    return () => window.removeEventListener(APPEARANCE_CHANGED_EVENT, sync);
  }, []);

  return null;
}
