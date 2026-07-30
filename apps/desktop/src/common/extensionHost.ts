import {
  decideCapability,
  type ExtensionManifest,
  type CapabilityRequest,
} from './extensionManifest';

/**
 * Extension host protocol core (PRD Epoch I §117 / Phase 239). Pure logic for the
 * supervised, out-of-process extension host: newline-delimited JSON framing, the
 * host↔extension message set (activate / command / capability request+result /
 * log / result / error), and capability ROUTING through the pure broker. No I/O —
 * the Main host service owns the child process + stdio; the child bootstrap uses
 * the framing. SECURITY: every capability the extension requests is brokered
 * against its declared manifest permissions (undeclared → deny; secrets → deny).
 * Smoke-tested.
 */

// ---- messages ----
export type HostToExt =
  | { t: 'activate'; extId: string }
  | { t: 'command'; id: number; command: string; args: unknown }
  | { t: 'capabilityResult'; id: number; allow: boolean; data?: unknown; error?: string };

export type ExtToHost =
  | { t: 'activated'; extId: string }
  | { t: 'log'; level: string; message: string }
  | { t: 'capability'; id: number; kind: string; target?: string }
  | { t: 'result'; id: number; value?: unknown; error?: string }
  | { t: 'error'; message: string };

// ---- framing (newline-delimited JSON over stdio) ----
export function encodeMessage(msg: HostToExt | ExtToHost): string {
  return `${JSON.stringify(msg)}\n`;
}

/** Buffering decoder that yields complete JSON messages from a stdio stream. */
export function createHostDecoder(): { push: (chunk: string) => unknown[] } {
  let buffer = '';
  return {
    push(chunk: string): unknown[] {
      buffer += chunk;
      const out: unknown[] = [];
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) {
          try {
            out.push(JSON.parse(line));
          } catch {
            /* ignore partial/garbage */
          }
        }
        idx = buffer.indexOf('\n');
      }
      return out;
    },
  };
}

// ---- builders (host → ext) ----
export function buildActivate(extId: string): HostToExt {
  return { t: 'activate', extId };
}
export function buildCommand(id: number, command: string, args: unknown): HostToExt {
  return { t: 'command', id, command, args };
}
export function buildCapabilityResult(
  id: number,
  allow: boolean,
  extra?: { data?: unknown; error?: string },
): HostToExt {
  return { t: 'capabilityResult', id, allow, ...(extra ?? {}) };
}

// ---- parsers / guards (ext → host) ----
const VALID_KINDS = new Set(['fs-read', 'fs-write', 'network', 'ai', 'secret']);

export interface CapabilityMessage {
  id: number;
  kind: CapabilityRequest['kind'];
  target?: string;
}

/** Narrow a decoded ext→host message to a capability request (validated). */
export function asCapabilityRequest(msg: unknown): CapabilityMessage | null {
  if (!msg || typeof msg !== 'object') return null;
  const o = msg as Record<string, unknown>;
  if (o.t !== 'capability' || typeof o.id !== 'number') return null;
  if (typeof o.kind !== 'string' || !VALID_KINDS.has(o.kind)) return null;
  return {
    id: o.id,
    kind: o.kind as CapabilityRequest['kind'],
    ...(typeof o.target === 'string' ? { target: o.target } : {}),
  };
}

/** True if the message signals the extension finished activating. */
export function isActivated(msg: unknown): boolean {
  return !!msg && typeof msg === 'object' && (msg as Record<string, unknown>).t === 'activated';
}

/** Extract a log message (level + capped text), or null. */
export function asLog(msg: unknown): { level: string; message: string } | null {
  if (!msg || typeof msg !== 'object') return null;
  const o = msg as Record<string, unknown>;
  if (o.t !== 'log') return null;
  return {
    level: typeof o.level === 'string' ? o.level : 'info',
    message: typeof o.message === 'string' ? o.message.slice(0, 2000) : '',
  };
}

/**
 * Route a capability request from an extension through the broker. Reuses the pure
 * `decideCapability` — undeclared/secret requests are denied. Returns the reply the
 * host should send back to the child.
 */
export function routeCapability(
  manifest: ExtensionManifest,
  req: CapabilityMessage,
): { id: number; allow: boolean; reason: string } {
  const decision = decideCapability(manifest, {
    kind: req.kind,
    ...(req.target !== undefined ? { target: req.target } : {}),
  });
  return { id: req.id, allow: decision.allow, reason: decision.reason };
}
