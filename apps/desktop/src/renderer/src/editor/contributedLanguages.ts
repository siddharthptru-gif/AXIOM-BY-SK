import { monaco } from './monacoEnv';
import type {
  ContributedLanguage,
  ContributedSnippet,
  ExtensionContributionCatalog,
} from '../../../common/contributions';

/**
 * Teach the editor about the languages and snippets installed extensions contribute.
 *
 * Two contribution points are handled here because both are pure data that the editor can
 * consume without running any extension code:
 *
 *   - **Languages.** A `languages` contribution is what makes `.rs` open as Rust rather
 *     than plain text, and its `configuration` file is what makes comment toggling,
 *     bracket matching and auto-closing behave correctly in that language. Monaco merges
 *     a repeated registration into the existing language, so contributing extensions to a
 *     language it already knows adds to it instead of replacing it.
 *   - **Snippets.** Bodies are fetched per language on first completion request rather
 *     than up front: a snippet pack for forty languages is a large payload, and all but
 *     the one being edited would be wasted.
 *
 * Everything registered here is disposed and re-registered when the catalog changes.
 * Monaco has no way to update a provider in place, and leaving the previous registration
 * behind would show snippets from an extension the user just uninstalled.
 */
let disposables: monaco.IDisposable[] = [];

function disposeAll(): void {
  for (const disposable of disposables) {
    try {
      disposable.dispose();
    } catch {
      // A provider that is already gone is not an error worth propagating; the point of
      // this pass is only to make sure nothing from the previous catalog survives it.
    }
  }
  disposables = [];
}

function registerLanguage(language: ContributedLanguage): void {
  monaco.languages.register({
    id: language.id,
    ...(language.extensions.length > 0 ? { extensions: [...language.extensions] } : {}),
    ...(language.filenames.length > 0 ? { filenames: [...language.filenames] } : {}),
    ...(language.aliases.length > 0 ? { aliases: [...language.aliases] } : {}),
  });

  const configuration = language.configuration;
  if (configuration === null) return;
  // Monaco ships a good configuration for the languages it knows. An extension's own
  // configuration still wins — installing it is a request for its behaviour — but a
  // contribution that shipped no configuration file must not blank out a working one,
  // which is why this is guarded on the file existing rather than on the language.
  const brackets = configuration.brackets.filter(
    (pair) => pair.length === 2 && pair[0] !== '' && pair[1] !== '',
  );
  const languageConfiguration: monaco.languages.LanguageConfiguration = {
    ...(configuration.lineComment !== null || configuration.blockComment !== null
      ? {
          comments: {
            ...(configuration.lineComment !== null
              ? { lineComment: configuration.lineComment }
              : {}),
            ...(configuration.blockComment !== null
              ? { blockComment: configuration.blockComment }
              : {}),
          },
        }
      : {}),
    ...(brackets.length > 0
      ? { brackets: brackets.map((pair) => [pair[0], pair[1]] as [string, string]) }
      : {}),
    ...(configuration.autoClosingPairs.length > 0
      ? { autoClosingPairs: configuration.autoClosingPairs.map((pair) => ({ ...pair })) }
      : {}),
    ...(configuration.surroundingPairs.length > 0
      ? { surroundingPairs: configuration.surroundingPairs.map((pair) => ({ ...pair })) }
      : {}),
  };
  if (Object.keys(languageConfiguration).length === 0) return;
  disposables.push(monaco.languages.setLanguageConfiguration(language.id, languageConfiguration));
}

/**
 * Completion items for one language's contributed snippets.
 *
 * The provider is registered eagerly (so the first keystroke already offers them) while the
 * bodies load on the first request and are then reused. A failed load yields no items
 * rather than an error: a missing snippet file should cost the user a suggestion, not their
 * completion list.
 */
function registerSnippets(language: string, workspaceRoot: string | null): void {
  let cache: Promise<ContributedSnippet[]> | null = null;
  const load = (): Promise<ContributedSnippet[]> => {
    cache ??= window.axiom.market
      .snippets(language, workspaceRoot)
      .catch(() => [] as ContributedSnippet[]);
    return cache;
  };
  disposables.push(
    monaco.languages.registerCompletionItemProvider(language, {
      provideCompletionItems: async (model, position) => {
        const snippets = await load();
        if (snippets.length === 0) return { suggestions: [] };
        const word = model.getWordUntilPosition(position);
        const range: monaco.IRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        return {
          suggestions: snippets.map((snippet) => ({
            label: snippet.prefix,
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: snippet.body,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
            detail: snippet.description ?? 'Extension snippet',
            documentation: { value: `\`\`\`\n${snippet.body}\n\`\`\`` },
          })),
        };
      },
    }),
  );
}

/** Apply a contribution catalog to the editor, replacing whatever was applied before. */
export function applyContributedLanguages(
  catalog: ExtensionContributionCatalog,
  workspaceRoot: string | null,
): void {
  disposeAll();
  for (const language of catalog.languages) {
    try {
      registerLanguage(language);
    } catch {
      // One malformed language contribution must not stop the rest from registering.
    }
  }
  for (const entry of catalog.snippetLanguages) {
    if (entry.count <= 0) continue;
    try {
      registerSnippets(entry.language, workspaceRoot);
    } catch {
      // Same reasoning: a language Monaco refuses to accept a provider for is skipped.
    }
  }
}

/** Remove every editor registration made from a contribution catalog. */
export function clearContributedLanguages(): void {
  disposeAll();
}
