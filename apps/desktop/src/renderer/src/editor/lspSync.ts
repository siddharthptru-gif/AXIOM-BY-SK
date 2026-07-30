import { monaco } from './monacoEnv';
import { languageIdForPath } from '../../../common/lspServers';
import { diagnosticToMarker, findModel } from './lspConvert';
import type { LspContentChange, LspDiagnostic } from '../../../common/ipc';

/**
 * Document lifecycle for the language servers.
 *
 * Two things make this more than a wrapper around didOpen/didChange:
 *
 * 1. Sync is INCREMENTAL. Monaco reports exactly which spans changed; those
 *    spans go on the wire instead of the whole file on every keystroke. Main
 *    keeps its own copy by replaying them and answers `resync` if the two ever
 *    disagree, so a drift is corrected rather than silently tolerated.
 *
 * 2. Diagnostics are attributed PER SERVER. tsserver, ESLint and Tailwind can all
 *    describe the same file; each gets its own Monaco marker owner so publishing
 *    one server's results never erases another's.
 */

/** Debounce for change flushing: long enough to batch a burst of typing. */
const CHANGE_DEBOUNCE_MS = 150;
/** Marker owner prefix. One owner per server keeps their results independent. */
const MARKER_OWNER_PREFIX = 'axiom-lsp';

export function markerOwnerFor(serverId: string | undefined): string {
  return serverId ? `${MARKER_OWNER_PREFIX}:${serverId}` : MARKER_OWNER_PREFIX;
}

/** Every marker owner this module has ever written, so all can be cleared. */
const markerOwners = new Set<string>([MARKER_OWNER_PREFIX]);

interface DocState {
  model: monaco.editor.ITextModel;
  languageId: string;
  /** LSP document version, incremented per flushed batch. */
  version: number;
  /** Changes accumulated since the last flush, in the order Monaco produced them. */
  pending: LspContentChange[];
  changeSub: monaco.IDisposable;
  flushTimer: number | null;
  /** Generation the document was bound in; a workspace switch invalidates it. */
  generation: number;
  /** True while a resync is in flight, so batches are not interleaved with it. */
  resyncing: boolean;
}

export interface LspSyncHost {
  /** Current workspace root, or null when no folder is open. */
  root(): string | null;
  /** Called after a document's text reached the servers, to refresh derived data. */
  onDocumentSynced(uri: string): void;
}

export class LspSync {
  private readonly docs = new Map<string, DocState>();
  private readonly pendingOpens = new Map<string, number>();
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly host: LspSyncHost) {}

  /** Serialize lifecycle calls so open/close can never race for one URI. */
  private enqueue(operation: () => Promise<void>): void {
    this.queue = this.queue.then(operation, operation).catch(() => undefined);
  }

  isOpen(uri: string): boolean {
    return this.docs.has(uri);
  }

  openModels(): void {
    for (const model of monaco.editor.getModels()) this.open(model);
  }

  /** Bind a model to its language servers, if the workspace and type allow it. */
  open(model: monaco.editor.ITextModel): void {
    const root = this.host.root();
    if (root === null || model.uri.scheme !== 'file') return;
    const languageId = languageIdForPath(model.uri.fsPath);
    if (!languageId) return;
    const uri = model.uri.toString();
    const generation = this.generation;
    if (this.docs.get(uri)?.generation === generation) return;
    if (this.pendingOpens.get(uri) === generation) return;

    this.pendingOpens.set(uri, generation);
    this.enqueue(async () => {
      try {
        if (
          this.pendingOpens.get(uri) !== generation ||
          generation !== this.generation ||
          this.host.root() !== root ||
          model.isDisposed()
        ) {
          return;
        }
        const versionAtOpen = model.getVersionId();
        try {
          await window.axiom.lsp.didOpen({
            uri,
            languageId,
            version: 1,
            text: model.getValue(),
            rootPath: root,
          });
        } catch {
          return;
        }
        if (
          generation !== this.generation ||
          this.host.root() !== root ||
          model.isDisposed() ||
          this.docs.has(uri)
        ) {
          return;
        }

        const state: DocState = {
          model,
          languageId,
          version: 1,
          pending: [],
          changeSub: { dispose: () => undefined },
          flushTimer: null,
          generation,
          resyncing: false,
        };
        state.changeSub = model.onDidChangeContent((event) => this.record(uri, event));
        this.docs.set(uri, state);

        // Edits landing while didOpen was in flight would otherwise be lost;
        // a full resync is the only correct recovery since their spans are gone.
        if (model.getVersionId() !== versionAtOpen) void this.resync(uri);
        else this.host.onDocumentSynced(uri);
      } finally {
        if (this.pendingOpens.get(uri) === generation) this.pendingOpens.delete(uri);
      }
    });
  }

  /**
   * Accumulate Monaco's change spans. Monaco emits them in descending position
   * order within one event, which is exactly the order LSP requires for
   * sequential application, so they are forwarded verbatim.
   */
  private record(uri: string, event: monaco.editor.IModelContentChangedEvent): void {
    const state = this.docs.get(uri);
    if (!state) return;
    for (const change of event.changes) {
      state.pending.push({
        text: change.text,
        range: {
          start: { line: change.range.startLineNumber - 1, character: change.range.startColumn - 1 },
          end: { line: change.range.endLineNumber - 1, character: change.range.endColumn - 1 },
        },
        rangeLength: change.rangeLength,
      });
    }
    if (state.flushTimer !== null) window.clearTimeout(state.flushTimer);
    state.flushTimer = window.setTimeout(() => {
      state.flushTimer = null;
      void this.flush(uri);
    }, CHANGE_DEBOUNCE_MS);
  }

  private async flush(uri: string): Promise<void> {
    const state = this.docs.get(uri);
    if (!state || state.resyncing || state.pending.length === 0) return;
    if (state.generation !== this.generation || state.model.isDisposed()) return;
    const changes = state.pending;
    state.pending = [];
    state.version += 1;
    try {
      const result = await window.axiom.lsp.didChange({
        uri,
        version: state.version,
        changes,
        length: state.model.getValueLength(),
      });
      if (result?.resync) {
        await this.resync(uri);
        return;
      }
    } catch {
      return;
    }
    if (this.docs.get(uri) === state) this.host.onDocumentSynced(uri);
  }

  /** Send the whole document, restoring agreement between renderer and Main. */
  private async resync(uri: string): Promise<void> {
    const state = this.docs.get(uri);
    if (!state || state.model.isDisposed()) return;
    state.resyncing = true;
    state.pending = [];
    state.version += 1;
    try {
      await window.axiom.lsp.resync(uri, state.version, state.model.getValue());
    } catch {
      return;
    } finally {
      state.resyncing = false;
    }
    if (this.docs.get(uri) === state) this.host.onDocumentSynced(uri);
  }

  /** Flush immediately — used before a request that must see the latest text. */
  async flushNow(uri: string): Promise<void> {
    const state = this.docs.get(uri);
    if (!state) return;
    if (state.flushTimer !== null) {
      window.clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    await this.flush(uri);
  }

  /** Notify servers a document was saved (ESLint and Prettier act on save). */
  didSave(path: string): void {
    const model = monaco.editor.getModel(monaco.Uri.file(path));
    if (!model) return;
    const uri = model.uri.toString();
    if (!this.docs.has(uri)) return;
    void this.flushNow(uri).then(() => {
      void window.axiom.lsp.didSave(uri, model.getValue()).catch(() => undefined);
    });
  }

  private unbind(uri: string): void {
    const state = this.docs.get(uri);
    if (!state) return;
    state.changeSub.dispose();
    if (state.flushTimer !== null) window.clearTimeout(state.flushTimer);
    this.docs.delete(uri);
  }

  close(model: monaco.editor.ITextModel): void {
    this.closeUri(model.uri.toString());
  }

  closeUri(uri: string): void {
    const wasOpen = this.docs.has(uri);
    this.unbind(uri);
    this.pendingOpens.delete(uri);
    if (!wasOpen) return;
    this.enqueue(async () => {
      await window.axiom.lsp.didClose(uri).catch(() => undefined);
    });
  }

  /** Clear every marker this layer owns, across all servers. */
  clearMarkers(): void {
    for (const model of monaco.editor.getModels()) {
      for (const owner of markerOwners) monaco.editor.setModelMarkers(model, owner, []);
    }
  }

  /**
   * Rebind everything to a new workspace root. Bumping the generation makes any
   * in-flight open from the previous root a no-op when it lands.
   */
  reconcileRoot(previousRoot: string | null, nextRoot: string | null): void {
    void previousRoot;
    const generation = ++this.generation;
    const openUris = [...this.docs.keys()];
    for (const uri of openUris) this.unbind(uri);
    this.pendingOpens.clear();
    this.clearMarkers();

    this.enqueue(async () => {
      for (const uri of openUris) {
        await window.axiom.lsp.didClose(uri).catch(() => undefined);
      }
      if (generation !== this.generation || this.host.root() !== nextRoot || nextRoot === null) {
        return;
      }
      this.openModels();
    });
  }

  /**
   * Paint one server's diagnostics. Using a per-server owner is what allows
   * ESLint warnings and tsserver errors to coexist on the same line.
   */
  applyDiagnostics(uri: string, diagnostics: LspDiagnostic[], serverId: string | undefined): void {
    const model = findModel(uri);
    if (!model) return;
    const owner = markerOwnerFor(serverId);
    markerOwners.add(owner);
    monaco.editor.setModelMarkers(
      model,
      owner,
      diagnostics.map((d) => diagnosticToMarker(d, serverId ?? 'lsp')),
    );
  }
}
