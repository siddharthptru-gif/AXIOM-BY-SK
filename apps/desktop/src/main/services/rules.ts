import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseRuleFile, ruleFromImport, validateRule, type Rule } from '../../common/rules';
import {
  learnConventions,
  type CodeSample,
  type ProposedRule,
} from '../../common/conventionLearner';
import { shouldIndexFile } from '../../common/largeFile';
import { appendAudit } from './audit';
import { assertAuthorizedPath } from './pathAuthorization';

/**
 * Workspace rules service (Main, PRD Epoch H §145 / Phase 233). Loads rules from
 * three sources: a user-global store (userData/global-rules.json), the workspace's
 * `.axiom/rules/*.md` files, and imported `AGENTS.md` / `.cursorrules` at the root.
 * Selection + prompt composition are the pure `common/rules` module; the renderer
 * injects the composed section into generation. Never records secrets.
 */
function globalPath(): string {
  return join(app.getPath('userData'), 'global-rules.json');
}

async function readGlobal(): Promise<Rule[]> {
  try {
    const raw = await fs.readFile(globalPath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Rule[] = [];
    for (const r of parsed) {
      const v = validateRule({ ...(r as object), source: 'global' });
      if (v) out.push(v);
    }
    return out;
  } catch {
    return [];
  }
}

async function writeGlobal(list: Rule[]): Promise<void> {
  const path = globalPath();
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.axiom-rules-${randomBytes(6).toString('hex')}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(list.slice(0, 100), null, 2), 'utf-8');
  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

async function readWorkspaceRules(root: string): Promise<Rule[]> {
  if (root.length === 0) return [];
  const out: Rule[] = [];
  const requestedDir = join(root, '.axiom', 'rules');
  try {
    const dir = await assertAuthorizedPath(requestedDir, { directory: true });
    const entries = await fs.readdir(dir);
    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.md')) continue;
      try {
        const path = await assertAuthorizedPath(join(dir, name));
        const text = await fs.readFile(path, 'utf-8');
        const r = parseRuleFile(text, { fileName: name, source: 'workspace' });
        if (r) out.push(r);
      } catch {
        /* skip unreadable or out-of-workspace rule file */
      }
    }
  } catch {
    /* no authorized .axiom/rules directory */
  }
  for (const fname of ['AGENTS.md', '.cursorrules']) {
    try {
      const path = await assertAuthorizedPath(join(root, fname));
      const text = await fs.readFile(path, 'utf-8');
      const r = ruleFromImport(fname, text);
      if (r) out.push(r);
    } catch {
      /* not present, unreadable, or linked outside the workspace */
    }
  }
  return out;
}

/** All rules for a workspace: workspace files + imports, then user-global rules. */
export async function listRules(root: string | null): Promise<Rule[]> {
  const [ws, global] = await Promise.all([readWorkspaceRules(root ?? ''), readGlobal()]);
  return [...ws, ...global];
}

/** Create/update a user-global rule (workspace rules are edited as files). */
export async function saveGlobalRule(raw: unknown): Promise<Rule[]> {
  const validated = validateRule({ ...(raw as object), source: 'global' });
  if (!validated) throw new Error('A rule needs a name and a body.');
  const list = await readGlobal();
  const next = [validated, ...list.filter((r) => r.id !== validated.id)];
  await writeGlobal(next);
  void appendAudit('rules.save', `Global rule saved: ${validated.name}`);
  return next;
}

export async function deleteGlobalRule(id: string): Promise<Rule[]> {
  const list = await readGlobal();
  const target = list.find((r) => r.id === id);
  const next = list.filter((r) => r.id !== id);
  await writeGlobal(next);
  if (target) void appendAudit('rules.delete', `Global rule deleted: ${target.name}`);
  return next;
}

// --- Convention learner (Phase 260) -----------------------------------------

const SAMPLE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts']);
const SAMPLE_SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', '.cache', 'target']);
const SAMPLE_MAX_FILES = 40;
const SAMPLE_MAX_DEPTH = 4;
const SAMPLE_MAX_BYTES = 8000;

/** Collect a bounded sample of the workspace's source files (for inference). */
async function gatherCodeSamples(root: string): Promise<CodeSample[]> {
  if (root.length === 0) return [];
  const samples: CodeSample[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (samples.length >= SAMPLE_MAX_FILES || depth > SAMPLE_MAX_DEPTH) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (samples.length >= SAMPLE_MAX_FILES) break;
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || SAMPLE_SKIP_DIRS.has(e.name)) continue;
        await walk(join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        const dot = e.name.lastIndexOf('.');
        const ext = dot >= 0 ? e.name.slice(dot).toLowerCase() : '';
        if (!SAMPLE_EXTS.has(ext)) continue;
        const full = join(dir, e.name);
        try {
          const buf = await fs.readFile(full);
          if (!shouldIndexFile({ path: full, bytes: buf.byteLength }).index) continue;
          samples.push({ path: full, text: buf.toString('utf-8').slice(0, SAMPLE_MAX_BYTES) });
        } catch {
          /* skip unreadable file */
        }
      }
    }
  };
  await walk(root, 0);
  return samples;
}

/**
 * Infer the workspace's conventions from a sample of its source files and return
 * PROPOSED rules for approval (Phase 260). Pure inference lives in
 * common/conventionLearner; this only gathers the samples. Never auto-applies.
 */
export async function proposeConventions(root: string | null): Promise<ProposedRule[]> {
  const samples = await gatherCodeSamples(root ?? '');
  return learnConventions(samples);
}
