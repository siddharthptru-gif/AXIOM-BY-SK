import { app } from 'electron';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  CollaborationEvent,
  CollaborationExport,
  CollaborationMember,
  CollaborationRole,
  CollaborationSession,
  CreateCollaborationSessionInput,
  EvidenceRecord,
  GodModeJob,
} from '../../common/godMode';
import { boundedText, GOD_MODE_SCHEMA_VERSION } from '../../common/godMode';
import { listGodModeJobs } from './godModeJobs';
import { getSupabase } from './supabase';

const STORE_VERSION = 1;
const MAX_SESSIONS = 100;
const MAX_MEMBERS = 200;
const MAX_EVENTS = 250;
const MAX_EVENT_TEXT = 4_000;
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const MAX_EXPORT_JOBS = 100;
const MAX_EXPORT_EVIDENCE = 2_000;
const MAX_EXPORT_BYTES = 4 * 1024 * 1024;
const CLOUD_TIMEOUT_MS = 15_000;
const CLOUD_SCHEMA_ATTESTATION = 'axiom-god-mode-collaboration-v1-rls';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROOT_FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const EVENT_KINDS = new Set<CollaborationEvent['kind']>([
  'note',
  'decision',
  'checkpoint',
  'verification',
  'handoff',
]);
const MEMBER_ROLES = new Set<CollaborationRole>(['owner', 'editor', 'reviewer', 'viewer']);

interface CollaborationStore {
  version: typeof STORE_VERSION;
  deviceActorId: string;
  sessions: CollaborationSession[];
}

class SafeCloudError extends Error {}


interface CollaborationCloudOperation {
  ownerId: number;
  root: string;
  controller: AbortController;
}

const cloudOperations = new Map<string, CollaborationCloudOperation>();

export interface CollaborationCloudLease {
  signal: AbortSignal;
  release: () => void;
}

export function beginCollaborationCloudOperation(
  ownerId: number,
  root: string,
): CollaborationCloudLease {
  const id = randomUUID();
  const operation: CollaborationCloudOperation = {
    ownerId,
    root: resolve(root),
    controller: new AbortController(),
  };
  cloudOperations.set(id, operation);
  return {
    signal: operation.controller.signal,
    release: () => {
      if (cloudOperations.get(id) === operation) cloudOperations.delete(id);
    },
  };
}

function cancelCloudOperations(
  predicate: (operation: CollaborationCloudOperation) => boolean,
): void {
  for (const [id, operation] of cloudOperations) {
    if (!predicate(operation)) continue;
    cloudOperations.delete(id);
    operation.controller.abort();
  }
}

export function cancelCollaborationCloudForOwner(ownerId: number): void {
  cancelCloudOperations((operation) => operation.ownerId === ownerId);
}

export function cancelCollaborationCloudForWorkspace(root: string): void {
  const key = rootFingerprint(root);
  cancelCloudOperations((operation) => rootFingerprint(operation.root) === key);
}

let operationTail: Promise<void> = Promise.resolve();

function filePath(): string {
  return join(app.getPath('userData'), 'god-mode', 'collaboration.json');
}

function rootFingerprint(root: string): string {
  const canonical = resolve(root);
  const normalized = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  return createHash('sha256').update(normalized, 'utf-8').digest('hex');
}

/** Cloud rows use an opaque session binding, never a guessable hash of a local path. */
function cloudRootFingerprint(sessionId: string): string {
  return createHash('sha256')
    .update(`axiom-collaboration-session:${sessionId}`, 'utf-8')
    .digest('hex');
}

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationTail.then(operation, operation);
  operationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function safeTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function normalizeMember(value: unknown): CollaborationMember | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = boundedText(item.id, 200);
  const displayName = boundedText(item.displayName, 100, 'Team member');
  if (!UUID_RE.test(id) || !MEMBER_ROLES.has(item.role as CollaborationRole)) return null;
  return {
    id,
    displayName,
    role: item.role as CollaborationRole,
    lastSeenAt: safeTimestamp(item.lastSeenAt, 0),
  };
}

function normalizeEvent(value: unknown, sessionId: string): CollaborationEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = boundedText(item.id, 200);
  const actorId = boundedText(item.actorId, 200);
  const text = boundedText(item.text, MAX_EVENT_TEXT);
  if (!id || !UUID_RE.test(actorId) || !text || !EVENT_KINDS.has(item.kind as CollaborationEvent['kind'])) {
    return null;
  }
  return {
    id,
    sessionId,
    actorId,
    kind: item.kind as CollaborationEvent['kind'],
    text,
    createdAt: safeTimestamp(item.createdAt, 0),
    evidenceIds: Array.isArray(item.evidenceIds)
      ? item.evidenceIds
          .slice(0, 100)
          .map((entry) => boundedText(entry, 200))
          .filter(Boolean)
      : [],
  };
}

function normalizeSession(value: unknown): CollaborationSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = boundedText(item.id, 200);
  const title = boundedText(item.title, 200);
  const fingerprint = boundedText(item.rootFingerprint, 64).toLowerCase();
  if (!UUID_RE.test(id) || !title || !ROOT_FINGERPRINT_RE.test(fingerprint)) return null;
  const createdAt = safeTimestamp(item.createdAt, 0);
  const members = Array.isArray(item.members)
    ? item.members.slice(0, MAX_MEMBERS).map(normalizeMember).filter((entry) => entry !== null)
    : [];
  const events = Array.isArray(item.events)
    ? item.events
        .slice(-MAX_EVENTS)
        .map((entry) => normalizeEvent(entry, id))
        .filter((entry) => entry !== null)
    : [];
  const cloudState = ['local-only', 'syncing', 'synced', 'error'].includes(
    String(item.cloudState),
  )
    ? (item.cloudState as CollaborationSession['cloudState'])
    : 'local-only';
  return {
    id,
    rootFingerprint: fingerprint,
    title,
    createdAt,
    updatedAt: safeTimestamp(item.updatedAt, createdAt),
    members,
    events,
    shared: item.shared === true,
    cloudState,
  };
}

async function readStore(): Promise<CollaborationStore> {
  try {
    const handle = await fs.open(filePath(), 'r');
    let text: string;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_STORE_BYTES) {
        throw new Error('Collaboration store is not a bounded regular file.');
      }
      text = await handle.readFile('utf-8');
    } finally {
      await handle.close();
    }
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    const value = parsed as { version?: unknown; deviceActorId?: unknown; sessions?: unknown };
    if (value.version !== STORE_VERSION || !Array.isArray(value.sessions)) throw new Error('invalid');
    return {
      version: STORE_VERSION,
      deviceActorId:
        typeof value.deviceActorId === 'string' && UUID_RE.test(value.deviceActorId)
          ? value.deviceActorId
          : randomUUID(),
      sessions: value.sessions
        .slice(-MAX_SESSIONS)
        .map(normalizeSession)
        .filter((session) => session !== null),
    };
  } catch (error) {
    if (
      !isMissing(error) &&
      !(error instanceof SyntaxError) &&
      (error as Error).message !== 'invalid'
    ) {
      throw error;
    }
    return { version: STORE_VERSION, deviceActorId: randomUUID(), sessions: [] };
  }
}

async function writeStore(store: CollaborationStore): Promise<void> {
  const path = filePath();
  await fs.mkdir(dirname(path), { recursive: true });
  const body = `${JSON.stringify(
    { ...store, sessions: store.sessions.slice(-MAX_SESSIONS) },
    null,
    2,
  )}\n`;
  if (Buffer.byteLength(body, 'utf-8') > MAX_STORE_BYTES) {
    throw new Error('Collaboration store reached its local size limit.');
  }
  const temp = join(dirname(path), `.collaboration-${randomBytes(8).toString('hex')}.tmp`);
  await fs.writeFile(temp, body, { encoding: 'utf-8', mode: 0o600 });
  try {
    await fs.rename(temp, path);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

function localMember(actorId: string): CollaborationMember {
  return { id: actorId, displayName: 'Local user', role: 'owner', lastSeenAt: Date.now() };
}

function findRootSession(
  store: CollaborationStore,
  root: string,
  id: string,
): CollaborationSession | undefined {
  const fingerprint = rootFingerprint(root);
  return store.sessions.find(
    (session) => session.id === id && session.rootFingerprint === fingerprint,
  );
}

function linkedCloudAbort(signal?: AbortSignal): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  return {
    controller,
    dispose: () => signal?.removeEventListener('abort', onAbort),
  };
}

async function markCloudState(
  root: string,
  id: string,
  cloudState: CollaborationSession['cloudState'],
): Promise<void> {
  await serialize(async () => {
    const store = await readStore();
    const session = findRootSession(store, root, id);
    if (!session) return;
    session.cloudState = cloudState;
    await writeStore(store);
  });
}

async function withTimeout<T>(
  operation: PromiseLike<T>,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new SafeCloudError(message));
    }, CLOUD_TIMEOUT_MS);
  });
  try {
    return await Promise.race([Promise.resolve(operation), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function requireCloudSchemaAttestation(
  client: ReturnType<typeof getSupabase>,
): Promise<void> {
  if (typeof client.rpc !== 'function') {
    throw new SafeCloudError('Collaboration backend attestation is unavailable.');
  }
  const controller = new AbortController();
  const request = client
    .rpc('attest_god_mode_collaboration')
    .abortSignal(controller.signal);
  const { data, error } = await withTimeout(
    request,
    'Collaboration backend attestation timed out.',
    () => controller.abort(),
  );
  if (error || data !== CLOUD_SCHEMA_ATTESTATION) {
    throw new SafeCloudError(
      'Collaboration backend schema and RLS policies are not attested. Apply and verify the migration before sharing.',
    );
  }
}

export async function createCollaborationSession(
  root: string,
  raw: Omit<CreateCollaborationSessionInput, 'root'>,
): Promise<CollaborationSession> {
  const title = boundedText(raw.title, 200);
  if (!title) throw new Error('Collaboration session title is required.');
  return serialize(async () => {
    const store = await readStore();
    const now = Date.now();
    const session: CollaborationSession = {
      id: randomUUID(),
      rootFingerprint: rootFingerprint(root),
      title,
      createdAt: now,
      updatedAt: now,
      members: [localMember(store.deviceActorId)],
      events: [],
      shared: false,
      cloudState: 'local-only',
    };
    store.sessions.push(session);
    await writeStore(store);
    return session;
  });
}

export function listCollaborationSessions(root: string): Promise<CollaborationSession[]> {
  return serialize(async () => {
    const fingerprint = rootFingerprint(root);
    return (await readStore()).sessions
      .filter((session) => session.rootFingerprint === fingerprint)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  });
}

export async function addCollaborationEvent(
  root: string,
  sessionId: unknown,
  raw: unknown,
): Promise<CollaborationSession> {
  const id = typeof sessionId === 'string' ? sessionId : '';
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Collaboration event is required.');
  }
  const value = raw as Record<string, unknown>;
  const kind = EVENT_KINDS.has(value.kind as CollaborationEvent['kind'])
    ? (value.kind as CollaborationEvent['kind'])
    : 'note';
  const text = boundedText(value.text, MAX_EVENT_TEXT);
  if (!id || !text) throw new Error('Session and event text are required.');
  const evidenceIds = Array.isArray(value.evidenceIds)
    ? value.evidenceIds
        .slice(0, 100)
        .map((entry) => boundedText(entry, 200))
        .filter(Boolean)
    : [];
  return serialize(async () => {
    const store = await readStore();
    const session = findRootSession(store, root, id);
    if (!session) throw new Error('Collaboration session was not found.');
    const event: CollaborationEvent = {
      id: randomUUID(),
      sessionId: id,
      actorId: store.deviceActorId,
      kind,
      text,
      createdAt: Date.now(),
      evidenceIds,
    };
    session.events = [...session.events, event].slice(-MAX_EVENTS);
    session.updatedAt = event.createdAt;
    if (session.shared) session.cloudState = 'syncing';
    await writeStore(store);
    return session;
  });
}

function replaceRoot(text: string, root: string): string {
  const canonical = resolve(root);
  const variants = new Set([
    canonical,
    canonical.replaceAll('\\', '/'),
    canonical.replaceAll('/', '\\'),
  ]);
  let output = text;
  for (const variant of variants) {
    if (!variant) continue;
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    output = output.replace(new RegExp(escaped, process.platform === 'win32' ? 'gi' : 'g'), '<workspace>');
  }
  return output;
}

function redactText(value: unknown, root: string, max: number): string {
  return replaceRoot(boundedText(value, max), root)
    .replace(/(?:https?:\/\/)?[^\s/@]+:[^\s/@]+@/gi, '')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(?:gh[opsur]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,})\b/g,
      '[REDACTED]',
    )
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .replace(
      /([?&](?:access[_-]?token|token|secret|password|passwd|api[_-]?key|authorization|signature)=)[^&#\s]*/gi,
      '$1[REDACTED]',
    )
    .replace(
      /\b(api[_-]?key|token|secret|password|passwd|authorization|credential)\b\s*[:=]\s*["']?[^\s"',;]{8,}["']?/gi,
      '$1=[REDACTED]',
    )
    .replace(/\b[A-Za-z]:[\\/][^\s"'`<>]+/g, '<absolute-path>')
    .replace(/\/(?:Users|home|root|tmp|var|opt)\/[^\s"'`<>]+/g, '<absolute-path>')
    .slice(0, max);
}

function redactEvidence(record: EvidenceRecord, root: string): EvidenceRecord {
  let safePath: string | undefined;
  if (record.path) {
    if (isAbsolute(record.path)) {
      const rel = relative(resolve(root), resolve(record.path));
      safePath =
        rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
          ? `<workspace>/${rel.replaceAll('\\', '/')}`.replace(/\/$/, '')
          : '<external-path>';
    } else {
      safePath = redactText(record.path, root, 1_000);
    }
  }
  return {
    ...record,
    id: boundedText(record.id, 200),
    label: redactText(record.label, root, 500),
    summary: redactText(record.summary, root, 4_000),
    ...(safePath ? { path: safePath } : {}),
    ...(record.command ? { command: redactText(record.command, root, 4_000) } : {}),
  };
}

function redactedJobs(jobs: GodModeJob[], root: string, linkedIds: ReadonlySet<string>): GodModeJob[] {
  return jobs
    .filter(
      (job) => linkedIds.has(job.id) || job.evidence.some((item) => linkedIds.has(item.id)),
    )
    .slice(-MAX_EXPORT_JOBS)
    .map((job) => ({
      ...job,
      root: '<workspace>',
      ownerWindowId: null,
      title: redactText(job.title, root, 500),
      summary: redactText(job.summary, root, 10_000),
      error: job.error ? redactText(job.error, root, 4_000) : null,
      evidence: job.evidence
        .filter((item) => linkedIds.has(item.id))
        .slice(-MAX_EXPORT_EVIDENCE)
        .map((item) => redactEvidence(item, root)),
    }));
}

function redactedSession(session: CollaborationSession, root: string): CollaborationSession {
  return {
    ...session,
    rootFingerprint: '<workspace>',
    title: redactText(session.title, root, 200),
    members: session.members.slice(0, MAX_MEMBERS).map((member) => ({
      ...member,
      displayName: redactText(member.displayName, root, 100),
    })),
    events: session.events.slice(-MAX_EVENTS).map((event) => ({
      ...event,
      text: redactText(event.text, root, MAX_EVENT_TEXT),
      evidenceIds: event.evidenceIds
        .slice(0, 100)
        .map((evidenceId) => redactText(evidenceId, root, 200)),
    })),
  };
}

function assertExportBounded(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf-8') > MAX_EXPORT_BYTES) {
    throw new Error('Collaboration export exceeds the 4 MiB safety limit.');
  }
}

export async function exportCollaborationSession(
  root: string,
  sessionId: unknown,
): Promise<CollaborationExport> {
  const id = typeof sessionId === 'string' ? sessionId : '';
  const session = (await listCollaborationSessions(root)).find((item) => item.id === id);
  if (!session) throw new Error('Collaboration session was not found.');
  const linkedIds = new Set(
    session.events.flatMap((event) => event.evidenceIds).map((value) => boundedText(value, 200)),
  );
  const jobs = redactedJobs(await listGodModeJobs(root), root, linkedIds);
  const evidence = jobs.flatMap((job) => job.evidence).slice(-MAX_EXPORT_EVIDENCE);
  const payload: CollaborationExport = {
    schemaVersion: GOD_MODE_SCHEMA_VERSION,
    exportedAt: Date.now(),
    session: redactedSession(session, root),
    jobs,
    evidence,
  };
  assertExportBounded(payload);
  return payload;
}

export interface CollaborationShareApprovalDescriptor {
  digest: string;
  contentDigest: string;
  detail: string;
  payload: CollaborationExport;
}

function collaborationExportDigest(payload: CollaborationExport): string {
  return createHash('sha256')
    .update(JSON.stringify({ ...payload, exportedAt: 0 }))
    .digest('hex');
}

export async function prepareCollaborationShareApproval(
  root: string,
  sessionId: unknown,
): Promise<CollaborationShareApprovalDescriptor> {
  const payload = await exportCollaborationSession(root, sessionId);
  const contentDigest = collaborationExportDigest(payload);
  const counts = {
    members: payload.session.members.length,
    events: payload.session.events.length,
    jobs: payload.jobs.length,
    evidence: payload.evidence.length,
    bytes: Buffer.byteLength(JSON.stringify(payload), 'utf-8'),
  };
  const identity = {
    root,
    sessionId: payload.session.id,
    redactedExportSha256: contentDigest,
    counts,
  };
  return {
    digest: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
    contentDigest,
    detail: JSON.stringify(identity, null, 2),
    payload,
  };
}

export async function shareCollaborationSession(
  root: string,
  sessionId: unknown,
  confirmation: unknown,
  approved: CollaborationShareApprovalDescriptor,
  signal?: AbortSignal,
): Promise<CollaborationSession> {
  signal?.throwIfAborted();
  if (confirmation !== true) throw new Error('Cloud sharing requires explicit confirmation.');
  const id = typeof sessionId === 'string' ? sessionId : '';
  const sourceSession = (await listCollaborationSessions(root)).find((item) => item.id === id);
  if (!sourceSession) throw new Error('Collaboration session was not found.');
  const sourceUpdatedAt = sourceSession.updatedAt;
  const currentPayload = await exportCollaborationSession(root, id);
  if (
    approved.payload.session.id !== id ||
    approved.contentDigest !== collaborationExportDigest(currentPayload)
  ) {
    throw new Error('The redacted collaboration export changed after approval.');
  }
  const payload = approved.payload;
  try {
    const client = getSupabase();
    const { data, error: authError } = await withTimeout(
      client.auth.getUser(),
      'Collaboration authentication timed out.',
    );
    if (authError || !data.user) {
      throw new SafeCloudError('Sign in before sharing a collaboration session.');
    }
    await requireCloudSchemaAttestation(client);
    const cloudBody = {
      title: payload.session.title,
      members: payload.session.members,
      events: payload.session.events,
      jobs: payload.jobs,
      evidence: payload.evidence,
      schema_version: payload.schemaVersion,
    };
    assertExportBounded(cloudBody);
    signal?.throwIfAborted();
    const linked = linkedCloudAbort(signal);
    const request = client
      .from('collaboration_sessions')
      .upsert(
        {
          id: payload.session.id,
          owner_id: data.user.id,
          root_fingerprint: cloudRootFingerprint(payload.session.id),
          body: cloudBody,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' },
      )
      .abortSignal(linked.controller.signal);
    let error: unknown;
    try {
      ({ error } = await withTimeout(
        request,
        'Collaboration sync timed out.',
        () => linked.controller.abort(),
      ));
    } finally {
      linked.dispose();
    }
    signal?.throwIfAborted();
    if (error) {
      throw new SafeCloudError(
        'Collaboration sync failed. Confirm the backend migration and access policy are installed.',
      );
    }
  } catch (error) {
    await markCloudState(root, id, 'error').catch(() => undefined);
    if (error instanceof SafeCloudError) throw error;
    throw new Error('Collaboration cloud service is unavailable. Local session data is unchanged.');
  }
  return serialize(async () => {
    const store = await readStore();
    const session = findRootSession(store, root, id);
    if (!session) throw new Error('Collaboration session was not found.');
    session.shared = true;
    if (session.updatedAt === sourceUpdatedAt) {
      session.cloudState = 'synced';
      session.updatedAt = Date.now();
    } else {
      session.cloudState = 'syncing';
    }
    await writeStore(store);
    return session;
  });
}

export async function addCloudCollaborationMember(
  root: string,
  sessionId: unknown,
  userId: unknown,
  roleValue: unknown,
  confirmation: unknown,
  signal?: AbortSignal,
): Promise<CollaborationSession> {
  signal?.throwIfAborted();
  if (confirmation !== true) throw new Error('Adding a collaborator requires explicit confirmation.');
  const id = typeof sessionId === 'string' ? sessionId : '';
  const memberId = typeof userId === 'string' ? userId.trim().toLowerCase() : '';
  if (!UUID_RE.test(memberId)) throw new Error('Collaborator user id is invalid.');
  if (!MEMBER_ROLES.has(roleValue as CollaborationRole) || roleValue === 'owner') {
    throw new Error('Collaborator role is invalid.');
  }
  const role = roleValue as Exclude<CollaborationRole, 'owner'>;
  const session = (await listCollaborationSessions(root)).find((item) => item.id === id);
  if (!session?.shared) throw new Error('Share the collaboration session before adding members.');
  if (!session.members.some((member) => member.id === memberId) && session.members.length >= MAX_MEMBERS) {
    throw new Error('Collaboration session reached its member limit.');
  }
  try {
    const client = getSupabase();
    const { data, error: authError } = await withTimeout(
      client.auth.getUser(),
      'Collaboration authentication timed out.',
    );
    if (authError || !data.user) {
      throw new SafeCloudError('Sign in before adding collaborators.');
    }
    await requireCloudSchemaAttestation(client);
    if (data.user.id.toLowerCase() === memberId) {
      throw new SafeCloudError('The session owner cannot be added as a collaborator.');
    }
    signal?.throwIfAborted();
    const linked = linkedCloudAbort(signal);
    const request = client
      .from('collaboration_members')
      .upsert({
        session_id: id,
        user_id: memberId,
        role,
        invited_by: data.user.id,
      })
      .abortSignal(linked.controller.signal);
    let error: unknown;
    try {
      ({ error } = await withTimeout(
        request,
        'Collaborator update timed out.',
        () => linked.controller.abort(),
      ));
    } finally {
      linked.dispose();
    }
    signal?.throwIfAborted();
    if (error) {
      throw new SafeCloudError(
        'Could not add the collaborator. Confirm their user id and backend policy.',
      );
    }
  } catch (error) {
    await markCloudState(root, id, 'error').catch(() => undefined);
    if (error instanceof SafeCloudError) throw error;
    throw new Error('Collaboration cloud service is unavailable. Local membership is unchanged.');
  }
  return serialize(async () => {
    const store = await readStore();
    const local = findRootSession(store, root, id);
    if (!local) throw new Error('Collaboration session was not found.');
    const existing = local.members.find((item) => item.id === memberId);
    if (existing) existing.role = role;
    else local.members.push({ id: memberId, displayName: 'Team member', role, lastSeenAt: 0 });
    local.updatedAt = Date.now();
    // The member table is current, while the session export body needs an explicit re-share.
    local.cloudState = 'syncing';
    await writeStore(store);
    return local;
  });
}
