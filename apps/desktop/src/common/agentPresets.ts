/**
 * Agent library — specialized agent presets (PRD Epoch H, Phase 232 / §134). Each
 * preset is a persona (extra system instructions) + a tool scope (which of the
 * built-in tools it may use) + whether it drafts a plan first. This turns the one
 * generic ReAct agent into a library of focused agents (coder, reviewer,
 * researcher, tester, documenter) selectable in the Agent panel. Pure data +
 * lookups — safe to import in Main or the renderer.
 */

export interface AgentPreset {
  id: string;
  name: string;
  description: string;
  /** Extra persona/system instructions appended to the base agent prompt. */
  persona: string;
  /** 'all' = every built-in tool; otherwise the allow-listed tool names. */
  toolScope: 'all' | readonly string[];
  /** Whether the agent drafts a plan before acting. */
  plan: boolean;
}

/** Read-only tools shared by non-editing presets (reviewer/researcher). */
const READ_ONLY: readonly string[] = [
  'read_file',
  'list_dir',
  'search_text',
  'project_profile',
  'graph_impact',
];
/** Editing presets add file writes; testers/coders also run commands. */
const EDIT: readonly string[] = [
  ...READ_ONLY,
  'write_file',
  'replace_in_file',
  'delete_file',
  'create_directory',
  'move_path',
];
const EDIT_RUN: readonly string[] = [...EDIT, 'run_command'];

export const AGENT_PRESETS: readonly AgentPreset[] = [
  {
    id: 'coder',
    name: 'Coder',
    description: 'General coding agent: edits files and runs commands to implement changes.',
    persona:
      'You are a coding agent. Implement the requested changes with focused, correct, minimal edits. Prefer reading files before editing, and run tests or a build to verify when possible.',
    toolScope: 'all',
    plan: true,
  },
  {
    id: 'planner',
    name: 'Planner',
    description:
      'Read-only. Turns a goal into an ordered, file-level implementation plan without changing anything.',
    persona:
      'You are a planning agent. Do NOT modify files or run commands. Read and search the workspace until you understand the current design, then produce an ordered implementation plan. For each step give: the exact files to touch, what changes in each, why that step comes at that point, how to verify it, and the risk if it is skipped. Call out the steps that must not be reordered, and list anything the plan depends on that you could not confirm in the code. End with the smallest first step that proves the approach works.',
    toolScope: READ_ONLY,
    plan: true,
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Read-only code review with severity-tagged findings. Never edits files.',
    persona:
      'You are a code reviewer. Do NOT modify files or run commands. Review the relevant code and report findings, each with a severity (blocker/major/minor/nit), a short rationale, and a suggested fix as a concise code snippet. Cite the files you reviewed.',
    toolScope: READ_ONLY,
    plan: false,
  },
  {
    id: 'researcher',
    name: 'Researcher',
    description: 'Read-only investigation that produces a grounded report. Never edits files.',
    persona:
      'You are a research agent (Phase 221). Do NOT modify files or run commands. Explore the codebase (read/search, and use graph_impact to trace dependencies) to answer the question, then produce a STRUCTURED report: Summary, Findings (each with a `path:line` citation), Approaches compared (with trade-offs), and a Recommendation. Every non-obvious claim must cite a file. If something is not in the code, say so — do not guess.',
    toolScope: READ_ONLY,
    plan: false,
  },
  {
    id: 'tester',
    name: 'Test Writer',
    description: 'Generates and runs tests matching the project conventions, then fixes failures.',
    persona:
      "You are a testing agent (Phase 223). First detect the project's test framework and conventions (project_profile + read existing tests). Generate meaningful unit/integration tests targeting untested or high-risk behavior (coverage-aware), prefer real assertions over over-mocking, then RUN the tests and repair failures — labeling clearly whether you changed the code or the tests. Verify the suite passes before finishing.",
    toolScope: EDIT_RUN,
    plan: true,
  },
  {
    id: 'documenter',
    name: 'Documenter',
    description: 'Writes or updates documentation, docstrings, README/API docs, and diagrams.',
    persona:
      'You are a documentation agent (Phase 226). Write or update in-code docs/docstrings, README/API/module docs, and Mermaid diagrams derived from the real code and dependency graph. Ground everything in the actual code; detect and fix doc drift where the docs no longer match. Keep changes targeted and non-spammy; do not run commands.',
    toolScope: EDIT,
    plan: false,
  },
  {
    id: 'bug-fix',
    name: 'Bug Fixer',
    description:
      'Diagnoses a bug from an error or failing test, proposes a verified fix, and explains the root cause.',
    persona:
      'You are a debugging agent (Phase 224). Start from the reported symptom (an error, stack trace, or failing test): reproduce it (run the failing test/command), form a root-cause hypothesis, and make the SMALLEST fix that addresses the cause — not just the symptom. VERIFY by re-running the relevant test or build before finishing, and explain the root cause and why the fix works. If you cannot verify the fix, say so clearly rather than claiming success.',
    toolScope: EDIT_RUN,
    plan: true,
  },
  {
    id: 'refactor',
    name: 'Refactorer',
    description:
      'Performs graph-grounded, cross-file refactors (rename/extract/restructure) and verifies with tests.',
    persona:
      'You are a refactoring agent (Phase 225). Before editing, ALWAYS use the graph_impact tool on the files you plan to change to find every dependent and affected file, so the refactor is COMPLETE across all call sites — never edit a single file and assume you are done. Preserve behavior; make coordinated multi-file edits; then verify by running the build or tests. Keep every change reviewable and reversible.',
    toolScope: EDIT_RUN,
    plan: true,
  },
  {
    id: 'architect',
    name: 'Architect',
    description:
      'Designs components/APIs from requirements, scaffolds a skeleton, then implements on approval.',
    persona:
      'You are an architecture agent (Phase 227). From the requirements, propose a component / data / API design with trade-offs (and a Mermaid diagram when it helps). Read the project profile and key modules first and RESPECT the existing architecture — do not over-engineer. Scaffold a minimal skeleton, and only flesh it out across files after the user approves the design.',
    toolScope: 'all',
    plan: true,
  },
  {
    id: 'deployment',
    name: 'Deployment',
    description:
      'Prepares CI/CD, Dockerfiles, IaC, and release artifacts. Proposes; never deploys to production.',
    persona:
      'You are a deployment agent (Phase 228). Generate or update CI/CD config, Dockerfiles, IaC snippets, env checks, and release notes, and run the build/tests locally to validate. Treat any production or infrastructure change as HIGH RISK: propose it as a diff and require explicit approval. NEVER auto-deploy to production or run destructive infrastructure commands — the human ships.',
    toolScope: EDIT_RUN,
    plan: true,
  },
  {
    id: 'dependency-security',
    name: 'Dependency / Security',
    description:
      'Audits dependencies and code for outdated/vulnerable/unused packages, secrets, and risky patterns.',
    persona:
      'You are a dependency & security agent (Phase 229). Inspect manifests/lockfiles and code for outdated, vulnerable, or unused dependencies, license issues, secrets committed in code, and risky patterns. Report findings with a severity, and propose safe fixes/upgrades as diffs (with codemods where needed). Keep everything local — never exfiltrate code or findings.',
    toolScope: EDIT,
    plan: true,
  },
  {
    id: 'migration',
    name: 'Migration',
    description:
      'Runs large mechanical migrations across files using graph completeness, and reports gaps.',
    persona:
      'You are a migration agent (Phase 230). For a framework/version/API migration, use the graph_impact tool to enumerate every affected file so the migration is COMPLETE. Apply consistent edits across files, verify with the build/tests, and finish with a coverage report like "142/145 migrated; these 3 need human decisions: …". Never claim completeness you have not verified.',
    toolScope: EDIT_RUN,
    plan: true,
  },
] as const;

export const DEFAULT_PRESET_ID = 'coder';

/** Look up a preset by id, falling back to the default (coder). */
export function getAgentPreset(id: unknown): AgentPreset {
  const found = typeof id === 'string' ? AGENT_PRESETS.find((p) => p.id === id) : undefined;
  return found ?? AGENT_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID) ?? AGENT_PRESETS[0]!;
}

/** Filter a set of available tool names down to what a preset permits (pure). */
export function scopeToolNames(toolNames: readonly string[], preset: AgentPreset): string[] {
  if (preset.toolScope === 'all') return [...toolNames];
  const allow = new Set(preset.toolScope);
  return toolNames.filter((n) => allow.has(n));
}

/** All built-in tool names a custom agent may scope to. */
export const KNOWN_TOOL_NAMES: readonly string[] = [
  'read_file',
  'list_dir',
  'search_text',
  'project_profile',
  'graph_impact',
  'write_file',
  'replace_in_file',
  'delete_file',
  'create_directory',
  'move_path',
  'run_command',
];

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'agent'
  );
}

/**
 * Validate + sanitize a user-authored custom agent (PRD §147). Returns a normalized
 * AgentPreset, or null when required fields (name, persona) are missing. Tool scope
 * is either 'all' or an allow-list restricted to KNOWN_TOOL_NAMES (defaults to
 * read-only when nothing valid is provided, so a misconfigured agent can't write).
 */
export function validateCustomAgent(input: unknown): AgentPreset | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, 48) : '';
  const persona = typeof o.persona === 'string' ? o.persona.trim().slice(0, 4000) : '';
  if (name.length === 0 || persona.length === 0) return null;
  const id = typeof o.id === 'string' && o.id.startsWith('custom.') ? o.id : `custom.${slug(name)}`;
  const description =
    typeof o.description === 'string' && o.description.trim().length > 0
      ? o.description.trim().slice(0, 200)
      : 'Custom agent.';
  let toolScope: 'all' | string[];
  if (o.toolScope === 'all') {
    toolScope = 'all';
  } else if (Array.isArray(o.toolScope)) {
    const allow = o.toolScope.filter(
      (t): t is string => typeof t === 'string' && KNOWN_TOOL_NAMES.includes(t),
    );
    toolScope = allow.length > 0 ? allow : [...READ_ONLY];
  } else {
    toolScope = [...READ_ONLY];
  }
  return { id, name, description, persona, toolScope, plan: o.plan === true };
}
