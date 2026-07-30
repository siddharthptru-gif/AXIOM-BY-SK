/**
 * Screen-reader / accessibility model (PRD Epoch I §116 / Phases 253–254). Pure
 * helpers that turn app events into live-region announcements (with the right
 * politeness) and build accessible labels, plus a dedupe guard so the same message
 * isn't re-announced. No DOM — a renderer LiveRegion applies these to `aria-live`
 * elements and the editor uses `editorAriaLabel`. Smoke-tested.
 */

export type Politeness = 'polite' | 'assertive';

export interface A11yAnnouncement {
  text: string;
  politeness: Politeness;
}

export type NotifyLevel = 'info' | 'warn' | 'error';

/** Errors/warnings interrupt (assertive); info is queued (polite). */
export function politenessFor(level: NotifyLevel): Politeness {
  return level === 'info' ? 'polite' : 'assertive';
}

/** Build an announcement for a notification (source · message — detail). */
export function announcementForNotification(
  level: NotifyLevel,
  message: string,
  detail?: string,
  source?: string,
): A11yAnnouncement {
  const parts: string[] = [];
  if (source && source.trim()) parts.push(`${source.trim()}:`);
  parts.push(message.trim());
  if (detail && detail.trim()) parts.push(`\u2014 ${detail.trim()}`);
  return { text: parts.join(' ').trim(), politeness: politenessFor(level) };
}

/** A polite summary of the current problem counts. */
export function buildDiagnosticsAnnouncement(errors: number, warnings: number): A11yAnnouncement {
  const e = Math.max(0, Math.floor(errors));
  const w = Math.max(0, Math.floor(warnings));
  if (e === 0 && w === 0) return { text: 'No problems.', politeness: 'polite' };
  const bits: string[] = [];
  if (e > 0) bits.push(`${e} ${e === 1 ? 'error' : 'errors'}`);
  if (w > 0) bits.push(`${w} ${w === 1 ? 'warning' : 'warnings'}`);
  return { text: `${bits.join(', ')}.`, politeness: 'polite' };
}

/** Accessible label for the editor (file, language, and optionally cursor position). */
export function editorAriaLabel(
  fileName: string,
  language: string,
  line?: number,
  column?: number,
): string {
  const base = language ? `${fileName}, ${language}` : fileName;
  return line && column ? `${base}, line ${line}, column ${column}` : base;
}

/** Announcement for opening a file in the editor. */
export function announceForFileOpen(fileName: string, language: string): A11yAnnouncement {
  return {
    text: `Opened ${language ? `${fileName}, ${language}` : fileName}`,
    politeness: 'polite',
  };
}

/** Whether `next` should be announced given the last-announced text (skips empty + exact repeats). */
export function shouldAnnounce(prevText: string | null, next: string): boolean {
  const t = next.trim();
  if (t.length === 0) return false;
  return t !== (prevText ?? '').trim();
}
