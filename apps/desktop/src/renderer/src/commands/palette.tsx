import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Palette open-state (PRD Part VII §103/§105). Kept tiny and separate from the
 * command registry so opening a palette does not re-render command contributors.
 */
export type PaletteMode =
  | 'commands'
  | 'files'
  | 'language'
  | 'indent'
  | 'eol'
  | 'theme'
  | 'accent'
  | 'gotoLine'
  | 'workspaceSymbols'
  | null;

interface PaletteValue {
  mode: PaletteMode;
  /** Seed text for the freshly opened palette (used by Quick Open prefix routing). */
  initialQuery: string;
  openCommands: (initial?: string) => void;
  openFiles: () => void;
  openLanguage: () => void;
  openIndent: () => void;
  openEol: () => void;
  openTheme: () => void;
  openAccent: () => void;
  openGoto: (initial?: string) => void;
  openWorkspaceSymbols: (initial?: string) => void;
  close: () => void;
}

const PaletteContext = createContext<PaletteValue | null>(null);

export function PaletteProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<PaletteMode>(null);
  const [initialQuery, setInitialQuery] = useState('');

  const openCommands = useCallback((initial = '') => {
    setInitialQuery(initial);
    setMode('commands');
  }, []);
  const openFiles = useCallback(() => {
    setInitialQuery('');
    setMode('files');
  }, []);
  const openLanguage = useCallback(() => setMode('language'), []);
  const openIndent = useCallback(() => setMode('indent'), []);
  const openEol = useCallback(() => setMode('eol'), []);
  const openTheme = useCallback(() => setMode('theme'), []);
  const openAccent = useCallback(() => setMode('accent'), []);
  const openGoto = useCallback((initial = '') => {
    setInitialQuery(initial);
    setMode('gotoLine');
  }, []);
  const openWorkspaceSymbols = useCallback((initial = '') => {
    setInitialQuery(initial);
    setMode('workspaceSymbols');
  }, []);
  const close = useCallback(() => setMode(null), []);

  const value = useMemo<PaletteValue>(
    () => ({
      mode,
      initialQuery,
      openCommands,
      openFiles,
      openLanguage,
      openIndent,
      openEol,
      openTheme,
      openAccent,
      openGoto,
      openWorkspaceSymbols,
      close,
    }),
    [
      mode,
      initialQuery,
      openCommands,
      openFiles,
      openLanguage,
      openIndent,
      openEol,
      openTheme,
      openAccent,
      openGoto,
      openWorkspaceSymbols,
      close,
    ],
  );

  return <PaletteContext.Provider value={value}>{children}</PaletteContext.Provider>;
}

export function usePalette(): PaletteValue {
  const ctx = useContext(PaletteContext);
  if (!ctx) throw new Error('usePalette must be used within PaletteProvider');
  return ctx;
}
