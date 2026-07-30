import type { AppInfo } from '../../../common/ipc';
import { useWorkspace } from '../state/workspace';
import { useNotifications } from '../notifications/store';
import { useDiagnostics } from '../state/diagnostics';
import { usePalette } from '../commands/palette';
import { useSettings } from '../settings/store';
import { getEditorSettings } from '../settings/schema';
import { languageForPath } from '../editor/language';
import type { IndentInfo } from '../editor/indentBus';
import { SpendStatusItem } from './SpendStatusItem';
import { VimStatusItem } from './VimStatusItem';
import { ErrorIcon, WarningIcon } from './icons';

interface StatusBarProps {
  info: AppInfo | null;
  cursor: { line: number; column: number };
  /** Number of selected characters across all selections (0 = none). */
  selectedChars: number;
  /** Active editor language id, or '' when unknown/none. */
  language: string;
  /** Active editor end-of-line sequence ('LF' | 'CRLF'), or '' when none. */
  eol: string;
  /** Active file encoding label, or '' when no file/encoding is available. */
  encoding: string;
  /** Active editor indentation, or null when no editor is focused. */
  indent: IndentInfo | null;
}

/** Status bar (PRD Part IX §160). Interactive items open the matching picker. */
export function StatusBar({
  info,
  cursor,
  selectedChars,
  language,
  eol,
  encoding,
  indent,
}: StatusBarProps) {
  const { activePath, rootName } = useWorkspace();
  const { setPanelOpen, setPanelTab } = useNotifications();
  const { errorCount, warningCount } = useDiagnostics();
  const { openLanguage, openIndent, openEol, openGoto } = usePalette();
  const { values } = useSettings();
  const editorSettings = getEditorSettings(values);
  const effectiveIndent = indent ?? {
    tabSize: editorSettings.tabSize,
    insertSpaces: editorSettings.insertSpaces,
  };
  const indentLabel = effectiveIndent.insertSpaces
    ? `Spaces: ${effectiveIndent.tabSize}`
    : `Tab Size: ${effectiveIndent.tabSize}`;
  const langLabel = activePath ? language || languageForPath(activePath) : null;

  const openProblems = (): void => {
    setPanelTab('problems');
    setPanelOpen(true);
  };

  return (
    <footer className="statusbar" aria-label="Status Bar">
      <span className="status-item">{rootName ?? 'No folder'}</span>
      <button
        type="button"
        className="status-item status-button"
        title="Show Problems"
        onClick={openProblems}
      >
        <span className="status-diagnostic status-error">
          <ErrorIcon />
          {errorCount}
        </span>
        <span className="status-diagnostic status-warning">
          <WarningIcon />
          {warningCount}
        </span>
      </button>
      <div className="spacer" />
      {activePath ? (
        <>
          <button
            type="button"
            className="status-item status-button"
            title="Go to Line/Column"
            onClick={() => openGoto()}
          >
            Ln {cursor.line}, Col {cursor.column}
            {selectedChars > 0 ? ` (${selectedChars} selected)` : ''}
          </button>
          <button
            type="button"
            className="status-item status-button"
            title="Select Indentation"
            onClick={openIndent}
          >
            {indentLabel}
          </button>
        </>
      ) : null}
      {langLabel ? (
        <button
          type="button"
          className="status-item status-button"
          title="Select Language Mode"
          onClick={openLanguage}
        >
          {langLabel}
        </button>
      ) : null}
      {activePath && eol ? (
        <button
          type="button"
          className="status-item status-button"
          title="Select End of Line Sequence"
          onClick={openEol}
        >
          {eol}
        </button>
      ) : null}
      <VimStatusItem />
      <SpendStatusItem />
      {activePath && encoding ? (
        <span className="status-item" title={`File Encoding: ${encoding}`}>
          {encoding}
        </span>
      ) : null}
      <span className="status-item">{info ? `${info.platform}/${info.arch}` : '—'}</span>
      <span className="status-item">{info ? `v${info.version}` : '…'}</span>
    </footer>
  );
}
