import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { rootLogger } from '@axiom/shared';
import type { AgentPreset } from '../../common/agentPresets';
import { validateCustomAgent } from '../../common/agentPresets';
import type { WorkspaceAgentFile } from '../../common/ipc';
import { resolveWithinWorkspaceRoot } from './workspaceContainment';

/**
 * Shareable agent presets (T3.13). A team keeps its agents in the repository at
 * `.axiom/agents/*.axiom-agent.json`, so a specialized agent is reviewed, versioned,
 * and cloned with the code instead of living in one person's app data.
 *
 * SECURITY — repository-authored agents are UNTRUSTED input:
 *  - Every file is validated + sanitized through `validateCustomAgent`, so a tool
 *    scope can only name known tools.
 *  - An agent's persona becomes system-level instructions, so a repo file is NEVER
 *    silently active. This module only *reports* what the repo declares, together
 *    with a content digest. The renderer requires an explicit per-agent enable, and
 *    because approval is bound to the digest, any later edit to the file (a pulled
 *    commit, a malicious PR) invalidates it and requires review again.
 *  - Paths are resolved through the workspace containment helper, so a symlinked or
 *    traversing name cannot read or write outside the folder.
 *  - Callers must have already asserted workspace trust.
 */
const log = rootLogger.child('workspace-agents');
const AGENTS_DIR = ['.axiom', 'agents'];
const FILE_SUFFIX = '.axiom-agent.json';
const MAX_FILES = 50;
const MAX_FILE_BYTES = 64 * 1024;

function agentsDir(root: string): string {
  return join(root, ...AGENTS_DIR);
}

/**
 * Stable digest of the agent's meaningful fields. Key order is fixed so a
 * reformatted file with identical content keeps its approval, while any change to
 * the persona or tool scope revokes it.
 */
export function agentDigest(agent: AgentPreset): string {
  const canonical = JSON.stringify([
    agent.id,
    agent.name,
    agent.description,
    agent.persona,
    agent.toolScope === 'all' ? 'all' : [...agent.toolScope].sort(),
    agent.plan,
  ]);
  return createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

/** Filename for sharing an agent into a repository. */
export function workspaceAgentFileName(agent: AgentPreset): string {
  const base =
    agent.id
      .replace(/^custom\./, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'agent';
  return `${base}${FILE_SUFFIX}`;
}

/**
 * List the agents this repository declares. Never throws: an unreadable directory
 * means "none declared", and a malformed file is reported as invalid rather than
 * failing the whole list.
 */
export async function listWorkspaceAgents(root: string): Promise<WorkspaceAgentFile[]> {
  const dir = agentsDir(root);
  let names: string[];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_FILES);
  } catch {
    return [];
  }

  const out: WorkspaceAgentFile[] = [];
  for (const name of names) {
    const resolved = resolveWithinWorkspaceRoot(root, join(...AGENTS_DIR, name));
    if (!resolved) continue;
    const rel = `${AGENTS_DIR.join('/')}/${name}`;
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
        out.push({ rel, valid: false, reason: 'File is not a regular file or is too large.' });
        continue;
      }
      const parsed: unknown = JSON.parse(await fs.readFile(resolved, 'utf-8'));
      const agent = validateCustomAgent(parsed);
      if (!agent) {
        out.push({
          rel,
          valid: false,
          reason: 'Needs at least a "name" and a "persona" (instructions).',
        });
        continue;
      }
      out.push({ rel, valid: true, agent, digest: agentDigest(agent) });
    } catch (error) {
      out.push({
        rel,
        valid: false,
        reason: error instanceof Error ? error.message : 'Could not read this agent file.',
      });
    }
  }
  log.info('Listed workspace agents', { root, files: out.length });
  return out;
}

/**
 * Write an agent into the repository so it can be committed and shared. Returns the
 * workspace-relative path written. The caller must have asserted trust.
 */
export async function shareWorkspaceAgent(root: string, agent: AgentPreset): Promise<string> {
  const name = workspaceAgentFileName(agent);
  const resolved = resolveWithinWorkspaceRoot(root, join(...AGENTS_DIR, name));
  if (!resolved) throw new Error('The agent file path escapes the workspace.');
  await fs.mkdir(agentsDir(root), { recursive: true });
  const payload = {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    persona: agent.persona,
    toolScope: agent.toolScope === 'all' ? 'all' : [...agent.toolScope],
    plan: agent.plan,
  };
  await fs.writeFile(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  const rel = `${AGENTS_DIR.join('/')}/${name}`;
  log.info('Shared agent to workspace', { root, rel });
  return rel;
}
