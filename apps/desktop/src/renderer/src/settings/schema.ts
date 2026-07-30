/**
 * Settings schema (PRD Part IV §55 / Part VII §120). A single declarative source
 * that drives the compiled defaults, the Settings UI controls, and typed access.
 * Only user-changed keys are persisted; everything else falls back to `default`.
 */
export type SettingType = 'number' | 'boolean' | 'string' | 'enum';

export interface SettingDefinition {
  key: string;
  type: SettingType;
  default: unknown;
  title: string;
  description: string;
  category: string;
  min?: number;
  max?: number;
  options?: readonly string[];
  /** Friendly labels for enum option values (value → label). */
  optionLabels?: Record<string, string>;
}

const DEFAULT_FONT = "'Cascadia Code', 'Consolas', ui-monospace, monospace";

export const SETTINGS: readonly SettingDefinition[] = [
  {
    key: 'workbench.colorTheme',
    type: 'enum',
    default: 'axiom-royal',
    options: [
      'axiom-royal',
      'axiom-royal-light',
      'axiom-dark',
      'axiom-light',
      'axiom-midnight',
      'axiom-high-contrast',
    ],
    optionLabels: {
      'axiom-royal': 'Royal Indigo (default)',
      'axiom-royal-light': 'Royal Indigo Light',
      'axiom-dark': 'Royal Graphite',
      'axiom-light': 'Royal Graphite Light',
      'axiom-midnight': 'Axiom Midnight',
      'axiom-high-contrast': 'Axiom High Contrast',
    },
    title: 'Color Theme',
    description: 'The color theme used across the workbench and editor.',
    category: 'Appearance',
  },
  {
    key: 'workbench.extensionColorTheme',
    type: 'string',
    default: '',
    title: 'Extension Color Theme',
    description:
      'A color theme contributed by an installed extension. Chosen from the Extensions view; when set it overrides the built-in Color Theme. Clear it to go back.',
    category: 'Appearance',
  },
  {
    key: 'workbench.extensionIconTheme',
    type: 'string',
    default: '',
    title: 'Extension File Icon Theme',
    description:
      'A file icon theme contributed by an installed extension, used for Explorer and tab icons. Chosen from the Extensions view; clear it to use the built-in icons.',
    category: 'Appearance',
  },
  {
    key: 'workbench.accentColor',
    type: 'enum',
    default: 'gold',
    options: ['gold', 'sapphire', 'emerald', 'mono', 'violet', 'blue', 'green', 'amber', 'rose'],
    optionLabels: {
      gold: 'Gold (default)',
      sapphire: 'Sapphire',
      emerald: 'Emerald',
      mono: 'Monochrome',
      violet: 'Violet',
      blue: 'Blue',
      green: 'Green',
      amber: 'Amber',
      rose: 'Rose',
    },
    title: 'Accent Color',
    description: 'The accent color used for highlights, focus, and the status bar.',
    category: 'Appearance',
  },
  {
    key: 'workbench.cornerStyle',
    type: 'enum',
    default: 'soft',
    options: ['sharp', 'soft', 'round'],
    optionLabels: { sharp: 'Sharp', soft: 'Soft (default)', round: 'Rounded' },
    title: 'Corner Style',
    description:
      'How rounded panels, buttons, and cards are. Affects only corner radius, never spacing or layout.',
    category: 'Appearance',
  },
  {
    key: 'workbench.density',
    type: 'enum',
    default: 'comfortable',
    options: ['comfortable', 'compact'],
    optionLabels: { comfortable: 'Comfortable', compact: 'Compact' },
    title: 'UI Density',
    description: 'Compact tightens spacing across lists and panels.',
    category: 'Appearance',
  },
  {
    key: 'workbench.uiZoom',
    type: 'number',
    default: 1,
    min: 0.8,
    max: 1.6,
    title: 'UI Zoom',
    description: 'Scale the whole workbench UI (0.8–1.6) for visual accessibility.',
    category: 'Appearance',
  },
  {
    key: 'workbench.reducedMotion',
    type: 'enum',
    default: 'auto',
    options: ['auto', 'on', 'off'],
    optionLabels: { auto: 'Follow system', on: 'Always reduce', off: 'Never reduce' },
    title: 'Reduced Motion',
    description: 'Honor reduced-motion for animations and transitions (WCAG 2.1).',
    category: 'Appearance',
  },
  {
    key: 'workbench.locale',
    type: 'enum',
    default: 'en',
    options: ['en', 'es'],
    optionLabels: { en: 'English', es: 'Español (beta)' },
    title: 'Language',
    description: 'Display language for the workbench (untranslated strings fall back to English).',
    category: 'Appearance',
  },
  {
    key: 'workbench.pseudoLocale',
    type: 'boolean',
    default: false,
    title: 'Pseudo-localization',
    description: 'Accent + expand UI text to test layout robustness (RTL/i18n dev aid).',
    category: 'Appearance',
  },
  {
    key: 'a11y.audioCues',
    type: 'boolean',
    default: false,
    title: 'Audio Cues',
    description:
      'Play a short, distinct tone on errors, warnings, and breakpoints (accessibility aid; off by default).',
    category: 'Appearance',
  },
  {
    key: 'workbench.restoreLastFolder',
    type: 'boolean',
    default: true,
    title: 'Restore Last Folder',
    description: 'Reopen the most recently opened folder when Axiom starts.',
    category: 'Workbench',
  },
  {
    key: 'workbench.breadcrumbs.enabled',
    type: 'boolean',
    default: true,
    title: 'Breadcrumbs',
    description: 'Show the breadcrumbs path bar above the editor.',
    category: 'Workbench',
  },
  {
    key: 'workbench.editor.enablePreview',
    type: 'boolean',
    default: true,
    title: 'Enable Preview Editors',
    description:
      'Single-clicking a file in the Explorer opens it in a reused preview tab (shown in italics). Double-clicking, editing, or pinning keeps it open.',
    category: 'Workbench',
  },
  {
    key: 'files.autoSave',
    type: 'enum',
    default: 'off',
    options: ['off', 'afterDelay', 'onFocusChange', 'onWindowChange'],
    optionLabels: {
      off: 'Off',
      afterDelay: 'After Delay',
      onFocusChange: 'On Focus Change',
      onWindowChange: 'On Window Change',
    },
    title: 'Auto Save',
    description:
      'Automatically save dirty editors. After Delay saves following a pause in typing; On Focus Change saves when an editor loses focus; On Window Change saves when the window loses focus.',
    category: 'Files',
  },
  {
    key: 'files.autoSaveDelay',
    type: 'number',
    default: 1000,
    min: 100,
    max: 30000,
    title: 'Auto Save Delay',
    description: 'Milliseconds after the last edit before “After Delay” auto save writes the file.',
    category: 'Files',
  },
  {
    key: 'files.trimTrailingWhitespace',
    type: 'boolean',
    default: false,
    title: 'Trim Trailing Whitespace',
    description: 'Remove trailing whitespace from each line when saving the active editor.',
    category: 'Files',
  },
  {
    key: 'files.insertFinalNewline',
    type: 'boolean',
    default: false,
    title: 'Insert Final Newline',
    description: 'Ensure the file ends with a single newline when saving.',
    category: 'Files',
  },
  {
    key: 'editor.fontSize',
    type: 'number',
    default: 13,
    min: 6,
    max: 40,
    title: 'Font Size',
    description: 'Editor font size in pixels.',
    category: 'Editor: Font',
  },
  {
    key: 'editor.fontFamily',
    type: 'string',
    default: DEFAULT_FONT,
    title: 'Font Family',
    description: 'Comma-separated font stack used by the editor.',
    category: 'Editor: Font',
  },
  {
    key: 'editor.fontLigatures',
    type: 'boolean',
    default: true,
    title: 'Font Ligatures',
    description: 'Enable programming ligatures where the font supports them.',
    category: 'Editor: Font',
  },
  {
    key: 'editor.tabSize',
    type: 'number',
    default: 2,
    min: 1,
    max: 8,
    title: 'Tab Size',
    description: 'The number of spaces a tab is equal to.',
    category: 'Editor',
  },
  {
    key: 'editor.insertSpaces',
    type: 'boolean',
    default: true,
    title: 'Insert Spaces',
    description:
      'Insert spaces when pressing Tab. When Detect Indentation is on, this is overridden per file based on its content.',
    category: 'Editor',
  },
  {
    key: 'editor.detectIndentation',
    type: 'boolean',
    default: true,
    title: 'Detect Indentation',
    description:
      'When a file opens, detect its tab size and whether it indents with spaces or tabs from its content.',
    category: 'Editor',
  },
  {
    key: 'editor.wordWrap',
    type: 'enum',
    default: 'off',
    options: ['off', 'on', 'bounded'],
    title: 'Word Wrap',
    description: 'Controls how long lines wrap.',
    category: 'Editor',
  },
  {
    key: 'editor.keymap',
    type: 'enum',
    default: 'default',
    options: ['default', 'vim'],
    optionLabels: { default: 'Default', vim: 'Vim' },
    title: 'Keymap',
    description: 'Keybinding profile. Vim adds a modal (normal / insert / visual) editing mode.',
    category: 'Editor',
  },
  {
    key: 'keymap.preset',
    type: 'enum',
    default: 'vscode',
    options: ['vscode', 'jetbrains', 'sublime', 'emacs'],
    optionLabels: {
      vscode: 'VS Code',
      jetbrains: 'JetBrains',
      sublime: 'Sublime Text',
      emacs: 'Emacs',
    },
    title: 'Keymap Preset',
    description:
      'Base keybinding style for command shortcuts (palette, save, find, …). Separate from the modal Vim keymap above.',
    category: 'Editor',
  },
  {
    key: 'editor.minimap.enabled',
    type: 'boolean',
    default: true,
    title: 'Minimap',
    description: 'Show the minimap on the right edge of the editor.',
    category: 'Editor',
  },
  {
    key: 'editor.lineNumbers',
    type: 'enum',
    default: 'on',
    options: ['on', 'off', 'relative'],
    title: 'Line Numbers',
    description: 'Controls display of line numbers.',
    category: 'Editor',
  },
  {
    key: 'editor.renderWhitespace',
    type: 'enum',
    default: 'selection',
    options: ['none', 'boundary', 'selection', 'all'],
    title: 'Render Whitespace',
    description: 'Controls how whitespace characters are rendered.',
    category: 'Editor',
  },
  {
    key: 'editor.stickyScroll.enabled',
    type: 'boolean',
    default: true,
    title: 'Sticky Scroll',
    description: 'Pin enclosing scopes to the top of the editor while scrolling.',
    category: 'Editor',
  },
  {
    key: 'editor.cursorBlinking',
    type: 'enum',
    default: 'blink',
    options: ['blink', 'smooth', 'phase', 'expand', 'solid'],
    title: 'Cursor Blinking',
    description: 'The cursor animation style.',
    category: 'Editor',
  },
  {
    key: 'editor.smoothScrolling',
    type: 'boolean',
    default: true,
    title: 'Smooth Scrolling',
    description: 'Animate the editor when scrolling.',
    category: 'Editor',
  },
  {
    key: 'editor.rulers',
    type: 'string',
    default: '',
    title: 'Rulers',
    description:
      'Comma-separated column positions to draw vertical rulers at (e.g. "80, 120"). Leave empty for none.',
    category: 'Editor',
  },
  {
    key: 'editor.renderLineHighlight',
    type: 'enum',
    default: 'line',
    options: ['none', 'gutter', 'line', 'all'],
    title: 'Render Line Highlight',
    description: 'How the line with the cursor is highlighted.',
    category: 'Editor',
  },
  {
    key: 'editor.cursorStyle',
    type: 'enum',
    default: 'line',
    options: ['line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin'],
    title: 'Cursor Style',
    description: 'The shape of the editor cursor.',
    category: 'Editor',
  },
  {
    key: 'editor.bracketPairColorization.enabled',
    type: 'boolean',
    default: true,
    title: 'Bracket Pair Colorization',
    description: 'Color matching bracket pairs to make nesting easier to read.',
    category: 'Editor',
  },
  {
    key: 'editor.formatOnSave',
    type: 'boolean',
    default: false,
    title: 'Format On Save',
    description: 'Format the document with its available formatter when you save.',
    category: 'Editor',
  },
  {
    key: 'ai.provider',
    type: 'enum',
    default: 'anthropic',
    options: ['anthropic', 'openai', 'gemini', 'ollama', 'custom'],
    optionLabels: {
      anthropic: 'Anthropic (Claude)',
      openai: 'OpenAI',
      gemini: 'Google Gemini',
      ollama: 'Ollama (local, free — no API key)',
      custom: 'Custom (OpenAI-Compatible)',
    },
    title: 'AI Provider',
    description:
      'The model provider Axiom AI connects to. Cloud providers use your own API key (BYOK); Ollama runs locally with no key and no data leaving your machine.',
    category: 'AI',
  },
  {
    key: 'ai.model',
    type: 'string',
    default: '',
    title: 'AI Model',
    description: "The model id to use. Leave empty to use the provider's recommended default.",
    category: 'AI',
  },
  {
    key: 'ai.baseUrl',
    type: 'string',
    default: '',
    title: 'AI Base URL',
    description:
      'Optional custom API base URL (for OpenAI-compatible or proxy endpoints). Leave empty for the provider default.',
    category: 'AI',
  },
  {
    key: 'ai.completion.enabled',
    type: 'boolean',
    default: true,
    title: 'Predictive Inline Completion',
    description:
      'Show document-versioned ghost-text suggestions. Main cancels stale requests and keeps provider/cache scope isolated.',
    category: 'AI & God Mode',
  },
  {
    key: 'ai.completion.priority',
    type: 'enum',
    default: 'inline',
    options: ['inline', 'intellisense'],
    optionLabels: {
      inline: 'Prefer predictive ghost text',
      intellisense: 'Prefer IntelliSense after member triggers',
    },
    title: 'Completion Arbitration',
    description: 'Choose whether predictive ghost text or IntelliSense wins when both can respond.',
    category: 'AI & God Mode',
  },
  {
    key: 'ai.approval.autonomy',
    type: 'enum',
    default: 'autopilot',
    options: ['manual', 'guided', 'autopilot'],
    optionLabels: {
      manual: 'Strict — approve every action',
      guided: 'Ask before changes and commands',
      autopilot: 'Autopilot — plan continuously; approve effects',
    },
    title: 'Build Permission',
    description:
      'Controls whether Build asks before actions. High-risk commands and MCP tools always remain approval-gated.',
    category: 'AI',
  },
  {
    key: 'ai.safety.egressMode',
    type: 'enum',
    default: 'audit',
    options: ['off', 'audit', 'sanitize', 'block'],
    optionLabels: {
      off: 'Off',
      audit: 'Audit (detect + log only)',
      sanitize: 'Sanitize (redact secrets / PII)',
      block: 'Block (refuse risky requests)',
    },
    title: 'AI Egress Safety',
    description:
      'Guards outbound AI requests before they leave your machine. Audit only logs detections; Sanitize redacts detected secrets / PII from the request body; Block refuses to send when a finding meets the threshold below. API keys (sent in request headers) are never affected.',
    category: 'AI',
  },
  {
    key: 'ai.safety.blockSeverity',
    type: 'enum',
    default: 'high',
    options: ['low', 'medium', 'high'],
    optionLabels: { low: 'Low and above', medium: 'Medium and above', high: 'High only' },
    title: 'AI Egress Block Threshold',
    description:
      'When AI Egress Safety is set to Block, refuse to send a request whose worst finding is at or above this severity. High only blocks on the most dangerous leaks (private keys, cloud / provider tokens).',
    category: 'AI',
  },
  {
    key: 'update.autoDownload',
    type: 'boolean',
    default: true,
    title: 'Automatic Updates',
    description:
      'Download available updates in the background automatically. Mandatory updates always download; disabling this only affects optional updates (you can still update manually).',
    category: 'Updates',
  },
  {
    key: 'update.channel',
    type: 'enum',
    default: 'stable',
    options: ['stable', 'beta'],
    optionLabels: { stable: 'Stable', beta: 'Beta (early access)' },
    title: 'Update Channel',
    description: 'Which release channel to receive updates from. Stable is recommended.',
    category: 'Updates',
  },
  {
    key: 'terminal.defaultShell',
    type: 'string',
    default: '',
    title: 'Default Shell',
    description:
      'The shell id new terminals launch by default (pwsh, powershell, cmd, gitbash, wsl). Leave empty to use the first available.',
    category: 'Terminal',
  },
  {
    key: 'terminal.fontSize',
    type: 'number',
    default: 13,
    min: 6,
    max: 40,
    title: 'Terminal Font Size',
    description: 'Font size (px) used by the integrated terminal.',
    category: 'Terminal',
  },
  {
    key: 'terminal.fontFamily',
    type: 'string',
    default: '',
    title: 'Terminal Font Family',
    description: 'Font stack for the terminal. Leave empty to use the editor font.',
    category: 'Terminal',
  },
  {
    key: 'terminal.cursorStyle',
    type: 'enum',
    default: 'block',
    options: ['block', 'bar', 'underline'],
    title: 'Terminal Cursor Style',
    description: 'The shape of the terminal cursor.',
    category: 'Terminal',
  },
  {
    key: 'terminal.scrollback',
    type: 'number',
    default: 1000,
    min: 100,
    max: 100000,
    title: 'Terminal Scrollback',
    description: 'Number of lines kept in the terminal scrollback buffer.',
    category: 'Terminal',
  },
  {
    key: 'telemetry.crashReports',
    type: 'boolean',
    default: false,
    title: 'Crash Reporting',
    description:
      'Buffer anonymized crash reports locally to help fix stability issues. Off by default; nothing leaves your device unless you send a diagnostics bundle.',
    category: 'Privacy & Telemetry',
  },
  {
    key: 'telemetry.analytics',
    type: 'boolean',
    default: false,
    title: 'Product Analytics',
    description:
      'Buffer anonymized, bucketed usage events (never code, prompts, or free text). Off by default.',
    category: 'Privacy & Telemetry',
  },
  {
    key: 'telemetry.performance',
    type: 'boolean',
    default: false,
    title: 'Performance Telemetry',
    description:
      'Buffer anonymized performance metrics (latency, memory), bucketed. Off by default.',
    category: 'Privacy & Telemetry',
  },
];

export const DEFAULTS: Record<string, unknown> = Object.fromEntries(
  SETTINGS.map((s): [string, unknown] => [s.key, s.default]),
);

export type WordWrap = 'off' | 'on' | 'bounded';
export type LineNumbers = 'on' | 'off' | 'relative';
export type RenderWhitespace = 'none' | 'boundary' | 'selection' | 'all';
export type CursorBlinking = 'blink' | 'smooth' | 'phase' | 'expand' | 'solid';
export type RenderLineHighlight = 'none' | 'gutter' | 'line' | 'all';
export type CursorStyle =
  'line' | 'block' | 'underline' | 'line-thin' | 'block-outline' | 'underline-thin';

export interface EditorSettings {
  fontSize: number;
  fontFamily: string;
  fontLigatures: boolean;
  tabSize: number;
  insertSpaces: boolean;
  detectIndentation: boolean;
  wordWrap: WordWrap;
  minimap: boolean;
  lineNumbers: LineNumbers;
  renderWhitespace: RenderWhitespace;
  stickyScroll: boolean;
  cursorBlinking: CursorBlinking;
  cursorStyle: CursorStyle;
  smoothScrolling: boolean;
  renderLineHighlight: RenderLineHighlight;
  rulers: number[];
  bracketPairColorization: boolean;
  formatOnSave: boolean;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pick<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === 'string' && (options as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/** Parse the comma-separated `editor.rulers` string into valid column numbers. */
function parseRulers(value: unknown): number[] {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 500);
}

/** Defensively coerces merged settings into a typed editor-options object. */
export function getEditorSettings(values: Record<string, unknown>): EditorSettings {
  const ff = values['editor.fontFamily'];
  return {
    fontSize: num(values['editor.fontSize'], 13),
    fontFamily: typeof ff === 'string' && ff.trim().length > 0 ? ff : DEFAULT_FONT,
    fontLigatures: bool(values['editor.fontLigatures'], true),
    tabSize: num(values['editor.tabSize'], 2),
    insertSpaces: bool(values['editor.insertSpaces'], true),
    detectIndentation: bool(values['editor.detectIndentation'], true),
    wordWrap: pick(values['editor.wordWrap'], ['off', 'on', 'bounded'] as const, 'off'),
    minimap: bool(values['editor.minimap.enabled'], true),
    lineNumbers: pick(values['editor.lineNumbers'], ['on', 'off', 'relative'] as const, 'on'),
    renderWhitespace: pick(
      values['editor.renderWhitespace'],
      ['none', 'boundary', 'selection', 'all'] as const,
      'selection',
    ),
    stickyScroll: bool(values['editor.stickyScroll.enabled'], true),
    cursorBlinking: pick(
      values['editor.cursorBlinking'],
      ['blink', 'smooth', 'phase', 'expand', 'solid'] as const,
      'blink',
    ),
    cursorStyle: pick(
      values['editor.cursorStyle'],
      ['line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin'] as const,
      'line',
    ),
    smoothScrolling: bool(values['editor.smoothScrolling'], true),
    renderLineHighlight: pick(
      values['editor.renderLineHighlight'],
      ['none', 'gutter', 'line', 'all'] as const,
      'line',
    ),
    rulers: parseRulers(values['editor.rulers']),
    bracketPairColorization: bool(values['editor.bracketPairColorization.enabled'], true),
    formatOnSave: bool(values['editor.formatOnSave'], false),
  };
}

export type AutoSaveMode = 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange';

export interface AutoSaveSettings {
  mode: AutoSaveMode;
  /** Debounce for `afterDelay` mode, in milliseconds. */
  delay: number;
}

/** Defensively coerces merged settings into a typed auto-save config. */
export function getAutoSaveSettings(values: Record<string, unknown>): AutoSaveSettings {
  return {
    mode: pick(
      values['files.autoSave'],
      ['off', 'afterDelay', 'onFocusChange', 'onWindowChange'] as const,
      'off',
    ),
    delay: num(values['files.autoSaveDelay'], 1000),
  };
}

export interface OnSaveHygiene {
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
}

/** On-save text hygiene toggles (PRD Part VII §106). */
export function getOnSaveHygiene(values: Record<string, unknown>): OnSaveHygiene {
  return {
    trimTrailingWhitespace: bool(values['files.trimTrailingWhitespace'], false),
    insertFinalNewline: bool(values['files.insertFinalNewline'], false),
  };
}

export type AiProvider = 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'custom';

export interface AiSettings {
  provider: AiProvider;
  /** Resolved model id (falls back to the provider default when unset). */
  model: string;
  /** Custom API base URL, or '' for the provider default. */
  baseUrl: string;
}

/** The recommended default model per provider when the user leaves it blank. */
const DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: 'claude-3-5-sonnet-latest',
  openai: 'gpt-4o',
  gemini: 'gemini-1.5-pro',
  // A widely-available small local model; the real list is detected at runtime.
  ollama: 'llama3.2',
  custom: '',
};

export function defaultModelFor(provider: AiProvider): string {
  return DEFAULT_MODELS[provider];
}

/**
 * A small catalog of commonly-used models per provider, powering the chat model
 * picker (PRD Phase 136). Not exhaustive — the resolved model is always included
 * in the picker, and any model id can still be set in Settings. The Custom
 * provider discovers its models via Fetch Models instead.
 */
export const MODEL_CATALOG: Record<AiProvider, readonly string[]> = {
  anthropic: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest', 'claude-3-opus-latest'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
  gemini: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash'],
  // Discovered from the running local server; never hard-coded.
  ollama: [],
  custom: [],
};

/** Defensively coerces merged settings into a typed AI config (BYOK). */
export function getAiSettings(values: Record<string, unknown>): AiSettings {
  const provider = pick(
    values['ai.provider'],
    ['anthropic', 'openai', 'gemini', 'ollama', 'custom'] as const,
    'anthropic',
  );
  // The Custom provider carries its own base URL + model configuration.
  if (provider === 'custom') {
    const custom = getCustomProvider(values);
    return { provider, model: custom.model, baseUrl: custom.baseUrl };
  }
  const modelRaw = values['ai.model'];
  const model =
    typeof modelRaw === 'string' && modelRaw.trim().length > 0
      ? modelRaw.trim()
      : DEFAULT_MODELS[provider];
  const baseRaw = values['ai.baseUrl'];
  const baseUrl = typeof baseRaw === 'string' ? baseRaw.trim() : '';
  return { provider, model, baseUrl };
}

/**
 * Custom OpenAI-compatible provider configuration (PRD Epoch F). Persisted as
 * plain `ai.custom.*` overrides (not schema-backed, so the generic Settings UI
 * stays unchanged); edited through the dedicated form in the AI panel.
 */
export interface CustomProviderConfig {
  name: string;
  baseUrl: string;
  model: string;
  /** Raw JSON string of extra headers, as stored. */
  headers: string;
  /** All model ids discovered from the endpoint (populate the chat switcher). */
  models: string[];
}

/** Parse the stored custom-models value (a JSON array, or a comma/newline list). */
export function parseCustomModels(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  const dedupe = (arr: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of arr) {
      const t = s.trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
    return out;
  };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return dedupe(parsed.filter((x): x is string => typeof x === 'string'));
    }
  } catch {
    // Not JSON — fall back to a comma/newline-delimited list.
  }
  return dedupe(raw.split(/[\n,]/));
}

export function getCustomProvider(values: Record<string, unknown>): CustomProviderConfig {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    name: str(values['ai.custom.name']),
    baseUrl: str(values['ai.custom.baseUrl']),
    model: str(values['ai.custom.model']),
    headers: str(values['ai.custom.headers']),
    models: parseCustomModels(values['ai.custom.models']),
  };
}

/** Parse the stored custom-headers JSON string into a string→string map. */
export function parseHeaders(raw: string): Record<string, string> {
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export type TerminalCursorStyle = 'block' | 'bar' | 'underline';

export interface TerminalSettings {
  defaultShell: string;
  fontSize: number;
  fontFamily: string;
  cursorStyle: TerminalCursorStyle;
  scrollback: number;
}

/** Defensively coerces merged settings into a typed integrated-terminal config. */
export function getTerminalSettings(values: Record<string, unknown>): TerminalSettings {
  const ff = values['terminal.fontFamily'];
  const editorFont = values['editor.fontFamily'];
  const fontFamily =
    typeof ff === 'string' && ff.trim().length > 0
      ? ff
      : typeof editorFont === 'string' && editorFont.trim().length > 0
        ? editorFont
        : DEFAULT_FONT;
  const shell = values['terminal.defaultShell'];
  return {
    defaultShell: typeof shell === 'string' ? shell.trim() : '',
    fontSize: num(values['terminal.fontSize'], 13),
    fontFamily,
    cursorStyle: pick(
      values['terminal.cursorStyle'],
      ['block', 'bar', 'underline'] as const,
      'block',
    ),
    scrollback: num(values['terminal.scrollback'], 1000),
  };
}
