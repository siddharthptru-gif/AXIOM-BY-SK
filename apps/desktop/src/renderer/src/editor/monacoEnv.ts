import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
// Monarch syntax highlighting for many languages, no language-service workers.
import 'monaco-editor/esm/vs/basic-languages/monaco.contribution';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

/**
 * Monaco environment. PRD ADR-0003. We wire only the base editor worker (via
 * Vite ?worker), giving full editing + Monarch highlighting. Rich language
 * services (LSP) arrive in Epoch D.
 */
interface WorkerHost {
  MonacoEnvironment?: monaco.Environment;
}

(self as unknown as WorkerHost).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

let themesDefined = false;
let activeTheme = 'axiom-dark';
/**
 * The definition behind `activeTheme`, kept so it can be re-declared.
 *
 * Encoded (TextMate) token colours arrive after the theme does — the grammar engine loads
 * lazily and only when a file needs it — and Monaco has no API to attach a colour map to an
 * existing theme. Re-defining the same name replaces it in place, which is why the last
 * definition is retained rather than reconstructed.
 */
let activeThemeData: monaco.editor.IStandaloneThemeData | null = null;

/**
 * The token rules of the active theme.
 *
 * Read by the TextMate engine so grammar highlighting uses the same colours as the rest of
 * the editor. Returned as a copy: a caller that mutates this would silently desynchronize
 * the two tokenizers.
 */
export function currentThemeRules(): monaco.editor.ITokenThemeRule[] {
  return (activeThemeData?.rules ?? []).map((rule) => ({ ...rule }));
}

/**
 * Attach a TextMate colour map to the active theme.
 *
 * `encodedTokensColors` occupies the low colour ids of the theme's own colour map, which is
 * exactly what encoded tokens index into, and leaves the rule-driven ids that Monarch
 * languages use appended after it. That is the reason this goes through the theme instead of
 * `monaco.languages.setColorMap`, which replaces the editor-wide map and would leave every
 * Monarch-highlighted language reading colours from the wrong table.
 */
export function applyEncodedTokensColors(colors: readonly string[]): void {
  if (activeThemeData === null || colors.length === 0) return;
  const next: monaco.editor.IStandaloneThemeData = {
    ...activeThemeData,
    encodedTokensColors: [...colors],
  };
  activeThemeData = next;
  monaco.editor.defineTheme(activeTheme, next);
  monaco.editor.setTheme(activeTheme);
}

/** Define a theme, remember it, and activate it. */
function defineAndActivate(id: string, data: monaco.editor.IStandaloneThemeData): void {
  activeTheme = id;
  activeThemeData = data;
  monaco.editor.defineTheme(id, data);
  monaco.editor.setTheme(id);
}

/**
 * The colour roles a semantic-token palette needs. Kept as a named shape so the
 * static and runtime themes cannot drift apart.
 */
interface SemanticPalette {
  foreground: string;
  keyword: string;
  string: string;
  number: string;
  type: string;
  fn: string;
  comment: string;
  subtle: string;
  constant: string;
  parameter: string;
  decorator: string;
}

/**
 * Semantic-highlighting rules.
 *
 * Standalone Monaco resolves a semantic token by matching `[type, ...modifiers]`
 * joined with dots against the theme's token selectors (see
 * `StandaloneTheme.getTokenStyleMetadata`). So a rule named `class` colours the
 * `class` token type, and `variable.readonly` colours a readonly variable —
 * which is how a constant gets its own colour without the grammar knowing
 * anything about constants.
 *
 * These rules are what turn AXIOM's ~8 Monarch roles into the full set the
 * language servers actually report: functions vs methods, classes vs interfaces
 * vs enums vs structs, parameters, properties, generics, decorators, namespaces.
 */
function semanticRules(p: SemanticPalette): monaco.editor.ITokenThemeRule[] {
  return [
    // Types and type-like declarations.
    { token: 'namespace', foreground: p.type },
    { token: 'type', foreground: p.type },
    { token: 'class', foreground: p.type },
    { token: 'enum', foreground: p.type },
    { token: 'interface', foreground: p.type },
    { token: 'struct', foreground: p.type },
    { token: 'typeParameter', foreground: p.type, fontStyle: 'italic' },
    { token: 'type.defaultLibrary', foreground: p.type },
    { token: 'class.defaultLibrary', foreground: p.type },

    // Callables. Methods stay in the function colour; a declaration is bolder.
    { token: 'function', foreground: p.fn },
    { token: 'method', foreground: p.fn },
    { token: 'function.declaration', foreground: p.fn, fontStyle: 'bold' },
    { token: 'method.declaration', foreground: p.fn, fontStyle: 'bold' },
    { token: 'function.defaultLibrary', foreground: p.fn },
    { token: 'macro', foreground: p.fn },

    // Values.
    { token: 'variable', foreground: p.foreground },
    { token: 'variable.readonly', foreground: p.constant },
    { token: 'variable.readonly.defaultLibrary', foreground: p.constant },
    { token: 'property', foreground: p.foreground },
    { token: 'property.readonly', foreground: p.constant },
    { token: 'parameter', foreground: p.parameter },
    { token: 'enumMember', foreground: p.constant },
    { token: 'event', foreground: p.fn },

    // Syntax.
    { token: 'keyword', foreground: p.keyword },
    { token: 'modifier', foreground: p.keyword },
    { token: 'operator', foreground: p.subtle },
    { token: 'comment', foreground: p.comment, fontStyle: 'italic' },
    { token: 'string', foreground: p.string },
    { token: 'number', foreground: p.number },
    { token: 'regexp', foreground: p.string },
    { token: 'decorator', foreground: p.decorator },

    // Deprecated APIs read as struck-through wherever a server reports them.
    { token: 'function.deprecated', foreground: p.fn, fontStyle: 'strikethrough' },
    { token: 'method.deprecated', foreground: p.fn, fontStyle: 'strikethrough' },
    { token: 'variable.deprecated', foreground: p.foreground, fontStyle: 'strikethrough' },
    { token: 'property.deprecated', foreground: p.foreground, fontStyle: 'strikethrough' },
    { token: 'class.deprecated', foreground: p.type, fontStyle: 'strikethrough' },
  ];
}

export function ensureAxiomTheme(): void {
  if (themesDefined) return;
  monaco.editor.defineTheme('axiom-dark', {
    base: 'vs-dark',
    inherit: true,
    // Part 6.3 syntax palette: a restrained, low-saturation set capped at 8 roles.
    rules: [
      { token: '', foreground: 'DDD8E7' },
      { token: 'keyword', foreground: 'A995FF' },
      { token: 'keyword.control', foreground: 'A995FF' },
      { token: 'storage', foreground: 'A995FF' },
      { token: 'string', foreground: '9FC08A' },
      { token: 'string.escape', foreground: '9FC08A' },
      { token: 'regexp', foreground: '9FC08A' },
      { token: 'attribute.value', foreground: '9FC08A' },
      { token: 'number', foreground: 'D6A87A' },
      { token: 'constant.numeric', foreground: 'D6A87A' },
      { token: 'type', foreground: '7FB8C4' },
      { token: 'type.identifier', foreground: '7FB8C4' },
      { token: 'entity.name.type', foreground: '7FB8C4' },
      { token: 'entity.name.class', foreground: '7FB8C4' },
      { token: 'function', foreground: 'C9B98E' },
      { token: 'entity.name.function', foreground: 'C9B98E' },
      { token: 'support.function', foreground: 'C9B98E' },
      { token: 'attribute.name', foreground: 'C9B98E' },
      { token: 'comment', foreground: '777286' },
      { token: 'delimiter', foreground: '918BA2' },
      { token: 'operator', foreground: '918BA2' },
      { token: 'punctuation', foreground: '918BA2' },
      { token: 'identifier', foreground: 'DDD8E7' },
      { token: 'tag', foreground: 'A995FF' },
      ...semanticRules({
        foreground: 'DDD8E7',
        keyword: 'A995FF',
        string: '9FC08A',
        number: 'D6A87A',
        type: '7FB8C4',
        fn: 'C9B98E',
        comment: '777286',
        subtle: '918BA2',
        constant: 'D6A87A',
        parameter: 'C4BEDA',
        decorator: 'B79BD8',
      }),
    ],
    colors: {
      'editor.background': '#1E1D28',
      'editor.foreground': '#DDD8E7',
      'editorLineNumber.foreground': '#777286',
      'editorLineNumber.activeForeground': '#DDD8E7',
      'editor.selectionBackground': '#7C5CFF42',
      'editor.inactiveSelectionBackground': '#7C5CFF24',
      'editor.selectionHighlightBackground': '#7C5CFF1F',
      'editor.lineHighlightBackground': '#CBC6E80A',
      'editorCursor.foreground': '#A995FF',
      'editorGutter.background': '#1E1D28',
      'editorWidget.background': '#2A2937',
      'editorWidget.border': '#3B384B',
      'editorIndentGuide.background1': '#302E3D',
      'editorIndentGuide.activeBackground1': '#504B65',
      'editorBracketMatch.border': '#8F79F0',
    },
  });
  monaco.editor.defineTheme('axiom-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: '2B303A' },
      { token: 'keyword', foreground: '3B5BA8' },
      { token: 'storage', foreground: '3B5BA8' },
      { token: 'string', foreground: '3E7A2E' },
      { token: 'number', foreground: 'A5561E' },
      { token: 'type', foreground: '2E7A88' },
      { token: 'function', foreground: '7A6420' },
      { token: 'entity.name.function', foreground: '7A6420' },
      { token: 'comment', foreground: '8A929E' },
      { token: 'delimiter', foreground: '5B626E' },
      ...semanticRules({
        foreground: '2B303A',
        keyword: '3B5BA8',
        string: '3E7A2E',
        number: 'A5561E',
        type: '2E7A88',
        fn: '7A6420',
        comment: '8A929E',
        subtle: '5B626E',
        constant: 'A5561E',
        parameter: '4A5160',
        decorator: '6B4FA8',
      }),
    ],
    colors: {
      'editor.background': '#FAF9FC',
      'editor.foreground': '#312B3B',
      'editorLineNumber.foreground': '#817A8E',
      'editorLineNumber.activeForeground': '#312B3B',
      'editor.selectionBackground': '#7C5CFF29',
      'editor.selectionHighlightBackground': '#7C5CFF1F',
      'editor.lineHighlightBackground': '#3028440A',
      'editorCursor.foreground': '#6344E6',
      'editorGutter.background': '#FAF9FC',
      'editorWidget.background': '#F7F5FA',
      'editorWidget.border': '#C9C3D2',
      'editorIndentGuide.background1': '#DDD8E5',
      'editorIndentGuide.activeBackground1': '#AAA2B7',
    },
  });
  themesDefined = true;
}

interface MonacoAppearanceTheme {
  kind: 'dark' | 'light';
  tokens: Record<string, string>;
}

interface MonacoAppearanceAccent {
  accent: string;
  accentHover: string;
  accentPress: string;
}

function tokenForeground(value: string | undefined, fallback: string): string {
  return /^#[0-9a-f]{6}$/i.test(value ?? '') ? value!.slice(1) : fallback;
}

function colorWithAlpha(color: string, alpha: number): string {
  return /^#[0-9a-f]{6}$/i.test(color)
    ? `${color}${Math.round(alpha * 255)
        .toString(16)
        .padStart(2, '0')}`
    : color;
}

/** Define and activate Monaco colors from the complete app theme and accent. */
export function setMonacoTheme(
  themeId: string,
  theme: MonacoAppearanceTheme,
  accent: MonacoAppearanceAccent,
): void {
  ensureAxiomTheme();
  const id = `axiom-runtime-${themeId}-${accent.accent.slice(1).toLowerCase()}`;
  const t = theme.tokens;
  const foreground = tokenForeground(t['--fg-default'], 'DDD8E7');
  const subtle = tokenForeground(t['--fg-subtle'], '918BA2');
  const faint = tokenForeground(t['--fg-faint'], '777286');
  const keyword = tokenForeground(accent.accentHover, 'A995FF');
  const string = tokenForeground(t['--success'], '62C88A');
  const number = tokenForeground(t['--warning'], 'DDB667');
  const type = tokenForeground(t['--info'], '76A8F8');
  const fn = tokenForeground(t['--ai'], 'A7ADB7');

  defineAndActivate(id, {
    base:
      themeId === 'axiom-high-contrast' ? 'hc-black' : theme.kind === 'light' ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground },
      { token: 'keyword', foreground: keyword },
      { token: 'keyword.control', foreground: keyword },
      { token: 'storage', foreground: keyword },
      { token: 'tag', foreground: keyword },
      { token: 'string', foreground: string },
      { token: 'string.escape', foreground: string },
      { token: 'regexp', foreground: string },
      { token: 'attribute.value', foreground: string },
      { token: 'number', foreground: number },
      { token: 'constant.numeric', foreground: number },
      { token: 'type', foreground: type },
      { token: 'type.identifier', foreground: type },
      { token: 'entity.name.type', foreground: type },
      { token: 'entity.name.class', foreground: type },
      { token: 'function', foreground: fn },
      { token: 'entity.name.function', foreground: fn },
      { token: 'support.function', foreground: fn },
      { token: 'attribute.name', foreground: fn },
      { token: 'comment', foreground: faint },
      { token: 'delimiter', foreground: subtle },
      { token: 'punctuation', foreground: subtle },
      { token: 'identifier', foreground },
      // Semantic roles inherit the same palette, so language-server highlighting
      // matches whichever theme and accent the user picked.
      ...semanticRules({
        foreground,
        keyword,
        string,
        number,
        type,
        fn,
        comment: faint,
        subtle,
        constant: number,
        parameter: subtle,
        decorator: keyword,
      }),
    ],
    colors: {
      'editor.background': t['--bg-editor'] ?? '#1E1D28',
      'editor.foreground': t['--fg-default'] ?? '#DDD8E7',
      'editorLineNumber.foreground': t['--fg-faint'] ?? '#777286',
      'editorLineNumber.activeForeground': t['--fg-strong'] ?? '#DDD8E7',
      'editor.selectionBackground': colorWithAlpha(accent.accent, 0.28),
      'editor.inactiveSelectionBackground': colorWithAlpha(accent.accent, 0.16),
      'editor.selectionHighlightBackground': colorWithAlpha(accent.accent, 0.12),
      'editor.lineHighlightBackground': colorWithAlpha(t['--fg-default'] ?? '#DDD8E7', 0.04),
      'editorCursor.foreground': accent.accentHover,
      'editorGutter.background': t['--bg-editor'] ?? '#1E1D28',
      'editorWidget.background': t['--bg-raised'] ?? '#2A2937',
      'editorWidget.border': t['--border'] ?? '#3B384B',
      'editorIndentGuide.background1': t['--border-subtle'] ?? '#302E3D',
      'editorIndentGuide.activeBackground1': t['--border-strong'] ?? '#504B65',
      'editorBracketMatch.border': accent.accentPress,
      focusBorder: accent.accent,
    },
  });
}

/**
 * The colour a contributed theme gives a TextMate scope, searched most-specific first.
 *
 * A theme states `entity.name.function`, not `function`; the semantic-token layer below
 * needs the opposite. Walking the candidate list in order and accepting a scope prefix
 * match is exactly how TextMate resolution works, so the answer is the colour the theme
 * would have painted that scope with.
 */
function scopeColor(
  rules: readonly ContributedTokenRule[],
  candidates: readonly string[],
  fallback: string,
): string {
  for (const candidate of candidates) {
    let best: { length: number; foreground: string } | null = null;
    for (const rule of rules) {
      if (rule.foreground === undefined || rule.token === '') continue;
      const matches = candidate === rule.token || candidate.startsWith(`${rule.token}.`);
      if (!matches) continue;
      if (best === null || rule.token.length >= best.length) {
        best = { length: rule.token.length, foreground: rule.foreground };
      }
    }
    if (best !== null) return best.foreground;
  }
  return fallback;
}

interface ContributedTokenRule {
  token: string;
  foreground?: string;
  fontStyle?: string;
}

/** A contributed theme, as far as Monaco is concerned. */
interface ContributedMonacoTheme {
  kind: 'dark' | 'light';
  base: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
  rules: readonly ContributedTokenRule[];
  editorColors: Record<string, string>;
  tokens: Record<string, string>;
}

/** Monaco stores themes by name; keep the id to characters a name can safely hold. */
function monacoThemeId(key: string): string {
  const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `axiom-ext-${slug.slice(0, 80) || 'theme'}`;
}

/**
 * Define and activate a Monaco theme from an extension-contributed colour theme.
 *
 * The theme's own `tokenColors` drive syntax highlighting directly — that is the point of
 * installing it. Semantic rules are then appended with colours *derived from those same
 * token colours*, because language servers report `parameter` and `enumMember`, which no
 * TextMate theme names. Deriving keeps semantic highlighting inside the theme's palette;
 * the alternative — leaving semantic tokens on AXIOM's built-in colours — makes a file
 * change colour the moment a language server attaches, which reads as a bug.
 */
export function setMonacoContributedTheme(key: string, theme: ContributedMonacoTheme): void {
  ensureAxiomTheme();
  const id = monacoThemeId(key);
  const t = theme.tokens;
  const foreground = tokenForeground(
    theme.editorColors['editor.foreground'] ?? t['--fg-default'],
    theme.kind === 'light' ? '2B303A' : 'DDD8E7',
  );
  const rules = theme.rules;
  const keyword = scopeColor(rules, ['keyword.control', 'keyword', 'storage.type'], foreground);
  const string = scopeColor(rules, ['string.quoted', 'string'], foreground);
  const number = scopeColor(rules, ['constant.numeric', 'constant'], foreground);
  const type = scopeColor(
    rules,
    ['entity.name.type', 'entity.name.class', 'support.type', 'storage.type'],
    foreground,
  );
  const fn = scopeColor(rules, ['entity.name.function', 'support.function'], foreground);
  const comment = scopeColor(rules, ['comment.line', 'comment'], tokenForeground(t['--fg-faint'], '777286'));
  const subtle = scopeColor(
    rules,
    ['punctuation', 'keyword.operator'],
    tokenForeground(t['--fg-subtle'], '918BA2'),
  );
  const constant = scopeColor(rules, ['constant.language', 'constant.numeric', 'constant'], number);
  const parameter = scopeColor(
    rules,
    ['variable.parameter', 'variable'],
    tokenForeground(t['--fg-subtle'], '918BA2'),
  );
  const decorator = scopeColor(rules, ['entity.name.decorator', 'meta.decorator', 'storage.type.annotation'], keyword);

  defineAndActivate(id, {
    base: theme.base,
    inherit: true,
    rules: [
      { token: '', foreground },
      ...rules.map((rule) => ({
        token: rule.token,
        ...(rule.foreground !== undefined ? { foreground: rule.foreground } : {}),
        ...(rule.fontStyle !== undefined ? { fontStyle: rule.fontStyle } : {}),
      })),
      ...semanticRules({
        foreground,
        keyword,
        string,
        number,
        type,
        fn,
        comment,
        subtle,
        constant,
        parameter,
        decorator,
      }),
    ],
    colors: theme.editorColors,
  });
}

/** The Monaco theme id new editors should be created with. */
export function currentMonacoTheme(): string {
  return activeTheme;
}

export { monaco };
