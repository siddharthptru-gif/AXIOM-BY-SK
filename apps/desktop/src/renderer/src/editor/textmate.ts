import onigWasmUrl from 'vscode-oniguruma/release/onig.wasm?url';
import { monaco } from './monacoEnv';
import type { ContributedGrammar } from '../../../common/contributions';
import type { MonacoTokenRule } from '../../../common/vscodeTheme';

/**
 * TextMate grammar highlighting, the way VS Code does it.
 *
 * Monaco ships Monarch grammars for the languages it knows. An installed language extension
 * ships a *TextMate* grammar instead, and nothing in Monaco can read one — so without this
 * module, installing a Rust or Nim extension adds a language id and no colour. The engine is
 * the same pair VS Code uses: `vscode-textmate` to interpret the grammar and
 * `vscode-oniguruma` (a WebAssembly build of Oniguruma) to run its regular expressions,
 * because TextMate patterns use Oniguruma syntax that JavaScript's own RegExp does not
 * support.
 *
 * Three decisions shape this file:
 *
 *   1. **Everything is lazy.** The 460 KB WebAssembly module is not fetched until a file
 *      actually needs a contributed grammar, and each grammar is compiled on first use of
 *      its language through Monaco's tokens-provider factory. Opening a TypeScript file in a
 *      workspace with twenty installed grammars costs nothing.
 *   2. **Colours travel through the theme, not through a global override.** Encoded tokens
 *      index a colour map, and Monaco accepts one per theme via `encodedTokensColors`. The
 *      alternative, `monaco.languages.setColorMap`, replaces the *editor-wide* map and
 *      breaks the Monarch-highlighted languages that share it. So the TextMate colour map is
 *      published into the theme definition and the two tokenizers coexist.
 *   3. **Failure is silent and local.** A grammar that will not parse leaves its language on
 *      Monaco's built-in tokenizer. A broken third-party grammar should cost that language
 *      its colours, not the editor its ability to open files.
 */
type OnigModule = typeof import('vscode-oniguruma');
type TextMateModule = typeof import('vscode-textmate');

interface Engine {
  textmate: TextMateModule;
  registry: import('vscode-textmate').Registry;
}

let enginePromise: Promise<Engine | null> | null = null;
let grammarWorkspaceRoot: string | null = null;
/** Scope names the current catalog can serve, so unknown scopes fail without an IPC call. */
let knownScopes = new Set<string>();
let colorMap: string[] = [];
let colorMapListener: ((colors: string[]) => void) | null = null;
let themeRules: MonacoTokenRule[] = [];
let providers: monaco.IDisposable[] = [];

/**
 * Load the Oniguruma WebAssembly module.
 *
 * Fetched from the packaged renderer origin — Vite emits it as a hashed asset — so the bytes
 * are the ones that shipped, never anything an extension supplied. Compiling WebAssembly is
 * why the production CSP carries `'wasm-unsafe-eval'`; see docs/security-architecture.md.
 */
async function loadOniguruma(): Promise<OnigModule> {
  const oniguruma = await import('vscode-oniguruma');
  const response = await fetch(onigWasmUrl);
  if (!response.ok) throw new Error(`Oniguruma module unavailable (${response.status})`);
  await oniguruma.loadWASM(await response.arrayBuffer());
  return oniguruma;
}

async function createEngine(): Promise<Engine | null> {
  try {
    const [oniguruma, textmate] = await Promise.all([loadOniguruma(), import('vscode-textmate')]);
    const registry = new textmate.Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (sources: string[]) => oniguruma.createOnigScanner(sources),
        createOnigString: (value: string) => oniguruma.createOnigString(value),
      }),
      loadGrammar: async (scopeName: string) => {
        if (!knownScopes.has(scopeName)) return null;
        const source = await window.axiom.market.loadGrammar(scopeName, grammarWorkspaceRoot);
        if (source === null) return null;
        // `parseRawGrammar` picks its parser from the file name, and both formats are in the
        // wild: `.tmLanguage` files are XML property lists, `.tmLanguage.json` files are
        // JSON. Main reports which one it read, and a synthetic name carries that to the
        // parser without the renderer ever handling a real path.
        return textmate.parseRawGrammar(
          source.content,
          source.format === 'json' ? 'grammar.json' : 'grammar.plist',
        );
      },
    });
    applyThemeToRegistry(registry);
    return { textmate, registry };
  } catch {
    return null;
  }
}

function ensureEngine(): Promise<Engine | null> {
  enginePromise ??= createEngine();
  return enginePromise;
}

/**
 * Push the active theme into the grammar engine and republish its colour map.
 *
 * The engine needs the theme in TextMate form because it resolves a token's colour while
 * tokenizing — an encoded token is an index into the map, not a scope name. Rules arrive
 * here in Monaco form (six hex digits, no `#`) and are converted back, which keeps the theme
 * pipeline single-sourced: one set of rules drives both tokenizers.
 */
function applyThemeToRegistry(registry: import('vscode-textmate').Registry): void {
  const settings = themeRules
    .filter((rule) => rule.foreground !== undefined || rule.fontStyle !== undefined)
    .map((rule) => ({
      ...(rule.token === '' ? {} : { scope: rule.token }),
      settings: {
        ...(rule.foreground !== undefined ? { foreground: `#${rule.foreground}` } : {}),
        ...(rule.fontStyle !== undefined ? { fontStyle: rule.fontStyle } : {}),
      },
    }));
  registry.setTheme({ settings });
  colorMap = registry.getColorMap();
  colorMapListener?.(colorMap);
}

/**
 * Adopt a theme for grammar highlighting.
 *
 * Called by the theme controller with the same rules it hands Monaco. When the engine is not
 * running yet this only records them — the engine picks them up when it starts, which is the
 * common case, since a theme is chosen long before a file that needs a grammar is opened.
 */
export function setTextMateTheme(
  rules: readonly MonacoTokenRule[],
  onColorMap: (colors: string[]) => void,
): void {
  themeRules = rules.map((rule) => ({ ...rule }));
  colorMapListener = onColorMap;
  if (enginePromise === null) return;
  void enginePromise.then((engine) => {
    if (engine !== null) applyThemeToRegistry(engine.registry);
  });
}

/** The colour map for the theme currently loaded into the engine. */
export function textMateColorMap(): string[] {
  return colorMap;
}

/**
 * Register a tokens provider for every contributed grammar bound to a language.
 *
 * A grammar with no `language` is not skipped by accident: those exist to be embedded in
 * other grammars (`source.css` inside HTML) and the engine resolves them through the
 * registry when an outer grammar includes them, which is why every scope stays reachable in
 * `knownScopes` even when it gets no provider of its own.
 */
export function applyContributedGrammars(
  grammars: readonly ContributedGrammar[],
  workspaceRoot: string | null,
): void {
  for (const provider of providers) {
    try {
      provider.dispose();
    } catch {
      // Disposing a provider Monaco already dropped is not a failure worth reporting.
    }
  }
  providers = [];
  grammarWorkspaceRoot = workspaceRoot;
  knownScopes = new Set(grammars.map((grammar) => grammar.scopeName));
  if (grammars.length === 0) return;

  const byLanguage = new Map<string, string>();
  for (const grammar of grammars) {
    if (grammar.language === null || grammar.language === '') continue;
    // First contribution wins, matching the discovery order the catalog was built in, so
    // reloading the catalog cannot silently change which grammar a language uses.
    if (!byLanguage.has(grammar.language)) byLanguage.set(grammar.language, grammar.scopeName);
  }

  for (const [languageId, scopeName] of byLanguage) {
    providers.push(
      monaco.languages.registerTokensProviderFactory(languageId, {
        create: async () => {
          const engine = await ensureEngine();
          if (engine === null) return null;
          const grammar = await engine.registry.loadGrammar(scopeName).catch(() => null);
          if (grammar === null) return null;
          return {
            getInitialState: () => engine.textmate.INITIAL as unknown as monaco.languages.IState,
            tokenizeEncoded: (line: string, state: monaco.languages.IState) => {
              const result = grammar.tokenizeLine2(
                line,
                state as unknown as import('vscode-textmate').StateStack,
              );
              return {
                tokens: result.tokens,
                endState: result.ruleStack as unknown as monaco.languages.IState,
              };
            },
          };
        },
      }),
    );
  }
}
