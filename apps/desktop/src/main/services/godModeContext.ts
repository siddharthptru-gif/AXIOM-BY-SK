import { randomUUID } from 'node:crypto';
import type {
  ContextEvalCase,
  ContextEvalCaseResult,
  ContextEvalSuiteResult,
  ContextIntelligenceInput,
  ContextIntelligenceReport,
} from '../../common/godMode';
import { scoreContextQuality, summarizeContextEvals } from '../../common/godMode';
import { buildContext } from './contextBuilder';
import { assertAuthorizedPath } from './pathAuthorization';
import { resolveWithinWorkspaceRoot } from './workspaceContainment';

const MAX_EVAL_CASES = 25;
const MAX_QUERY_CHARS = 4_000;
const MAX_EXPECTED_PATHS = 100;

function queryOf(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Context query must be a string.');
  const query = value.trim().slice(0, MAX_QUERY_CHARS);
  if (!query) throw new Error('Enter a context question or coding goal.');
  return query;
}

function expectedPathsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string'))]
    .map((item) => item.trim().replace(/\\/g, '/').slice(0, 1_024))
    .filter(Boolean)
    .slice(0, MAX_EXPECTED_PATHS);
}

function boundedPositive(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(max, Math.floor(value))
    : fallback;
}

async function authorizedActivePath(root: string, value: unknown): Promise<string | undefined> {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const candidate = resolveWithinWorkspaceRoot(root, value.trim());
  if (!candidate) throw new Error('Context active path must remain inside the workspace.');
  try {
    return await assertAuthorizedPath(candidate);
  } catch {
    throw new Error('Context active path must be an existing workspace path.');
  }
}

export async function inspectContext(
  root: string,
  raw: Omit<ContextIntelligenceInput, 'root'>,
  signal?: AbortSignal,
): Promise<ContextIntelligenceReport> {
  signal?.throwIfAborted();
  const query = queryOf(raw.query);
  const expectedPaths = expectedPathsOf(raw.expectedPaths);
  const activePath = await authorizedActivePath(root, raw.activePath);
  signal?.throwIfAborted();
  const startedAt = Date.now();
  const context = await buildContext(
    {
      root,
      query,
      ...(activePath ? { activePath } : {}),
      budgetTokens: boundedPositive(raw.budgetTokens, 12_000, 100_000),
      topK: boundedPositive(raw.topK, 16, 100),
    },
    signal,
  );
  signal?.throwIfAborted();
  const quality = scoreContextQuality(context.sources, expectedPaths);
  return {
    id: randomUUID(),
    query,
    createdAt: startedAt,
    durationMs: Date.now() - startedAt,
    tokensEstimated: context.tokensEstimated,
    truncated: context.truncated,
    citations: context.sources.map((source, index) => ({
      ...source,
      id: `${index + 1}:${source.rel}:${source.startLine}-${source.endLine}`,
      included: true,
    })),
    quality,
    contextText: context.text,
  };
}

function evalCaseOf(value: unknown, index: number): ContextEvalCase {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Evaluation case ${index + 1} is invalid.`);
  }
  const record = value as Record<string, unknown>;
  const id =
    typeof record.id === 'string' && record.id.trim()
      ? record.id.trim().slice(0, 100)
      : `case-${index + 1}`;
  const query = queryOf(record.query);
  const expectedPaths = expectedPathsOf(record.expectedPaths);
  if (expectedPaths.length === 0) {
    throw new Error(`Evaluation case "${id}" must name at least one expected path.`);
  }
  return {
    id,
    query,
    expectedPaths,
    ...(typeof record.activePath === 'string' && record.activePath.trim()
      ? { activePath: record.activePath.trim() }
      : {}),
  };
}

export async function evaluateContextSuite(
  root: string,
  rawCases: unknown,
  signal?: AbortSignal,
): Promise<ContextEvalSuiteResult> {
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    throw new Error('Add at least one context evaluation case.');
  }
  if (rawCases.length > MAX_EVAL_CASES) {
    throw new Error(`Context evaluation suites are limited to ${MAX_EVAL_CASES} cases.`);
  }
  const cases = rawCases.map(evalCaseOf);
  const results: ContextEvalCaseResult[] = [];
  for (const item of cases) {
    signal?.throwIfAborted();
    const report = await inspectContext(
      root,
      {
        query: item.query,
        expectedPaths: item.expectedPaths,
        ...(item.activePath ? { activePath: item.activePath } : {}),
      },
      signal,
    );
    results.push({
      id: item.id,
      quality: report.quality,
      durationMs: report.durationMs,
      tokensEstimated: report.tokensEstimated,
    });
  }
  return summarizeContextEvals(results);
}
