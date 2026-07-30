import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AgentPreset } from '../../common/agentPresets';
import { validateCustomAgent } from '../../common/agentPresets';

/**
 * Custom-agent store (Main, PRD Epoch H §147 / Phase 235). Persists user-authored
 * agent definitions (an AgentPreset each) locally (JSON in app-data; INV-4). They
 * merge into the agent library alongside the built-in presets. Every write is
 * validated + sanitized (name/persona required; tool scope restricted to known
 * tools, defaulting read-only) so a malformed agent can't gain write/exec tools.
 */
const MAX_AGENTS = 100;

function storePath(): string {
  return join(app.getPath('userData'), 'custom-agents.json');
}

async function read(): Promise<AgentPreset[]> {
  try {
    const raw = await fs.readFile(storePath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((p) => validateCustomAgent(p)).filter((p): p is AgentPreset => p !== null);
  } catch {
    return [];
  }
}

async function write(list: AgentPreset[]): Promise<void> {
  const path = storePath();
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });
  const tmp = join(dir, `.axiom-agents-${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(list, null, 2), 'utf-8');
  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

export async function listCustomAgents(): Promise<AgentPreset[]> {
  return read();
}

/** A single custom agent by id, or null. */
export async function getCustomAgent(id: string): Promise<AgentPreset | null> {
  return (await read()).find((a) => a.id === id) ?? null;
}

/** Validate + upsert a custom agent (by id). Throws on invalid input. */
export async function saveCustomAgent(input: unknown): Promise<AgentPreset[]> {
  const agent = validateCustomAgent(input);
  if (!agent) throw new Error('A custom agent needs a name and instructions.');
  const list = (await read()).filter((a) => a.id !== agent.id);
  list.push(agent);
  await write(list.slice(0, MAX_AGENTS));
  return read();
}

export async function deleteCustomAgent(id: string): Promise<AgentPreset[]> {
  const next = (await read()).filter((a) => a.id !== id);
  await write(next);
  return next;
}
