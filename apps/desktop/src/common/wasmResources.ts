export interface WasmBinaryResourcePolicy {
  maxMemoryPages: number;
  maxTableElements: number;
}

export const DEFAULT_WASM_BINARY_RESOURCE_POLICY: Readonly<WasmBinaryResourcePolicy> =
  Object.freeze({
    maxMemoryPages: 256,
    maxTableElements: 100_000,
  });

interface Cursor {
  offset: number;
}

function readU32(bytes: Uint8Array, cursor: Cursor, end: number): number {
  let value = 0;
  let shift = 0;
  for (let index = 0; index < 5; index++) {
    if (cursor.offset >= end) throw new Error('WASM section is truncated.');
    const byte = bytes[cursor.offset++]!;
    if (index === 4 && (byte & 0xf0) !== 0) throw new Error('WASM integer exceeds u32.');
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value >>> 0;
    shift += 7;
  }
  throw new Error('WASM integer encoding is invalid.');
}

function validateLimits(
  bytes: Uint8Array,
  cursor: Cursor,
  end: number,
  kind: 'memory' | 'table',
  maximum: number,
): string | null {
  const flags = readU32(bytes, cursor, end);
  if ((flags & ~1) !== 0) return `${kind} uses unsupported shared or 64-bit limits.`;
  const minimum = readU32(bytes, cursor, end);
  const declaredMaximum = (flags & 1) !== 0 ? readU32(bytes, cursor, end) : null;
  if (minimum > maximum) return `${kind} minimum exceeds the configured limit.`;
  if (declaredMaximum === null) return `${kind} must declare a maximum.`;
  if (declaredMaximum < minimum) return `${kind} maximum is below its minimum.`;
  if (declaredMaximum > maximum) return `${kind} maximum exceeds the configured limit.`;
  return null;
}

/**
 * Inspect standard table/memory sections without compiling or instantiating the module.
 * Unknown proposals in these resource sections fail closed; unrelated sections remain
 * the WebAssembly engine's responsibility.
 */
export function validateWasmBinaryResources(
  bytes: Uint8Array,
  policy: Partial<WasmBinaryResourcePolicy> = {},
): string[] {
  const maxMemoryPages =
    Number.isSafeInteger(policy.maxMemoryPages) && (policy.maxMemoryPages ?? 0) > 0
      ? Math.min(65_536, policy.maxMemoryPages!)
      : DEFAULT_WASM_BINARY_RESOURCE_POLICY.maxMemoryPages;
  const maxTableElements =
    Number.isSafeInteger(policy.maxTableElements) && (policy.maxTableElements ?? 0) > 0
      ? Math.min(1_000_000, policy.maxTableElements!)
      : DEFAULT_WASM_BINARY_RESOURCE_POLICY.maxTableElements;
  const errors: string[] = [];
  if (
    bytes.length < 8 ||
    bytes[0] !== 0x00 ||
    bytes[1] !== 0x61 ||
    bytes[2] !== 0x73 ||
    bytes[3] !== 0x6d ||
    bytes[4] !== 0x01 ||
    bytes[5] !== 0x00 ||
    bytes[6] !== 0x00 ||
    bytes[7] !== 0x00
  ) {
    return ['WASM header or version is invalid.'];
  }

  const cursor: Cursor = { offset: 8 };
  let sawTableSection = false;
  let sawMemorySection = false;
  try {
    while (cursor.offset < bytes.length) {
      const sectionId = bytes[cursor.offset++]!;
      const sectionSize = readU32(bytes, cursor, bytes.length);
      const sectionEnd = cursor.offset + sectionSize;
      if (sectionEnd > bytes.length || sectionEnd < cursor.offset) {
        throw new Error('WASM section length is invalid.');
      }
      if (sectionId === 4) {
        if (sawTableSection) errors.push('WASM contains duplicate table sections.');
        sawTableSection = true;
        const count = readU32(bytes, cursor, sectionEnd);
        if (count > 1) errors.push('WASM declares more than one table.');
        for (let index = 0; index < count; index++) {
          if (cursor.offset >= sectionEnd) throw new Error('WASM table section is truncated.');
          const referenceType = bytes[cursor.offset++]!;
          if (referenceType !== 0x70 && referenceType !== 0x6f) {
            errors.push('WASM table reference type is unsupported.');
          }
          const error = validateLimits(
            bytes,
            cursor,
            sectionEnd,
            'table',
            maxTableElements,
          );
          if (error) errors.push(error);
        }
        if (cursor.offset !== sectionEnd) errors.push('WASM table section shape is unsupported.');
      } else if (sectionId === 5) {
        if (sawMemorySection) errors.push('WASM contains duplicate memory sections.');
        sawMemorySection = true;
        const count = readU32(bytes, cursor, sectionEnd);
        if (count > 1) errors.push('WASM declares more than one memory.');
        for (let index = 0; index < count; index++) {
          const error = validateLimits(
            bytes,
            cursor,
            sectionEnd,
            'memory',
            maxMemoryPages,
          );
          if (error) errors.push(error);
        }
        if (cursor.offset !== sectionEnd) errors.push('WASM memory section shape is unsupported.');
      }
      cursor.offset = sectionEnd;
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'WASM resource sections are invalid.');
  }
  return [...new Set(errors)].slice(0, 20);
}
