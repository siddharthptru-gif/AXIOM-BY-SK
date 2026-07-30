export interface WasmModuleImport {
  module: string;
  name: string;
  kind: string;
}

export interface WasmModuleExport {
  name: string;
  kind: string;
}

export interface WasmMemoryValue {
  buffer: ArrayBuffer;
}

export interface WasmInstanceValue {
  exports: Record<string, unknown>;
}

export interface WasmRuntimeApi {
  compile: (bytes: Uint8Array) => Promise<object>;
  instantiate: (module: object, imports: Record<string, never>) => Promise<WasmInstanceValue>;
  Module: {
    imports: (module: object) => WasmModuleImport[];
    exports: (module: object) => WasmModuleExport[];
  };
  Memory: new (...args: unknown[]) => WasmMemoryValue;
}

export function getWasmRuntime(): WasmRuntimeApi {
  const runtime = (globalThis as unknown as { WebAssembly?: WasmRuntimeApi }).WebAssembly;
  if (!runtime) throw new Error('WebAssembly runtime is unavailable.');
  return runtime;
}
