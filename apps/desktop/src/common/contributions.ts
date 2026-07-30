/**
 * The shapes of everything installed extensions contribute, as they cross IPC.
 *
 * These live in `common` rather than beside the Main service that produces them because
 * both sides of the bridge need them: Main builds the catalog, preload declares the
 * bridge, and the renderer consumes it. Declaring them next to the service would have
 * forced preload to import from `main`, which inverts the layering even when the import
 * is type-only.
 *
 * Types only — no behaviour, so there is nothing here to keep in sync with a runtime.
 */

export interface ContributedTheme {
  /** Stable selection key. A theme cannot be identified by label alone. */
  key: string;
  extensionId: string;
  extensionName: string;
  /** The theme's own contributed id, when it declares one. */
  id: string | null;
  label: string;
  kind: 'dark' | 'light';
}

export interface ContributedIconTheme {
  key: string;
  extensionId: string;
  extensionName: string;
  id: string;
  label: string;
}

export interface ContributedSnippet {
  extensionId: string;
  language: string;
  prefix: string;
  /** Multi-line bodies are already joined with newlines. */
  body: string;
  description: string | null;
}

export interface ContributedKeybinding {
  extensionId: string;
  extensionName: string;
  command: string;
  key: string;
  when: string | null;
  /** False while commands cannot be invoked, so the UI can say so plainly. */
  active: boolean;
  /**
   * KB-11: the Keyboard Shortcuts editor must attribute an override of an
   * `editor.action.*` / `workbench.action.*` default to the extension that took it.
   * Optional so existing consumers of this shape keep compiling.
   */
  overridesDefault?: boolean;
  /** KB-10: set when the chord was refused (reserved by the OS, or unusable here). */
  rejected?: 'reserved' | 'invalid-key' | 'unavailable-on-platform' | 'invalid-when';
}

export interface LanguageConfiguration {
  lineComment: string | null;
  blockComment: [string, string] | null;
  brackets: Array<[string, string]>;
  autoClosingPairs: Array<{ open: string; close: string }>;
  surroundingPairs: Array<{ open: string; close: string }>;
}

export interface ContributedLanguage {
  extensionId: string;
  id: string;
  aliases: string[];
  extensions: string[];
  filenames: string[];
  /** Bracket/comment/auto-closing rules, when the extension ships them. */
  configuration: LanguageConfiguration | null;
}

export interface ContributedSetting {
  extensionId: string;
  extensionName: string;
  key: string;
  type: string | null;
  description: string | null;
  hasDefault: boolean;
  default: unknown;
  enum: unknown[] | null;
}

export interface ContributedCommand {
  extensionId: string;
  extensionName: string;
  command: string;
  title: string;
  category: string | null;
  /** Always false today: invoking a command requires running extension code. */
  invocable: boolean;
}

export interface ContributedGrammar {
  extensionId: string;
  language: string | null;
  scopeName: string;
  /** Absolute path, already containment-checked by Main. */
  path: string;
}

/**
 * The bytes of one grammar, as they cross IPC.
 *
 * Carries the format instead of the path. The renderer needs to know which parser to run —
 * `.tmLanguage` files are XML property lists, `.tmLanguage.json` files are JSON — but it has
 * no use for the location, and not sending it keeps the grammar loader from doubling as a
 * way to name files on disk.
 */
export interface ContributedGrammarSource {
  scopeName: string;
  format: 'json' | 'plist';
  content: string;
}

export interface ExtensionContributionCatalog {
  themes: ContributedTheme[];
  iconThemes: ContributedIconTheme[];
  keybindings: ContributedKeybinding[];
  languages: ContributedLanguage[];
  settings: ContributedSetting[];
  commands: ContributedCommand[];
  grammars: ContributedGrammar[];
  /** Defaults extensions want applied, merged in discovery order. */
  configurationDefaults: Record<string, unknown>;
  /** Snippet counts per language; bodies are loaded on demand. */
  snippetLanguages: Array<{ language: string; count: number }>;
  /**
   * Per extension, the contribution points that will not do anything — both points this
   * build does not model and points it models but cannot act on, such as commands.
   */
  inert: Array<{ extensionId: string; extensionName: string; points: string[] }>;
}

/**
 * One icon definition.
 *
 * `dataUrl` is an image source and nothing else. It is never injected as markup: an SVG
 * rendered from an image source runs in the browser's secure static mode, while the same
 * bytes placed in the DOM would be a script-capable document.
 */
export interface IconDefinition {
  dataUrl?: string;
  fontCharacter?: string;
  fontColor?: string;
}

export interface IconThemeDefinition {
  key: string;
  label: string;
  iconDefinitions: Record<string, IconDefinition>;
  /** Default icons. Null when the theme did not ship a usable one. */
  file: string | null;
  folder: string | null;
  folderExpanded: string | null;
  rootFolder: string | null;
  /** Lookup maps, pruned to definitions that exist so every name resolves. */
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  languageIds: Record<string, string>;
}

/**
 * The selection key for a contributed theme or icon theme.
 *
 * Shared by Main (which builds the catalog) and the renderer (which persists a chosen
 * theme), so both must derive it identically — hence a function rather than a convention.
 */
export function contributionKey(extensionId: string, id: string | null, label: string): string {
  return `${extensionId}::${id ?? label}`;
}
