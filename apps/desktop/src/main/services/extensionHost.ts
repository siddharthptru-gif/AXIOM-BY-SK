/**
 * Executable extension hosts are intentionally disabled.
 *
 * Declarative extension contributions remain supported by `extensions.ts`, but
 * extension JavaScript is never spawned or loaded. Keeping these lifecycle APIs
 * as explicit no-ops lets shutdown, workspace teardown, and status callers remain
 * fail-safe without retaining a dormant Node child-process execution path.
 */

export function isActive(_extId: string): boolean {
  return false;
}

export function listActiveHosts(): Array<{ extId: string; active: boolean }> {
  return [];
}

export async function deactivateExtension(_extId: string): Promise<void> {
  // No executable extension host can exist while activation is disabled.
}

export async function deactivateExtensionsForWorkspace(_root: string): Promise<void> {
  // No executable extension host can exist while activation is disabled.
}

export async function deactivateAllExtensions(): Promise<void> {
  // No executable extension host can exist while activation is disabled.
}
