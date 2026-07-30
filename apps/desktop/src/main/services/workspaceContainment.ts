import { isAbsolute, join, normalize, relative, sep } from 'node:path';

/**
 * Resolve a lexical path inside one workspace root. This is only the first
 * containment layer; callers must still canonicalize links before file access.
 */
export function resolveWithinWorkspaceRoot(root: string, candidate: string): string | null {
  const normalizedRoot = normalize(root);
  const resolved = isAbsolute(candidate)
    ? normalize(candidate)
    : normalize(join(normalizedRoot, candidate));
  const rel = relative(normalizedRoot, resolved);
  const contained = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  return contained ? resolved : null;
}
