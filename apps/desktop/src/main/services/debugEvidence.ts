import { isAbsolute, relative, resolve } from 'node:path';
import type {
  DebugEvidenceFrame,
  DebugEvidenceScope,
  DebugEvidenceSnapshot,
  DebugEvidenceVariable,
} from '../../common/godMode';
import { boundedText, stableId } from '../../common/godMode';
import { debugScopes, debugStackTrace, debugVariables } from './dap';

const MAX_FRAMES = 8;
const MAX_SCOPES_PER_FRAME = 4;
const MAX_VARIABLES_PER_SCOPE = 25;
const MAX_VARIABLES_TOTAL = 160;
const SECRET_NAME =
  /(?:^|[_\-.])(password|passwd|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key)(?:$|[_\-.])/i;
const SECRET_VALUE =
  /(?:\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b|\bBearer\s+\S+|\b(?:https?|wss?):\/\/[^\s/@:]+:[^\s/@]+@)/gi;

function workspacePath(root: string, rawPath: string | null): string | null {
  if (!rawPath) return null;
  const absolute = resolve(root, rawPath);
  const child = relative(resolve(root), absolute);
  if (!child || child.startsWith('..') || isAbsolute(child)) return child ? null : '.';
  return child.replace(/\\/g, '/');
}

function safeName(value: string): string {
  return boundedText(value.replace(/[\u0000-\u001f\u007f]/g, ' '), 160);
}

function redactValue(name: string, rawValue: string): { value: string; redacted: boolean } {
  if (SECRET_NAME.test(name)) return { value: '[REDACTED]', redacted: true };
  SECRET_VALUE.lastIndex = 0;
  const redacted = SECRET_VALUE.test(rawValue);
  SECRET_VALUE.lastIndex = 0;
  const value = boundedText(
    rawValue.replace(SECRET_VALUE, (match) =>
      /^Bearer\s/i.test(match) ? 'Bearer [REDACTED]' : '[REDACTED]',
    ),
    500,
  );
  return { value, redacted };
}

export async function captureDebugEvidence(
  root: string,
  threadId: number,
): Promise<DebugEvidenceSnapshot> {
  if (!Number.isSafeInteger(threadId) || threadId < 0) {
    throw new Error('A valid debugger thread is required.');
  }

  const capturedAt = Date.now();
  const stack = await debugStackTrace(threadId);
  const selectedFrames = stack.slice(0, MAX_FRAMES);
  const frames: DebugEvidenceFrame[] = [];
  const warnings: string[] = [];
  let remainingVariables = MAX_VARIABLES_TOTAL;
  let redactedValues = 0;
  let truncated = stack.length > selectedFrames.length;

  for (const frame of selectedFrames) {
    const scopes: DebugEvidenceScope[] = [];
    let rawScopes: Awaited<ReturnType<typeof debugScopes>>;
    try {
      rawScopes = await debugScopes(frame.id);
    } catch {
      rawScopes = [];
      warnings.push(`Scopes were unavailable for frame ${frames.length + 1}.`);
    }
    const selectedScopes = rawScopes.slice(0, MAX_SCOPES_PER_FRAME);
    if (selectedScopes.length < rawScopes.length) truncated = true;

    for (const scope of selectedScopes) {
      let rawVariables: Awaited<ReturnType<typeof debugVariables>>;
      try {
        rawVariables = await debugVariables(scope.variablesReference);
      } catch {
        rawVariables = [];
        warnings.push(`Variables were unavailable for scope ${safeName(scope.name)}.`);
      }
      const count = Math.min(MAX_VARIABLES_PER_SCOPE, remainingVariables, rawVariables.length);
      const variables: DebugEvidenceVariable[] = rawVariables.slice(0, count).map((variable) => {
        const name = safeName(variable.name);
        const safe = redactValue(name, variable.value);
        if (safe.redacted) redactedValues += 1;
        return {
          name,
          value: safe.value,
          type: variable.type ? safeName(variable.type) : null,
          hasChildren: variable.variablesReference > 0,
          redacted: safe.redacted,
        };
      });
      remainingVariables -= variables.length;
      const scopeTruncated = variables.length < rawVariables.length;
      truncated ||= scopeTruncated;
      scopes.push({
        name: safeName(scope.name),
        expensive: scope.expensive,
        variables,
        truncated: scopeTruncated,
      });
      if (remainingVariables === 0) break;
    }

    frames.push({
      name: safeName(frame.name),
      workspacePath: workspacePath(root, frame.path),
      line: Math.max(0, Math.trunc(frame.line)),
      column: Math.max(0, Math.trunc(frame.column)),
      scopes,
    });
    if (remainingVariables === 0) break;
  }

  if (frames.length < selectedFrames.length) truncated = true;
  return {
    id: stableId('debug', `${root}\0${threadId}\0${capturedAt}`),
    capturedAt,
    threadId,
    frames,
    frameCount: stack.length,
    truncated,
    redactedValues,
    warnings: warnings.slice(0, 20),
  };
}
