import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { getWasmRuntime } from './wasmRuntime';
import { validateWasmBinaryResources } from '../common/wasmResources';

interface SandboxWorkerInput {
  modulePath: string;
  expectedSha256: string;
  maxModuleBytes: number;
  maxMemoryPages: number;
}

interface SandboxWorkerResult {
  ok: boolean;
  sha256: string;
  imports: string[];
  exports: string[];
  activated: boolean;
  error: string | null;
}

function fail(message: string): never {
  throw new Error(message.slice(0, 500));
}

async function main(): Promise<SandboxWorkerResult> {
  const input = workerData as SandboxWorkerInput;
  if (!input || typeof input.modulePath !== 'string') fail('Sandbox input is invalid.');
  const stat = await fs.stat(input.modulePath);
  if (!stat.isFile()) fail('WASM entry is not a regular file.');
  if (stat.size <= 0 || stat.size > input.maxModuleBytes) fail('WASM module size is outside policy.');
  const bytes = await fs.readFile(input.modulePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== input.expectedSha256) fail('WASM integrity verification failed.');
  const resourceErrors = validateWasmBinaryResources(bytes, {
    maxMemoryPages: input.maxMemoryPages,
  });
  if (resourceErrors.length > 0) fail(resourceErrors.join(' '));
  const wasm = getWasmRuntime();
  const module = await wasm.compile(bytes);
  const imports = wasm.Module.imports(module).map((item) => `${item.module}.${item.name}`);
  if (imports.length > 0) fail(`WASM imports are denied: ${imports.join(', ')}`);
  const exportNames = wasm.Module.exports(module).map((item) => item.name).slice(0, 200);
  const instance = await wasm.instantiate(module, {});
  for (const value of Object.values(instance.exports)) {
    if (value instanceof wasm.Memory) {
      const pages = value.buffer.byteLength / 65_536;
      if (pages > input.maxMemoryPages) fail('WASM memory exceeds the configured page limit.');
    }
  }
  const activation = instance.exports['axiom_activate'] ?? instance.exports['_start'];
  let activated = false;
  if (typeof activation === 'function') {
    const result = activation();
    if (typeof result === 'number' && !Number.isFinite(result)) fail('WASM activation returned an invalid value.');
    activated = true;
  }
  return { ok: true, sha256, imports, exports: exportNames, activated, error: null };
}

void main().then(
  (result) => parentPort?.postMessage(result),
  (error: unknown) =>
    parentPort?.postMessage({
      ok: false,
      sha256: '',
      imports: [],
      exports: [],
      activated: false,
      error: error instanceof Error ? error.message.slice(0, 500) : 'WASM sandbox failed.',
    } satisfies SandboxWorkerResult),
);
