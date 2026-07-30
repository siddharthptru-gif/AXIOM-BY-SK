import { matchesGlob } from './workflows';

/**
 * Extension manifest + capability decision core. Pure logic validates manifests,
 * models declared permissions, and denies undeclared/secret requests. The current
 * WASM runtime receives no imports and therefore no filesystem, network, AI, or
 * secret broker at all; declarations are retained for review and for any future
 * explicitly brokered API. Default-disabled, least-privilege, no-secret invariant.
 */
export interface ExtensionPermissions {
  /** Workspace-relative globs the extension may read. */
  fsRead?: string[];
  /** Workspace-relative globs the extension may write. */
  fsWrite?: string[];
  /** Network hosts the extension may reach. */
  network?: string[];
  /** Whether the extension may use the AI subsystem. */
  ai?: boolean;
}

export interface ContributedCommand {
  id: string;
  title: string;
}
export interface ContributedTool {
  name: string;
  description: string;
}
export interface ContributedPrompt {
  id: string;
  title: string;
  body: string;
}
export interface ContributedContextProvider {
  id: string;
  title: string;
}

export interface ExtensionContributes {
  commands?: ContributedCommand[];
  tools?: ContributedTool[];
  prompts?: ContributedPrompt[];
  contextProviders?: ContributedContextProvider[];
}

export interface ExtensionWasmRuntime {
  kind: 'wasm';
  entry: string;
  /** Required lowercase SHA-256 of the exact module bytes. */
  sha256: string;
  /** Optional Ed25519 signature over the lowercase SHA-256 text (base64). */
  signature?: string;
  /** Optional SPKI PEM Ed25519 public key. Trust is still a separate user decision. */
  publisherKey?: string;
  memoryLimitMb?: number;
  timeoutMs?: number;
}

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  publisher?: string;
  description?: string;
  /** Legacy JavaScript entry. It remains fail-closed and is never executed. */
  main?: string;
  /** Optional capability-free WebAssembly runtime executed in a bounded trusted worker. */
  runtime?: ExtensionWasmRuntime;
  permissions: ExtensionPermissions;
  contributes: ExtensionContributes;
  /** Off by default (trust-aware activation). */
  enabled: boolean;
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{1,60}$/i;

function strArray(v: unknown, max = 50): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, max)
    : [];
}

function sanitizeContributes(v: unknown): ExtensionContributes {
  const o = (v ?? {}) as Record<string, unknown>;
  const out: ExtensionContributes = {};
  if (Array.isArray(o.commands)) {
    out.commands = o.commands
      .map((c) => c as Record<string, unknown>)
      .filter((c) => typeof c.id === 'string' && typeof c.title === 'string')
      .map((c) => ({ id: c.id as string, title: c.title as string }))
      .slice(0, 100);
  }
  if (Array.isArray(o.tools)) {
    out.tools = o.tools
      .map((c) => c as Record<string, unknown>)
      .filter((c) => typeof c.name === 'string')
      .map((c) => ({
        name: c.name as string,
        description: typeof c.description === 'string' ? c.description : '',
      }))
      .slice(0, 100);
  }
  if (Array.isArray(o.prompts)) {
    out.prompts = o.prompts
      .map((c) => c as Record<string, unknown>)
      .filter(
        (c) =>
          typeof c.id === 'string' && typeof c.title === 'string' && typeof c.body === 'string',
      )
      .map((c) => ({ id: c.id as string, title: c.title as string, body: c.body as string }))
      .slice(0, 100);
  }
  if (Array.isArray(o.contextProviders)) {
    out.contextProviders = o.contextProviders
      .map((c) => c as Record<string, unknown>)
      .filter((c) => typeof c.id === 'string' && typeof c.title === 'string')
      .map((c) => ({ id: c.id as string, title: c.title as string }))
      .slice(0, 100);
  }
  return out;
}

function sanitizePermissions(v: unknown): ExtensionPermissions {
  const o = (v ?? {}) as Record<string, unknown>;
  const perms: ExtensionPermissions = {};
  const fsRead = strArray(o.fsRead);
  const fsWrite = strArray(o.fsWrite);
  const network = strArray(o.network);
  if (fsRead.length > 0) perms.fsRead = fsRead;
  if (fsWrite.length > 0) perms.fsWrite = fsWrite;
  if (network.length > 0) perms.network = network;
  if (o.ai === true) perms.ai = true;
  return perms;
}

function sanitizeMainEntry(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const entry = value.trim().replace(/\\/g, '/').slice(0, 200);
  if (
    entry.length === 0 ||
    entry.startsWith('/') ||
    /^[a-zA-Z]:\//.test(entry) ||
    entry.includes('\0') ||
    entry.split('/').some((segment) => segment === '..' || segment.length === 0)
  ) {
    return null;
  }
  return entry;
}

function sanitizeWasmRuntime(value: unknown): ExtensionWasmRuntime | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== 'wasm') return null;
  const entry = sanitizeMainEntry(raw.entry);
  const sha256 = typeof raw.sha256 === 'string' ? raw.sha256.trim().toLowerCase() : '';
  if (!entry || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  const memoryLimitMb =
    typeof raw.memoryLimitMb === 'number' && Number.isFinite(raw.memoryLimitMb)
      ? Math.max(8, Math.min(64, Math.floor(raw.memoryLimitMb)))
      : 32;
  const timeoutMs =
    typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs)
      ? Math.max(50, Math.min(5_000, Math.floor(raw.timeoutMs)))
      : 1_500;
  const runtime: ExtensionWasmRuntime = { kind: 'wasm', entry, sha256, memoryLimitMb, timeoutMs };
  if (typeof raw.signature === 'string' && /^[A-Za-z0-9+/]{80,120}={0,2}$/.test(raw.signature)) {
    runtime.signature = raw.signature;
  }
  if (
    typeof raw.publisherKey === 'string' &&
    raw.publisherKey.length <= 1_000 &&
    raw.publisherKey.includes('BEGIN PUBLIC KEY')
  ) {
    runtime.publisherKey = raw.publisherKey;
  }
  if ((runtime.signature === undefined) !== (runtime.publisherKey === undefined)) return null;
  return runtime;
}

/** Validate + sanitize a raw manifest object. Requires id/name/version. Default disabled. */
export function validateManifest(raw: unknown): ExtensionManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, 80) : '';
  const version = typeof o.version === 'string' ? o.version.trim().slice(0, 20) : '';
  if (!ID_RE.test(id) || name.length === 0 || version.length === 0) return null;
  const manifest: ExtensionManifest = {
    id,
    name,
    version,
    permissions: sanitizePermissions(o.permissions),
    contributes: sanitizeContributes(o.contributes),
    enabled: o.enabled === true,
  };
  if (typeof o.publisher === 'string' && o.publisher.trim())
    manifest.publisher = o.publisher.trim().slice(0, 60);
  if (typeof o.description === 'string' && o.description.trim())
    manifest.description = o.description.trim().slice(0, 200);
  if (typeof o.main === 'string' && o.main.trim()) {
    const main = sanitizeMainEntry(o.main);
    if (!main) return null;
    manifest.main = main;
  }
  if (o.runtime !== undefined) {
    const runtime = sanitizeWasmRuntime(o.runtime);
    if (!runtime) return null;
    manifest.runtime = runtime;
  }
  return manifest;
}

export type CapabilityKind = 'fs-read' | 'fs-write' | 'network' | 'ai' | 'secret';

export interface CapabilityRequest {
  kind: CapabilityKind;
  /** Path (for fs) or host (for network); unused for ai/secret. */
  target?: string;
}

export interface CapabilityDecision {
  allow: boolean;
  reason: string;
}

function anyGlobMatches(globs: readonly string[] | undefined, target: string): boolean {
  return !!globs && globs.some((g) => matchesGlob(g, target));
}

/**
 * The capability-broker decision for an extension request. Enforces least
 * privilege: a disabled extension is denied everything, secrets are ALWAYS denied
 * (no-secret invariant), and anything not explicitly declared is denied.
 */
export function decideCapability(
  manifest: ExtensionManifest,
  req: CapabilityRequest,
): CapabilityDecision {
  if (req.kind === 'secret') {
    return { allow: false, reason: 'Extensions can never access secrets (no-secret invariant).' };
  }
  if (!manifest.enabled) {
    return { allow: false, reason: 'Extension is disabled.' };
  }
  const target = req.target ?? '';
  switch (req.kind) {
    case 'fs-read':
      return anyGlobMatches(manifest.permissions.fsRead, target)
        ? { allow: true, reason: 'Declared fs-read scope.' }
        : { allow: false, reason: `Undeclared fs-read for "${target}".` };
    case 'fs-write':
      return anyGlobMatches(manifest.permissions.fsWrite, target)
        ? { allow: true, reason: 'Declared fs-write scope.' }
        : { allow: false, reason: `Undeclared fs-write for "${target}".` };
    case 'network':
      return manifest.permissions.network?.includes(target)
        ? { allow: true, reason: 'Declared network host.' }
        : { allow: false, reason: `Undeclared network host "${target}".` };
    case 'ai':
      return manifest.permissions.ai === true
        ? { allow: true, reason: 'Declared AI permission.' }
        : { allow: false, reason: 'AI permission not declared.' };
    default:
      return { allow: false, reason: 'Unknown capability.' };
  }
}

/** A short human-readable summary of an extension's declared permissions. */
export function summarizePermissions(p: ExtensionPermissions): string {
  const parts: string[] = [];
  if (p.fsRead?.length) parts.push(`read ${p.fsRead.length} path(s)`);
  if (p.fsWrite?.length) parts.push(`write ${p.fsWrite.length} path(s)`);
  if (p.network?.length) parts.push(`network: ${p.network.join(', ')}`);
  if (p.ai) parts.push('AI');
  return parts.length > 0 ? parts.join(' · ') : 'no special permissions';
}
