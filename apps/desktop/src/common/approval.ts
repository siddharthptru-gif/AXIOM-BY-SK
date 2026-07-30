/**
 * Approval Workflow & Guardrails (PRD Epoch G §144 / Part X §181, Phase 174). Pure
 * policy engine: classify a tool into an action class, decide allow/ask/deny from
 * the autonomy level (with per-class overrides), and force a confirmation for
 * high-risk shell commands. No I/O — the agent loop consults `decide()` before
 * running a tool. Safe defaults: the default policy reproduces today's behavior
 * (reads run freely; writes/exec/network/git-writes require approval).
 */

export type ActionClass = 'read' | 'write' | 'exec' | 'network' | 'gitWrite';
export type AutonomyLevel = 'manual' | 'guided' | 'autopilot';
export type PolicyDecision = 'allow' | 'ask' | 'deny';

export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = ['manual', 'guided', 'autopilot'];

export interface ApprovalPolicy {
  autonomy: AutonomyLevel;
  /** Per-class hard overrides that win over the autonomy default. */
  overrides: Partial<Record<ActionClass, PolicyDecision>>;
  /** Legacy compatibility field; high-risk actions are always approval-gated. */
  confirmHighRisk: boolean;
}

/**
 * Default policy. Once the user has explicitly trusted a workspace, Axiom runs in
 * Autopilot: reads, planning, analysis, and ordinary commands flow without
 * prompting, so agents work end-to-end instead of stalling on every step.
 * High-risk commands and workspace-mutating effects still surface an exact
 * one-click preview — that safety net is not disableable, because tool arguments
 * can be influenced by untrusted file content.
 */
export const DEFAULT_POLICY: ApprovalPolicy = {
  autonomy: 'autopilot',
  overrides: {},
  confirmHighRisk: true,
};

/** Map a tool name to an action class (explicit known tools + a safe heuristic). */
export function classifyTool(name: string): ActionClass {
  switch (name) {
    case 'read_file':
    case 'list_dir':
    case 'search_text':
    case 'project_profile':
    case 'subagent':
    case 'sub_agent':
      return 'read';
    case 'write_file':
    case 'replace_in_file':
    case 'delete_file':
    case 'create_directory':
    case 'move_path':
      return 'write';
    case 'run_command':
      return 'exec';
  }
  const n = name.toLowerCase();
  if (/(push|pull|commit|checkout|reset|merge|rebase|git_write)/.test(n)) return 'gitWrite';
  if (/(fetch|http|request|network|download|url)/.test(n)) return 'network';
  if (/(run|exec|command|shell|terminal|spawn)/.test(n)) return 'exec';
  if (/(write|edit|replace|create|save|delete|remove|move|rename)/.test(n)) return 'write';
  return 'read';
}

/** Heuristic: is this shell command destructive / high-blast-radius? */
export function isHighRiskCommand(cmd: string): boolean {
  const c = cmd.toLowerCase();
  return (
    /\brm\s+-[a-z]*r/.test(c) || // rm -rf / rm -r
    /\brmdir\b/.test(c) ||
    /\bdel\s+\/[a-z]/.test(c) || // del /s /q
    /\brd\s+\/s/.test(c) ||
    /\bformat\b/.test(c) ||
    /\bmkfs\b/.test(c) ||
    /\bdd\s+if=/.test(c) ||
    />\s*\/dev\/(sd|null|zero)/.test(c) ||
    /\bgit\s+push\b.*(--force|-f\b)/.test(c) ||
    /\bgit\s+reset\s+--hard/.test(c) ||
    /\bgit\s+clean\s+-[a-z]*f/.test(c) ||
    /\b(shutdown|reboot|halt|killall)\b/.test(c) ||
    /\bchmod\s+-r/.test(c) ||
    /\bsudo\b/.test(c) ||
    /:\(\)\s*\{.*\}\s*;/.test(c) // fork bomb
  );
}

/** The base decision from the autonomy level for a given action class. */
function baseDecision(autonomy: AutonomyLevel, cls: ActionClass): PolicyDecision {
  if (autonomy === 'manual') return 'ask'; // approve everything, even reads
  if (autonomy === 'autopilot') return 'allow'; // hands-off (high-risk handled below)
  return cls === 'read' ? 'allow' : 'ask'; // guided: reads free, mutating asks
}

/**
 * Decide whether an action may run. Precedence: a per-class override wins over the
 * autonomy default; then any high-risk `allow` is unconditionally upgraded to
 * `ask` (a non-disableable safety net that overrides even an `allow` override).
 */
export function decide(
  policy: ApprovalPolicy,
  action: { cls: ActionClass; highRisk?: boolean },
): PolicyDecision {
  const override = policy.overrides[action.cls];
  let decision: PolicyDecision = override ?? baseDecision(policy.autonomy, action.cls);
  if (action.highRisk === true && decision === 'allow') {
    decision = 'ask';
  }
  return decision;
}

/**
 * Parse a stored/settings string into a valid AutonomyLevel. An unset value means
 * the user never changed it, so it resolves to the Autopilot default above.
 */
export function parseAutonomy(value: unknown): AutonomyLevel {
  return typeof value === 'string' && (AUTONOMY_LEVELS as readonly string[]).includes(value)
    ? (value as AutonomyLevel)
    : DEFAULT_POLICY.autonomy;
}
