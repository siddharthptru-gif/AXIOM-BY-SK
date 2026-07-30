import type { DebugBreakpoint } from '../../../common/ipc';

/**
 * Breakpoint store (PRD Phases 96/98/100). A renderer-side registry of
 * breakpoints per file — each with an optional condition / log message — toggled
 * from the editor gutter and edited in the Debug panel. Changes sync to the live
 * DAP session (best-effort) and notify subscribers (the editor redraws glyphs).
 * Lines are 1-based.
 */
interface Meta {
  condition?: string;
  logMessage?: string;
}

type Listener = () => void;

const map = new Map<string, Map<number, Meta>>();
const listeners = new Set<Listener>();
let liveSyncEnabled = false;

function emit(): void {
  for (const l of listeners) l();
}

function bpsFor(path: string): DebugBreakpoint[] {
  const lines = map.get(path);
  if (!lines) return [];
  return [...lines.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([line, meta]) => ({
      line,
      ...(meta.condition ? { condition: meta.condition } : {}),
      ...(meta.logMessage ? { logMessage: meta.logMessage } : {}),
    }));
}

/** Enable live breakpoint synchronization only while a trusted debug session exists. */
export function setBreakpointSyncEnabled(enabled: boolean): void {
  liveSyncEnabled = enabled;
}

function sync(path: string): void {
  if (!liveSyncEnabled) return;
  void window.axiom.debug.setBreakpoints(path, bpsFor(path)).catch(() => {});
}

/** Toggle a breakpoint's existence at `path:line`. */
export function toggleBreakpoint(path: string, line: number): void {
  const lines = map.get(path) ?? new Map<number, Meta>();
  if (lines.has(line)) lines.delete(line);
  else lines.set(line, {});
  if (lines.size > 0) map.set(path, lines);
  else map.delete(path);
  emit();
  sync(path);
}

/** Set (or clear, when empty) a breakpoint's condition; creates it if missing. */
export function setBreakpointCondition(path: string, line: number, condition: string): void {
  const lines = map.get(path) ?? new Map<number, Meta>();
  const meta = lines.get(line) ?? {};
  if (condition.trim()) meta.condition = condition.trim();
  else delete meta.condition;
  lines.set(line, meta);
  map.set(path, lines);
  emit();
  sync(path);
}

/** Breakpoint lines for one file (sorted) — for gutter glyphs. */
export function linesFor(path: string): number[] {
  const lines = map.get(path);
  return lines ? [...lines.keys()].sort((a, b) => a - b) : [];
}

/** All breakpoints as a plain map (for starting a session). */
export function allBreakpoints(): Record<string, DebugBreakpoint[]> {
  const out: Record<string, DebugBreakpoint[]> = {};
  for (const path of map.keys()) out[path] = bpsFor(path);
  return out;
}

/** Flat list of every breakpoint (for the Debug panel). */
export function listBreakpoints(): Array<{ path: string; line: number; condition?: string }> {
  const out: Array<{ path: string; line: number; condition?: string }> = [];
  for (const path of map.keys()) {
    for (const bp of bpsFor(path)) {
      out.push({ path, line: bp.line, ...(bp.condition ? { condition: bp.condition } : {}) });
    }
  }
  return out;
}

export function breakpointCount(): number {
  let n = 0;
  for (const lines of map.values()) n += lines.size;
  return n;
}

export function subscribeBreakpoints(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
