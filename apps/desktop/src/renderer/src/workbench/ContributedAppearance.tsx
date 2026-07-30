import { useCallback, useEffect, useState } from 'react';
import type { ContributedIconTheme, ContributedTheme } from '../../../common/contributions';
import { useSettings } from '../settings/store';
import { useWorkspace } from '../state/workspace';
import { PaletteIcon } from './icons';

/**
 * Selection of the colour and file-icon themes installed extensions contribute.
 *
 * This lives in the Extensions view rather than in Settings for one reason: a contributed
 * theme only exists while the extension that ships it is installed and enabled, so the
 * place you install extensions is the only place where the list is guaranteed to be
 * truthful. Settings still holds the choice — `workbench.extensionColorTheme` — which is
 * what makes it survive a restart and follow the account profile like every other
 * preference.
 *
 * The section hides itself when nothing is contributed. An empty "Themes" panel would
 * suggest the feature is broken when the honest reading is that no theme extension is
 * installed yet.
 */
export function ContributedAppearance() {
  const { rootPath } = useWorkspace();
  const { values, set } = useSettings();
  const [themes, setThemes] = useState<ContributedTheme[]>([]);
  const [iconThemes, setIconThemes] = useState<ContributedIconTheme[]>([]);
  const [expanded, setExpanded] = useState(false);

  const activeTheme = typeof values['workbench.extensionColorTheme'] === 'string'
    ? (values['workbench.extensionColorTheme'] as string).trim()
    : '';
  const activeIconTheme = typeof values['workbench.extensionIconTheme'] === 'string'
    ? (values['workbench.extensionIconTheme'] as string).trim()
    : '';

  const reload = useCallback(async () => {
    try {
      const catalog = await window.axiom.market.contributions(rootPath ?? null);
      setThemes(catalog.themes);
      setIconThemes(catalog.iconThemes);
    } catch {
      // A catalog that cannot be read is indistinguishable from nothing contributed as
      // far as this picker is concerned; the Extensions list above reports real errors.
      setThemes([]);
      setIconThemes([]);
    }
  }, [rootPath]);

  useEffect(() => {
    void reload();
    return window.axiom.market.onChanged(() => void reload());
  }, [reload]);

  const total = themes.length + iconThemes.length;
  if (total === 0) return null;

  return (
    <section className="ext-contrib">
      <button
        type="button"
        className="ext-contrib-head"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        <PaletteIcon size={13} />
        <span className="ext-contrib-title">Themes from extensions</span>
        <span className="ext-badge ext-badge-quiet">{total}</span>
        <span className="ext-contrib-chevron" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded ? (
        <div className="ext-contrib-body">
          {themes.length > 0 ? (
            <div className="ext-contrib-group">
              <p className="ext-contrib-label" id="ext-color-themes">
                Color themes
              </p>
              <div className="ext-contrib-choices" role="group" aria-labelledby="ext-color-themes">
                <button
                  type="button"
                  className={`ext-chip ${activeTheme === '' ? 'is-on' : ''}`}
                  aria-pressed={activeTheme === ''}
                  onClick={() => set('workbench.extensionColorTheme', '', 'user')}
                >
                  Built-in
                </button>
                {themes.map((theme) => (
                  <button
                    key={theme.key}
                    type="button"
                    className={`ext-chip ${activeTheme === theme.key ? 'is-on' : ''}`}
                    aria-pressed={activeTheme === theme.key}
                    title={`${theme.label} — ${theme.extensionName} (${theme.kind})`}
                    onClick={() => set('workbench.extensionColorTheme', theme.key, 'user')}
                  >
                    <span className={`ext-chip-dot is-${theme.kind}`} aria-hidden="true" />
                    {theme.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {iconThemes.length > 0 ? (
            <div className="ext-contrib-group">
              <p className="ext-contrib-label" id="ext-icon-themes">
                File icon themes
              </p>
              <div className="ext-contrib-choices" role="group" aria-labelledby="ext-icon-themes">
                <button
                  type="button"
                  className={`ext-chip ${activeIconTheme === '' ? 'is-on' : ''}`}
                  aria-pressed={activeIconTheme === ''}
                  onClick={() => set('workbench.extensionIconTheme', '', 'user')}
                >
                  Built-in
                </button>
                {iconThemes.map((theme) => (
                  <button
                    key={theme.key}
                    type="button"
                    className={`ext-chip ${activeIconTheme === theme.key ? 'is-on' : ''}`}
                    aria-pressed={activeIconTheme === theme.key}
                    title={`${theme.label} — ${theme.extensionName}`}
                    onClick={() => set('workbench.extensionIconTheme', theme.key, 'user')}
                  >
                    {theme.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
