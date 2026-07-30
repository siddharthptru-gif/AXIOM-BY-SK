export type AgentActivityStatus =
  'succeeded' | 'failed' | 'blocked' | 'rejected' | 'cancelled' | 'replayed';

const TOOL_LABELS: Readonly<Record<string, string>> = {
  read_file: 'File inspection',
  list_dir: 'Directory inspection',
  search_text: 'Workspace search',
  project_profile: 'Project profile',
  graph_impact: 'Impact analysis',
  write_file: 'File update',
  replace_in_file: 'File replacement',
  delete_file: 'File deletion',
  create_directory: 'Directory creation',
  move_path: 'File or folder move',
  run_command: 'Verification command',
  spawn_subagent: 'Read-only delegation',
};

/** Allow-listed label only; unknown/provider-controlled tool names are never displayed. */
export function agentToolLabel(tool: string | undefined): string {
  if (tool?.startsWith('mcp/') || /^mcp_tool_\d+$/.test(tool ?? '')) return 'MCP tool';
  return (tool && TOOL_LABELS[tool]) || 'Workspace tool';
}

/** Request copy never consumes tool arguments. */
export function agentActivityRequest(tool: string | undefined): string {
  switch (tool) {
    case 'read_file':
      return 'Inspect a workspace file; content hidden.';
    case 'list_dir':
      return 'Inspect a workspace directory; entries hidden.';
    case 'search_text':
      return 'Search the workspace; query and excerpts hidden.';
    case 'project_profile':
      return 'Inspect the project profile; payload hidden.';
    case 'graph_impact':
      return 'Inspect dependency impact; payload hidden.';
    case 'write_file':
    case 'replace_in_file':
      return 'Update a workspace file; edit payload hidden.';
    case 'delete_file':
      return 'Delete an approved workspace file.';
    case 'create_directory':
      return 'Create an approved workspace directory.';
    case 'move_path':
      return 'Move or rename an approved workspace item.';
    case 'run_command':
      return 'Run focused verification; command hidden.';
    case 'spawn_subagent':
      return 'Delegate a bounded read-only workspace task.';
    default:
      return tool?.startsWith('mcp/') || /^mcp_tool_\d+$/.test(tool ?? '')
        ? 'Invoke an approved MCP tool; payload hidden.'
        : 'Use a workspace tool; payload hidden.';
  }
}

/** Result copy consumes only Main-authored status, never a raw observation. */
export function agentActivityResult(
  tool: string | undefined,
  status: AgentActivityStatus | undefined,
): string {
  if (status === 'blocked') return 'Blocked by Main policy; details hidden.';
  if (status === 'rejected') return 'Rejected by the user; no action was taken.';
  if (status === 'cancelled') return 'Cancelled before completion.';
  if (status === 'failed' || status === undefined) {
    return 'The action did not complete successfully; details hidden.';
  }
  if (status === 'replayed') return 'Replayed from the run journal without re-execution.';
  switch (tool) {
    case 'read_file':
      return 'Workspace file inspected; content hidden.';
    case 'list_dir':
      return 'Directory inspected; entries hidden.';
    case 'search_text':
      return 'Workspace search completed; excerpts hidden.';
    case 'project_profile':
    case 'graph_impact':
      return 'Workspace analysis completed; payload hidden.';
    case 'run_command':
      return 'Verification completed; output hidden.';
    case 'write_file':
    case 'replace_in_file':
    case 'delete_file':
    case 'create_directory':
    case 'move_path':
      return 'Approved workspace change completed.';
    default:
      return 'Tool action completed; payload hidden.';
  }
}
