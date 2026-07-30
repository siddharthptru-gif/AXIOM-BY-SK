import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AiConversation, AiConversationMutation, ChatMessage } from '../../common/ipc';

/**
 * Local conversation store. Reads distinguish a missing file from corruption or
 * I/O failure; mutations are serialized and scoped so one window/connection can
 * never replace unrelated records with a stale whole-store snapshot.
 */
function filePath(): string {
  return join(app.getPath('userData'), 'ai-conversations.json');
}

function sanitizeMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  const out: ChatMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    if (
      (o.role === 'system' || o.role === 'user' || o.role === 'assistant') &&
      typeof o.content === 'string'
    ) {
      out.push({ role: o.role, content: o.content });
    }
  }
  return out;
}

function sanitizeConversation(value: unknown): AiConversation | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0) return null;
  const now = Date.now();
  return {
    id: o.id,
    title: typeof o.title === 'string' && o.title.length > 0 ? o.title : 'Untitled',
    createdAt: typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : now,
    updatedAt: typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt) ? o.updatedAt : now,
    messages: sanitizeMessages(o.messages),
    ...(typeof o.scopeId === 'string' && o.scopeId.length > 0 ? { scopeId: o.scopeId } : {}),
    ...(o.pinned === true ? { pinned: true } : {}),
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === code;
}

async function quarantineCorruptStore(path: string): Promise<string | null> {
  const quarantine = `${path}.corrupt-${Date.now()}`;
  try {
    await fs.rename(path, quarantine);
    return quarantine;
  } catch {
    return null;
  }
}

async function readStore(): Promise<AiConversation[]> {
  const path = filePath();
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return [];
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const quarantine = await quarantineCorruptStore(path);
    throw new Error(
      quarantine
        ? `Conversation data was unreadable and preserved at ${quarantine}.`
        : 'Conversation data is unreadable and could not be quarantined.',
      { cause: error },
    );
  }
  if (!Array.isArray(parsed)) {
    const quarantine = await quarantineCorruptStore(path);
    throw new Error(
      quarantine
        ? `Conversation data had an invalid shape and was preserved at ${quarantine}.`
        : 'Conversation data has an invalid shape and could not be quarantined.',
    );
  }

  const out: AiConversation[] = [];
  for (const item of parsed) {
    const conversation = sanitizeConversation(item);
    if (conversation) out.push(conversation);
  }
  return out;
}

async function writeStore(list: readonly AiConversation[]): Promise<void> {
  const path = filePath();
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.axiom-aiconv-${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(list, null, 2), 'utf-8');
  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

let mutationTail: Promise<void> = Promise.resolve();

function serializeMutation<T>(run: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(run, run);
  mutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** All persisted conversations after earlier mutations have reached disk. */
export async function readConversations(): Promise<AiConversation[]> {
  await mutationTail;
  return readStore();
}

/**
 * Full-store replacement is intentionally disabled: it cannot express deletion
 * without racing other windows/scopes. Kept only as an explicit compatibility
 * failure for older preload clients; current callers use scoped mutations.
 */
export function writeConversations(_list: unknown): Promise<void> {
  return Promise.reject(
    new Error('Full conversation replacement is disabled; use scoped mutations.'),
  );
}

/** Apply one trusted, scope-local mutation and return that scope's latest list. */
export function mutateConversations(mutation: AiConversationMutation): Promise<AiConversation[]> {
  if (!mutation.scopeId) return Promise.reject(new Error('Conversation scope is required.'));
  return serializeMutation(async () => {
    const current = await readStore();
    let next: AiConversation[];

    switch (mutation.kind) {
      case 'upsert': {
        const sanitized = sanitizeConversation(mutation.conversation);
        if (!sanitized) throw new Error('Invalid conversation.');
        const conversation: AiConversation = { ...sanitized, scopeId: mutation.scopeId };
        next = [
          conversation,
          ...current.filter(
            (candidate) =>
              candidate.id !== conversation.id || candidate.scopeId !== mutation.scopeId,
          ),
        ];
        break;
      }
      case 'delete':
        next = current.filter(
          (conversation) =>
            conversation.scopeId !== mutation.scopeId || conversation.id !== mutation.id,
        );
        break;
      case 'clear':
        next = current.filter((conversation) => conversation.scopeId !== mutation.scopeId);
        break;
      case 'migrateLegacy':
        next = current.map((conversation) =>
          conversation.scopeId ? conversation : { ...conversation, scopeId: mutation.scopeId },
        );
        break;
    }

    await writeStore(next);
    return next
      .filter((conversation) => conversation.scopeId === mutation.scopeId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  });
}
