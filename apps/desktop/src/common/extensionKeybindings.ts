/**
 * Extension keybinding policy (PRD Ch. 25, KB-10 … KB-13).
 *
 * AXIOM already resolves *its own* three keybinding layers in `keybindingResolution.ts`
 * (compiled defaults → keymap preset → user overrides). That module stays exactly as it
 * is; nothing here replaces it. What it cannot do is the four things the PRD asks for once
 * extensions are in the picture:
 *
 *   - KB-10: reserved OS shortcuts must be *dropped with a warning*, not silently bound.
 *   - KB-11: an extension may override `editor.action.*` / `workbench.action.*`, but the
 *     Keyboard Shortcuts editor must say which extension did it.
 *   - KB-12: resolution must stay under 1 ms for 2,000 entries, hence a hash keyed on the
 *     first chord part rather than a scan of the table.
 *   - KB-13: the troubleshooting toggle must show the resolved binding, the matched `when`,
 *     and every shadowed candidate.
 *
 * `when` clauses are honoured through `contextKeyExpr.ts`, which is why an extension
 * binding with an unparseable `when` is rejected here: binding a key on a clause we cannot
 * evaluate would fire the command in contexts the author never intended.
 *
 * Pure: chords in, decisions out.
 */

import {
  evaluateContextKey,
  parseContextKeyExpression,
  type ContextKeyExpression,
  type ContextKeyValues,
} from './contextKeyExpr';

export type KeybindingPlatform = 'win' | 'mac' | 'linux';
export type KeybindingSource = 'default' | 'extension' | 'user';

export interface ExtensionKeybindingContribution {
  extensionId: string;
  extensionName?: string;
  command: string;
  key: string;
  mac?: string;
  linux?: string;
  win?: string;
  when?: string;
}

export interface KeybindingRule {
  command: string;
  /** Normalized, space-separated chord parts. */
  chord: string;
  when: string | null;
  whenExpression: ContextKeyExpression;
  source: KeybindingSource;
  extensionId: string | null;
  extensionName: string | null;
  /** Registration order. Later registration wins, as upstream does. */
  sequence: number;
}

export type DropReason = 'reserved' | 'invalid-key' | 'unavailable-on-platform' | 'invalid-when';

export interface DroppedKeybinding {
  extensionId: string;
  command: string;
  chord: string;
  reason: DropReason;
  /** Ready for the extension's log channel. */
  message: string;
}

const MAX_CHORD_LENGTH = 120;
const MAX_CHORD_PARTS = 4;

const MODIFIER_ALIASES: Readonly<Record<string, string>> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  win: 'meta',
  super: 'meta',
};

/** Canonical modifier order, so `shift+ctrl+p` and `ctrl+shift+p` are one chord. */
const MODIFIER_ORDER = ['ctrl', 'shift', 'alt', 'meta'] as const;

/**
 * Shortcuts the OS owns (KB-10).
 *
 * Kept to combinations the window manager or shell intercepts before the app ever sees
 * them — binding these produces a shortcut that appears in the UI and never fires, which is
 * worse than refusing it.
 */
const RESERVED: Readonly<Record<KeybindingPlatform, readonly string[]>> = {
  win: ['alt+f4', 'ctrl+alt+delete', 'alt+tab', 'meta+l', 'ctrl+shift+escape'],
  linux: ['alt+f4', 'ctrl+alt+delete', 'alt+tab'],
  mac: ['meta+q', 'meta+tab', 'meta+alt+escape', 'ctrl+meta+q'],
};

/**
 * Normalize one chord (`ctrl+k ctrl+s` is two parts).
 *
 * Returns `null` for an empty chord, a chord over the caps, or a part that is only
 * modifiers — `ctrl+` alone cannot be pressed.
 */
export function normalizeKeybindingChord(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > MAX_CHORD_LENGTH) return null;
  const parts = trimmed.split(/\s+/).slice(0, MAX_CHORD_PARTS);
  const normalized: string[] = [];
  for (const part of parts) {
    const pieces = part.split('+').filter((piece) => piece.length > 0);
    if (pieces.length === 0) return null;
    const modifiers = new Set<string>();
    let key: string | null = null;
    for (const piece of pieces) {
      const modifier = MODIFIER_ALIASES[piece];
      if (modifier !== undefined) modifiers.add(modifier);
      else key = piece;
    }
    if (key === null) return null;
    normalized.push([...MODIFIER_ORDER.filter((mod) => modifiers.has(mod)), key].join('+'));
  }
  return normalized.join(' ');
}

/** KB-10: is this chord owned by the OS on this platform? */
export function isReservedShortcut(chord: string, platform: KeybindingPlatform): boolean {
  const normalized = normalizeKeybindingChord(chord);
  if (normalized === null) return false;
  // Only the first part matters: `cmd+q x` still starts by triggering Quit.
  const first = normalized.split(' ')[0] as string;
  return RESERVED[platform].includes(first);
}

/** The platform-specific key of a contribution, falling back to `key` as upstream does. */
export function platformChordOf(
  binding: ExtensionKeybindingContribution,
  platform: KeybindingPlatform,
): string | undefined {
  const specific =
    platform === 'mac' ? binding.mac : platform === 'linux' ? binding.linux : binding.win;
  return specific ?? binding.key;
}

export interface CompileKeybindingsOptions {
  platform: KeybindingPlatform;
  /** First sequence number to assign; pass the count of lower-priority rules. */
  startSequence?: number;
}

export interface CompiledExtensionKeybindings {
  rules: KeybindingRule[];
  dropped: DroppedKeybinding[];
}

/**
 * Turn `contributes.keybindings` into resolvable rules, dropping the ones policy forbids.
 *
 * Every rejection is reported rather than thrown: one bad binding in a 40-binding
 * extension must not cost the other 39.
 */
export function compileExtensionKeybindings(
  contributions: readonly ExtensionKeybindingContribution[],
  options: CompileKeybindingsOptions,
): CompiledExtensionKeybindings {
  const rules: KeybindingRule[] = [];
  const dropped: DroppedKeybinding[] = [];
  let sequence = options.startSequence ?? 0;
  for (const binding of contributions) {
    const raw = platformChordOf(binding, options.platform);
    const chord = normalizeKeybindingChord(raw);
    if (chord === null) {
      dropped.push({
        extensionId: binding.extensionId,
        command: binding.command,
        chord: raw ?? '',
        reason:
          raw === undefined || raw.trim().length === 0 ? 'unavailable-on-platform' : 'invalid-key',
        message: `Keybinding for "${binding.command}" has no usable key on ${options.platform}; ignored.`,
      });
      continue;
    }
    if (isReservedShortcut(chord, options.platform)) {
      dropped.push({
        extensionId: binding.extensionId,
        command: binding.command,
        chord,
        reason: 'reserved',
        message: `Keybinding "${chord}" for "${binding.command}" is reserved by the operating system; ignored.`,
      });
      continue;
    }
    const whenExpression = parseContextKeyExpression(binding.when ?? null);
    if (whenExpression === null) {
      dropped.push({
        extensionId: binding.extensionId,
        command: binding.command,
        chord,
        reason: 'invalid-when',
        message: `Keybinding "${chord}" for "${binding.command}" has an unreadable when clause; ignored.`,
      });
      continue;
    }
    rules.push({
      command: binding.command,
      chord,
      when: binding.when ?? null,
      whenExpression,
      source: 'extension',
      extensionId: binding.extensionId,
      extensionName: binding.extensionName ?? null,
      sequence: sequence++,
    });
  }
  return { rules, dropped };
}

// ---------------------------------------------------------------------------
// Resolution (KB-12)
// ---------------------------------------------------------------------------
export interface KeybindingIndex {
  /** First chord part → rules whose chord starts with it. */
  byFirstPart: Map<string, KeybindingRule[]>;
  size: number;
}

/**
 * Build the dispatch index.
 *
 * The hash is keyed on the *first* chord part, which is what makes a 2,000-entry table
 * resolvable inside the KB-12 budget: a keypress touches only the handful of rules that
 * share its opening chord instead of the whole table. Within a bucket the rules are sorted
 * by descending sequence, so the first `when`-satisfying rule found is the winner and the
 * rest are exactly the shadowed candidates KB-13 has to report.
 */
export function buildKeybindingIndex(rules: readonly KeybindingRule[]): KeybindingIndex {
  const byFirstPart = new Map<string, KeybindingRule[]>();
  for (const rule of rules) {
    const first = rule.chord.split(' ')[0] as string;
    const bucket = byFirstPart.get(first);
    if (bucket === undefined) byFirstPart.set(first, [rule]);
    else bucket.push(rule);
  }
  for (const bucket of byFirstPart.values()) bucket.sort((a, b) => b.sequence - a.sequence);
  return { byFirstPart, size: rules.length };
}

export interface KeybindingResolution {
  /** The command to run, or null when nothing matched or a chord is still pending. */
  command: string | null;
  rule: KeybindingRule | null;
  /** Candidates that lost: same chord, but a later rule or an unsatisfied `when`. */
  shadowed: KeybindingRule[];
  /** True when the keypress is the prefix of a longer chord and dispatch must wait. */
  chordPending: boolean;
}

/**
 * Resolve a chord against the index.
 *
 * `pressed` may be a partial chord (`ctrl+k`); if some rule needs more parts and nothing
 * matches exactly, the result is a pending chord rather than a miss — that is how upstream
 * keeps `ctrl+k ctrl+s` from firing a `ctrl+k` binding that does not exist.
 */
export function resolveKeybinding(
  index: KeybindingIndex,
  pressed: string,
  context: ContextKeyValues = {},
): KeybindingResolution {
  const normalized = normalizeKeybindingChord(pressed);
  if (normalized === null) return { command: null, rule: null, shadowed: [], chordPending: false };
  const bucket = index.byFirstPart.get(normalized.split(' ')[0] as string) ?? [];
  const shadowed: KeybindingRule[] = [];
  let winner: KeybindingRule | null = null;
  let pending = false;
  for (const rule of bucket) {
    if (rule.chord === normalized) {
      if (winner === null && evaluateContextKey(rule.whenExpression, context)) winner = rule;
      else shadowed.push(rule);
      continue;
    }
    if (rule.chord.startsWith(`${normalized} `)) pending = true;
  }
  if (winner !== null)
    return { command: winner.command, rule: winner, shadowed, chordPending: false };
  return { command: null, rule: null, shadowed, chordPending: pending };
}

// ---------------------------------------------------------------------------
// Attribution (KB-11)
// ---------------------------------------------------------------------------
/** Command namespaces whose defaults extensions are allowed to take over. */
const OVERRIDABLE_PREFIXES = ['editor.action.', 'workbench.action.'];

export interface KeybindingAttribution {
  command: string;
  chord: string;
  when: string | null;
  source: KeybindingSource;
  extensionId: string | null;
  extensionName: string | null;
  /** KB-11: this rule replaces a built-in binding, and the editor must say who did it. */
  overridesDefault: boolean;
  /** The built-in chord that was displaced, when there was one. */
  defaultChord: string | null;
  /** False when an unconditional later rule takes the same chord. */
  active: boolean;
}

/**
 * Describe every rule for the Keyboard Shortcuts editor.
 *
 * `active` is computed without a context snapshot on purpose: the editor lists bindings
 * outside of any particular editor state, so the only shadowing it can state as fact is an
 * unconditional later rule on the same chord. A `when`-guarded rule is always listed as
 * active, because whether it wins depends on where the cursor is.
 */
export function attributeKeybindings(rules: readonly KeybindingRule[]): KeybindingAttribution[] {
  const defaultChords = new Map<string, string>();
  const defaultOwnedChords = new Set<string>();
  for (const rule of rules) {
    if (rule.source !== 'default') continue;
    if (!defaultChords.has(rule.command)) defaultChords.set(rule.command, rule.chord);
    defaultOwnedChords.add(rule.chord);
  }
  const unconditionalOwner = new Map<string, number>();
  for (const rule of rules) {
    if (rule.whenExpression.kind !== 'true') continue;
    const held = unconditionalOwner.get(rule.chord);
    if (held === undefined || rule.sequence > held)
      unconditionalOwner.set(rule.chord, rule.sequence);
  }
  return rules.map((rule) => {
    const defaultChord = defaultChords.get(rule.command) ?? null;
    const owner = unconditionalOwner.get(rule.chord);
    return {
      command: rule.command,
      chord: rule.chord,
      when: rule.when,
      source: rule.source,
      extensionId: rule.extensionId,
      extensionName: rule.extensionName,
      overridesDefault:
        rule.source !== 'default' &&
        (defaultChord !== null ||
          defaultOwnedChords.has(rule.chord) ||
          OVERRIDABLE_PREFIXES.some((prefix) => rule.command.startsWith(prefix))),
      defaultChord: rule.source === 'default' ? null : defaultChord,
      active: owner === undefined || owner <= rule.sequence,
    };
  });
}

// ---------------------------------------------------------------------------
// Troubleshooting log (KB-13)
// ---------------------------------------------------------------------------
export interface ShadowedCandidate {
  command: string;
  when: string | null;
  source: KeybindingSource;
  extensionId: string | null;
  reason: 'when-unsatisfied' | 'lower-priority';
}

export interface KeypressTroubleshootEntry {
  chord: string;
  command: string | null;
  when: string | null;
  source: KeybindingSource | null;
  extensionId: string | null;
  chordPending: boolean;
  shadowed: ShadowedCandidate[];
}

/** One log record per keypress, as **Developer: Toggle Keyboard Shortcuts Troubleshooting**. */
export function troubleshootKeypress(
  index: KeybindingIndex,
  pressed: string,
  context: ContextKeyValues = {},
): KeypressTroubleshootEntry {
  const resolution = resolveKeybinding(index, pressed, context);
  return {
    chord: normalizeKeybindingChord(pressed) ?? pressed,
    command: resolution.command,
    when: resolution.rule?.when ?? null,
    source: resolution.rule?.source ?? null,
    extensionId: resolution.rule?.extensionId ?? null,
    chordPending: resolution.chordPending,
    shadowed: resolution.shadowed.map((rule) => ({
      command: rule.command,
      when: rule.when,
      source: rule.source,
      extensionId: rule.extensionId,
      reason: evaluateContextKey(rule.whenExpression, context)
        ? ('lower-priority' as const)
        : ('when-unsatisfied' as const),
    })),
  };
}

/** A single log line; the shadowed list is what makes "my shortcut does nothing" diagnosable. */
export function formatTroubleshootEntry(entry: KeypressTroubleshootEntry): string {
  const head =
    entry.command === null
      ? entry.chordPending
        ? `${entry.chord} -> (chord pending)`
        : `${entry.chord} -> (no binding)`
      : `${entry.chord} -> ${entry.command}`;
  const parts = [head];
  if (entry.when !== null) parts.push(`when: ${entry.when}`);
  if (entry.source !== null) {
    parts.push(entry.extensionId === null ? `from: ${entry.source}` : `from: ${entry.extensionId}`);
  }
  for (const candidate of entry.shadowed) {
    parts.push(`shadowed: ${candidate.command} (${candidate.reason})`);
  }
  return parts.join(' | ');
}

// ---------------------------------------------------------------------------
// Table assembly
// ---------------------------------------------------------------------------
export interface BaseKeybinding {
  command: string;
  key: string;
  mac?: string;
  linux?: string;
  win?: string;
  when?: string;
}

export interface KeybindingTableInput {
  platform: KeybindingPlatform;
  /** AXIOM's compiled defaults, lowest priority. */
  defaults?: readonly BaseKeybinding[];
  extensions?: readonly ExtensionKeybindingContribution[];
  /** User entries, highest priority; the reserved-shortcut rule does not apply to them. */
  user?: readonly BaseKeybinding[];
}

export interface KeybindingTable {
  rules: KeybindingRule[];
  dropped: DroppedKeybinding[];
  index: KeybindingIndex;
}

function baseRules(
  bindings: readonly BaseKeybinding[],
  source: 'default' | 'user',
  platform: KeybindingPlatform,
  start: number,
): KeybindingRule[] {
  const out: KeybindingRule[] = [];
  let sequence = start;
  for (const binding of bindings) {
    const chord = normalizeKeybindingChord(
      platformChordOf({ ...binding, extensionId: '' }, platform),
    );
    const whenExpression = parseContextKeyExpression(binding.when ?? null);
    if (chord === null || whenExpression === null) continue;
    out.push({
      command: binding.command,
      chord,
      when: binding.when ?? null,
      whenExpression,
      source,
      extensionId: null,
      extensionName: null,
      sequence: sequence++,
    });
  }
  return out;
}

/**
 * Assemble defaults → extensions → user into one table plus its dispatch index.
 *
 * Sequence numbers encode the precedence, which is why the layers are compiled in this
 * order: a user entry always carries a higher sequence than any extension rule, so it wins
 * without a second pass.
 */
export function compileKeybindingTable(input: KeybindingTableInput): KeybindingTable {
  const defaults = baseRules(input.defaults ?? [], 'default', input.platform, 0);
  const extensions = compileExtensionKeybindings(input.extensions ?? [], {
    platform: input.platform,
    startSequence: defaults.length,
  });
  const user = baseRules(
    input.user ?? [],
    'user',
    input.platform,
    defaults.length + extensions.rules.length,
  );
  const rules = [...defaults, ...extensions.rules, ...user];
  return { rules, dropped: extensions.dropped, index: buildKeybindingIndex(rules) };
}
