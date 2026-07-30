// Streamed tool-call & reasoning assembler (PRD Epoch F / Phase 148). Pure — no
// I/O, no Electron — so it is safe to import in Main or the renderer and simple
// to unit-test.
//
// Providers stream a tool call as a *sequence of fragments*: the first fragment
// for a given `index` carries the call `id` and function `name`, and subsequent
// fragments append more of the (partial-JSON) `arguments` string. Reasoning
// models additionally interleave "thinking" tokens that must be kept separate
// from the visible answer. This module normalizes a raw provider chunk into flat
// `StreamDelta`s and folds a delta sequence into a finalized result: merged tool
// calls (arguments concatenated in arrival order, then JSON-parsed), the answer
// text, and the reasoning text.

/** A normalized streamed event. Adapters map each raw chunk to zero or more. */
export type StreamDelta =
  | { kind: 'content'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool_call'; index: number; id?: string; name?: string; args?: string }
  | { kind: 'finish'; reason?: string };

/**
 * Normalize provider text payloads. OpenAI-compatible APIs may return content as
 * a string, an array of typed text parts, or a nested `{ text: { value } }`
 * object. Keep this pure and bounded so both streaming and completed responses
 * share the same compatibility behavior without accepting arbitrary metadata.
 */
export function textFromProviderContent(value: unknown, depth = 0): string {
  if (depth > 4 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((part) => textFromProviderContent(part, depth + 1)).join('');
  }
  if (typeof value !== 'object') return '';

  const record = value as Record<string, unknown>;
  for (const key of ['text', 'value', 'content', 'output_text'] as const) {
    const text = textFromProviderContent(record[key], depth + 1);
    if (text.length > 0) return text;
  }
  return '';
}

/** A finalized tool call, merged from its streamed fragments. */
export interface ToolCall {
  index: number;
  id: string;
  name: string;
  /** Raw concatenated arguments string (may or may not be valid JSON). */
  arguments: string;
  /** Parsed arguments when `arguments` is a valid JSON object, else null. */
  parsed: Record<string, unknown> | null;
  /** True when `arguments` parsed as a JSON object. */
  valid: boolean;
}

/** The finalized result of folding a whole delta stream. */
export interface AssembledStream {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
}

/**
 * Parse a concatenated tool-call arguments string. Valid only when it is a JSON
 * object (`{...}`); empty / partial / non-object payloads are reported invalid
 * so callers never dispatch a half-streamed or malformed tool call.
 */
export function parseToolArguments(args: string): {
  parsed: Record<string, unknown> | null;
  valid: boolean;
} {
  const trimmed = args.trim();
  if (trimmed.length === 0) return { parsed: null, valid: false };
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return { parsed: value as Record<string, unknown>, valid: true };
    }
    return { parsed: null, valid: false };
  } catch {
    return { parsed: null, valid: false };
  }
}

/**
 * Fold a delta sequence into a finalized stream: concatenate content and
 * reasoning text, merge tool-call fragments by `index` (first non-empty id/name
 * wins; arguments concatenated in order), and keep the last finish reason. Tool
 * calls come back sorted by index.
 */
export function assembleStream(deltas: StreamDelta[]): AssembledStream {
  let content = '';
  let reasoning = '';
  let finishReason: string | null = null;
  const byIndex = new Map<number, { index: number; id: string; name: string; args: string }>();

  for (const d of deltas) {
    switch (d.kind) {
      case 'content':
        content += d.text;
        break;
      case 'reasoning':
        reasoning += d.text;
        break;
      case 'finish':
        if (d.reason !== undefined) finishReason = d.reason;
        break;
      case 'tool_call': {
        let tc = byIndex.get(d.index);
        if (!tc) {
          tc = { index: d.index, id: '', name: '', args: '' };
          byIndex.set(d.index, tc);
        }
        if (d.id !== undefined && d.id.length > 0) tc.id = d.id;
        if (d.name !== undefined && d.name.length > 0) tc.name = d.name;
        if (d.args !== undefined) tc.args += d.args;
        break;
      }
    }
  }

  const toolCalls: ToolCall[] = [...byIndex.values()]
    .sort((a, b) => a.index - b.index)
    .map((tc) => {
      const { parsed, valid } = parseToolArguments(tc.args);
      return { index: tc.index, id: tc.id, name: tc.name, arguments: tc.args, parsed, valid };
    });

  return { content, reasoning, toolCalls, finishReason };
}

/**
 * Normalize one parsed OpenAI-style streaming chunk (`choices[0].delta`) into
 * flat deltas. Tolerant of unknown shapes — anything unrecognized yields no
 * deltas. Recognizes `reasoning` / `reasoning_content` for reasoning models.
 */
export function deltasFromOpenAIChunk(chunk: unknown): StreamDelta[] {
  const out: StreamDelta[] = [];
  if (chunk === null || typeof chunk !== 'object') return out;
  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return out;
  const first = choices[0];
  if (first === null || typeof first !== 'object') return out;
  const choice = first as { delta?: unknown; finish_reason?: unknown };

  const delta = choice.delta;
  if (delta !== null && typeof delta === 'object') {
    const d = delta as {
      content?: unknown;
      reasoning?: unknown;
      reasoning_content?: unknown;
      tool_calls?: unknown;
    };
    const content = textFromProviderContent(d.content);
    if (content.length > 0) {
      out.push({ kind: 'content', text: content });
    }
    const reasoningText =
      typeof d.reasoning === 'string'
        ? d.reasoning
        : typeof d.reasoning_content === 'string'
          ? d.reasoning_content
          : '';
    if (reasoningText.length > 0) out.push({ kind: 'reasoning', text: reasoningText });
    if (Array.isArray(d.tool_calls)) {
      for (const raw of d.tool_calls) {
        if (raw === null || typeof raw !== 'object') continue;
        const tc = raw as { index?: unknown; id?: unknown; function?: unknown };
        const index = typeof tc.index === 'number' ? tc.index : 0;
        const fn =
          tc.function !== null && typeof tc.function === 'object'
            ? (tc.function as { name?: unknown; arguments?: unknown })
            : {};
        const id = typeof tc.id === 'string' ? tc.id : undefined;
        const name = typeof fn.name === 'string' ? fn.name : undefined;
        const args = typeof fn.arguments === 'string' ? fn.arguments : undefined;
        out.push({
          kind: 'tool_call',
          index,
          ...(id !== undefined ? { id } : {}),
          ...(name !== undefined ? { name } : {}),
          ...(args !== undefined ? { args } : {}),
        });
      }
    }
  }

  const fr = choice.finish_reason;
  if (typeof fr === 'string' && fr.length > 0) out.push({ kind: 'finish', reason: fr });
  return out;
}

/**
 * Incremental SSE decoder. It follows the event-stream framing rules: physical
 * `data:` fields are joined with newlines and emitted only at the blank event
 * delimiter. `finish()` also flushes a provider's final unterminated event.
 */
export interface SseDataParser {
  push(chunk: string): void;
  finish(): void;
}

export function createSseDataParser(onData: (data: string) => void): SseDataParser {
  let buffer = '';
  let dataLines: string[] = [];

  const emitEvent = (): void => {
    if (dataLines.length === 0) return;
    onData(dataLines.join('\n'));
    dataLines = [];
  };

  const consumeLine = (rawLine: string): void => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) {
      emitEvent();
      return;
    }
    if (line.startsWith(':')) return;
    if (line === 'data') {
      dataLines.push('');
      return;
    }
    if (!line.startsWith('data:')) return;
    const value = line.slice(5);
    dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
  };

  const drain = (): void => {
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      consumeLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  };

  return {
    push(chunk: string): void {
      buffer += chunk;
      drain();
    },
    finish(): void {
      drain();
      if (buffer.length > 0) {
        consumeLine(buffer);
        buffer = '';
      }
      emitEvent();
    },
  };
}
