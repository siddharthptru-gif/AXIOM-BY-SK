import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { app } from 'electron';
import { rootLogger } from '@axiom/shared';
import type { ActionClass } from '../../common/approval';
import type { WriteConsentState } from '../../common/ipc';

/**
 * Batch write consent for a trusted folder (PRD §144 extension).
 *
 * The user explicitly grants "let Axiom edit files in THIS trusted folder without
 * asking for each one". Two shapes exist:
 *
 *   session   — Main memory only, bounded lifetime, dies with the process.
 *   persisted — remembered for that exact folder across restarts, until revoked.
 *
 * The persisted shape exists because re-affirming on every launch is friction the
 * user pays for a decision they already made when they trusted the folder through
 * a native dialog. It is a deliberate, narrow relaxation, and every hard boundary
 * around it is unchanged:
 *
 * - It covers ONLY the `write` action class. Command execution (`exec`), Git
 *   writes, network actions, MCP tools, and every high-risk command still require
 *   an exact native approval preview, because those are the irreversible and
 *   privilege-escalating paths. Nothing here can waive them.
 * - It is bound to one canonical workspace root, and the agent still asserts that
 *   the workspace is trusted on every action, so revoking trust revokes this too.
 * - Path containment, root binding, no-overwrite, identity revalidation, and
 *   dirty-buffer checks are untouched.
 * - Every write is still snapshotted and audited, so it stays revertible from the
 *   checkpoint timeline and from Build's post-turn review bar.
 *
 * The persisted store records only canonical folder paths — never file content,
 * credentials, or anything derived from a model.
 */
const log = rootLogger.child('write-consent');

/** Hard ceiling for one SESSION grant. A long session must re-affirm rather than drift. */
export const MAX_WRITE_CONSENT_MS = 4 * 60 * 60 * 1000;
const MIN_WRITE_CONSENT_MS = 60 * 1000;
/** Bound the persisted store so it cannot grow without limit. */
const MAX_PERSISTED_ROOTS = 64;
const STORE_VERSION = 1;

interface ConsentGrant {
  ownerId: number;
  rootKey: string;
  root: string;
  grantedAt: number;
  expiresAt: number;
}

interface PersistedGrant {
  rootKey: string;
  root: string;
  grantedAt: number;
}

const grants = new Map<string, ConsentGrant>();
const persistedGrants = new Map<string, PersistedGrant>();
let loaded = false;
let loading: Promise<void> | null = null;

function storePath(): string {
  return join(app.getPath('userData'), 'write-consent.json');
}

function rootKeyOf(root: string): string {
  const canonical = resolve(root);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

function grantKey(ownerId: number, root: string): string {
  return `${ownerId}\u0000${rootKeyOf(root)}`;
}

async function readStore(): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(storePath(), 'utf-8');
  } catch {
    // No store, or unreadable: the safe default is "no persisted consent".
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn('Persisted write consent store is not valid JSON; ignoring it.');
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const record = parsed as Record<string, unknown>;
  if (record.version !== STORE_VERSION || !Array.isArray(record.roots)) return;
  for (const entry of record.roots.slice(0, MAX_PERSISTED_ROOTS)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const root = typeof item.root === 'string' ? item.root.trim() : '';
    // Only absolute canonical paths are accepted back; anything else is dropped.
    if (root.length === 0 || resolve(root) !== root) continue;
    const grantedAt = typeof item.grantedAt === 'number' && item.grantedAt > 0 ? item.grantedAt : 0;
    const key = rootKeyOf(root);
    persistedGrants.set(key, { rootKey: key, root, grantedAt });
  }
}

async function writeStore(): Promise<void> {
  const path = storePath();
  const payload = {
    version: STORE_VERSION,
    roots: [...persistedGrants.values()]
      .slice(-MAX_PERSISTED_ROOTS)
      .map((grant) => ({ root: grant.root, grantedAt: grant.grantedAt })),
  };
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.axiom-write-consent-${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/**
 * Load the persisted store exactly once. Every async entry point awaits this, and
 * an agent run awaits it before dispatch, so the synchronous gate below always
 * observes a fully loaded set.
 */
export function ensureWriteConsentLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  loading ??= readStore().then(
    () => {
      loaded = true;
      loading = null;
    },
    () => {
      loaded = true;
      loading = null;
    },
  );
  return loading;
}

function activeGrant(ownerId: number, root: string, now = Date.now()): ConsentGrant | null {
  const key = grantKey(ownerId, root);
  const grant = grants.get(key);
  if (!grant) return null;
  if (grant.expiresAt <= now) {
    grants.delete(key);
    return null;
  }
  return grant;
}

function persistedGrant(root: string): PersistedGrant | null {
  return persistedGrants.get(rootKeyOf(root)) ?? null;
}

function snapshot(
  grant: ConsentGrant | null,
  persisted: PersistedGrant | null,
  now = Date.now(),
): WriteConsentState {
  // A persisted grant outranks a session grant: it is broader and never lapses.
  if (persisted) return { granted: true, expiresAt: null, remainingMs: 0, persisted: true };
  if (!grant) return { granted: false, expiresAt: null, remainingMs: 0, persisted: false };
  return {
    granted: true,
    expiresAt: grant.expiresAt,
    remainingMs: Math.max(0, grant.expiresAt - now),
    persisted: false,
  };
}

/**
 * Record an explicit grant for one owner + canonical root. The caller (Main IPC)
 * must have already verified workspace trust and explicit confirmation.
 *
 * `persist` remembers the folder across restarts; otherwise the grant is bounded
 * to this session. A persist failure is reported so the UI never claims a durable
 * grant it does not have — the session grant still stands.
 */
export async function grantWriteConsent(
  ownerId: number,
  root: string,
  requestedMs: number,
  persist = false,
): Promise<WriteConsentState> {
  await ensureWriteConsentLoaded();
  const duration = Number.isFinite(requestedMs)
    ? Math.min(MAX_WRITE_CONSENT_MS, Math.max(MIN_WRITE_CONSENT_MS, Math.floor(requestedMs)))
    : MAX_WRITE_CONSENT_MS;
  const now = Date.now();
  const canonical = resolve(root);
  const key = rootKeyOf(root);
  const grant: ConsentGrant = {
    ownerId,
    rootKey: key,
    root: canonical,
    grantedAt: now,
    expiresAt: now + duration,
  };
  grants.set(grantKey(ownerId, root), grant);

  if (!persist) {
    log.info('Session write consent granted', { durationMs: duration });
    return snapshot(grant, null, now);
  }

  const previous = persistedGrants.get(key);
  persistedGrants.set(key, { rootKey: key, root: canonical, grantedAt: now });
  while (persistedGrants.size > MAX_PERSISTED_ROOTS) {
    const oldest = persistedGrants.keys().next().value as string | undefined;
    if (!oldest || oldest === key) break;
    persistedGrants.delete(oldest);
  }
  try {
    await writeStore();
  } catch (error) {
    // Roll back so the in-memory set matches what is actually on disk.
    if (previous) persistedGrants.set(key, previous);
    else persistedGrants.delete(key);
    log.warn('Could not persist folder write consent', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return snapshot(grant, null, now);
  }
  log.info('Folder write consent remembered for this workspace');
  return snapshot(grant, persistedGrants.get(key) ?? null, now);
}

/** Remove both the session grant and any remembered grant for this folder. */
export async function revokeWriteConsent(
  ownerId: number,
  root: string,
): Promise<WriteConsentState> {
  await ensureWriteConsentLoaded();
  grants.delete(grantKey(ownerId, root));
  const key = rootKeyOf(root);
  if (persistedGrants.delete(key)) {
    try {
      await writeStore();
    } catch (error) {
      log.warn('Could not remove remembered folder write consent from disk', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return snapshot(null, null);
}

export async function getWriteConsent(ownerId: number, root: string): Promise<WriteConsentState> {
  await ensureWriteConsentLoaded();
  return snapshot(activeGrant(ownerId, root), persistedGrant(root));
}

/**
 * The exact gate consulted by the agent loop. Only a non-high-risk `write` action
 * in a folder with an active session grant or a remembered grant may skip the
 * per-action preview. Synchronous by contract; callers ensure the store is loaded.
 */
export function isWriteAutoApproved(
  ownerId: number,
  root: string,
  cls: ActionClass,
  highRisk: boolean,
): boolean {
  if (cls !== 'write' || highRisk) return false;
  if (persistedGrant(root) !== null) return true;
  return activeGrant(ownerId, root) !== null;
}

/**
 * Revoke every grant for a workspace, including the remembered one. Called on
 * trust revocation: consent can never outlive the trust that justified it.
 */
export async function revokeWriteConsentForWorkspace(root: string): Promise<void> {
  const key = rootKeyOf(root);
  for (const [id, grant] of grants) {
    if (grant.rootKey === key) grants.delete(id);
  }
  await ensureWriteConsentLoaded();
  if (!persistedGrants.delete(key)) return;
  try {
    await writeStore();
  } catch (error) {
    log.warn('Could not remove remembered folder write consent after trust revocation', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Revoke every session grant held by a renderer (called when it is destroyed). */
export function revokeWriteConsentForOwner(ownerId: number): void {
  for (const [id, grant] of grants) {
    if (grant.ownerId === ownerId) grants.delete(id);
  }
}

export function revokeAllWriteConsent(): void {
  grants.clear();
}
