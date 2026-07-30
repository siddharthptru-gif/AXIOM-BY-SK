/**
 * Model action parsing for the agent loop (pure).
 *
 * The loop asks a model to reply with one JSON action. Frontier models comply;
 * smaller open models routinely do not — they wrap the action in prose, put a
 * ```bash or ```js example BEFORE it, or use a different key spelling
 * (`tool_name`, `action`/`action_input`, OpenAI's `function`/`arguments`). The
 * previous parser read only the FIRST fenced block, so a single unrelated example
 * fence made the whole reply unparseable. The loop then treated that as "no
 * action" and finished the run with the model's prose — which is exactly why a
 * request like "build me a game" came back as a tutorial instead of files.
 *
 * This parser tries every plausible JSON candidate in the reply and accepts the
 * common key spellings. It grants NO new authority: a parsed action still passes
 * through tool resolution, the approval policy, path containment, and the native
 * approval preview. Tolerance here only means the agent gets to attempt work.
 *
 * Pure: no I/O, no Electron. Safe in Main or the renderer.
 */
import { balancedJsonSlices, stripReasoning } from './modelText';

export type AgentAction =
  | { kind: 'tool'; tool: string; args: Record<string, unknown> }
  | { kind: 'final'; answer: string }
  | { kind: 'none' };

/** Unambiguous tool-name keys: accepted without cross-checking the tool registry. */
const EXPLICIT_TOOL_KEYS = ['tool', 'tool_name', 'toolName'] as const;
/**
 * Ambiguous tool-name keys. `name` and `action` appear constantly in ordinary JSON
 * examples, so these are honoured only when the value is a registered tool —
 * otherwise a code sample like `{"name": "phaser"}` would become a bogus call.
 */
const AMBIGUOUS_TOOL_KEYS = ['action', 'name'] as const;
const ARG_KEYS = [
  'args',
  'arguments',
  'parameters',
  'params',
  'action_input',
  'actionInput',
  'tool_input',
  'toolInput',
  'input',
] as const;
const FINAL_KEYS = ['final', 'final_answer', 'finalAnswer'] as const;
/** Keys that wrap the real action one level down. */
const WRAPPER_KEYS = ['action', 'tool_call', 'toolCall', 'function', 'command'] as const;

const RESERVED_KEYS = new Set<string>([
  ...EXPLICIT_TOOL_KEYS,
  ...AMBIGUOUS_TOOL_KEYS,
  ...ARG_KEYS,
  ...FINAL_KEYS,
  ...WRAPPER_KEYS,
  'thought',
  'reasoning',
  'observation',
  'type',
  'id',
]);

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_./-]{0,63}$/;
/** Bound how many JSON candidates one reply may cost us. */
const MAX_CANDIDATES = 16;
const FENCE = /```[A-Za-z0-9_+-]*\s*([\s\S]*?)```/g;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Every substring of the reply that might be the action object.
 *
 * Reasoning is removed FIRST. A reasoning-capable model routinely rehearses the
 * action inside `<think>` ("We will issue: {"tool":"write_file","args":{…}}"), and
 * that rehearsal is deliberately not valid JSON. The previous implementation took
 * the widest brace slice via `indexOf('{')`/`lastIndexOf('}')`, so it spanned from
 * inside the reasoning to the end of the real action and failed to parse — every
 * candidate did. The run was then treated as "no usable action", printed the raw
 * reply, and the file the user asked for was never written.
 *
 * Candidates now come from a string-aware balanced-brace scan, which also survives
 * an action whose payload contains braces (any file content with a function body).
 */
function jsonCandidates(text: string): string[] {
  const cleaned = stripReasoning(text);
  const sources: string[] = [];
  FENCE.lastIndex = 0;
  for (let match = FENCE.exec(cleaned); match !== null; match = FENCE.exec(cleaned)) {
    const body = match[1];
    if (body && body.trim().length > 0) sources.push(body);
    if (sources.length >= MAX_CANDIDATES) break;
  }
  // The unfenced reply matters too: many models emit bare JSON, or prose then JSON.
  sources.push(cleaned);

  const candidates: string[] = [];
  const push = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || candidates.length >= MAX_CANDIDATES) return;
    if (!candidates.includes(trimmed)) candidates.push(trimmed);
  };
  for (const source of sources) {
    push(source);
    for (const slice of balancedJsonSlices(source, MAX_CANDIDATES)) push(slice);
  }
  return candidates;
}

/** Arguments may arrive as an object or, in OpenAI tool-call shape, a JSON string. */
function argsFrom(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (record) return record;
  const text = nonEmptyString(value);
  if (!text || !text.startsWith('{')) return null;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function toolNameFrom(
  record: Record<string, unknown>,
  knownTools: ReadonlySet<string> | null,
): string | null {
  for (const key of EXPLICIT_TOOL_KEYS) {
    const name = nonEmptyString(record[key]);
    if (name && TOOL_NAME.test(name)) return name;
  }
  for (const key of AMBIGUOUS_TOOL_KEYS) {
    const name = nonEmptyString(record[key]);
    if (!name || !TOOL_NAME.test(name)) continue;
    // Without a registry we cannot tell a tool name from sample data, so an
    // ambiguous key is ignored rather than guessed at.
    if (knownTools?.has(name)) return name;
  }
  return null;
}

function actionFromRecord(
  record: Record<string, unknown>,
  knownTools: ReadonlySet<string> | null,
  depth = 0,
): AgentAction {
  for (const key of FINAL_KEYS) {
    const answer = nonEmptyString(record[key]);
    if (answer) return { kind: 'final', answer };
  }

  const tool = toolNameFrom(record, knownTools);
  if (tool) {
    for (const key of ARG_KEYS) {
      const args = argsFrom(record[key]);
      if (args) return { kind: 'tool', tool, args };
    }
    // Flattened form: `{"tool":"write_file","path":"a.ts","content":"…"}`.
    const inline: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (!RESERVED_KEYS.has(key)) inline[key] = value;
    }
    return { kind: 'tool', tool, args: inline };
  }

  if (depth < 2) {
    for (const key of WRAPPER_KEYS) {
      const nested = asRecord(record[key]);
      if (!nested) continue;
      const inner = actionFromRecord(nested, knownTools, depth + 1);
      if (inner.kind !== 'none') return inner;
    }
  }
  return { kind: 'none' };
}

/**
 * Classify a model reply into a tool call, a final answer, or neither.
 *
 * `knownTools` is the run's registered tool names. Supplying it lets ambiguous key
 * spellings be honoured safely; omitting it simply makes parsing stricter.
 */
export function parseModelAction(text: string, knownTools?: readonly string[]): AgentAction {
  if (typeof text !== 'string' || text.trim().length === 0) return { kind: 'none' };
  const registry = knownTools && knownTools.length > 0 ? new Set(knownTools) : null;
  let firstFinal: AgentAction | null = null;
  for (const candidate of jsonCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (!record) continue;
    const action = actionFromRecord(record, registry, 0);
    // A tool call anywhere in the reply outranks a final answer: a model that
    // narrates a conclusion and then calls a tool still intends to do the work.
    if (action.kind === 'tool') return action;
    if (action.kind === 'final' && !firstFinal) firstFinal = action;
  }
  return firstFinal ?? { kind: 'none' };
}

/**
 * The exact reminder sent when a reply carried no usable action. Kept here so the
 * required shape is stated in one place and matches what the parser accepts.
 */
export function protocolRepairMessage(toolNames: readonly string[]): string {
  const names = toolNames.slice(0, 24).join(', ');
  return [
    'Your last reply contained no usable action, so nothing happened.',
    'Reply with exactly ONE JSON object and no other text.',
    'To act: {"tool":"<name>","args":{ … }}',
    'To finish: {"final":"<your answer>"}',
    `Available tools: ${names}.`,
    'Do not explain how the user could do it themselves — use the tools to do it.',
  ].join(' ');
}
