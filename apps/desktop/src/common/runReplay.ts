/**
 * Replay guard for resumed Agent runs. Completed side effects are represented by
 * ordered, effect-specific signatures so a resume can skip exactly the actions
 * that already took effect without collapsing distinct writes to the same path.
 */

import type { RunRecord } from './runJournal';

export const SIDE_EFFECTING_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'replace_in_file',
  'create_file',
  'create_directory',
  'delete_file',
  'move_path',
  'run_command',
]);

export function isSideEffecting(tool: string): boolean {
  return SIDE_EFFECTING_TOOLS.has(tool);
}

export function parseArgs(argsJson: string | undefined): Record<string, unknown> {
  if (!argsJson) return {};
  try {
    const value: unknown = JSON.parse(argsJson);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Pure lexical normalization for model-supplied relative/absolute paths. */
export function normalizeActionPath(value: string, root = ''): string {
  const raw = value.trim();
  if (!raw) return '';
  const rootSlash = root.trim().replace(/\\/g, '/');
  const rawSlash = raw.replace(/\\/g, '/');
  const rawAbsolute = /^[a-zA-Z]:\//.test(rawSlash) || rawSlash.startsWith('/');
  const slash =
    !rawAbsolute && rootSlash ? `${rootSlash.replace(/\/+$/, '')}/${rawSlash}` : rawSlash;
  const driveMatch = /^([a-zA-Z]:)(?:\/|$)/.exec(slash);
  const drive = driveMatch ? driveMatch[1]!.toLowerCase() : '';
  const unc = slash.startsWith('//');
  const windowsLike =
    drive.length > 0 ||
    unc ||
    rootSlash.startsWith('//') ||
    raw.includes('\\') ||
    /^[a-zA-Z]:\//.test(rootSlash);
  const absolute = drive.length > 0 || slash.startsWith('/');
  const body = drive ? slash.slice(drive.length).replace(/^\/+/, '') : slash.replace(/^\/+/, '');
  const parts: string[] = [];
  for (const part of body.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts.at(-1) !== '..') parts.pop();
      else if (!absolute) parts.push(part);
      continue;
    }
    parts.push(windowsLike ? part.toLowerCase() : part);
  }
  const prefix = drive ? `${drive}/` : unc ? '//' : absolute ? '/' : '';
  return `${prefix}${parts.join('/')}` || (absolute ? prefix : '.');
}

/** Exact command text or a root-qualified lexical file identity. */
export function actionTarget(tool: string, args: Record<string, unknown>, root = ''): string {
  if (tool === 'run_command') {
    const command = args.command ?? args.cmd ?? '';
    // Execution trims only outer whitespace; internal whitespace/newlines are semantic.
    return (typeof command === 'string' ? command : '').trim();
  }
  if (tool === 'move_path') {
    const source = typeof args.source === 'string' ? args.source : '';
    const destination = typeof args.destination === 'string' ? args.destination : '';
    return `${normalizeActionPath(source, root)} -> ${normalizeActionPath(destination, root)}`;
  }
  const target = args.path ?? args.file ?? '';
  return normalizeActionPath(typeof target === 'string' ? target : '', root);
}

function encoded(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value);
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotateRight(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

/** Synchronous, runtime-neutral SHA-256 used only for bounded action signatures. */
export function sha256Digest(input: string): string {
  const source = new TextEncoder().encode(input);
  const bitLength = source.length * 8;
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(source);
  bytes[source.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index++) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index++) {
      const x = words[index - 15]!;
      const y = words[index - 2]!;
      const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index++) {
      const sum1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choose = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + sum1 + choose + SHA256_K[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0]! + a!) >>> 0;
    state[1] = (state[1]! + b!) >>> 0;
    state[2] = (state[2]! + c!) >>> 0;
    state[3] = (state[3]! + d!) >>> 0;
    state[4] = (state[4]! + e!) >>> 0;
    state[5] = (state[5]! + f!) >>> 0;
    state[6] = (state[6]! + g!) >>> 0;
    state[7] = (state[7]! + h!) >>> 0;
  }
  return state.map((value) => value.toString(16).padStart(8, '0')).join('');
}

function operandDigest(value: unknown): string {
  return sha256Digest(encoded(value));
}

/**
 * Effect-specific signature. Content and replacement operands deliberately
 * participate so two edits to the same file do not collide.
 */
export function actionSignature(tool: string, args: Record<string, unknown>, root = ''): string {
  const target = actionTarget(tool, args, root);
  const targetDigest = sha256Digest(target);
  const prefix = 'v2\u0000';
  switch (tool) {
    case 'write_file':
    case 'create_file':
      return `${prefix}${tool}\u0000target=${targetDigest}\u0000content=${operandDigest(args.content)}`;
    case 'replace_in_file':
      return `${prefix}${tool}\u0000target=${targetDigest}\u0000find=${operandDigest(args.find)}\u0000replace=${operandDigest(args.replace)}`;
    case 'delete_file':
    case 'create_directory':
      return `${prefix}${tool}\u0000target=${targetDigest}`;
    case 'move_path':
      return `${prefix}${tool}\u0000source=${operandDigest(normalizeActionPath(typeof args.source === 'string' ? args.source : '', root))}\u0000destination=${operandDigest(normalizeActionPath(typeof args.destination === 'string' ? args.destination : '', root))}`;
    case 'run_command':
      return `${prefix}${tool}\u0000command=${targetDigest}`;
    default:
      return `${prefix}${tool}\u0000target=${targetDigest}\u0000args=${operandDigest(args)}`;
  }
}

const ACTION_DIGEST = /^[0-9a-f]{64}$/;

function isTaggedDigest(value: string, tag: string): boolean {
  const prefix = `${tag}=`;
  return value.startsWith(prefix) && ACTION_DIGEST.test(value.slice(prefix.length));
}

/** Validate a complete, tool-bound signature before trusting a durable replay entry. */
export function isValidActionSignature(tool: string, signature: string): boolean {
  const parts = signature.split('\u0000');
  if (parts[0] !== 'v2' || parts[1] !== tool) return false;
  switch (tool) {
    case 'write_file':
    case 'create_file':
      return (
        parts.length === 4 &&
        isTaggedDigest(parts[2]!, 'target') &&
        isTaggedDigest(parts[3]!, 'content')
      );
    case 'replace_in_file':
      return (
        parts.length === 5 &&
        isTaggedDigest(parts[2]!, 'target') &&
        isTaggedDigest(parts[3]!, 'find') &&
        isTaggedDigest(parts[4]!, 'replace')
      );
    case 'delete_file':
    case 'create_directory':
      return parts.length === 3 && isTaggedDigest(parts[2]!, 'target');
    case 'move_path':
      return (
        parts.length === 4 &&
        isTaggedDigest(parts[2]!, 'source') &&
        isTaggedDigest(parts[3]!, 'destination')
      );
    case 'run_command':
      return parts.length === 3 && isTaggedDigest(parts[2]!, 'command');
    default:
      return false;
  }
}

/** Conservative legacy fallback; ambiguous or failed effects must be re-run only as a new task. */
export function wasEffective(observation: string | undefined): boolean {
  if (!observation) return false;
  const value = observation.trimStart();
  if (/(?:^|\n)\s*error\b/i.test(value)) return false;
  if (/(?:^|\n)\s*blocked\b/i.test(value)) return false;
  if (/(?:^|\n)\s*cancelled\.?\b/i.test(value)) return false;
  if (/(?:^|\n)\s*command timed out\b/i.test(value)) return false;
  if (/(?:^|\n)\s*\[verification\][^\n]*\b(?:failed|unclear)\b/i.test(value)) return false;
  const exit = /(?:^|\n)\s*exit code\s+(-?\d+|null)\b/i.exec(value);
  if (exit && exit[1] !== '0') return false;
  if (/rejected this action|user rejected/i.test(value)) return false;
  return true;
}

export interface ReplayEntry {
  signature: string;
  tool: string;
  target: string;
  observation: string;
}

export interface ReplayLedger {
  sourceRunId: string;
  root: string;
  /** One entry per completed effect, preserving journal order and duplicates. */
  entries: ReplayEntry[];
  /** Legacy side effects lack exact authoritative signatures and cannot be resumed safely. */
  unsafeLegacySteps: number;
}

export function buildReplayLedger(run: RunRecord): ReplayLedger {
  const entries: ReplayEntry[] = [];
  const root = run.root ?? '';
  let unsafeLegacySteps = 0;
  for (const step of run.steps) {
    if (step.kind !== 'tool' || !step.tool || !isSideEffecting(step.tool)) continue;
    if (step.effectApplied === false) continue;
    if (
      step.effectApplied !== true ||
      !step.effectSignature ||
      !isValidActionSignature(step.tool, step.effectSignature) ||
      !root
    ) {
      unsafeLegacySteps++;
      continue;
    }
    const args = parseArgs(step.args);
    entries.push({
      signature: step.effectSignature,
      tool: step.tool,
      target: actionTarget(step.tool, args, root),
      observation: step.observation ?? '',
    });
  }
  return { sourceRunId: run.id, root, entries, unsafeLegacySteps };
}

export type ReplayAction = 'execute' | 'replay';

export interface ReplayDecision {
  action: ReplayAction;
  signature: string;
  observation?: string;
  reason: string;
}

export interface ReplayGuard {
  decide(tool: string, args: Record<string, unknown>): ReplayDecision;
  readonly replayed: readonly string[];
  remaining(): number;
}

/** Consume matching duplicate entries one-by-one in their original order. */
export function createReplayGuard(ledger: ReplayLedger): ReplayGuard {
  const available = new Map<string, ReplayEntry[]>();
  for (const entry of ledger.entries) {
    const queue = available.get(entry.signature) ?? [];
    queue.push(entry);
    available.set(entry.signature, queue);
  }
  const consumed = new Map<string, number>();
  const replayedList: string[] = [];
  return {
    get replayed(): readonly string[] {
      return replayedList;
    },
    remaining(): number {
      return ledger.entries.length - replayedList.length;
    },
    decide(tool: string, args: Record<string, unknown>): ReplayDecision {
      const signature = actionSignature(tool, args, ledger.root);
      if (!isSideEffecting(tool)) {
        return { action: 'execute', signature, reason: 'Read-only tool — always executed.' };
      }
      const queue = available.get(signature) ?? [];
      const index = consumed.get(signature) ?? 0;
      const entry = queue[index];
      if (entry) {
        consumed.set(signature, index + 1);
        replayedList.push(signature);
        return {
          action: 'replay',
          signature,
          observation: entry.observation,
          reason: `Already completed in run ${ledger.sourceRunId} — replaying recorded result.`,
        };
      }
      return { action: 'execute', signature, reason: 'Not previously completed — executing.' };
    },
  };
}

export function replaySummary(ledger: ReplayLedger): string {
  if (ledger.unsafeLegacySteps > 0) {
    return `${ledger.unsafeLegacySteps} legacy side-effecting step(s) cannot be resumed safely.`;
  }
  if (ledger.entries.length === 0) return 'No completed side-effecting steps to replay.';
  const commands = ledger.entries.filter((entry) => entry.tool === 'run_command').length;
  const fileActions = ledger.entries.length - commands;
  const parts: string[] = [];
  if (fileActions > 0) parts.push(`${fileActions} file edit${fileActions === 1 ? '' : 's'}`);
  if (commands > 0) parts.push(`${commands} command${commands === 1 ? '' : 's'}`);
  return `${ledger.entries.length} completed side-effecting step(s) will be skipped on resume (${parts.join(', ')}).`;
}
