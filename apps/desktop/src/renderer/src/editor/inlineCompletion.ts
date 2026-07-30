import { monaco } from './monacoEnv';
import { shouldTriggerCompletion } from '../../../common/completion';
import { arbitrateInline, type InlinePriority } from '../../../common/nextEdit';

/**
 * Low-latency predictive completion provider. Main owns provider cancellation,
 * deduplication, cache isolation, and metrics; the renderer binds every result to
 * the exact Monaco document version and reports only user interaction outcomes.
 */
const PREFIX_CHARS = 4_000;
const SUFFIX_CHARS = 1_000;
const DEBOUNCE_MS = 180;
const ACCEPT_COMMAND = 'axiom.inlineCompletion.accepted';

let registered = false;
let inlineEnabled = true;
let inlinePriority: InlinePriority = 'inline';
const decisions = new Map<string, boolean>();
const containers = new WeakMap<object, { requestId: string; textLength: number }>();

/** Enable or disable predictive requests without unregistering Monaco's provider. */
export function setInlineCompletionEnabled(enabled: boolean): void {
  inlineEnabled = enabled;
}

/** Set the inline-vs-IntelliSense priority; called from the settings bridge. */
export function setInlineCompletionPriority(priority: InlinePriority): void {
  inlinePriority = priority;
}

function report(
  requestId: string,
  kind: 'accepted' | 'accepted-partial' | 'dismissed' | 'stale',
  acceptedCharacters: number,
): void {
  if (decisions.get(requestId)) return;
  decisions.set(requestId, true);
  void window.axiom.ai
    .completionFeedback({ requestId, kind, acceptedCharacters, at: Date.now() })
    .catch(() => undefined);
  window.setTimeout(() => decisions.delete(requestId), 60_000);
}

export function initInlineCompletion(): void {
  if (registered) return;
  registered = true;

  monaco.editor.registerCommand(
    ACCEPT_COMMAND,
    (_accessor, requestId: unknown, textLength: unknown) => {
      if (typeof requestId !== 'string') return;
      report(
        requestId,
        'accepted',
        typeof textLength === 'number' && Number.isFinite(textLength) ? textLength : 0,
      );
    },
  );

  monaco.languages.registerInlineCompletionsProvider('*', {
    provideInlineCompletions: async (model, position, _context, token) => {
      if (model.uri.scheme !== 'file') return { items: [] };
      const offset = model.getOffsetAt(position);
      const full = model.getValue();
      const prefix = full.slice(Math.max(0, offset - PREFIX_CHARS), offset);
      const suffix = full.slice(offset, offset + SUFFIX_CHARS);
      const language = model.getLanguageId();
      if (!shouldTriggerCompletion(prefix, suffix)) return { items: [] };
      if (!arbitrateInline({ enabled: inlineEnabled, prefix, priority: inlinePriority })) {
        return { items: [] };
      }

      const requestId = crypto.randomUUID();
      const documentVersion = model.getVersionId();
      let cancellationRequested = false;
      const cancellation = token.onCancellationRequested(() => {
        cancellationRequested = true;
        void window.axiom.ai.cancelCompletion(requestId).catch(() => undefined);
      });
      try {
        await new Promise<void>((resolve) => window.setTimeout(resolve, DEBOUNCE_MS));
        if (!inlineEnabled || token.isCancellationRequested || cancellationRequested) {
          return { items: [] };
        }
        const result = await window.axiom.ai.complete({
          requestId,
          documentUri: model.uri.toString(),
          documentVersion,
          prefix,
          suffix,
          language,
          trigger: 'typing',
          maxLines: 12,
        });
        const stale =
          !inlineEnabled ||
          token.isCancellationRequested ||
          cancellationRequested ||
          result.stale ||
          result.documentVersion !== documentVersion ||
          model.getVersionId() !== documentVersion;
        if (stale) {
          report(requestId, 'stale', 0);
          return { items: [] };
        }
        if (!result.text) return { items: [] };
        const completion = {
          items: [
            {
              insertText: result.text,
              range: new monaco.Range(
                position.lineNumber,
                position.column,
                position.lineNumber,
                position.column,
              ),
              command: {
                id: ACCEPT_COMMAND,
                title: 'Record accepted Axiom completion',
                arguments: [requestId, result.text.length],
              },
            },
          ],
        };
        containers.set(completion, { requestId, textLength: result.text.length });
        return completion;
      } catch {
        return { items: [] };
      } finally {
        cancellation.dispose();
      }
    },
    handlePartialAccept: (completions, _item, acceptedCharacters) => {
      const meta = containers.get(completions as object);
      if (meta) report(meta.requestId, 'accepted-partial', acceptedCharacters);
    },
    freeInlineCompletions: (completions) => {
      const meta = containers.get(completions as object);
      if (!meta) return;
      window.setTimeout(() => {
        if (!decisions.get(meta.requestId)) report(meta.requestId, 'dismissed', 0);
      }, 0);
    },
  });
}
