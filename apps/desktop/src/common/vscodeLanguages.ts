/**
 * The language-provider registry and declarative language registration (PRD Phase 6).
 *
 * `vscode.languages.register*Provider` is 28 functions that all do the same three things:
 * remember a provider object, remember the `DocumentSelector` it applies to, and hand back a
 * `Disposable`. This module owns the bookkeeping half of that — which provider exists, for which
 * feature, for which documents, in what order, and what happens when one is disposed — so the
 * extension host and Main agree on the answer without either of them holding the logic.
 *
 * Scoring and merge strategy are *not* restated here: `documentSelector.ts` already implements
 * upstream's numbers and upstream's per-feature merge rules, and this registry defers to it. What
 * this file adds is identity (a handle per registration), ownership (an extension id per handle,
 * so disposing an extension disposes its providers), the per-feature metadata Monaco needs before
 * a provider is ever called (trigger characters, a semantic-tokens legend), and the declarative
 * `contributes.languages` side: aliases, extensions, filename patterns and first-line detection.
 *
 * Pure: no I/O, no Electron, no Monaco. Every bound here is a bound on what one extension can
 * make the platform hold.
 */
import {
  orderProviders,
  selectProviders,
  type DocumentCandidate,
  type DocumentSelector,
  type MergeStrategy,
  type RegisteredProvider,
} from './documentSelector';
import { matchesVsCodeGlob, normalizeGlobPath } from './vscodeGlob';

/**
 * Every language feature a provider can be registered for.
 *
 * One entry per `register*Provider` function, with two exceptions that are aliases rather than
 * features: `registerSemanticTokensProvider` and `registerDocumentSemanticTokensProvider` are the
 * same registration (`semanticTokens`), and the range variant is separate (`semanticTokensRange`)
 * because Monaco asks for it through a different provider interface.
 */
export const LANGUAGE_FEATURES = [
  'completion',
  'hover',
  'signatureHelp',
  'definition',
  'typeDefinition',
  'implementation',
  'declaration',
  'reference',
  'rename',
  'documentSymbol',
  'workspaceSymbol',
  'formatting',
  'rangeFormatting',
  'onTypeFormatting',
  'codeAction',
  'codeLens',
  'color',
  'documentHighlight',
  'documentLink',
  'selectionRange',
  'foldingRange',
  'linkedEditingRange',
  'inlayHint',
  'inlineValue',
  'typeHierarchy',
  'callHierarchy',
  'semanticTokens',
  'semanticTokensRange',
] as const;

export type LanguageFeature = (typeof LANGUAGE_FEATURES)[number];

const FEATURE_SET: ReadonlySet<string> = new Set(LANGUAGE_FEATURES);

export function isLanguageFeature(value: unknown): value is LanguageFeature {
  return typeof value === 'string' && FEATURE_SET.has(value);
}

/**
 * The operations Main may ask a provider to perform.
 *
 * `provide` is the primary call. The rest are the second halves of features that upstream splits
 * in two so the expensive part is only paid when the user actually looks: `resolve` for the
 * documentation behind a completion item, `prepare` for rename's validation and for a hierarchy
 * root, and the hierarchy traversals.
 */
export const PROVIDER_OPS = [
  'provide',
  'resolve',
  'prepare',
  'presentations',
  'incoming',
  'outgoing',
  'supertypes',
  'subtypes',
  'edits',
] as const;

export type ProviderOp = (typeof PROVIDER_OPS)[number];

const OPS_BY_FEATURE: Readonly<Record<LanguageFeature, readonly ProviderOp[]>> = {
  completion: ['provide', 'resolve'],
  hover: ['provide'],
  signatureHelp: ['provide'],
  definition: ['provide'],
  typeDefinition: ['provide'],
  implementation: ['provide'],
  declaration: ['provide'],
  reference: ['provide'],
  rename: ['provide', 'prepare'],
  documentSymbol: ['provide'],
  workspaceSymbol: ['provide', 'resolve'],
  formatting: ['provide'],
  rangeFormatting: ['provide'],
  onTypeFormatting: ['provide'],
  codeAction: ['provide', 'resolve'],
  codeLens: ['provide', 'resolve'],
  color: ['provide', 'presentations'],
  documentHighlight: ['provide'],
  documentLink: ['provide', 'resolve'],
  selectionRange: ['provide'],
  foldingRange: ['provide'],
  linkedEditingRange: ['provide'],
  inlayHint: ['provide', 'resolve'],
  inlineValue: ['provide'],
  typeHierarchy: ['prepare', 'supertypes', 'subtypes'],
  callHierarchy: ['prepare', 'incoming', 'outgoing'],
  semanticTokens: ['provide', 'edits'],
  semanticTokensRange: ['provide'],
};

/** True when this feature answers this operation. Anything else is refused at the boundary. */
export function isProviderOp(feature: LanguageFeature, op: unknown): op is ProviderOp {
  return typeof op === 'string' && (OPS_BY_FEATURE[feature] as readonly string[]).includes(op);
}

export function providerOpsFor(feature: LanguageFeature): readonly ProviderOp[] {
  return OPS_BY_FEATURE[feature];
}

/** Providers one extension may hold at once. GitLens registers ~12; Python ~9. */
export const MAX_PROVIDERS_PER_EXTENSION = 200;
/** Trigger characters one provider may declare. */
export const MAX_TRIGGER_CHARACTERS = 64;
/** Language definitions the registry will hold across every extension plus the built-ins. */
export const MAX_REGISTERED_LANGUAGES = 400;
/** Token types and modifiers a semantic-tokens legend may declare. */
export const MAX_TOKEN_TYPES = 256;
export const MAX_TOKEN_MODIFIERS = 64;

/**
 * The metadata a registration carries alongside the provider object.
 *
 * Monaco needs part of this before any provider call happens — it will not ask for completions
 * after `.` unless `.` was declared a trigger character — and part of it decides whether an
 * operation is offered at all: advertising `hasResolve` for a completion provider that has no
 * `resolveCompletionItem` would make Monaco call a method that does not exist.
 */
export interface ProviderMetadata {
  triggerCharacters?: readonly string[];
  retriggerCharacters?: readonly string[];
  firstTriggerCharacter?: string;
  moreTriggerCharacter?: readonly string[];
  codeActionKinds?: readonly string[];
  legend?: { tokenTypes: readonly string[]; tokenModifiers: readonly string[] };
  hasResolve?: boolean;
  hasEdits?: boolean;
  hasPrepare?: boolean;
  /** The provider has the change event for its feature, so refreshes can arrive for it. */
  hasChangeEvent?: boolean;
  /** Shown when a `single`-strategy feature ties and the user has to choose. */
  displayName?: string;
  /** A code-action provider's `documentation`, as command ids. */
  documentation?: ReadonlyArray<{ kind: string; title: string; command: string }>;
}

export interface LanguageProviderRegistration extends RegisteredProvider {
  feature: LanguageFeature;
  metadata: ProviderMetadata;
}

/** Keep only single-character triggers, deduplicated and capped. */
export function normalizeTriggerCharacters(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    // Upstream takes the first character of anything longer than one.
    seen.add(Array.from(entry)[0] as string);
    if (seen.size >= MAX_TRIGGER_CHARACTERS) break;
  }
  return [...seen];
}
const MAX_CODE_ACTION_KINDS = 32;
const MAX_METADATA_STRING = 200;
const MAX_DOCUMENTATION_ENTRIES = 16;

function shortString(value: unknown, limit = MAX_METADATA_STRING): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, limit);
}

function stringList(value: unknown, max: number, limit = MAX_METADATA_STRING): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const text = shortString(entry, limit);
    if (text !== undefined && !out.includes(text)) out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

/** Shape-and-cap check only; encoding lives in `vscodeSemanticTokens.ts`. */
function normalizeLegendShape(
  value: unknown,
): { tokenTypes: string[]; tokenModifiers: string[] } | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const tokenTypes = stringList(source.tokenTypes, MAX_TOKEN_TYPES, 64);
  if (tokenTypes.length === 0) return undefined;
  return { tokenTypes, tokenModifiers: stringList(source.tokenModifiers, MAX_TOKEN_MODIFIERS, 64) };
}

function normalizeDocumentation(
  value: unknown,
): Array<{ kind: string; title: string; command: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ kind: string; title: string; command: string }> = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    const kind = shortString(entry.kind, 64);
    const title = shortString(entry.title);
    const command =
      shortString(entry.command, 128) ??
      shortString((entry.command as Record<string, unknown> | undefined)?.command, 128);
    if (kind === undefined || title === undefined || command === undefined) continue;
    out.push({ kind, title, command });
    if (out.length >= MAX_DOCUMENTATION_ENTRIES) break;
  }
  return out;
}
/**
 * Reduce whatever an extension passed at registration to the shape Main and Monaco will act on.
 *
 * Registration metadata crosses the process boundary and is then held for the life of the
 * registration, so it is normalised here rather than trusted: a `triggerCharacters` array of ten
 * thousand entries, or a `displayName` holding a megabyte of text, would otherwise be kept
 * resident for as long as the extension is enabled.
 */
export function normalizeProviderMetadata(raw: unknown): ProviderMetadata {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const metadata: ProviderMetadata = {};
  const trigger = normalizeTriggerCharacters(source.triggerCharacters);
  if (trigger.length > 0) metadata.triggerCharacters = trigger;
  const retrigger = normalizeTriggerCharacters(source.retriggerCharacters);
  if (retrigger.length > 0) metadata.retriggerCharacters = retrigger;
  const first = shortString(source.firstTriggerCharacter, 8);
  if (first !== undefined) metadata.firstTriggerCharacter = Array.from(first)[0] as string;
  const more = normalizeTriggerCharacters(source.moreTriggerCharacter);
  if (more.length > 0) metadata.moreTriggerCharacter = more;
  const kinds = stringList(source.codeActionKinds, MAX_CODE_ACTION_KINDS, 64);
  if (kinds.length > 0) metadata.codeActionKinds = kinds;
  const legend = normalizeLegendShape(source.legend);
  if (legend !== undefined) metadata.legend = legend;
  if (source.hasResolve === true) metadata.hasResolve = true;
  if (source.hasEdits === true) metadata.hasEdits = true;
  if (source.hasPrepare === true) metadata.hasPrepare = true;
  if (source.hasChangeEvent === true) metadata.hasChangeEvent = true;
  const displayName = shortString(source.displayName);
  if (displayName !== undefined) metadata.displayName = displayName;
  const documentation = normalizeDocumentation(source.documentation);
  if (documentation.length > 0) metadata.documentation = documentation;
  return metadata;
}
export interface ProviderRegistrationInput {
  extensionId: string;
  feature: LanguageFeature;
  selector: DocumentSelector;
  metadata?: ProviderMetadata;
  /**
   * Handle to register under. The worker owns handle identity — it is what the extension's
   * `Disposable` closes over — so Main mirrors the worker's number rather than minting its own.
   * Omitted, the registry mints the next free one.
   */
  handle?: number;
}

/**
 * Which providers exist, for what, and in what order.
 *
 * Both sides of the boundary keep one of these: the worker so it can find the provider object to
 * call and revoke it on dispose, Main so it can decide who to ask without a round trip. They are
 * kept in step by handle, and the registry is deliberately dumb about *how* providers combine —
 * that is `documentSelector.ts`'s job, and this defers to it so there is exactly one answer.
 */
export class ProviderRegistry {
  private readonly byHandle = new Map<number, LanguageProviderRegistration>();
  private readonly byFeature = new Map<LanguageFeature, LanguageProviderRegistration[]>();
  private readonly countByExtension = new Map<string, number>();
  private sequence = 0;
  private handleSeed = 0;

  register(input: ProviderRegistrationInput): LanguageProviderRegistration {
    const used = this.countByExtension.get(input.extensionId) ?? 0;
    if (used >= MAX_PROVIDERS_PER_EXTENSION) {
      throw new Error(
        `${input.extensionId} has reached the limit of ${MAX_PROVIDERS_PER_EXTENSION} language providers.`,
      );
    }
    const handle = input.handle ?? this.handleSeed + 1;
    if (this.byHandle.has(handle)) {
      throw new Error(`Language provider handle ${handle} is already registered.`);
    }
    if (handle > this.handleSeed) this.handleSeed = handle;
    this.sequence += 1;
    const registration: LanguageProviderRegistration = {
      handle,
      extensionId: input.extensionId,
      feature: input.feature,
      selector: input.selector,
      sequence: this.sequence,
      metadata: input.metadata ?? {},
    };
    this.byHandle.set(handle, registration);
    const list = this.byFeature.get(input.feature);
    if (list) list.push(registration);
    else this.byFeature.set(input.feature, [registration]);
    this.countByExtension.set(input.extensionId, used + 1);
    return registration;
  }
  /** Remove one registration. Idempotent: disposing a `Disposable` twice is legal. */
  unregister(handle: number): LanguageProviderRegistration | undefined {
    const registration = this.byHandle.get(handle);
    if (!registration) return undefined;
    this.byHandle.delete(handle);
    const list = this.byFeature.get(registration.feature);
    if (list) {
      const index = list.indexOf(registration);
      if (index >= 0) list.splice(index, 1);
      if (list.length === 0) this.byFeature.delete(registration.feature);
    }
    const used = this.countByExtension.get(registration.extensionId) ?? 0;
    if (used <= 1) this.countByExtension.delete(registration.extensionId);
    else this.countByExtension.set(registration.extensionId, used - 1);
    return registration;
  }

  /**
   * Drop every provider one extension registered.
   *
   * This is what makes deactivation and a worker crash equivalent: an extension that died without
   * disposing anything still leaves no providers behind, so the editor stops asking a process that
   * is not there.
   */
  removeExtension(extensionId: string): LanguageProviderRegistration[] {
    const removed: LanguageProviderRegistration[] = [];
    for (const registration of [...this.byHandle.values()]) {
      if (registration.extensionId !== extensionId) continue;
      this.unregister(registration.handle);
      removed.push(registration);
    }
    return removed;
  }

  get(handle: number): LanguageProviderRegistration | undefined {
    return this.byHandle.get(handle);
  }

  forFeature(feature: LanguageFeature): readonly LanguageProviderRegistration[] {
    return this.byFeature.get(feature) ?? [];
  }

  /** Features with at least one provider — what the renderer needs to register in Monaco. */
  activeFeatures(): LanguageFeature[] {
    return LANGUAGE_FEATURES.filter((feature) => (this.byFeature.get(feature)?.length ?? 0) > 0);
  }

  countFor(extensionId: string): number {
    return this.countByExtension.get(extensionId) ?? 0;
  }

  get size(): number {
    return this.byHandle.size;
  }
  /** Providers to invoke for a document, with the feature's merge strategy. */
  select(
    feature: LanguageFeature,
    document: DocumentCandidate,
  ): { strategy: MergeStrategy; providers: LanguageProviderRegistration[]; needsPicker: boolean } {
    return selectProviders(feature, this.forFeature(feature), document);
  }

  /** Every applicable provider, best first — used where all results are wanted regardless. */
  ordered(feature: LanguageFeature, document: DocumentCandidate): LanguageProviderRegistration[] {
    return orderProviders(this.forFeature(feature), document).map((entry) => entry.provider);
  }

  /**
   * The union of trigger characters across every applicable provider.
   *
   * Monaco takes one set per language, not one per provider, so the union is the only correct
   * answer: a character declared by any provider has to reach dispatch, and the per-provider
   * check happens when results come back.
   */
  triggerCharactersFor(
    feature: LanguageFeature,
    document: DocumentCandidate,
    kind: 'trigger' | 'retrigger' = 'trigger',
  ): string[] {
    const out = new Set<string>();
    for (const provider of this.ordered(feature, document)) {
      const chars =
        kind === 'trigger'
          ? provider.metadata.triggerCharacters
          : provider.metadata.retriggerCharacters;
      for (const ch of chars ?? []) {
        out.add(ch);
        if (out.size >= MAX_TRIGGER_CHARACTERS) return [...out];
      }
    }
    return [...out];
  }

  /**
   * The legend of the highest-scoring semantic-tokens provider for a document.
   *
   * Semantic tokens are a `single` feature precisely because the legend is per-provider: token
   * type 3 means whatever that provider's legend says it means, so merging two providers' output
   * would recolour the file at random.
   */
  legendFor(
    document: DocumentCandidate,
    feature: 'semanticTokens' | 'semanticTokensRange' = 'semanticTokens',
  ): { tokenTypes: readonly string[]; tokenModifiers: readonly string[] } | undefined {
    for (const provider of this.ordered(feature, document)) {
      if (provider.metadata.legend) return provider.metadata.legend;
    }
    return undefined;
  }

  clear(): void {
    this.byHandle.clear();
    this.byFeature.clear();
    this.countByExtension.clear();
  }
}
/** A language as the platform holds it: lists deduplicated, extensions and filenames folded. */
export interface LanguageDefinition {
  id: string;
  aliases: string[];
  extensions: string[];
  filenames: string[];
  filenamePatterns: string[];
  mimetypes: string[];
  firstLine?: string;
  /** Path of the language-configuration JSON, when one was contributed. */
  configurationPath?: string;
  /** Contributing extension; absent for the languages Monaco already knows. */
  extensionId?: string;
}

const LANGUAGE_ID_RE = /^[A-Za-z0-9_+#.-]{1,64}$/;
/** Cap on a `firstLine` pattern. A long pattern over a long line is where backtracking bites. */
const MAX_FIRST_LINE_PATTERN = 256;
const MAX_FIRST_LINE_TEXT = 512;
const MAX_LANGUAGE_LIST = 64;

export function isLanguageId(value: unknown): value is string {
  return typeof value === 'string' && LANGUAGE_ID_RE.test(value);
}

function foldExtension(value: string): string | undefined {
  const text = value.trim().toLowerCase();
  if (text.length === 0 || text.length > 64) return undefined;
  return text.startsWith('.') ? text : `.${text}`;
}

/**
 * Normalise one `contributes.languages` entry (or one `registerLanguage()` call).
 *
 * Returns null for anything without a usable id: a language the platform cannot name is a
 * language nothing can select against, and silently keeping it would make `getLanguages()`
 * disagree with what providers can match.
 */
export function normalizeLanguageDefinition(
  raw: unknown,
  options: { extensionId?: string; configurationPath?: string } = {},
): LanguageDefinition | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as Record<string, unknown>;
  const id = shortString(source.id, 64);
  if (id === undefined || !LANGUAGE_ID_RE.test(id)) return null;
  const extensions: string[] = [];
  for (const entry of stringList(source.extensions, MAX_LANGUAGE_LIST, 64)) {
    const folded = foldExtension(entry);
    if (folded !== undefined && !extensions.includes(folded)) extensions.push(folded);
  }
  const filenames = stringList(source.filenames, MAX_LANGUAGE_LIST, 260).map((name) =>
    name.toLowerCase(),
  );
  const firstLine = shortString(source.firstLine, MAX_FIRST_LINE_PATTERN);
  const configurationPath =
    options.configurationPath ?? shortString(source.configuration, 512) ?? undefined;
  return {
    id,
    aliases: stringList(source.aliases, MAX_LANGUAGE_LIST),
    extensions,
    filenames: [...new Set(filenames)],
    filenamePatterns: stringList(source.filenamePatterns, MAX_LANGUAGE_LIST, 260),
    mimetypes: stringList(source.mimetypes, MAX_LANGUAGE_LIST, 128),
    ...(firstLine !== undefined ? { firstLine } : {}),
    ...(configurationPath !== undefined ? { configurationPath } : {}),
    ...(options.extensionId !== undefined ? { extensionId: options.extensionId } : {}),
  };
}
function baseName(path: string): string {
  const normalized = normalizeGlobPath(path);
  const slash = normalized.lastIndexOf('/');
  return (slash >= 0 ? normalized.slice(slash + 1) : normalized).toLowerCase();
}

/**
 * Test a contributed `firstLine` pattern against a document's first line.
 *
 * The pattern comes from an extension manifest, so both sides are bounded before the match runs:
 * the pattern at 256 characters and the line at 512. A pattern is compiled with `RegExp` — never
 * `eval` or `new Function` — and an unparseable one simply does not match rather than throwing
 * through detection and leaving the document with no language at all.
 */
export function matchesFirstLine(pattern: string, line: string): boolean {
  if (pattern.length === 0 || pattern.length > MAX_FIRST_LINE_PATTERN) return false;
  try {
    return new RegExp(pattern).test(line.slice(0, MAX_FIRST_LINE_TEXT));
  } catch {
    return false;
  }
}

export interface LanguageDetectionInput {
  path: string;
  /** The document's first line, when it has been read. */
  firstLine?: string;
}

/**
 * Resolve a document's language id from the registered definitions.
 *
 * Upstream's precedence, in order: exact filename, filename pattern, file extension (longest
 * match — `.d.ts` beats `.ts`), then the `firstLine` pattern. Within a tier the most recently
 * registered definition wins, so a user-installed extension can override a built-in association.
 */
export function detectLanguageId(
  languages: readonly LanguageDefinition[],
  input: LanguageDetectionInput,
): string | undefined {
  const name = baseName(input.path);
  const path = normalizeGlobPath(input.path);
  for (let i = languages.length - 1; i >= 0; i -= 1) {
    const language = languages[i] as LanguageDefinition;
    if (language.filenames.includes(name)) return language.id;
  }
  for (let i = languages.length - 1; i >= 0; i -= 1) {
    const language = languages[i] as LanguageDefinition;
    for (const pattern of language.filenamePatterns) {
      if (matchesVsCodeGlob(pattern, path) || matchesVsCodeGlob(pattern, name)) return language.id;
    }
  }
  let best: { id: string; length: number } | undefined;
  for (let i = languages.length - 1; i >= 0; i -= 1) {
    const language = languages[i] as LanguageDefinition;
    for (const extension of language.extensions) {
      if (!name.endsWith(extension)) continue;
      if (best === undefined || extension.length > best.length) {
        best = { id: language.id, length: extension.length };
      }
    }
  }
  if (best !== undefined) return best.id;
  if (typeof input.firstLine === 'string' && input.firstLine.length > 0) {
    for (let i = languages.length - 1; i >= 0; i -= 1) {
      const language = languages[i] as LanguageDefinition;
      if (language.firstLine !== undefined && matchesFirstLine(language.firstLine, input.firstLine))
        return language.id;
    }
  }
  return undefined;
}
/**
 * Every language the platform knows, in registration order.
 *
 * Contributions are kept as separate entries rather than collapsed on first write, because
 * upstream lets several extensions extend one language — a dozen extensions add file extensions to
 * `json` — and an extension being uninstalled has to take its own additions with it and nothing
 * else. `resolve()` does the merging at read time so removal stays exact.
 */
export class LanguageRegistry {
  private readonly definitions: LanguageDefinition[] = [];

  /** False when the registry is full; a refused language is simply not known to the platform. */
  register(definition: LanguageDefinition): boolean {
    if (this.definitions.length >= MAX_REGISTERED_LANGUAGES) return false;
    this.definitions.push(definition);
    return true;
  }

  registerAll(definitions: readonly LanguageDefinition[]): number {
    let added = 0;
    for (const definition of definitions) if (this.register(definition)) added += 1;
    return added;
  }

  removeExtension(extensionId: string): number {
    let removed = 0;
    for (let i = this.definitions.length - 1; i >= 0; i -= 1) {
      if ((this.definitions[i] as LanguageDefinition).extensionId !== extensionId) continue;
      this.definitions.splice(i, 1);
      removed += 1;
    }
    return removed;
  }

  /** All contributions for one id, merged. */
  resolve(id: string): LanguageDefinition | undefined {
    const parts = this.definitions.filter((definition) => definition.id === id);
    if (parts.length === 0) return undefined;
    const merged: LanguageDefinition = {
      id,
      aliases: [],
      extensions: [],
      filenames: [],
      filenamePatterns: [],
      mimetypes: [],
    };
    for (const part of parts) {
      for (const key of ['aliases', 'extensions', 'filenames', 'filenamePatterns', 'mimetypes']) {
        const target = merged[key as 'aliases'];
        for (const value of part[key as 'aliases']) if (!target.includes(value)) target.push(value);
      }
      if (part.firstLine !== undefined) merged.firstLine = part.firstLine;
      if (part.configurationPath !== undefined) merged.configurationPath = part.configurationPath;
      if (part.extensionId !== undefined) merged.extensionId = part.extensionId;
    }
    return merged;
  }

  has(id: string): boolean {
    return this.definitions.some((definition) => definition.id === id);
  }

  /** `vscode.languages.getLanguages()` — every known id, first-registered first. */
  ids(): string[] {
    return [...new Set(this.definitions.map((definition) => definition.id))];
  }

  all(): readonly LanguageDefinition[] {
    return this.definitions;
  }

  detect(input: LanguageDetectionInput): string | undefined {
    return detectLanguageId(this.definitions, input);
  }

  get size(): number {
    return this.definitions.length;
  }

  clear(): void {
    this.definitions.length = 0;
  }
}
/**
 * A language configuration as it crosses the boundary.
 *
 * Upstream's type holds live `RegExp` objects; here every pattern is a string and the renderer
 * compiles it against Monaco's own configuration type. That keeps the wire format plain data
 * (validatable, loggable, structured-cloneable) and keeps pattern compilation on one side, where
 * an unparseable pattern from an extension manifest can be dropped instead of thrown.
 */
export interface LanguageConfigurationData {
  comments?: { lineComment?: string; blockComment?: [string, string] };
  brackets?: Array<[string, string]>;
  autoClosingPairs?: Array<{ open: string; close: string; notIn?: string[] }>;
  surroundingPairs?: Array<{ open: string; close: string }>;
  colorizedBracketPairs?: Array<[string, string]>;
  wordPattern?: string;
  indentationRules?: {
    increaseIndentPattern?: string;
    decreaseIndentPattern?: string;
    indentNextLinePattern?: string;
    unIndentedLinePattern?: string;
  };
  onEnterRules?: Array<{
    beforeText: string;
    afterText?: string;
    previousLineText?: string;
    action: { indent: string; appendText?: string; removeText?: number };
  }>;
  folding?: { offSide?: boolean; markers?: { start: string; end: string } };
  autoCloseBefore?: string;
}

const MAX_PAIRS = 64;
const MAX_ENTER_RULES = 64;
const MAX_PATTERN = 1024;
const MAX_BRACKET_TOKEN = 32;
/** Monaco's `IndentAction` names — anything else is not an indent action. */
const INDENT_ACTIONS = new Set(['none', 'indent', 'indentOutdent', 'outdent']);

function pattern(value: unknown): string | undefined {
  // Language-configuration JSON allows either a bare string or `{ pattern, flags }`.
  const raw =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>).pattern
      : value;
  const text = shortString(raw, MAX_PATTERN);
  if (text === undefined) return undefined;
  try {
    new RegExp(text);
  } catch {
    return undefined;
  }
  return text;
}
/** `["{", "}"]` or `{ open, close }` — both spellings appear in real configuration files. */
function normalizePairs(value: unknown): Array<[string, string]> {
  if (!Array.isArray(value)) return [];
  const out: Array<[string, string]> = [];
  for (const item of value) {
    let open: string | undefined;
    let close: string | undefined;
    if (Array.isArray(item)) {
      open = shortString(item[0], MAX_BRACKET_TOKEN);
      close = shortString(item[1], MAX_BRACKET_TOKEN);
    } else if (typeof item === 'object' && item !== null) {
      const entry = item as Record<string, unknown>;
      open = shortString(entry.open, MAX_BRACKET_TOKEN);
      close = shortString(entry.close, MAX_BRACKET_TOKEN);
    }
    if (open === undefined || close === undefined) continue;
    out.push([open, close]);
    if (out.length >= MAX_PAIRS) break;
  }
  return out;
}

function normalizeAutoClosingPairs(
  value: unknown,
): Array<{ open: string; close: string; notIn?: string[] }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ open: string; close: string; notIn?: string[] }> = [];
  for (const item of value) {
    const pair = normalizePairs([item])[0];
    if (pair === undefined) continue;
    const notIn =
      typeof item === 'object' && item !== null
        ? stringList((item as Record<string, unknown>).notIn, 8, 32)
        : [];
    out.push({ open: pair[0], close: pair[1], ...(notIn.length > 0 ? { notIn } : {}) });
    if (out.length >= MAX_PAIRS) break;
  }
  return out;
}
function normalizeOnEnterRules(
  value: unknown,
): NonNullable<LanguageConfigurationData['onEnterRules']> {
  if (!Array.isArray(value)) return [];
  const out: NonNullable<LanguageConfigurationData['onEnterRules']> = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    const beforeText = pattern(entry.beforeText);
    const rawAction = entry.action;
    if (beforeText === undefined || typeof rawAction !== 'object' || rawAction === null) continue;
    const action = rawAction as Record<string, unknown>;
    // `indent` arrives as an IndentAction name from JSON and as the enum's number from code.
    const indentName =
      typeof action.indent === 'number'
        ? ['none', 'indent', 'indentOutdent', 'outdent'][action.indent]
        : shortString(action.indent, 32);
    if (indentName === undefined || !INDENT_ACTIONS.has(indentName)) continue;
    const afterText = pattern(entry.afterText);
    const previousLineText = pattern(entry.previousLineText);
    const appendText = shortString(action.appendText, 64);
    const removeText =
      typeof action.removeText === 'number' && Number.isFinite(action.removeText)
        ? Math.max(0, Math.min(256, Math.floor(action.removeText)))
        : undefined;
    out.push({
      beforeText,
      ...(afterText !== undefined ? { afterText } : {}),
      ...(previousLineText !== undefined ? { previousLineText } : {}),
      action: {
        indent: indentName,
        ...(appendText !== undefined ? { appendText } : {}),
        ...(removeText !== undefined ? { removeText } : {}),
      },
    });
    if (out.length >= MAX_ENTER_RULES) break;
  }
  return out;
}
/**
 * Normalise a `setLanguageConfiguration()` argument or a parsed language-configuration file.
 *
 * Anything unrecognised is dropped rather than passed through: this object is handed to Monaco,
 * and an unexpected key there is at best ignored and at worst a type error inside the editor.
 */
export function normalizeLanguageConfiguration(raw: unknown): LanguageConfigurationData {
  if (typeof raw !== 'object' || raw === null) return {};
  const source = raw as Record<string, unknown>;
  const config: LanguageConfigurationData = {};

  const comments = source.comments;
  if (typeof comments === 'object' && comments !== null) {
    const entry = comments as Record<string, unknown>;
    const lineComment = shortString(entry.lineComment, MAX_BRACKET_TOKEN);
    const block = normalizePairs([entry.blockComment])[0];
    const value: NonNullable<LanguageConfigurationData['comments']> = {};
    if (lineComment !== undefined) value.lineComment = lineComment;
    if (block !== undefined) value.blockComment = block;
    if (value.lineComment !== undefined || value.blockComment !== undefined) {
      config.comments = value;
    }
  }

  const brackets = normalizePairs(source.brackets);
  if (brackets.length > 0) config.brackets = brackets;
  const autoClosingPairs = normalizeAutoClosingPairs(source.autoClosingPairs);
  if (autoClosingPairs.length > 0) config.autoClosingPairs = autoClosingPairs;
  const surrounding = normalizePairs(source.surroundingPairs);
  if (surrounding.length > 0) {
    config.surroundingPairs = surrounding.map(([open, close]) => ({ open, close }));
  }
  const colorized = normalizePairs(source.colorizedBracketPairs);
  if (colorized.length > 0) config.colorizedBracketPairs = colorized;
  const wordPattern = pattern(source.wordPattern);
  if (wordPattern !== undefined) config.wordPattern = wordPattern;
  const autoCloseBefore = shortString(source.autoCloseBefore, 128);
  if (autoCloseBefore !== undefined) config.autoCloseBefore = autoCloseBefore;
  const onEnterRules = normalizeOnEnterRules(source.onEnterRules);
  if (onEnterRules.length > 0) config.onEnterRules = onEnterRules;
  const indentation = source.indentationRules;
  if (typeof indentation === 'object' && indentation !== null) {
    const entry = indentation as Record<string, unknown>;
    const rules: NonNullable<LanguageConfigurationData['indentationRules']> = {};
    const increase = pattern(entry.increaseIndentPattern);
    const decrease = pattern(entry.decreaseIndentPattern);
    const indentNext = pattern(entry.indentNextLinePattern);
    const unIndented = pattern(entry.unIndentedLinePattern);
    if (increase !== undefined) rules.increaseIndentPattern = increase;
    if (decrease !== undefined) rules.decreaseIndentPattern = decrease;
    if (indentNext !== undefined) rules.indentNextLinePattern = indentNext;
    if (unIndented !== undefined) rules.unIndentedLinePattern = unIndented;
    if (Object.keys(rules).length > 0) config.indentationRules = rules;
  }

  const folding = source.folding;
  if (typeof folding === 'object' && folding !== null) {
    const entry = folding as Record<string, unknown>;
    const value: NonNullable<LanguageConfigurationData['folding']> = {};
    if (typeof entry.offSide === 'boolean') value.offSide = entry.offSide;
    const markers = entry.markers;
    if (typeof markers === 'object' && markers !== null) {
      const source2 = markers as Record<string, unknown>;
      const start = pattern(source2.start);
      const end = pattern(source2.end);
      if (start !== undefined && end !== undefined) value.markers = { start, end };
    }
    if (value.offSide !== undefined || value.markers !== undefined) config.folding = value;
  }

  return config;
}
/**
 * Normalise a `DocumentSelector` arriving from an extension.
 *
 * A selector is held for the life of the registration and consulted on every keystroke, so it is
 * reduced to plain data here — filters keep only the four fields upstream defines, and a selector
 * that constrains nothing at all is refused so a typo cannot silently register a provider for
 * every document in the workspace.
 */
export function normalizeDocumentSelector(raw: unknown): DocumentSelector | null {
  if (typeof raw === 'string') {
    const id = shortString(raw, 128);
    return id === undefined ? null : id;
  }
  if (Array.isArray(raw)) {
    const out: Array<string | Record<string, unknown>> = [];
    for (const entry of raw.slice(0, 32)) {
      const filter = normalizeDocumentSelector(entry);
      if (filter !== null) out.push(filter as string | Record<string, unknown>);
    }
    return out.length === 0 ? null : (out as DocumentSelector);
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as Record<string, unknown>;
  const filter: Record<string, unknown> = {};
  const language = shortString(source.language, 128);
  if (language !== undefined) filter.language = language;
  const scheme = shortString(source.scheme, 64);
  if (scheme !== undefined) filter.scheme = scheme;
  const notebookType = shortString(source.notebookType, 128);
  if (notebookType !== undefined) filter.notebookType = notebookType;
  const rawPattern = source.pattern;
  if (typeof rawPattern === 'string') {
    const text = shortString(rawPattern, 512);
    if (text !== undefined) filter.pattern = text;
  } else if (typeof rawPattern === 'object' && rawPattern !== null) {
    const entry = rawPattern as Record<string, unknown>;
    const base = shortString(entry.base ?? entry.baseUri, 512);
    const glob = shortString(entry.pattern, 512);
    if (base !== undefined && glob !== undefined) filter.pattern = { base, pattern: glob };
  }
  return Object.keys(filter).length === 0 ? null : (filter as DocumentSelector);
}
/** Providers that may be invoked at once for one request, across all extensions. */
export const MAX_PROVIDERS_PER_REQUEST = 32;

/** Cap a selection so one pathological workspace cannot fan a keystroke out unboundedly. */
export function limitProviders<T>(providers: readonly T[]): T[] {
  return providers.slice(0, MAX_PROVIDERS_PER_REQUEST);
}
