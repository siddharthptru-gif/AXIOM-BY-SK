/**
 * Lazy-activation index (PRD Ch. 41 — LA-1 … LA-6).
 *
 * `vscodeHost.activationMatches` answers "does this one event fire for this trigger?",
 * which is the right question when a single extension is being considered. Startup asks
 * the inverted question — "given this trigger, which of the 40 installed extensions must
 * wake up?" — and answering it by looping every extension × every event on each keystroke
 * or file open is what turns lazy activation back into eager activation. So the trigger
 * set is indexed once at load time and looked up by key.
 *
 * Both directions classify events with `parseActivationEvent`, so an event is never lazy to
 * one of them and unknown to the other: `activationMatches` decides whether a single
 * declared event fires, this index decides which extensions a trigger reaches, and the
 * vocabulary they share is the table below.
 *
 * Pure: no I/O. Callers supply the manifest list and the workspace file list.
 */
import { matchesVsCodeGlob } from './vscodeGlob';

/** The trigger families the platform recognizes. `unknown` never activates. */
export type ActivationEventKind =
  | 'startup'
  | 'language'
  | 'command'
  | 'workspaceContains'
  | 'fileSystem'
  | 'view'
  | 'uri'
  | 'webviewPanel'
  | 'customEditor'
  | 'notebook'
  | 'debug'
  | 'taskType'
  | 'terminalProfile'
  | 'terminalShellIntegration'
  | 'terminalQuickFix'
  | 'authentication'
  | 'search'
  | 'editSession'
  | 'languageModelTool'
  | 'chatParticipant'
  | 'renderer'
  | 'unknown';

/** Prefix → kind. Upstream's list; anything absent is deliberately `unknown`. */
const EVENT_PREFIXES: Readonly<Record<string, ActivationEventKind>> = {
  onLanguage: 'language',
  onCommand: 'command',
  workspaceContains: 'workspaceContains',
  onFileSystem: 'fileSystem',
  onView: 'view',
  onUri: 'uri',
  // A deep link handled by the extension: the same trigger family as `onUri`, and firing it
  // separately would mean an extension that declared one but not the other missed its link.
  onOpenExternalUri: 'uri',
  onWebviewPanel: 'webviewPanel',
  onCustomEditor: 'customEditor',
  onNotebook: 'notebook',
  onNotebookEditor: 'notebook',
  onDebug: 'debug',
  onDebugInitialConfigurations: 'debug',
  onDebugDynamicConfigurations: 'debug',
  onDebugResolve: 'debug',
  onDebugAdapterProtocolTracker: 'debug',
  onTaskType: 'taskType',
  onTerminalProfile: 'terminalProfile',
  onTerminalShellIntegration: 'terminalShellIntegration',
  onTerminalQuickFixRequest: 'terminalQuickFix',
  onAuthenticationRequest: 'authentication',
  onSearch: 'search',
  onEditSession: 'editSession',
  onLanguageModelTool: 'languageModelTool',
  onChatParticipant: 'chatParticipant',
  onRenderer: 'renderer',
};

export interface ParsedActivationEvent {
  raw: string;
  kind: ActivationEventKind;
  /** The part after the colon, when the event takes an argument. */
  argument?: string;
}

/** Classify one declared activation event without deciding whether it fires. */
export function parseActivationEvent(event: string): ParsedActivationEvent {
  const raw = typeof event === 'string' ? event.trim() : '';
  if (raw.length === 0) return { raw, kind: 'unknown' };
  if (raw === '*' || raw === 'onStartupFinished') return { raw, kind: 'startup' };
  const separator = raw.indexOf(':');
  if (separator < 0) {
    // `onDebug` and friends are legal with no argument: they mean "any of this family".
    const kind = EVENT_PREFIXES[raw];
    return kind === undefined ? { raw, kind: 'unknown' } : { raw, kind };
  }
  const name = raw.slice(0, separator);
  const argument = raw.slice(separator + 1);
  const kind = EVENT_PREFIXES[name];
  if (kind === undefined || argument.length === 0) return { raw, kind: 'unknown' };
  return { raw, kind, argument };
}

export interface ActivationIndexEntry {
  extensionId: string;
  activationEvents: readonly string[];
}

export interface ActivationIndex {
  /** Extensions that activate at startup (`*` / `onStartupFinished`). */
  eager: string[];
  /** `${kind}:${argument}` → extension ids, for the argument-bearing events. */
  byKey: Map<string, string[]>;
  /** Extensions listening to a whole family with no argument, e.g. bare `onDebug`. */
  byKind: Map<ActivationEventKind, string[]>;
  /** `workspaceContains:` globs, kept separate because they need path matching. */
  workspaceGlobs: Array<{ extensionId: string; pattern: string }>;
  /** Events that were not understood, surfaced so the UI can warn rather than hide. */
  unknown: Array<{ extensionId: string; event: string }>;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

/** Build the inverted index once, at extension-scan time. */
export function buildActivationIndex(entries: readonly ActivationIndexEntry[]): ActivationIndex {
  const index: ActivationIndex = {
    eager: [],
    byKey: new Map(),
    byKind: new Map(),
    workspaceGlobs: [],
    unknown: [],
  };
  for (const entry of entries) {
    for (const event of entry.activationEvents ?? []) {
      const parsed = parseActivationEvent(event);
      switch (parsed.kind) {
        case 'startup':
          if (!index.eager.includes(entry.extensionId)) index.eager.push(entry.extensionId);
          break;
        case 'unknown':
          index.unknown.push({ extensionId: entry.extensionId, event: parsed.raw });
          break;
        case 'workspaceContains':
          index.workspaceGlobs.push({
            extensionId: entry.extensionId,
            pattern: parsed.argument as string,
          });
          break;
        default:
          if (parsed.argument === undefined) {
            const list = index.byKind.get(parsed.kind);
            if (list === undefined) index.byKind.set(parsed.kind, [entry.extensionId]);
            else if (!list.includes(entry.extensionId)) list.push(entry.extensionId);
          } else {
            push(index.byKey, `${parsed.kind}:${parsed.argument}`, entry.extensionId);
          }
          break;
      }
    }
  }
  return index;
}

export interface ActivationLookup {
  kind: ActivationEventKind;
  argument?: string;
}

/**
 * Which extensions must activate for a trigger.
 *
 * A family match (bare `onDebug`) fires alongside the specific one, matching upstream:
 * a debug extension declaring `onDebug` expects to wake for `onDebug:node` too.
 */
export function extensionsForTrigger(index: ActivationIndex, lookup: ActivationLookup): string[] {
  if (lookup.kind === 'startup') return [...index.eager];
  const out: string[] = [];
  if (lookup.argument !== undefined) {
    for (const id of index.byKey.get(`${lookup.kind}:${lookup.argument}`) ?? []) out.push(id);
  }
  for (const id of index.byKind.get(lookup.kind) ?? []) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Resolve `workspaceContains:` against a workspace file listing (LA-4).
 *
 * The listing is supplied by the caller and is expected to be bounded — the scan that
 * produces it, not this function, is where the file-count budget belongs.
 */
export function extensionsForWorkspaceFiles(
  index: ActivationIndex,
  paths: readonly string[],
): string[] {
  const out: string[] = [];
  for (const { extensionId, pattern } of index.workspaceGlobs) {
    if (out.includes(extensionId)) continue;
    for (const path of paths) {
      if (matchesVsCodeGlob(pattern, path)) {
        out.push(extensionId);
        break;
      }
    }
  }
  return out;
}

/**
 * Filter a candidate list down to what still needs activating.
 *
 * LA-6: activation is idempotent and must never be requested twice for one extension,
 * because a second `activate()` on a live host would register every command again.
 */
export function pendingActivations(
  candidates: readonly string[],
  activated: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const id of candidates) {
    if (!activated.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}
