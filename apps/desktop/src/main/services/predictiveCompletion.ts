import type {
  PredictionFeedback,
  PredictionMetrics,
  PredictiveCompletionInput,
  PredictiveCompletionResult,
} from '../../common/godMode';
import { summarizePredictionMetrics } from '../../common/godMode';
import { CompletionCache, completionCacheKey } from '../../common/completion';

interface ActivePrediction {
  ownerId: number;
  root: string | null;
  requestId: string;
  documentUri: string;
  controller: AbortController;
}

interface IssuedPrediction {
  ownerId: number;
  root: string | null;
  requestId: string;
  textLength: number;
  decided: boolean;
  at: number;
}

const MAX_ACTIVE_PER_OWNER = 8;
const MAX_ACTIVE_GLOBAL = 64;
const active = new Map<string, ActivePrediction>();
const latestByDocument = new Map<string, string>();
const issued = new Map<string, IssuedPrediction>();
const cache = new CompletionCache(500, 90_000);
const latencies: number[] = [];
const counters = {
  requested: 0,
  completed: 0,
  cacheHits: 0,
  stale: 0,
  accepted: 0,
  partial: 0,
  dismissed: 0,
};

function ownerRequestKey(ownerId: number, requestId: string): string {
  return `${ownerId}:${requestId}`;
}

function ownerDocumentKey(ownerId: number, documentUri: string): string {
  return `${ownerId}:${documentUri}`;
}

function pruneIssued(now = Date.now()): void {
  for (const [key, value] of issued) {
    if (now - value.at > 10 * 60_000) issued.delete(key);
  }
  while (issued.size > 2_000) {
    const key = issued.keys().next().value;
    if (key === undefined) break;
    issued.delete(key);
  }
}

function validateInput(input: PredictiveCompletionInput): void {
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(input.requestId)) throw new Error('Completion request id is invalid.');
  if (!Number.isSafeInteger(input.documentVersion) || input.documentVersion < 1) {
    throw new Error('Completion document version is invalid.');
  }
  if (input.prefix.length > 8_000 || input.suffix.length > 4_000) {
    throw new Error('Completion context exceeded the size limit.');
  }
  if (input.documentUri.length === 0 || input.documentUri.length > 4_096) {
    throw new Error('Completion document URI is invalid.');
  }
  if (input.language.length > 100) throw new Error('Completion language id is invalid.');
}

export async function runPredictiveCompletion(
  ownerId: number,
  input: PredictiveCompletionInput,
  cacheScope: string,
  run: (signal: AbortSignal) => Promise<string>,
  root: string | null = null,
): Promise<PredictiveCompletionResult> {
  validateInput(input);
  pruneIssued();
  const requestKey = ownerRequestKey(ownerId, input.requestId);
  if (active.has(requestKey)) throw new Error('Completion request id is already active.');
  if (active.size >= MAX_ACTIVE_GLOBAL) {
    throw new Error('Too many completion requests are active. Try again shortly.');
  }
  let ownerActive = 0;
  for (const item of active.values()) if (item.ownerId === ownerId) ownerActive++;
  if (ownerActive >= MAX_ACTIVE_PER_OWNER) {
    throw new Error('This window has too many active completion requests.');
  }
  counters.requested++;
  const documentKey = ownerDocumentKey(ownerId, input.documentUri);
  const previousId = latestByDocument.get(documentKey);
  if (previousId) active.get(ownerRequestKey(ownerId, previousId))?.controller.abort();
  latestByDocument.set(documentKey, input.requestId);
  const controller = new AbortController();
  const record: ActivePrediction = {
    ownerId,
    root,
    requestId: input.requestId,
    documentUri: input.documentUri,
    controller,
  };
  active.set(requestKey, record);
  const startedAt = Date.now();
  const cacheKey = `${cacheScope}\0${completionCacheKey(input.prefix, input.suffix, input.language)}`;
  let cached = false;
  try {
    let text = cache.get(cacheKey);
    if (text !== null) {
      cached = true;
      counters.cacheHits++;
    } else {
      text = await run(controller.signal);
      if (!controller.signal.aborted && text) cache.set(cacheKey, text);
    }
    const elapsedMs = Date.now() - startedAt;
    const stale =
      controller.signal.aborted || latestByDocument.get(documentKey) !== input.requestId;
    counters.completed++;
    if (stale) counters.stale++;
    latencies.push(elapsedMs);
    if (latencies.length > 2_000) latencies.splice(0, latencies.length - 2_000);
    const output = stale ? '' : text;
    issued.set(requestKey, {
      ownerId,
      root,
      requestId: input.requestId,
      textLength: output.length,
      decided: stale,
      at: Date.now(),
    });
    return {
      requestId: input.requestId,
      documentVersion: input.documentVersion,
      text: output,
      elapsedMs,
      cached,
      stale,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      counters.completed++;
      counters.stale++;
      return {
        requestId: input.requestId,
        documentVersion: input.documentVersion,
        text: '',
        elapsedMs: Date.now() - startedAt,
        cached,
        stale: true,
      };
    }
    throw error;
  } finally {
    if (active.get(requestKey) === record) active.delete(requestKey);
    if (latestByDocument.get(documentKey) === input.requestId) {
      latestByDocument.delete(documentKey);
    }
  }
}

export function cancelPredictiveCompletion(ownerId: number, requestId: unknown): void {
  if (typeof requestId !== 'string') return;
  active.get(ownerRequestKey(ownerId, requestId))?.controller.abort();
}

export function recordPredictionFeedback(ownerId: number, raw: PredictionFeedback): void {
  const key = ownerRequestKey(ownerId, raw.requestId);
  const item = issued.get(key);
  if (!item || item.ownerId !== ownerId || item.decided) return;
  item.decided = true;
  item.at = Date.now();
  if (raw.kind === 'accepted') counters.accepted++;
  else if (raw.kind === 'accepted-partial') counters.partial++;
  else if (raw.kind === 'dismissed') counters.dismissed++;
  else counters.stale++;
}

export function predictionMetrics(): PredictionMetrics {
  return summarizePredictionMetrics(latencies, counters);
}


export function cancelPredictionsForWorkspace(root: string): void {
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  const matches = (candidate: string | null): boolean =>
    candidate !== null && (process.platform === 'win32' ? candidate.toLowerCase() : candidate) === key;
  for (const record of active.values()) {
    if (matches(record.root)) record.controller.abort();
  }
  for (const [requestKey, item] of issued) {
    if (matches(item.root)) issued.delete(requestKey);
  }
  for (const [documentKey, requestId] of latestByDocument) {
    const ownerPrefix = documentKey.indexOf(':');
    const ownerId = Number(documentKey.slice(0, ownerPrefix));
    const record = active.get(ownerRequestKey(ownerId, requestId));
    if (record && matches(record.root)) latestByDocument.delete(documentKey);
  }
}

export function cancelPredictionsForOwner(ownerId: number): void {
  for (const record of active.values()) if (record.ownerId === ownerId) record.controller.abort();
  for (const [key, item] of issued) if (item.ownerId === ownerId) issued.delete(key);
  const prefix = `${ownerId}:`;
  for (const key of latestByDocument.keys()) {
    if (key.startsWith(prefix)) latestByDocument.delete(key);
  }
}

export function cancelAllPredictions(): void {
  for (const record of active.values()) record.controller.abort();
  active.clear();
  latestByDocument.clear();
  issued.clear();
  cache.clear();
}
