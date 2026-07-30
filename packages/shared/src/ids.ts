/** Cross-runtime identifier helpers (work in Node and the browser). */

interface MaybeCrypto {
  randomUUID?: () => string;
}

/** RFC-4122 v4 UUID, using the platform crypto when available. */
export function generateId(): string {
  const c = (globalThis as { crypto?: MaybeCrypto }).crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

let counter = 0;

/** Short, monotonic-ish id for correlation within a session. */
export function shortId(prefix = ''): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}${Date.now().toString(36)}-${counter.toString(36)}`;
}
