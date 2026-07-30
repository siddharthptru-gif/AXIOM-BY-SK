/**
 * MCP (Model Context Protocol) client core (PRD Epoch H §80.3 / Phase 237). Pure
 * protocol logic: JSON-RPC 2.0 message framing (newline-delimited over stdio),
 * request builders (initialize / tools.list / tools.call), response parsers, tool
 * namespacing into the agent registry, an untrusted-output sanitizer, config
 * validation, and the permission-broker decision. No I/O — the Main service owns
 * the child-process transport and calls these. Unit-smoke-tested.
 *
 * SECURITY (INV): MCP servers are third-party. Their tool output is treated as
 * DATA (never executed), calls are permission-brokered + approval-gated, and
 * servers default to DISABLED.
 */
export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_TOOL_PREFIX = 'mcp';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

// ---- framing (newline-delimited JSON over stdio) ----------------------------

/** Encode a JSON-RPC message as a single newline-delimited line. */
export function encodeMessage(msg: JsonRpcRequest | JsonRpcNotification): string {
  return `${JSON.stringify(msg)}\n`;
}

/** A streaming decoder that buffers stdout and yields complete JSON messages. */
export function createNdjsonDecoder(): { push: (chunk: string) => unknown[] } {
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
            /* ignore partial/garbage lines */
          }
        }
        idx = buffer.indexOf('\n');
      }
      return out;
    },
  };
}

// ---- request builders -------------------------------------------------------

export function buildInitialize(id: number): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'Axiom', version: '1.0.0' },
    },
  };
}

/** The notification sent after a successful initialize handshake. */
export function buildInitializedNotification(): JsonRpcNotification {
  return { jsonrpc: '2.0', method: 'notifications/initialized' };
}

export function buildToolsList(id: number): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method: 'tools/list' };
}

export function buildToolsCall(
  id: number,
  name: string,
  args: Record<string, unknown>,
): JsonRpcRequest {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

// ---- response parsers -------------------------------------------------------

function resultOf(msg: unknown): Record<string, unknown> | null {
  if (!msg || typeof msg !== 'object') return null;
  const r = (msg as Record<string, unknown>).result;
  return r && typeof r === 'object' ? (r as Record<string, unknown>) : null;
}

/** True if the message is a JSON-RPC response for the given request id. */
export function isResponseFor(msg: unknown, id: number): boolean {
  return !!msg && typeof msg === 'object' && (msg as Record<string, unknown>).id === id;
}

/** Extract a JSON-RPC error, if the message carries one. */
export function parseRpcError(msg: unknown): { code: number; message: string } | null {
  if (!msg || typeof msg !== 'object') return null;
  const e = (msg as Record<string, unknown>).error;
  if (!e || typeof e !== 'object') return null;
  const eo = e as Record<string, unknown>;
  return {
    code: typeof eo.code === 'number' ? eo.code : -1,
    message: typeof eo.message === 'string' ? eo.message : 'MCP error',
  };
}

export interface McpServerInfo {
  serverName: string;
  version: string;
  protocolVersion: string;
}

export function parseInitializeResult(msg: unknown): McpServerInfo | null {
  const r = resultOf(msg);
  if (!r) return null;
  const info = (r.serverInfo ?? {}) as Record<string, unknown>;
  return {
    serverName: typeof info.name === 'string' ? info.name : 'mcp-server',
    version: typeof info.version === 'string' ? info.version : '',
    protocolVersion: typeof r.protocolVersion === 'string' ? r.protocolVersion : '',
  };
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export const MAX_MCP_TOOLS = 64;
export const MAX_MCP_TOOL_NAME_CHARS = 128;
export const MAX_MCP_TOOL_DESCRIPTION_CHARS = 512;
export const MAX_MCP_TOOL_SCHEMA_CHARS = 2_000;

function boundedInputSchema(value: unknown): unknown {
  try {
    const encoded = JSON.stringify(value ?? {});
    return encoded.length <= MAX_MCP_TOOL_SCHEMA_CHARS ? (value ?? {}) : {};
  } catch {
    return {};
  }
}

/** Sanitize a `tools/list` result into a bounded tool array (drops malformed entries). */
export function parseToolsListResult(msg: unknown): McpTool[] {
  const r = resultOf(msg);
  const tools = r?.tools;
  if (!Array.isArray(tools)) return [];
  const out: McpTool[] = [];
  for (const t of tools.slice(0, MAX_MCP_TOOLS)) {
    if (!t || typeof t !== 'object') continue;
    const to = t as Record<string, unknown>;
    if (typeof to.name !== 'string') continue;
    const name = to.name.trim();
    if (name.length === 0 || name.length > MAX_MCP_TOOL_NAME_CHARS) continue;
    out.push({
      name,
      description:
        typeof to.description === 'string'
          ? to.description.slice(0, MAX_MCP_TOOL_DESCRIPTION_CHARS)
          : '',
      inputSchema: boundedInputSchema(to.inputSchema),
    });
  }
  return out;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

/** Extract the text content from a `tools/call` result (content is untrusted data). */
export function parseToolsCallResult(msg: unknown): McpCallResult {
  const r = resultOf(msg);
  const isError = r?.isError === true;
  const content = r?.content;
  let text = '';
  if (Array.isArray(content)) {
    text = content
      .filter(
        (c): c is { type: string; text: string } =>
          !!c &&
          typeof c === 'object' &&
          (c as Record<string, unknown>).type === 'text' &&
          typeof (c as Record<string, unknown>).text === 'string',
      )
      .map((c) => c.text)
      .join('\n');
  }
  return { text, isError };
}

/**
 * Cap and stringify untrusted MCP tool output before it becomes an agent
 * observation. The output is DATA — never executed — and length-bounded so a
 * server cannot flood the context.
 */
export function sanitizeToolOutput(text: unknown, maxChars = 8000): string {
  const s = typeof text === 'string' ? text : JSON.stringify(text ?? '');
  return s.length > maxChars ? `${s.slice(0, maxChars)}\n\u2026 (truncated)` : s;
}

// ---- tool namespacing -------------------------------------------------------

/** Namespace an MCP tool into the agent registry: `mcp/<server>/<tool>`. */
export function mcpToolName(serverId: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}/${serverId}/${tool}`;
}

/** Parse a namespaced MCP tool name back into its server + tool parts. */
export function parseMcpToolName(qualified: string): { serverId: string; tool: string } | null {
  const parts = qualified.split('/');
  if (parts.length < 3 || parts[0] !== MCP_TOOL_PREFIX) return null;
  const serverId = parts[1] ?? '';
  const tool = parts.slice(2).join('/');
  if (serverId.length === 0 || tool.length === 0) return null;
  return { serverId, tool };
}

// ---- config + permissions ---------------------------------------------------

export interface McpServerConfig {
  id: string;
  name: string;
  /** Executable to spawn (e.g. `npx`). */
  command: string;
  /** Arguments to the executable. */
  args: string[];
  enabled: boolean;
}

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s.length > 0 ? s : 'server';
}

/** Sanitize arbitrary input into a safe MCP server config (defaults DISABLED). */
export function validateMcpServer(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const name = (typeof o.name === 'string' ? o.name : '').trim().slice(0, 80);
  const command = (typeof o.command === 'string' ? o.command : '').trim();
  if (name.length === 0 || command.length === 0) return null;
  const id = typeof o.id === 'string' && o.id.length > 0 ? o.id : slugify(name);
  const args = Array.isArray(o.args)
    ? o.args.filter((a): a is string => typeof a === 'string').slice(0, 50)
    : [];
  return { id, name, command, args, enabled: o.enabled === true };
}

export interface McpPermission {
  allow: boolean;
  requiresApproval: boolean;
  reason: string;
}

/**
 * The permission-broker decision for an MCP tool call. Unknown/disabled servers
 * are denied; enabled servers are allowed but ALWAYS require approval, because
 * MCP tools are third-party and can reach external systems (INV: content-as-data
 * + approval-gated).
 */
export function decideMcpCall(server: McpServerConfig | undefined): McpPermission {
  if (!server) return { allow: false, requiresApproval: false, reason: 'Unknown MCP server.' };
  if (!server.enabled) {
    return { allow: false, requiresApproval: false, reason: 'MCP server is disabled.' };
  }
  return {
    allow: true,
    requiresApproval: true,
    reason: 'MCP tool output is untrusted; the call is approval-gated.',
  };
}

/** Result of connecting to an MCP server (handshake + tool discovery). */
export interface McpConnectResult {
  ok: boolean;
  tools: McpTool[];
  error?: string;
}

/** Live status of a connected MCP server (for the panel). */
export interface McpConnectionStatus {
  id: string;
  name: string;
  tools: McpTool[];
  connected: boolean;
}
