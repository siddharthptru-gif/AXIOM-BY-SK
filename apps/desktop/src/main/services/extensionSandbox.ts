import { createHash, createPublicKey, verify } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { WebContents } from 'electron';
import type { ExtensionSandboxStatus } from '../../common/godMode';
import { DEFAULT_WASM_SANDBOX_POLICY, validateWasmModuleShape } from '../../common/godMode';
import { validateWasmBinaryResources } from '../../common/wasmResources';
import { summarizePermissions } from '../../common/extensionManifest';
import {
  listExtensions,
  resolveExtensionWasm,
  setSandboxExtensionEnabledState,
} from './extensions';
import { getWasmRuntime } from '../wasmRuntime';

interface WorkerResult {
  ok: boolean;
  sha256: string;
  imports: string[];
  exports: string[];
  activated: boolean;
  error: string | null;
}

interface ActiveWorker {
  ownerId: number;
  root: string;
  extensionId: string;
  worker: Worker;
}

const active = new Map<string, ActiveWorker>();
const lastErrors = new Map<string, string>();

function permissionsOf(text: string): string[] {
  return text === 'no special permissions' ? [] : text.split(' · ');
}

function signatureVerified(
  hash: string,
  signature: string | undefined,
  publisherKey: string | undefined,
): boolean {
  if (!signature || !publisherKey) return false;
  try {
    const key = createPublicKey(publisherKey);
    return (
      key.asymmetricKeyType === 'ed25519' &&
      verify(null, Buffer.from(hash, 'utf-8'), key, Buffer.from(signature, 'base64'))
    );
  } catch {
    return false;
  }
}

async function inspectOne(
  root: string,
  extensionId: string,
): Promise<ExtensionSandboxStatus> {
  const resolved = await resolveExtensionWasm(extensionId, root);
  if (!resolved?.manifest.runtime) throw new Error('Extension does not declare a WASM runtime.');
  const runtime = resolved.manifest.runtime;
  const stat = await fs.stat(resolved.modulePath);
  const bytes = await fs.readFile(resolved.modulePath);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const memoryLimitMb = runtime.memoryLimitMb ?? 32;
  let imports: string[] = [];
  let shapeErrors = [
    ...validateWasmModuleShape(stat.size, imports),
    ...validateWasmBinaryResources(bytes, {
      maxMemoryPages: Math.floor((memoryLimitMb * 1024 * 1024) / 65_536),
    }),
  ];
  if (hash === runtime.sha256 && shapeErrors.length === 0) {
    try {
      const wasm = getWasmRuntime();
      const module = await wasm.compile(bytes);
      imports = wasm.Module.imports(module).map((item) => `${item.module}.${item.name}`);
      shapeErrors = validateWasmModuleShape(stat.size, imports);
    } catch {
      shapeErrors = ['WASM module could not be compiled.'];
    }
  }
  const integrityVerified = hash === runtime.sha256 && shapeErrors.length === 0;
  const signed = signatureVerified(hash, runtime.signature, runtime.publisherKey);
  return {
    extensionId,
    runtime: 'wasm',
    enabled: resolved.manifest.enabled,
    integrityVerified,
    signatureVerified: signed,
    permissions: permissionsOf(summarizePermissions(resolved.manifest.permissions)),
    memoryLimitMb,
    executionTimeoutMs: runtime.timeoutMs ?? DEFAULT_WASM_SANDBOX_POLICY.executionTimeoutMs,
    lastError:
      lastErrors.get(extensionId) ??
      (integrityVerified ? null : shapeErrors[0] ?? 'WASM integrity verification failed.'),
  };
}

export async function listExtensionSandboxes(root: string): Promise<ExtensionSandboxStatus[]> {
  const manifests = await listExtensions(root);
  const statuses: ExtensionSandboxStatus[] = [];
  for (const manifest of manifests) {
    if (!manifest.runtime) continue;
    try {
      statuses.push(await inspectOne(root, manifest.id));
    } catch (error) {
      statuses.push({
        extensionId: manifest.id,
        runtime: 'wasm',
        enabled: manifest.enabled,
        integrityVerified: false,
        signatureVerified: false,
        permissions: permissionsOf(summarizePermissions(manifest.permissions)),
        memoryLimitMb: manifest.runtime.memoryLimitMb ?? 32,
        executionTimeoutMs:
          manifest.runtime.timeoutMs ?? DEFAULT_WASM_SANDBOX_POLICY.executionTimeoutMs,
        lastError: error instanceof Error ? error.message.slice(0, 500) : 'Sandbox inspection failed.',
      });
    }
  }
  return statuses.sort((a, b) => a.extensionId.localeCompare(b.extensionId));
}

function runWorker(
  owner: WebContents,
  root: string,
  extensionId: string,
  modulePath: string,
  expectedSha256: string,
  memoryLimitMb: number,
  timeoutMs: number,
): Promise<WorkerResult> {
  if (active.has(extensionId)) throw new Error('This extension sandbox is already running.');
  const worker = new Worker(join(__dirname, 'extensionSandboxWorker.js'), {
    workerData: {
      modulePath,
      expectedSha256,
      maxModuleBytes: DEFAULT_WASM_SANDBOX_POLICY.maxModuleBytes,
      maxMemoryPages: Math.floor((memoryLimitMb * 1024 * 1024) / 65_536),
    },
    resourceLimits: {
      maxOldGenerationSizeMb: memoryLimitMb,
      maxYoungGenerationSizeMb: Math.max(4, Math.floor(memoryLimitMb / 4)),
      stackSizeMb: 2,
    },
    stdout: false,
    stderr: false,
  });
  const record = { ownerId: owner.id, root, extensionId, worker };
  active.set(extensionId, record);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (result?: WorkerResult, error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      owner.removeListener('destroyed', onOwnerDestroyed);
      if (active.get(extensionId) === record) active.delete(extensionId);
      void worker.terminate();
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error('Extension sandbox stopped without a result.'));
    };
    const onOwnerDestroyed = (): void => {
      if (active.get(extensionId) === record) {
        finish(undefined, new Error('Extension sandbox owner was destroyed.'));
      }
    };
    timer = setTimeout(
      () => finish(undefined, new Error(`Extension exceeded its ${timeoutMs} ms execution quota.`)),
      timeoutMs,
    );
    owner.once('destroyed', onOwnerDestroyed);
    worker.once('message', (value: WorkerResult) => finish(value));
    worker.once('error', (error) => finish(undefined, error));
    worker.once('exit', (code) => {
      if (code !== 0) finish(undefined, new Error(`Extension sandbox exited with code ${code}.`));
    });
  });
}

export async function enableSandboxExtension(
  owner: WebContents,
  root: string,
  extensionId: unknown,
  confirmation: unknown,
  allowUnsigned: unknown,
): Promise<ExtensionSandboxStatus[]> {
  if (confirmation !== true) throw new Error('Enabling a sandboxed extension requires explicit confirmation.');
  const id = typeof extensionId === 'string' ? extensionId.trim() : '';
  if (!id) throw new Error('Extension id is required.');
  const resolved = await resolveExtensionWasm(id, root);
  if (!resolved?.manifest.runtime) throw new Error('Extension does not declare a valid WASM runtime.');
  const runtime = resolved.manifest.runtime;
  const inspection = await inspectOne(root, id);
  if (!inspection.integrityVerified) throw new Error(inspection.lastError ?? 'WASM integrity verification failed.');
  if (allowUnsigned !== true) {
    throw new Error(
      inspection.signatureVerified
        ? 'This signature uses a self-declared publisher key. Explicitly approve the untrusted publisher to continue.'
        : 'This WASM package is unsigned. Explicitly approve untrusted local execution to continue.',
    );
  }
  try {
    const result = await runWorker(
      owner,
      root,
      id,
      resolved.modulePath,
      runtime.sha256,
      inspection.memoryLimitMb,
      inspection.executionTimeoutMs,
    );
    if (!result.ok) throw new Error(result.error ?? 'WASM activation failed.');
    lastErrors.delete(id);
    await setSandboxExtensionEnabledState(id, true, root);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'WASM activation failed.';
    lastErrors.set(id, message);
    await setSandboxExtensionEnabledState(id, false, root).catch(() => undefined);
    throw new Error(message);
  }
  return listExtensionSandboxes(root);
}

export async function disableSandboxExtension(
  root: string,
  extensionId: unknown,
): Promise<ExtensionSandboxStatus[]> {
  const id = typeof extensionId === 'string' ? extensionId.trim() : '';
  if (!id) throw new Error('Extension id is required.');
  const running = active.get(id);
  if (running) {
    active.delete(id);
    await running.worker.terminate();
  }
  await setSandboxExtensionEnabledState(id, false, root);
  return listExtensionSandboxes(root);
}

async function terminateMatchingExtensionSandboxes(
  predicate: (item: ActiveWorker) => boolean,
): Promise<void> {
  const workers: ActiveWorker[] = [];
  for (const [id, item] of active) {
    if (!predicate(item)) continue;
    if (active.get(id) === item) active.delete(id);
    workers.push(item);
  }
  await Promise.allSettled(workers.map((item) => item.worker.terminate()));
}

export async function terminateExtensionSandboxesForOwner(ownerId: number): Promise<void> {
  await terminateMatchingExtensionSandboxes((item) => item.ownerId === ownerId);
}

export async function terminateExtensionSandboxesForWorkspace(root: string): Promise<void> {
  const key = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);
  await terminateMatchingExtensionSandboxes((item) => {
    const itemRoot = resolve(item.root);
    return (process.platform === 'win32' ? itemRoot.toLowerCase() : itemRoot) === key;
  });
}

export async function terminateAllExtensionSandboxes(): Promise<void> {
  await terminateMatchingExtensionSandboxes(() => true);
}
