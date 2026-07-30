import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { rootLogger } from '@axiom/shared';
import type { DiscoveredDebugConfig } from '../../common/ipc';
import { buildChildProcessEnvironment } from './processEnvironment';

/**
 * Main-authoritative debug adapter discovery (zero-config debugging).
 *
 * A normal user should never have to hand-type a DAP adapter command, an entry
 * point, or source-map settings. This module inspects the selected workspace,
 * detects its runtime(s), resolves whether a REAL Debug Adapter Protocol adapter is
 * present on this machine, and derives a complete launch configuration.
 *
 * - Python: `debugpy` is a stdio DAP adapter (`python -m debugpy.adapter`).
 * - Node/TypeScript: js-debug (the standard JavaScript debugger, also used by VS
 *   Code and Visual Studio) speaks DAP over a TCP server. The DAP client supports
 *   that transport plus js-debug's child-session handshake, so when js-debug is
 *   present on the machine Node and TypeScript debugging work with no configuration:
 *   the entry point comes from package.json / conventional paths, and a TypeScript
 *   entry is run through the project's own tsx / ts-node loader.
 *
 * Anything that cannot actually run is reported as unavailable with the exact
 * enablement step, never as a silent, broken launch. All probes are bounded, hidden
 * (no console window), run with a positively allow-listed environment, and never
 * inherit Main credentials.
 */
const log = rootLogger.child('debug-discovery');
const PROBE_TIMEOUT_MS = 6_000;
const MAX_PROBE_OUTPUT = 8_192;
const MAX_DIR_ENTRIES = 400;
const MAX_PACKAGE_JSON_BYTES = 2_000_000;

/** js-debug's standalone DAP server, relative to an extension/package directory. */
const JS_DEBUG_SERVER_PARTS = ['src', 'dapDebugServer.js'] as const;
const JS_DEBUG_EXTENSION_PATTERN = /^ms-vscode\.js-debug(-nightly)?-/i;
const TYPESCRIPT_ENTRY = /\.(ts|tsx|mts|cts)$/i;

/** Conventional entry points, in the order a developer would expect them tried. */
const NODE_ENTRY_CANDIDATES = [
  'src/index.ts',
  'src/index.js',
  'src/index.mjs',
  'src/main.ts',
  'src/main.js',
  'src/server.ts',
  'src/server.js',
  'src/app.ts',
  'src/app.js',
  'index.ts',
  'index.js',
  'index.mjs',
  'index.cjs',
  'main.ts',
  'main.js',
  'server.ts',
  'server.js',
  'app.ts',
  'app.js',
] as const;

const PYTHON_ENTRY_CANDIDATES = [
  'main.py',
  'app.py',
  'manage.py',
  'run.py',
  'src/main.py',
  'src/app.py',
] as const;

interface ProbeResult {
  ok: boolean;
  output: string;
}

function probe(command: string, args: string[], signal?: AbortSignal): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ ok, output: output.trim() });
    };
    let child;
    try {
      child = spawn(command, args, {
        windowsHide: true,
        env: buildChildProcessEnvironment({ color: false }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve({ ok: false, output: '' });
      return;
    }
    const onAbort = (): void => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(false);
    };
    const timer = setTimeout(onAbort, PROBE_TIMEOUT_MS);
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const append = (chunk: Buffer): void => {
      if (output.length < MAX_PROBE_OUTPUT) output += chunk.toString('utf-8');
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.once('error', () => finish(false));
    child.once('close', (code) => finish(code === 0));
  });
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Shallow, bounded scan of the workspace root for runtime signals. */
async function detectRuntimes(root: string): Promise<{ node: boolean; python: boolean }> {
  const signals = { node: false, python: false };
  let entries: string[] = [];
  try {
    const dirents = await fs.readdir(root, { withFileTypes: true });
    entries = dirents.slice(0, MAX_DIR_ENTRIES).map((entry) => entry.name);
  } catch {
    return signals;
  }
  const has = (name: string): boolean => entries.includes(name);
  const anyMatch = (re: RegExp): boolean => entries.some((name) => re.test(name));

  if (
    has('package.json') ||
    has('tsconfig.json') ||
    has('pnpm-lock.yaml') ||
    has('yarn.lock') ||
    anyMatch(/\.(m?js|cjs|ts|tsx|jsx)$/i)
  ) {
    signals.node = true;
  }
  if (
    has('requirements.txt') ||
    has('pyproject.toml') ||
    has('setup.py') ||
    has('Pipfile') ||
    has('manage.py') ||
    anyMatch(/\.py$/i)
  ) {
    signals.python = true;
  }
  return signals;
}

/** Resolve a usable Python interpreter, preferring the Windows `py -3` launcher. */
async function resolvePython(
  signal?: AbortSignal,
): Promise<{ command: string; baseArgs: string[] } | null> {
  const candidates: Array<{ command: string; baseArgs: string[] }> =
    process.platform === 'win32'
      ? [
          { command: 'py', baseArgs: ['-3'] },
          { command: 'python', baseArgs: [] },
          { command: 'python3', baseArgs: [] },
        ]
      : [
          { command: 'python3', baseArgs: [] },
          { command: 'python', baseArgs: [] },
        ];
  for (const candidate of candidates) {
    if (signal?.aborted) return null;
    const result = await probe(candidate.command, [...candidate.baseArgs, '--version'], signal);
    if (result.ok && /python\s+3\./i.test(result.output)) return candidate;
  }
  return null;
}

/** Resolve the `node` binary that will host js-debug and run the debuggee. */
async function resolveNode(signal?: AbortSignal): Promise<string | null> {
  const result = await probe('node', ['--version'], signal);
  return result.ok && /^v\d+\./.test(result.output) ? 'node' : null;
}

/** Editor extension directories that ship js-debug, in preference order. */
function extensionRoots(): string[] {
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (!home) return [];
  return [
    join(home, '.vscode', 'extensions'),
    join(home, '.vscode-insiders', 'extensions'),
    join(home, '.vscode-oss', 'extensions'),
    join(home, '.cursor', 'extensions'),
    join(home, '.windsurf', 'extensions'),
    join(home, '.vscode-server', 'extensions'),
  ];
}

/**
 * Locate js-debug's standalone DAP server. A workspace-local copy wins so a project
 * can pin its own debugger; otherwise the newest installed editor extension is used.
 */
async function findJsDebugServer(root: string, signal?: AbortSignal): Promise<string | null> {
  const local = [
    join(root, 'node_modules', '@vscode', 'js-debug', ...JS_DEBUG_SERVER_PARTS),
    join(root, 'node_modules', 'js-debug', ...JS_DEBUG_SERVER_PARTS),
  ];
  for (const candidate of local) {
    if (signal?.aborted) return null;
    if (await isFile(candidate)) return candidate;
  }
  for (const dir of extensionRoots()) {
    if (signal?.aborted) return null;
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const matches = dirents
      .filter((entry) => entry.isDirectory() && JS_DEBUG_EXTENSION_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const name of matches) {
      if (signal?.aborted) return null;
      const candidate = join(dir, name, ...JS_DEBUG_SERVER_PARTS);
      if (await isFile(candidate)) return candidate;
    }
  }
  return null;
}

async function readPackageJson(root: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(join(root, 'package.json'), 'utf-8');
    if (raw.length > MAX_PACKAGE_JSON_BYTES) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Resolve the first existing candidate under the root (containment-checked). */
async function firstExisting(root: string, candidates: readonly string[]): Promise<string | null> {
  for (const rel of candidates) {
    const trimmed = rel.trim();
    if (!trimmed || isAbsolute(trimmed) || trimmed.split(/[\\/]/).includes('..')) continue;
    const resolved = join(root, trimmed);
    if (await isFile(resolved)) return resolved;
  }
  return null;
}

/** Derive the Node entry point: package.json `main`, then conventional paths. */
async function detectNodeEntry(root: string): Promise<string | null> {
  const pkg = await readPackageJson(root);
  const declared = pkg && typeof pkg.main === 'string' ? pkg.main : '';
  return firstExisting(root, [declared, ...NODE_ENTRY_CANDIDATES]);
}

interface TsRunner {
  label: string;
  runtimeArgs: string[];
}

/** Find the project's own TypeScript loader so a `.ts` entry runs directly. */
async function resolveTsRunner(root: string): Promise<TsRunner | null> {
  if (await isFile(join(root, 'node_modules', 'tsx', 'package.json'))) {
    return { label: 'tsx', runtimeArgs: ['--import', 'tsx'] };
  }
  if (await isFile(join(root, 'node_modules', 'ts-node', 'package.json'))) {
    return { label: 'ts-node', runtimeArgs: ['-r', 'ts-node/register'] };
  }
  return null;
}

/** js-debug launch arguments that make stepping through real source work. */
function nodeLaunchArgs(root: string, runtimeArgs: string[]): Record<string, unknown> {
  const posixRoot = root.replace(/\\/g, '/');
  return {
    type: 'pwa-node',
    name: 'Axiom: debug Node',
    console: 'internalConsole',
    outputCapture: 'std',
    sourceMaps: true,
    skipFiles: ['<node_internals>/**'],
    resolveSourceMapLocations: [`${posixRoot}/**`, '!**/node_modules/**'],
    ...(runtimeArgs.length > 0 ? { runtimeArgs } : {}),
  };
}

function unavailable(
  id: string,
  label: string,
  runtime: DiscoveredDebugConfig['runtime'],
  detail: string,
): DiscoveredDebugConfig {
  return {
    id,
    label,
    runtime,
    available: false,
    adapterCommand: '',
    adapterArgs: [],
    request: 'launch',
    program: 'active-file',
    detail,
    transport: 'stdio',
    programPath: '',
    launchArgs: {},
  };
}

async function discoverPython(
  root: string,
  signal?: AbortSignal,
): Promise<DiscoveredDebugConfig> {
  const python = await resolvePython(signal);
  if (!python) {
    return unavailable(
      'python-debugpy',
      'Python (interpreter not found)',
      'python',
      'A Python file was detected but no Python 3 interpreter was found on PATH. Install Python 3, then run: python -m pip install debugpy',
    );
  }
  const shown = `${python.command}${python.baseArgs.length ? ` ${python.baseArgs.join(' ')}` : ''}`;
  const debugpy = await probe(
    python.command,
    [...python.baseArgs, '-m', 'debugpy', '--version'],
    signal,
  );
  if (!debugpy.ok) {
    return unavailable(
      'python-debugpy',
      'Python (debugpy not installed)',
      'python',
      `Python found (${shown}) but debugpy is missing. Enable debugging with: ${shown} -m pip install debugpy`,
    );
  }
  const entry = await firstExisting(root, PYTHON_ENTRY_CANDIDATES);
  // debugpy prefixes its version with timing and frozen-module warnings, so the
  // version has to be matched rather than taken from the start of the output — a
  // leading "0.01s - Debugger warning" would otherwise be reported as "debugpy 0.01".
  const version = /(\d+\.\d+\.\d+[^\s]*)/.exec(debugpy.output)?.[1] ?? 'installed';
  return {
    id: 'python-debugpy',
    label: entry
      ? `Python: debug ${entry.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')}`
      : 'Python: debug the active file (debugpy)',
    runtime: 'python',
    available: true,
    adapterCommand: python.command,
    adapterArgs: [...python.baseArgs, '-m', 'debugpy.adapter'],
    request: 'launch',
    program: entry ? 'none' : 'active-file',
    detail: `Ready — ${shown} -m debugpy.adapter (debugpy ${version})${
      entry ? '. Entry point detected automatically.' : '.'
    }`,
    transport: 'stdio',
    programPath: entry ?? '',
    launchArgs: { console: 'internalConsole', justMyCode: true },
  };
}

async function discoverNode(root: string, signal?: AbortSignal): Promise<DiscoveredDebugConfig> {
  const [node, adapter, entry] = await Promise.all([
    resolveNode(signal),
    findJsDebugServer(root, signal),
    detectNodeEntry(root),
  ]);
  if (!node) {
    return unavailable(
      'node-js-debug',
      'Node.js (runtime not found)',
      'node',
      'A JavaScript/TypeScript project was detected but no `node` was found on PATH. Install Node.js, then re-scan.',
    );
  }
  if (!adapter) {
    return unavailable(
      'node-js-debug',
      'Node.js (JavaScript Debugger not installed)',
      'node',
      'Node.js project detected. Debugging needs js-debug, the standard JavaScript debugger. Axiom auto-detects it from a VS Code / Cursor / Windsurf install of the "JavaScript Debugger" extension, or from js-debug placed at node_modules/js-debug/src/dapDebugServer.js in this workspace. Until then you can run `node --inspect` in the integrated terminal.',
    );
  }
  const isTypeScript = entry !== null && TYPESCRIPT_ENTRY.test(entry);
  const tsRunner = isTypeScript ? await resolveTsRunner(root) : null;
  const rel =
    entry === null
      ? ''
      : entry.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/') || entry;
  if (isTypeScript && !tsRunner) {
    return unavailable(
      'node-js-debug',
      'Node.js (TypeScript loader missing)',
      'node',
      `TypeScript entry point detected (${rel}) and the JavaScript Debugger is installed, but running .ts directly needs a loader. Install one in this project: npm install -D tsx`,
    );
  }
  return {
    id: 'node-js-debug',
    label: entry
      ? `Node.js: debug ${rel}${tsRunner ? ` (via ${tsRunner.label})` : ''}`
      : 'Node.js: debug the active file',
    runtime: 'node',
    available: true,
    // js-debug's standalone DAP server takes the port to listen on as its argument.
    adapterCommand: node,
    adapterArgs: [adapter, '${port}'],
    request: 'launch',
    program: entry ? 'none' : 'active-file',
    detail: entry
      ? `Ready — js-debug over loopback, entry ${rel}${
          tsRunner ? `, TypeScript via ${tsRunner.label}` : ''
        }. Source maps and skipped Node internals are configured for you.`
      : 'Ready — js-debug over loopback. No conventional entry point was found, so the active editor file is debugged.',
    transport: 'server',
    programPath: entry ?? '',
    launchArgs: nodeLaunchArgs(root, tsRunner?.runtimeArgs ?? []),
  };
}

export async function discoverDebugConfigs(
  root: string,
  signal?: AbortSignal,
): Promise<DiscoveredDebugConfig[]> {
  const runtimes = await detectRuntimes(root);
  const configs: DiscoveredDebugConfig[] = [];

  if (runtimes.node) configs.push(await discoverNode(root, signal));
  if (runtimes.python) configs.push(await discoverPython(root, signal));

  log.info('Debug discovery complete', {
    root,
    node: runtimes.node,
    python: runtimes.python,
    available: configs.filter((config) => config.available).length,
  });
  return configs;
}
