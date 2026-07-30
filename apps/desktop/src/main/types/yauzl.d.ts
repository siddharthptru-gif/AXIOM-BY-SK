import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

/**
 * Local type declarations for `yauzl` 3.4.0.
 *
 * yauzl ships no types of its own, and the published `@types/yauzl` package still
 * describes the 2.x callback-only API — using it here would type away the promise
 * methods this code actually calls. These declarations cover only the surface AXIOM
 * uses, transcribed from the installed module rather than guessed, so a yauzl upgrade
 * that changes that surface fails the typecheck instead of failing at runtime.
 *
 * Intentionally omitted: `open`/`fromFd`/`fromRandomAccessReader` and the low-level
 * local-header readers. A VSIX is read from a buffer that has already been
 * integrity-checked, so there is no reason to expose file-descriptor entry points.
 */
declare module 'yauzl' {
  /** One central-directory record. */
  export interface Entry {
    /** Decoded entry name. yauzl rejects traversal in this value when decoding. */
    readonly fileName: string;
    readonly uncompressedSize: number;
    readonly compressedSize: number;
    /** 0 = stored, 8 = deflate. Anything else is unsupported. */
    readonly compressionMethod: number;
    readonly crc32: number;
    readonly generalPurposeBitFlag: number;
    /** Unix mode lives in the high 16 bits when `versionMadeBy >> 8` is 3. */
    readonly externalFileAttributes: number;
    readonly versionMadeBy: number;
    isEncrypted(): boolean;
    isCompressed(): boolean;
    /** False when the entry uses a feature yauzl cannot decode. */
    canDecodeFileData(): boolean;
    getLastModDate(): Date;
  }

  export interface ZipFile extends EventEmitter {
    readonly entryCount: number;
    readonly entriesRead: number;
    readonly fileSize: number;
    readonly isOpen: boolean;
    /** With `lazyEntries`, advances to the next `entry` (or `end`) event. */
    readEntry(): void;
    openReadStreamPromise(entry: Entry): Promise<Readable>;
    close(): void;
    on(event: 'entry', listener: (entry: Entry) => void): this;
    on(event: 'end', listener: () => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'close', listener: () => void): this;
  }

  export interface FromBufferOptions {
    /** Required for bounded reads: entries arrive one `readEntry()` at a time. */
    lazyEntries?: boolean;
    /** Leave true so yauzl validates entry names while decoding them. */
    decodeStrings?: boolean;
    /** Leave true so a lying central directory fails the read. */
    validateEntrySizes?: boolean;
    strictFileNames?: boolean;
  }

  export function fromBufferPromise(buffer: Buffer, options?: FromBufferOptions): Promise<ZipFile>;

  /**
   * yauzl's own name check: rejects backslashes, drive-letter and rooted absolute
   * paths, and any `..` path segment. Returns the reason, or null when the name is
   * acceptable.
   */
  export function validateFileName(fileName: string): string | null;
}
