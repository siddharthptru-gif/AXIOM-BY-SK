/**
 * Language-server registry — the extensible plugin contract for AXIOM's code
 * intelligence layer.
 *
 * Two tiers, one uniform shape:
 *   • `bundled` servers ship inside AXIOM's node_modules and always work offline.
 *     They are launched with AXIOM's own Node runtime, so there is no toolchain
 *     for the user to install.
 *   • `external` servers are the ones that legitimately belong to a toolchain
 *     (gopls needs Go, rust-analyzer needs Rust, clangd needs LLVM). AXIOM does
 *     not bundle multi-gigabyte SDKs; it DETECTS these on the user's PATH and
 *     lights the language up automatically when present. Adding a language is a
 *     data-only change to {@link LSP_SERVERS} — no new IPC, no new provider code.
 *
 * This module is pure data plus pure helpers: no spawning, no filesystem, no
 * Electron. Main owns process creation (see main/services/lsp.ts) so the trust
 * boundary and the RunAsNode threat model stay in exactly one place.
 */

/** How a server is started. */
export type LspLaunch =
  | {
      kind: 'bundled';
      /** Path segments under node_modules to the server's Node entry point. */
      cliPath: string[];
      args: string[];
    }
  | {
      kind: 'external';
      /**
       * Executable base names to look for on PATH, in preference order. The first
       * one found wins, which is how "pyright if installed, else pylsp" works.
       */
      commands: string[];
      args: string[];
    };

/** One language server definition. */
export interface LspServerDefinition {
  id: string;
  displayName: string;
  /** LSP languageIds this server answers for. */
  languageIds: string[];
  launch: LspLaunch;
  /** `initializationOptions` sent with `initialize`. */
  initializationOptions?: Record<string, unknown>;
  /**
   * Settings returned for `workspace/configuration` and pushed via
   * `workspace/didChangeConfiguration`. Sections are dotted, as servers ask.
   */
  settings?: Record<string, unknown>;
  /**
   * When set, the server only starts if one of these files/directories exists at
   * the workspace root. Keeps Tailwind's server from attaching to every project.
   */
  rootMarkers?: string[];
  /** Extra characters that should re-trigger completion for this language. */
  extraTriggerCharacters?: string[];
}

const TS_LANGUAGE_IDS = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'];

/**
 * The registry. Order matters only for readability; routing is by languageId.
 *
 * Every language in the brief is represented. The bundled tier covers the web
 * stack end to end (TS/JS/React/Next, JSON, CSS/SCSS/LESS, HTML, ESLint,
 * Markdown). The external tier covers the compiled and interpreted languages
 * whose servers are inseparable from their toolchains.
 */
export const LSP_SERVERS: readonly LspServerDefinition[] = [
  // ---- Bundled: always available, no user setup ----------------------------
  {
    id: 'typescript',
    displayName: 'TypeScript / JavaScript',
    languageIds: TS_LANGUAGE_IDS,
    launch: {
      kind: 'bundled',
      cliPath: ['typescript-language-server', 'lib', 'cli.mjs'],
      args: ['--stdio'],
    },
    // tsserver's own preferences drive auto-import quality and inlay hints.
    initializationOptions: {
      preferences: {
        includeCompletionsForModuleExports: true,
        includeCompletionsForImportStatements: true,
        includeCompletionsWithSnippetText: true,
        includeCompletionsWithInsertText: true,
        includeAutomaticOptionalChainCompletions: true,
        includeCompletionsWithClassMemberSnippets: true,
        allowIncompleteCompletions: true,
        importModuleSpecifierPreference: 'shortest',
        quotePreference: 'auto',
      },
    },
    settings: {
      // Inlay hints are opt-in per server; enable the informative ones.
      typescript: {
        inlayHints: {
          includeInlayParameterNameHints: 'literals',
          includeInlayParameterNameHintsWhenArgumentMatchesName: false,
          includeInlayFunctionParameterTypeHints: true,
          includeInlayVariableTypeHints: false,
          includeInlayPropertyDeclarationTypeHints: true,
          includeInlayFunctionLikeReturnTypeHints: true,
          includeInlayEnumMemberValueHints: true,
        },
      },
      javascript: {
        inlayHints: {
          includeInlayParameterNameHints: 'literals',
          includeInlayFunctionParameterTypeHints: true,
          includeInlayFunctionLikeReturnTypeHints: true,
          includeInlayEnumMemberValueHints: true,
        },
      },
    },
    extraTriggerCharacters: ['<', '/', '@'],
  },
  {
    id: 'json',
    displayName: 'JSON',
    languageIds: ['json', 'jsonc'],
    launch: {
      kind: 'bundled',
      cliPath: ['vscode-langservers-extracted', 'bin', 'vscode-json-language-server'],
      args: ['--stdio'],
    },
    settings: { json: { validate: { enable: true }, format: { enable: true } } },
  },
  {
    id: 'css',
    displayName: 'CSS / SCSS / Less',
    languageIds: ['css', 'scss', 'less'],
    launch: {
      kind: 'bundled',
      cliPath: ['vscode-langservers-extracted', 'bin', 'vscode-css-language-server'],
      args: ['--stdio'],
    },
    // Tailwind's at-rules are unknown to the plain CSS server; don't cry wolf.
    settings: {
      css: { validate: true, lint: { unknownAtRules: 'ignore' } },
      scss: { validate: true, lint: { unknownAtRules: 'ignore' } },
      less: { validate: true, lint: { unknownAtRules: 'ignore' } },
    },
  },
  {
    id: 'html',
    displayName: 'HTML',
    languageIds: ['html'],
    launch: {
      kind: 'bundled',
      cliPath: ['vscode-langservers-extracted', 'bin', 'vscode-html-language-server'],
      args: ['--stdio'],
    },
    settings: { html: { format: { enable: true } } },
    extraTriggerCharacters: ['<', '/', '='],
  },
  {
    id: 'markdown',
    displayName: 'Markdown',
    languageIds: ['markdown'],
    launch: {
      kind: 'bundled',
      cliPath: ['vscode-langservers-extracted', 'bin', 'vscode-markdown-language-server'],
      args: ['--stdio'],
    },
  },
  {
    id: 'eslint',
    displayName: 'ESLint',
    languageIds: TS_LANGUAGE_IDS,
    launch: {
      kind: 'bundled',
      cliPath: ['vscode-langservers-extracted', 'bin', 'vscode-eslint-language-server'],
      args: ['--stdio'],
    },
    // Only attach where the project actually configures ESLint, so files in
    // unconfigured projects don't get spurious "couldn't find config" errors.
    rootMarkers: [
      'eslint.config.js',
      'eslint.config.mjs',
      'eslint.config.cjs',
      'eslint.config.ts',
      '.eslintrc',
      '.eslintrc.js',
      '.eslintrc.cjs',
      '.eslintrc.json',
      '.eslintrc.yml',
      '.eslintrc.yaml',
    ],
    settings: {
      // The ESLint server reads these from `workspace/configuration`.
      validate: 'on',
      useESLintClass: false,
      experimental: { useFlatConfig: false },
      codeAction: {
        disableRuleComment: { enable: true, location: 'separateLine' },
        showDocumentation: { enable: true },
      },
      codeActionOnSave: { enable: false, mode: 'all' },
      format: true,
      run: 'onType',
      problems: { shortenToSingleLine: false },
    },
  },

  // ---- External: detected on PATH, never bundled ---------------------------
  {
    id: 'tailwind',
    displayName: 'Tailwind CSS',
    languageIds: [...TS_LANGUAGE_IDS, 'html', 'css', 'scss', 'less'],
    launch: { kind: 'external', commands: ['tailwindcss-language-server'], args: ['--stdio'] },
    rootMarkers: [
      'tailwind.config.js',
      'tailwind.config.cjs',
      'tailwind.config.mjs',
      'tailwind.config.ts',
    ],
    settings: { tailwindCSS: { validate: true, emmetCompletions: false } },
    extraTriggerCharacters: ['"', "'", '`', ' ', ':', '-'],
  },
  {
    id: 'python',
    displayName: 'Python',
    languageIds: ['python'],
    launch: {
      kind: 'external',
      // Pyright first (fastest, best inference), then the community servers.
      commands: ['pyright-langserver', 'basedpyright-langserver', 'jedi-language-server', 'pylsp'],
      args: ['--stdio'],
    },
    settings: {
      python: { analysis: { autoImportCompletions: true, typeCheckingMode: 'basic' } },
    },
  },
  {
    id: 'go',
    displayName: 'Go',
    languageIds: ['go', 'gomod', 'gowork'],
    launch: { kind: 'external', commands: ['gopls'], args: [] },
    settings: { gopls: { usePlaceholders: true, completeUnimported: true } },
  },
  {
    id: 'rust',
    displayName: 'Rust',
    languageIds: ['rust'],
    launch: { kind: 'external', commands: ['rust-analyzer'], args: [] },
    settings: {
      'rust-analyzer': { checkOnSave: { command: 'check' }, procMacro: { enable: true } },
    },
  },
  {
    id: 'clangd',
    displayName: 'C / C++',
    languageIds: ['c', 'cpp', 'objective-c', 'objective-cpp', 'cuda'],
    launch: {
      kind: 'external',
      commands: ['clangd'],
      args: ['--background-index', '--clang-tidy', '--header-insertion=iwyu'],
    },
  },
  {
    id: 'csharp',
    displayName: 'C#',
    languageIds: ['csharp'],
    launch: { kind: 'external', commands: ['csharp-ls'], args: [] },
  },
  {
    id: 'java',
    displayName: 'Java',
    languageIds: ['java'],
    launch: { kind: 'external', commands: ['jdtls'], args: [] },
  },
  {
    id: 'kotlin',
    displayName: 'Kotlin',
    languageIds: ['kotlin'],
    launch: { kind: 'external', commands: ['kotlin-language-server'], args: [] },
  },
  {
    id: 'swift',
    displayName: 'Swift',
    languageIds: ['swift'],
    launch: { kind: 'external', commands: ['sourcekit-lsp'], args: [] },
  },
  {
    id: 'php',
    displayName: 'PHP',
    languageIds: ['php'],
    launch: { kind: 'external', commands: ['intelephense', 'phpactor'], args: ['--stdio'] },
  },
  {
    id: 'ruby',
    displayName: 'Ruby',
    languageIds: ['ruby'],
    launch: { kind: 'external', commands: ['ruby-lsp', 'solargraph'], args: ['--stdio'] },
  },
  {
    id: 'prettier',
    displayName: 'Prettier',
    languageIds: [
      ...TS_LANGUAGE_IDS,
      'json',
      'jsonc',
      'css',
      'scss',
      'less',
      'html',
      'markdown',
      'yaml',
    ],
    launch: { kind: 'external', commands: ['prettier-language-server'], args: ['--stdio'] },
    rootMarkers: [
      '.prettierrc',
      '.prettierrc.json',
      '.prettierrc.js',
      '.prettierrc.cjs',
      '.prettierrc.yml',
      '.prettierrc.yaml',
      'prettier.config.js',
      'prettier.config.cjs',
      'prettier.config.mjs',
    ],
  },
] as const;

/** Every server that can answer for a languageId, in registry order. */
export function serversForLanguage(languageId: string): LspServerDefinition[] {
  return LSP_SERVERS.filter((server) => server.languageIds.includes(languageId));
}

/** Look a definition up by id. */
export function serverDefinition(id: string): LspServerDefinition | undefined {
  return LSP_SERVERS.find((server) => server.id === id);
}

/** Every languageId any registered server can serve, deduplicated and sorted. */
export function supportedLanguageIds(): string[] {
  const ids = new Set<string>();
  for (const server of LSP_SERVERS) {
    for (const id of server.languageIds) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * Map a file path to an LSP languageId. Kept here (not in the renderer) so Main
 * and the renderer cannot disagree about what a `.tsx` file is.
 */
export function languageIdForPath(fsPath: string): string | null {
  const lower = fsPath.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const name = lower.slice(lower.lastIndexOf('/') + 1).replace(/^.*\\/, '');
  if (name === 'go.mod') return 'gomod';
  if (name === 'go.work') return 'gowork';
  if (name === 'dockerfile') return 'dockerfile';
  if (dot <= 0) return null;
  switch (lower.slice(dot + 1)) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'tsx':
      return 'typescriptreact';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'javascriptreact';
    case 'json':
      return 'json';
    case 'jsonc':
      return 'jsonc';
    case 'css':
      return 'css';
    case 'scss':
      return 'scss';
    case 'less':
      return 'less';
    case 'html':
    case 'htm':
      return 'html';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'py':
    case 'pyi':
      return 'python';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'c':
      return 'c';
    case 'h':
    case 'hpp':
    case 'hh':
    case 'hxx':
    case 'cc':
    case 'cpp':
    case 'cxx':
      return 'cpp';
    case 'm':
      return 'objective-c';
    case 'mm':
      return 'objective-cpp';
    case 'cu':
    case 'cuh':
      return 'cuda';
    case 'cs':
      return 'csharp';
    case 'java':
      return 'java';
    case 'kt':
    case 'kts':
      return 'kotlin';
    case 'swift':
      return 'swift';
    case 'php':
      return 'php';
    case 'rb':
    case 'rake':
      return 'ruby';
    default:
      return null;
  }
}

/**
 * The Monaco language ids that should receive LSP providers. Monaco's Monarch
 * grammars use one id for both a language and its JSX variant, so the react
 * variants collapse and a few names differ from LSP's.
 */
export function monacoLanguageIds(): string[] {
  const monaco = new Set<string>();
  for (const id of supportedLanguageIds()) {
    if (id === 'typescriptreact') monaco.add('typescript');
    else if (id === 'javascriptreact') monaco.add('javascript');
    else if (id === 'jsonc') monaco.add('json');
    else if (id === 'objective-c' || id === 'objective-cpp') monaco.add('objective-c');
    else if (id === 'gomod' || id === 'gowork') monaco.add('go');
    else monaco.add(id);
  }
  return [...monaco].sort();
}
