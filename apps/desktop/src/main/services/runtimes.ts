import { rootLogger } from '@axiom/shared';
import { buildChildProcessEnvironment } from './processEnvironment';
import { readVersion, resolveExecutable } from './executables';
import { RUNTIMES, type DetectedRuntime, type RuntimeDefinition } from '../../common/runtimes';

/**
 * Toolchain detection.
 *
 * Scans the allowlisted PATH for each executable in the registry, then asks the ones
 * it finds for their version. The result drives two things: the Run ▶ button (so it
 * only offers what can actually run) and the settings list of detected tools.
 *
 * Safety properties this deliberately holds:
 *
 * - Detection is READ-ONLY. Each probe runs the tool's own informational version
 *   flag, taken from the registry — never a renderer-supplied argument, never
 *   anything that installs or builds. Probing happens automatically at startup, so
 *   it must not be able to change the machine.
 * - Resolution is delegated to `executables.ts`, which asks the OS's own resolver
 *   rather than only stat-ing PATH. A PATH scan alone reported a Microsoft Store
 *   Python as missing (its WindowsApps entry is a reparse point that stats EACCES),
 *   which made Run ▶ refuse to run a language the user had installed.
 * - Every probe is bounded by a timeout and an output cap, so one hung tool cannot
 *   stall startup or grow memory.
 * - The child environment is the same narrow allowlist every other AXIOM child
 *   process gets; a probe never inherits Main's credentials.
 */
const log = rootLogger.child('runtimes');

/** How long a completed scan is reused before the machine is re-examined. */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Concurrency cap, so a full scan does not spawn fifty processes at once. */
const MAX_PARALLEL_PROBES = 6;

let cache: { at: number; runtimes: DetectedRuntime[] } | null = null;
let inFlight: Promise<DetectedRuntime[]> | null = null;

async function probe(
  definition: RuntimeDefinition,
  env: NodeJS.ProcessEnv,
): Promise<DetectedRuntime> {
  const base: DetectedRuntime = {
    id: definition.id,
    displayName: definition.displayName,
    category: definition.category,
    path: null,
    version: null,
  };
  const resolved = await resolveExecutable(
    definition.commands,
    definition.versionArgs.length > 0 ? definition.versionArgs : ['--version'],
    env,
  ).catch(() => null);
  if (!resolved) return base;
  // Version output is informative only. A tool that resolved but whose version
  // cannot be read is still installed, so `path` is what decides availability.
  const version = await readVersion(resolved.path, definition.versionArgs, env).catch(() => null);
  return { ...base, path: resolved.path, version };
}

/** Scan in bounded batches so a full sweep never floods the machine. */
async function scan(): Promise<DetectedRuntime[]> {
  const env = buildChildProcessEnvironment({ color: false });
  const results: DetectedRuntime[] = [];
  for (let index = 0; index < RUNTIMES.length; index += MAX_PARALLEL_PROBES) {
    const batch = RUNTIMES.slice(index, index + MAX_PARALLEL_PROBES);
    results.push(...(await Promise.all(batch.map((definition) => probe(definition, env)))));
  }
  const found = results.filter((entry) => entry.path !== null);
  log.info('Toolchain scan complete', {
    detected: found.length,
    probed: results.length,
    ids: found.map((entry) => entry.id).join(','),
  });
  return results;
}

/**
 * Every probed toolchain, installed or not. Cached briefly so opening settings or
 * switching files does not re-scan the machine; `refresh` forces a new sweep after
 * the user installs something.
 */
export async function detectRuntimes(
  options: { refresh?: boolean } = {},
): Promise<DetectedRuntime[]> {
  const now = Date.now();
  if (!options.refresh && cache && now - cache.at < CACHE_TTL_MS) return cache.runtimes;
  if (inFlight) return inFlight;
  inFlight = scan()
    .then((runtimes) => {
      cache = { at: Date.now(), runtimes };
      return runtimes;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Ids of the toolchains that are installed, for the Run system's availability set. */
export async function availableRuntimeIds(): Promise<string[]> {
  const runtimes = await detectRuntimes();
  return runtimes.filter((entry) => entry.path !== null).map((entry) => entry.id);
}

/** Warm the cache during startup so the first Run ▶ does not wait on a scan. */
export function warmRuntimeDetection(): void {
  void detectRuntimes().catch((error: unknown) => {
    log.warn('Toolchain scan failed', {
      reason: error instanceof Error ? error.message : String(error),
    });
  });
}
