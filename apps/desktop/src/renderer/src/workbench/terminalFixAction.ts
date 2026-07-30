import {
  buildTerminalFixPrompt,
  looksLikeFailingOutput,
  terminalFixEvidenceLabel,
  terminalFixReadiness,
} from '../../../common/terminalFix';
import {
  lastTerminalCommand,
  lastTerminalCommandOutput,
  recentTerminalTitle,
} from '../state/terminalOutputBus';
import { requestAiAction } from '../editor/aiActionBus';
import { notifyError, notifyInfo } from '../notifications/bus';

/**
 * "Fix the last failing command" (T3.14). One entry point shared by the terminal
 * toolbar button and the command palette, so both behave identically.
 *
 * Reads only what the terminal already captured in this session (renderer-side,
 * bounded, ANSI-stripped) and hands it to Ask as explicit evidence. When nothing has
 * been captured it says so instead of sending an empty prompt.
 */
export function requestTerminalFix(cwdLabel?: string | null): boolean {
  const command = lastTerminalCommand() ?? '';
  const output = lastTerminalCommandOutput();
  const title = recentTerminalTitle();
  const input = {
    command,
    output,
    title,
    ...(cwdLabel !== undefined ? { cwdLabel } : {}),
  };

  const readiness = terminalFixReadiness(input);
  if (!readiness.ready) {
    notifyError('Nothing to diagnose yet', { source: 'Terminal', detail: readiness.reason });
    return false;
  }

  requestAiAction({
    kind: 'fix',
    question: buildTerminalFixPrompt(input),
    code: output,
    fileLabel: terminalFixEvidenceLabel(input),
    language: 'text',
    startLine: 1,
    endLine: output.split('\n').length,
  });

  notifyInfo(
    looksLikeFailingOutput(output)
      ? 'Sent the failing command and its output to Ask.'
      : 'Sent the last command and its output to Ask.',
    { source: 'Terminal' },
  );
  return true;
}

/** True when there is captured terminal activity worth offering a fix for. */
export function canRequestTerminalFix(): boolean {
  return terminalFixReadiness({
    command: lastTerminalCommand() ?? '',
    output: lastTerminalCommandOutput(),
  }).ready;
}
