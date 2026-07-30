/**
 * VS Code extension manifest reader.
 *
 * A VSIX carries an ordinary npm `package.json` with VS Code's extension fields layered
 * on top. This module turns that untrusted JSON into a normalized, bounded model, and —
 * just as importantly — states plainly which of its contributions AXIOM can honour.
 *
 * Two design commitments:
 *
 *   1. Nothing is trusted. Every string is length-capped, every array is count-capped,
 *      every path is checked for traversal, and unknown shapes are dropped rather than
 *      coerced. A manifest is attacker-controlled input that arrives before any
 *      signature check has meaning, so it is parsed defensively.
 *
 *   2. Capability is reported, never implied. An extension whose only contribution is a
 *      colour theme works completely; one that registers commands from `main` cannot run
 *      its code until the extension host exists. Both install; the difference is
 *      described (`supported` vs `inert`) so the UI can tell the user the truth instead
 *      of letting them discover it by clicking something that does nothing.
 *
 * Pure: no I/O, no Electron, no filesystem. Fully unit-testable.
 */
import { satisfiesRange, minimumForRange } from './semverRange';

/**
 * The VS Code API level AXIOM reports to extensions.
 *
 * This is the level whose *declarative* contribution schema AXIOM implements. It is
 * used only to evaluate `engines.vscode`; it is not a claim that every runtime API of
 * that release exists here, which is why `activation` is reported separately.
 */
export const AXIOM_VSCODE_API_VERSION = '1.96.0';

// ---------------------------------------------------------------------------
// Bounds. Chosen to be far above any real manifest and far below anything that
// could exhaust memory: the largest published manifests run to a few hundred
// contributions, not tens of thousands.
// ---------------------------------------------------------------------------
const MAX_IDENTIFIER = 128;
const MAX_LABEL = 200;
const MAX_DESCRIPTION = 2_000;
const MAX_PATH = 512;
const MAX_URL = 2_048;
const MAX_LIST = 500;
const MAX_LANGUAGE_PATTERNS = 200;
const MAX_CONFIG_PROPERTIES = 2_000;
const MAX_ACTIVATION_EVENTS = 200;

const PUBLISHER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const LANGUAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SCOPE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+#-]{0,127}$/;

// ---------------------------------------------------------------------------
// Contribution shapes
// ---------------------------------------------------------------------------
export type UiThemeKind = 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';

export interface ThemeContribution {
  id?: string;
  label: string;
  /** Authoritative light/dark signal: theme files often omit their own `type`. */
  uiTheme: UiThemeKind;
  path: string;
}

export interface IconThemeContribution {
  id: string;
  label: string;
  path: string;
}

export interface SnippetContribution {
  /**
   * Omitted for a `.code-snippets` file, which is multi-language: each entry inside it
   * carries its own `scope` (PRD Ch. 29 SN-2). Requiring a language here dropped those
   * files entirely.
   */
  language?: string;
  path: string;
}

export interface KeybindingContribution {
  command: string;
  key: string;
  mac?: string;
  linux?: string;
  win?: string;
  when?: string;
}

export interface LanguageContribution {
  id: string;
  aliases?: string[];
  extensions?: string[];
  filenames?: string[];
  filenamePatterns?: string[];
  firstLine?: string;
  mimetypes?: string[];
  /** Path to the language-configuration JSON (brackets, comments, auto-closing). */
  configuration?: string;
}

export interface GrammarContribution {
  language?: string;
  scopeName: string;
  path: string;
  embeddedLanguages?: Record<string, string>;
  injectTo?: string[];
}

export interface CommandContribution {
  command: string;
  title: string;
  category?: string;
  enablement?: string;
}

export interface ConfigurationProperty {
  key: string;
  type?: string;
  description?: string;
  /** Present only when the manifest supplied one; `null` is a legitimate default. */
  hasDefault: boolean;
  default?: unknown;
  enum?: unknown[];
  scope?: string;
  deprecationMessage?: string;
}

export interface ConfigurationContribution {
  title?: string;
  order?: number;
  properties: ConfigurationProperty[];
}

export interface JsonValidationContribution {
  fileMatch: string[];
  url: string;
}

/**
 * `contributes.viewsContainers` (PRD Phase 5 §2).
 *
 * `location` is the key the container was declared under — `activitybar` or `panel`. Upstream
 * accepts nothing else, and a container in an unknown location has nowhere to be drawn.
 */
export interface ViewsContainerContribution {
  id: string;
  title: string;
  /** Packaged-relative icon path; SVG in practice. */
  icon?: string;
  location: 'activitybar' | 'panel';
}

/** One entry of `contributes.views`, plus the container id it was declared under. */
export interface ViewContribution {
  id: string;
  container: string;
  name: string;
  /** `tree` unless the manifest says `webview`; upstream defaults the same way. */
  type: 'tree' | 'webview';
  when?: string;
  icon?: string;
  contextualTitle?: string;
  visibility?: 'visible' | 'collapsed' | 'hidden';
  initialSize?: number;
}

/** One entry of `contributes.viewsWelcome`: what an empty view shows. */
export interface ViewWelcomeContribution {
  view: string;
  contents: string;
  when?: string;
  group?: string;
  enablement?: string;
}

/**
 * One entry of `contributes.menus`, carrying the menu id it was declared under.
 *
 * Flattened deliberately: upstream's shape is a record of arrays, but every consumer wants
 * "all items for this location", and a flat list with the location on each item is the shape
 * that both resolution and the `when`-change diff need.
 */
export interface MenuItemContribution {
  location: string;
  command?: string;
  submenu?: string;
  /** The `alt` command, shown when the user holds a modifier. */
  alt?: string;
  when?: string;
  /** `group@order`, as written. Split at resolution time. */
  group?: string;
}

/** `contributes.submenus`: a named menu another menu can nest. */
export interface SubmenuContribution {
  id: string;
  label: string;
  icon?: string;
}

export interface ManifestContributions {
  themes: ThemeContribution[];
  iconThemes: IconThemeContribution[];
  productIconThemes: IconThemeContribution[];
  snippets: SnippetContribution[];
  keybindings: KeybindingContribution[];
  languages: LanguageContribution[];
  grammars: GrammarContribution[];
  commands: CommandContribution[];
  configuration: ConfigurationContribution[];
  configurationDefaults: Record<string, unknown>;
  jsonValidation: JsonValidationContribution[];
  viewsContainers: ViewsContainerContribution[];
  views: ViewContribution[];
  viewsWelcome: ViewWelcomeContribution[];
  menus: MenuItemContribution[];
  submenus: SubmenuContribution[];
  /** Contribution points present in the manifest that this reader does not model. */
  unmodelled: string[];
}

export interface ManifestRepository {
  type?: string;
  url: string;
}

export interface VsCodeManifest {
  /** `publisher.name`, the identifier every VS Code surface uses. */
  id: string;
  publisher: string;
  name: string;
  version: string;
  displayName: string;
  description?: string;
  /** Raw `engines` map; `vscode` is the one that gates compatibility. */
  engines: Record<string, string>;
  categories: string[];
  keywords: string[];
  license?: string;
  homepage?: string;
  repository?: ManifestRepository;
  bugs?: string;
  sponsor?: string;
  qna?: string;
  /** Packaged-relative path to the extension icon, when it ships one. */
  icon?: string;
  preview: boolean;
  /** Present when the extension ships executable code for the desktop host. */
  main?: string;
  /** Present when it ships a web worker entry point. */
  browser?: string;
  activationEvents: string[];
  extensionDependencies: string[];
  extensionPack: string[];
  extensionKind: string[];
  /** `capabilities.untrustedWorkspaces.supported`, as declared. */
  untrustedWorkspaces?: 'limited' | boolean;
  contributes: ManifestContributions;
}

// ---------------------------------------------------------------------------
// Primitive coercion
// ---------------------------------------------------------------------------
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

function stringList(value: unknown, max: number, itemMax = MAX_IDENTIFIER): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const entry = text(item, itemMax);
    if (entry !== null) out.push(entry);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * A packaged-relative path that cannot escape the extension directory.
 *
 * Manifest paths routinely start with `./`, which is fine; anything absolute,
 * backslash-separated, or containing a `..` segment is refused outright. Rejecting
 * here means every downstream consumer receives a path it can safely join.
 */
export function safeRelativePath(value: unknown): string | null {
  const raw = text(value, MAX_PATH);
  if (raw === null) return null;
  const normalized = raw.replace(/^\.\//, '');
  if (normalized.length === 0) return null;
  if (normalized.includes('\\') || normalized.includes('\0')) return null;
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return null;
  if (normalized.split('/').some((segment) => segment === '..' || segment === '')) return null;
  return normalized;
}

function httpsUrl(value: unknown): string | null {
  const raw = text(value, MAX_URL);
  if (raw === null) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username !== '' || url.password !== '') return null;
    return url.href;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Contribution parsing
// ---------------------------------------------------------------------------
const UI_THEMES = new Set<UiThemeKind>(['vs', 'vs-dark', 'hc-black', 'hc-light']);

function parseThemes(value: unknown): ThemeContribution[] {
  if (!Array.isArray(value)) return [];
  const out: ThemeContribution[] = [];
  for (const item of value.slice(0, MAX_LIST)) {
    const entry = record(item);
    if (!entry) continue;
    const path = safeRelativePath(entry.path);
    if (path === null) continue;
    const rawUiTheme = text(entry.uiTheme, 32);
    // A theme with no declared `uiTheme` is treated as dark: that is VS Code's own
    // fallback, and guessing light would make text unreadable on a dark palette.
    const uiTheme: UiThemeKind =
      rawUiTheme !== null && UI_THEMES.has(rawUiTheme as UiThemeKind)
        ? (rawUiTheme as UiThemeKind)
        : 'vs-dark';
    const id = text(entry.id, MAX_IDENTIFIER);
    const label = text(entry.label, MAX_LABEL) ?? id ?? path;
    out.push({ ...(id !== null ? { id } : {}), label, uiTheme, path });
  }
  return out;
}

function parseIconThemes(value: unknown): IconThemeContribution[] {
  if (!Array.isArray(value)) return [];
  const out: IconThemeContribution[] = [];
  for (const item of value.slice(0, MAX_LIST)) {
    const entry = record(item);
    if (!entry) continue;
    const path = safeRelativePath(entry.path);
    const id = text(entry.id, MAX_IDENTIFIER);
    if (path === null || id === null) continue;
    out.push({ id, label: text(entry.label, MAX_LABEL) ?? id, path });
  }
  return out;
}

function parseSnippets(value: unknown): SnippetContribution[] {
  if (!Array.isArray(value)) return [];
  const out: SnippetContribution[] = [];
  for (const item of value.slice(0, MAX_LIST)) {
    const entry = record(item);
    if (!entry) continue;
    const path = safeRelativePath(entry.path);
    const language = text(entry.language, MAX_IDENTIFIER);
    if (path === null) continue;
    // A missing or malformed language is not fatal: the file may be a `.code-snippets`
    // bundle whose entries scope themselves.
    if (language !== null && LANGUAGE_ID_RE.test(language)) out.push({ language, path });
    else out.push({ path });
  }
  return out;
}

function parseKeybindings(value: unknown): KeybindingContribution[] {
  if (!Array.isArray(value)) return [];
  const out: KeybindingContribution[] = [];
  for (const item of value.slice(0, MAX_LIST)) {
    const entry = record(item);
    if (!entry) continue;
    const command = text(entry.command, MAX_IDENTIFIER);
    const key = text(entry.key, MAX_LABEL);
    if (command === null || key === null) continue;
    const mac = text(entry.mac, MAX_LABEL);
    const linux = text(entry.linux, MAX_LABEL);
    const win = text(entry.win, MAX_LABEL);
    const when = text(entry.when, MAX_DESCRIPTION);
    out.push({
      command,
      key,
      ...(mac !== null ? { mac } : {}),
      ...(linux !== null ? { linux } : {}),
      ...(win !== null ? { win } : {}),
      ...(when !== null ? { when } : {}),
    });
  }
  return out;
}

function parseLanguages(value: unknown): LanguageContribution[] {
  if (!Array.isArray(value)) return [];
  const out: LanguageContribution[] = [];
  for (const item of value.slice(0, MAX_LIST)) {
    const entry = record(item);
    if (!entry) continue;
    const id = text(entry.id, MAX_IDENTIFIER);
    if (id === null || !LANGUAGE_ID_RE.test(id)) continue;
    const aliases = stringList(entry.aliases, MAX_LANGUAGE_PATTERNS, MAX_LABEL);
    const extensions = stringList(entry.extensions, MAX_LANGUAGE_PATTERNS);
    const filenames = stringList(entry.filenames, MAX_LANGUAGE_PATTERNS, MAX_PATH);
    const filenamePatterns = stringList(entry.filenamePatterns, MAX_LANGUAGE_PATTERNS, MAX_PATH);
    const mimetypes = stringList(entry.mimetypes, MAX_LANGUAGE_PATTERNS);
    const firstLine = text(entry.firstLine, MAX_DESCRIPTION);
    const configuration = safeRelativePath(entry.configuration);
    out.push({
      id,
      ...(aliases.length > 0 ? { aliases } : {}),
      ...(extensions.length > 0 ? { extensions } : {}),
      ...(filenames.length > 0 ? { filenames } : {}),
      ...(filenamePatterns.length > 0 ? { filenamePatterns } : {}),
      ...(mimetypes.length > 0 ? { mimetypes } : {}),
      ...(firstLine !== null ? { firstLine } : {}),
      ...(configuration !== null ? { configuration } : {}),
    });
  }
  return out;
}

function parseGrammars(value: unknown): GrammarContribution[] {
  if (!Array.isArray(value)) return [];
  const out: GrammarContribution[] = [];
  for (const item of value.slice(0, MAX_LIST)) {
    const entry = record(item);
    if (!entry) continue;
    const scopeName = text(entry.scopeName, MAX_IDENTIFIER);
    const path = safeRelativePath(entry.path);
    if (scopeName === null || path === null || !SCOPE_NAME_RE.test(scopeName)) continue;
    const language = text(entry.language, MAX_IDENTIFIER);
    const embedded = record(entry.embeddedLanguages);
    const embeddedLanguages: Record<string, string> = {};
    if (embedded) {
      for (const [scope, languageId] of Object.entries(embedded).slice(0, MAX_LANGUAGE_PATTERNS)) {
        const mapped = text(languageId, MAX_IDENTIFIER);
        const scopeKey = text(scope, MAX_IDENTIFIER);
        if (mapped !== null && scopeKey !== null) embeddedLanguages[scopeKey] = mapped;
      }
    }
    const injectTo = stringList(entry.injectTo, MAX_LANGUAGE_PATTERNS);
    out.push({
      ...(language !== null && LANGUAGE_ID_RE.test(language) ? { language } : {}),
      scopeName,
      path,
      ...(Object.keys(embeddedLanguages).length > 0 ? { embeddedLanguages } : {}),
      ...(injectTo.length > 0 ? { injectTo } : {}),
    });
  }
  return out;
}

function parseCommands(value: unknown): CommandContribution[] {
  if (!Array.isArray(value)) return [];
  const out: CommandContribution[] = [];
  for (const item of value.slice(0, MAX_LIST)) {
    const entry = record(item);
    if (!entry) continue;
    const command = text(entry.command, MAX_IDENTIFIER);
    if (command === null) continue;
    // `title` may be a localizable object; only a plain string is usable here.
    const title = text(entry.title, MAX_LABEL) ?? command;
    const category = text(entry.category, MAX_LABEL);
    const enablement = text(entry.enablement, MAX_DESCRIPTION);
    out.push({
      command,
      title,
      ...(category !== null ? { category } : {}),
      ...(enablement !== null ? { enablement } : {}),
    });
  }
  return out;
}

function parseConfigurationBlock(value: unknown, budget: { left: number }): ConfigurationContribution | null {
  const entry = record(value);
  if (!entry) return null;
  const properties: ConfigurationProperty[] = [];
  const declared = record(entry.properties);
  if (declared) {
    for (const [key, rawProperty] of Object.entries(declared)) {
      if (budget.left <= 0) break;
      const propertyKey = text(key, MAX_IDENTIFIER);
      const property = record(rawProperty);
      if (propertyKey === null || !property) continue;
      budget.left -= 1;
      const type = text(property.type, 32);
      const description =
        text(property.markdownDescription, MAX_DESCRIPTION) ??
        text(property.description, MAX_DESCRIPTION);
      const scope = text(property.scope, 64);
      const deprecationMessage = text(property.deprecationMessage, MAX_DESCRIPTION);
      const hasDefault = Object.hasOwn(property, 'default');
      properties.push({
        key: propertyKey,
        ...(type !== null ? { type } : {}),
        ...(description !== null ? { description } : {}),
        hasDefault,
        ...(hasDefault ? { default: property.default } : {}),
        ...(Array.isArray(property.enum) ? { enum: property.enum.slice(0, MAX_LIST) } : {}),
        ...(scope !== null ? { scope } : {}),
        ...(deprecationMessage !== null ? { deprecationMessage } : {}),
      });
    }
  }
  const title = text(entry.title, MAX_LABEL);
  const order = typeof entry.order === 'number' && Number.isFinite(entry.order) ? entry.order : null;
  if (properties.length === 0 && title === null) return null;
  return {
    ...(title !== null ? { title } : {}),
    ...(order !== null ? { order } : {}),
    properties,
  };
}

function parseConfiguration(value: unknown): ConfigurationContribution[] {
  const budget = { left: MAX_CONFIG_PROPERTIES };
  const blocks = Array.isArray(value) ? value.slice(0, MAX_LIST) : [value];
  const out: ConfigurationContribution[] = [];
  for (const block of blocks) {
    const parsed = parseConfigurationBlock(block, budget);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseJsonValidation(value: unknown): JsonValidationContribution[] {
  if (!Array.isArray(value)) return [];
  const out: JsonValidationContribution[] = [];
  for (const item of value.slice(0, MAX_LIST)) {
    const entry = record(item);
    if (!entry) continue;
    const fileMatch =
      typeof entry.fileMatch === 'string'
        ? stringList([entry.fileMatch], 1, MAX_PATH)
        : stringList(entry.fileMatch, MAX_LANGUAGE_PATTERNS, MAX_PATH);
    if (fileMatch.length === 0) continue;
    // The schema may be packaged (`./schema.json`) or remote (`https://...`).
    const relative = safeRelativePath(entry.url);
    const remote = httpsUrl(entry.url);
    const url = relative ?? remote;
    if (url === null) continue;
    out.push({ fileMatch, url });
  }
  return out;
}

/** Views are declared per container: `{ "explorer": [...], "myContainer": [...] }`. */
function parseViews(value: unknown): ViewContribution[] {
  const entry = record(value);
  if (!entry) return [];
  const out: ViewContribution[] = [];
  for (const [rawContainer, rawViews] of Object.entries(entry)) {
    const container = text(rawContainer, MAX_IDENTIFIER);
    if (container === null || !Array.isArray(rawViews)) continue;
    for (const item of rawViews.slice(0, MAX_LIST)) {
      if (out.length >= MAX_LIST) return out;
      const view = record(item);
      if (!view) continue;
      const id = text(view.id, MAX_IDENTIFIER);
      if (id === null) continue;
      const name = text(view.name, MAX_LABEL) ?? id;
      const when = text(view.when, MAX_DESCRIPTION);
      const icon = safeRelativePath(view.icon);
      const contextualTitle = text(view.contextualTitle, MAX_LABEL);
      const visibility = view.visibility;
      const initialSize = view.initialSize;
      out.push({
        id,
        container,
        name,
        type: view.type === 'webview' ? 'webview' : 'tree',
        ...(when !== null ? { when } : {}),
        ...(icon !== null ? { icon } : {}),
        ...(contextualTitle !== null ? { contextualTitle } : {}),
        ...(visibility === 'collapsed' || visibility === 'hidden' || visibility === 'visible'
          ? { visibility }
          : {}),
        ...(typeof initialSize === 'number' && Number.isFinite(initialSize) && initialSize > 0
          ? { initialSize: Math.min(4_000, Math.round(initialSize)) }
          : {}),
      });
    }
  }
  return out;
}

/** Containers are declared per location: `{ "activitybar": [...], "panel": [...] }`. */
function parseViewsContainers(value: unknown): ViewsContainerContribution[] {
  const entry = record(value);
  if (!entry) return [];
  const out: ViewsContainerContribution[] = [];
  for (const location of ['activitybar', 'panel'] as const) {
    const declared = entry[location];
    if (!Array.isArray(declared)) continue;
    for (const item of declared.slice(0, MAX_LIST)) {
      if (out.length >= MAX_LIST) return out;
      const container = record(item);
      if (!container) continue;
      const id = text(container.id, MAX_IDENTIFIER);
      if (id === null) continue;
      const icon = safeRelativePath(container.icon);
      out.push({
        id,
        title: text(container.title, MAX_LABEL) ?? id,
        ...(icon !== null ? { icon } : {}),
        location,
      });
    }
  }
  return out;
}

function parseViewsWelcome(value: unknown): ViewWelcomeContribution[] {
  if (!Array.isArray(value)) return [];
  const out: ViewWelcomeContribution[] = [];
  for (const item of value.slice(0, MAX_LIST)) {
    const entry = record(item);
    if (!entry) continue;
    const view = text(entry.view, MAX_IDENTIFIER);
    const contents = text(entry.contents, MAX_DESCRIPTION);
    if (view === null || contents === null) continue;
    const when = text(entry.when, MAX_DESCRIPTION);
    const group = text(entry.group, MAX_IDENTIFIER);
    const enablement = text(entry.enablement, MAX_DESCRIPTION);
    out.push({
      view,
      contents,
      ...(when !== null ? { when } : {}),
      ...(group !== null ? { group } : {}),
      ...(enablement !== null ? { enablement } : {}),
    });
  }
  return out;
}

/**
 * `contributes.menus`, flattened to one list.
 *
 * An item with neither `command` nor `submenu` is dropped: there is nothing for it to do, and
 * a menu row that does nothing when clicked is worse than a missing row.
 */
function parseMenus(value: unknown): MenuItemContribution[] {
  const entry = record(value);
  if (!entry) return [];
  const out: MenuItemContribution[] = [];
  for (const [rawLocation, rawItems] of Object.entries(entry)) {
    const location = text(rawLocation, MAX_IDENTIFIER);
    if (location === null || !Array.isArray(rawItems)) continue;
    for (const item of rawItems.slice(0, MAX_LIST)) {
      if (out.length >= MAX_CONFIG_PROPERTIES) return out;
      const declared = record(item);
      if (!declared) continue;
      const command = text(declared.command, MAX_IDENTIFIER);
      const submenu = text(declared.submenu, MAX_IDENTIFIER);
      if (command === null && submenu === null) continue;
      const alt = text(declared.alt, MAX_IDENTIFIER);
      const when = text(declared.when, MAX_DESCRIPTION);
      const group = text(declared.group, MAX_LABEL);
      out.push({
        location,
        ...(command !== null ? { command } : {}),
        ...(submenu !== null ? { submenu } : {}),
        ...(alt !== null ? { alt } : {}),
        ...(when !== null ? { when } : {}),
        ...(group !== null ? { group } : {}),
      });
    }
  }
  return out;
}

function parseSubmenus(value: unknown): SubmenuContribution[] {
  if (!Array.isArray(value)) return [];
  const out: SubmenuContribution[] = [];
  for (const item of value.slice(0, MAX_LIST)) {
    const entry = record(item);
    if (!entry) continue;
    const id = text(entry.id, MAX_IDENTIFIER);
    if (id === null) continue;
    const icon = safeRelativePath(entry.icon);
    out.push({
      id,
      label: text(entry.label, MAX_LABEL) ?? id,
      ...(icon !== null ? { icon } : {}),
    });
  }
  return out;
}

/** Contribution points this reader models. Anything else is recorded as unmodelled. */
const MODELLED_POINTS = new Set([
  'themes',
  'iconThemes',
  'productIconThemes',
  'snippets',
  'keybindings',
  'languages',
  'grammars',
  'commands',
  'configuration',
  'configurationDefaults',
  'jsonValidation',
  'viewsContainers',
  'views',
  'viewsWelcome',
  'menus',
  'submenus',
]);

function parseContributes(value: unknown): ManifestContributions {
  const entry = record(value) ?? {};
  const defaults = record(entry.configurationDefaults) ?? {};
  const configurationDefaults: Record<string, unknown> = {};
  for (const [key, defaultValue] of Object.entries(defaults).slice(0, MAX_CONFIG_PROPERTIES)) {
    const settingKey = text(key, MAX_IDENTIFIER);
    if (settingKey !== null) configurationDefaults[settingKey] = defaultValue;
  }
  return {
    themes: parseThemes(entry.themes),
    iconThemes: parseIconThemes(entry.iconThemes),
    productIconThemes: parseIconThemes(entry.productIconThemes),
    snippets: parseSnippets(entry.snippets),
    keybindings: parseKeybindings(entry.keybindings),
    languages: parseLanguages(entry.languages),
    grammars: parseGrammars(entry.grammars),
    commands: parseCommands(entry.commands),
    configuration: parseConfiguration(entry.configuration),
    configurationDefaults,
    jsonValidation: parseJsonValidation(entry.jsonValidation),
    viewsContainers: parseViewsContainers(entry.viewsContainers),
    views: parseViews(entry.views),
    viewsWelcome: parseViewsWelcome(entry.viewsWelcome),
    menus: parseMenus(entry.menus),
    submenus: parseSubmenus(entry.submenus),
    unmodelled: Object.keys(entry)
      .filter((key) => !MODELLED_POINTS.has(key))
      .slice(0, MAX_LIST)
      .sort(),
  };
}

function parseRepository(value: unknown): ManifestRepository | null {
  if (typeof value === 'string') {
    const url = text(value, MAX_URL);
    return url === null ? null : { url };
  }
  const entry = record(value);
  if (!entry) return null;
  const url = text(entry.url, MAX_URL);
  if (url === null) return null;
  const type = text(entry.type, 32);
  return { ...(type !== null ? { type } : {}), url };
}

function parseBugs(value: unknown): string | null {
  if (typeof value === 'string') return httpsUrl(value);
  const entry = record(value);
  return entry ? httpsUrl(entry.url) : null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export type ManifestParseResult =
  | { ok: true; manifest: VsCodeManifest }
  | { ok: false; errors: string[] };

/**
 * Parse and normalize a VS Code extension manifest.
 *
 * Only the three fields that give an extension its identity are fatal — without
 * publisher, name and a well-formed version there is nothing to install, no directory
 * to name, and no way to compare versions for updates. Everything else degrades: a
 * malformed contribution is dropped and the rest of the extension still works, which
 * is how VS Code itself behaves.
 */
export function parseVsCodeManifest(raw: unknown): ManifestParseResult {
  const entry = record(raw);
  if (!entry) return { ok: false, errors: ['The manifest is not a JSON object.'] };

  const errors: string[] = [];
  const publisher = text(entry.publisher, MAX_IDENTIFIER);
  const name = text(entry.name, MAX_IDENTIFIER);
  const version = text(entry.version, 64);

  if (publisher === null || !PUBLISHER_RE.test(publisher)) {
    errors.push('The manifest does not declare a valid `publisher`.');
  }
  if (name === null || !NAME_RE.test(name)) {
    errors.push('The manifest does not declare a valid `name`.');
  }
  if (version === null || !VERSION_RE.test(version)) {
    errors.push('The manifest does not declare a valid semver `version`.');
  }
  if (errors.length > 0 || publisher === null || name === null || version === null) {
    return { ok: false, errors };
  }

  const engines: Record<string, string> = {};
  const rawEngines = record(entry.engines);
  if (rawEngines) {
    for (const [engine, range] of Object.entries(rawEngines).slice(0, 20)) {
      const engineKey = text(engine, 32);
      const rangeText = text(range, MAX_IDENTIFIER);
      if (engineKey !== null && rangeText !== null) engines[engineKey] = rangeText;
    }
  }

  const capabilities = record(entry.capabilities);
  const untrusted = record(capabilities?.untrustedWorkspaces);
  const untrustedSupported = untrusted?.supported;

  const description = text(entry.description, MAX_DESCRIPTION);
  const license = text(entry.license, MAX_IDENTIFIER);
  const homepage = httpsUrl(entry.homepage);
  const repository = parseRepository(entry.repository);
  const bugs = parseBugs(entry.bugs);
  const sponsor = httpsUrl(record(entry.sponsor)?.url);
  const qna = typeof entry.qna === 'string' ? httpsUrl(entry.qna) : null;
  const icon = safeRelativePath(entry.icon);
  const main = safeRelativePath(entry.main);
  const browser = safeRelativePath(entry.browser);

  return {
    ok: true,
    manifest: {
      id: extensionIdOf(publisher, name),
      publisher,
      name,
      version,
      displayName: text(entry.displayName, MAX_LABEL) ?? name,
      ...(description !== null ? { description } : {}),
      engines,
      categories: stringList(entry.categories, 50, MAX_LABEL),
      keywords: stringList(entry.keywords, 50, MAX_LABEL),
      ...(license !== null ? { license } : {}),
      ...(homepage !== null ? { homepage } : {}),
      ...(repository !== null ? { repository } : {}),
      ...(bugs !== null ? { bugs } : {}),
      ...(sponsor !== null ? { sponsor } : {}),
      ...(qna !== null ? { qna } : {}),
      ...(icon !== null ? { icon } : {}),
      preview: entry.preview === true,
      ...(main !== null ? { main } : {}),
      ...(browser !== null ? { browser } : {}),
      activationEvents: stringList(entry.activationEvents, MAX_ACTIVATION_EVENTS, MAX_LABEL),
      extensionDependencies: stringList(entry.extensionDependencies, MAX_LIST),
      extensionPack: stringList(entry.extensionPack, MAX_LIST),
      extensionKind: stringList(entry.extensionKind, 10, 32),
      ...(untrustedSupported === true || untrustedSupported === false || untrustedSupported === 'limited'
        ? { untrustedWorkspaces: untrustedSupported }
        : {}),
      contributes: parseContributes(entry.contributes),
    },
  };
}

/** The canonical `publisher.name` identifier, lowercased as VS Code compares it. */
export function extensionIdOf(publisher: string, name: string): string {
  return `${publisher}.${name}`.toLowerCase();
}

// ---------------------------------------------------------------------------
// Capability reporting
// ---------------------------------------------------------------------------
/**
 * Contribution points AXIOM honours without running extension code.
 *
 * `commands` is deliberately absent: a command can be *declared* and listed, but
 * invoking it runs the extension's JavaScript, so it is reported as inert.
 */
const DECLARATIVE_POINTS = [
  'themes',
  'iconThemes',
  'productIconThemes',
  'snippets',
  'keybindings',
  'languages',
  'grammars',
  'configuration',
  'configurationDefaults',
  'jsonValidation',
  // Phase 5: a container, a view, its welcome content and a menu row are all drawn from the
  // manifest alone. What still needs the host is the *content* of a tree view, which is why
  // `views` counts as declarative here while a tree with no running provider shows its
  // welcome content instead of rows.
  'viewsContainers',
  'views',
  'viewsWelcome',
  'menus',
  'submenus',
] as const;

export type ActivationRequirement = 'declarative' | 'requires-host';

export interface CapabilityReport {
  /** Contribution points AXIOM applies for real, with how many of each. */
  supported: Array<{ point: string; count: number }>;
  /** Points present in the manifest that need executable activation to do anything. */
  inert: Array<{ point: string; count: number }>;
  /** Whether the extension ships code that must run to deliver its features. */
  activation: ActivationRequirement;
  /** True when at least one contribution works today. */
  usableNow: boolean;
}

function countOf(contributes: ManifestContributions, point: string): number {
  switch (point) {
    case 'themes':
      return contributes.themes.length;
    case 'iconThemes':
      return contributes.iconThemes.length;
    case 'productIconThemes':
      return contributes.productIconThemes.length;
    case 'snippets':
      return contributes.snippets.length;
    case 'keybindings':
      return contributes.keybindings.length;
    case 'languages':
      return contributes.languages.length;
    case 'grammars':
      return contributes.grammars.length;
    case 'commands':
      return contributes.commands.length;
    case 'configuration':
      return contributes.configuration.length;
    case 'configurationDefaults':
      return Object.keys(contributes.configurationDefaults).length;
    case 'jsonValidation':
      return contributes.jsonValidation.length;
    case 'viewsContainers':
      return contributes.viewsContainers.length;
    case 'views':
      return contributes.views.length;
    case 'viewsWelcome':
      return contributes.viewsWelcome.length;
    case 'menus':
      return contributes.menus.length;
    case 'submenus':
      return contributes.submenus.length;
    default:
      return 0;
  }
}

/**
 * Describe what an installed extension will and will not do in AXIOM.
 *
 * This is the honest half of the extension story: the manager shows it verbatim so a
 * user installing a language-server extension learns up front that its themes apply
 * and its commands do not, rather than filing a bug about it later.
 */
export function reportCapabilities(manifest: VsCodeManifest): CapabilityReport {
  const supported: Array<{ point: string; count: number }> = [];
  const inert: Array<{ point: string; count: number }> = [];
  for (const point of DECLARATIVE_POINTS) {
    const count = countOf(manifest.contributes, point);
    if (count > 0) supported.push({ point, count });
  }
  if (manifest.contributes.commands.length > 0) {
    inert.push({ point: 'commands', count: manifest.contributes.commands.length });
  }
  for (const point of manifest.contributes.unmodelled) {
    inert.push({ point, count: 1 });
  }
  const needsCode = manifest.main !== undefined || manifest.browser !== undefined;
  return {
    supported,
    inert,
    activation: needsCode ? 'requires-host' : 'declarative',
    usableNow: supported.length > 0,
  };
}

export interface CompatibilityReport {
  /** null when `engines.vscode` is absent or uses grammar we do not evaluate. */
  engineSatisfied: boolean | null;
  declaredRange: string | null;
  /** Lowest API level the extension accepts, for the "needs newer" message. */
  minimumApiVersion: string | null;
  /** A sentence fit to show the user, never a raw range. */
  summary: string;
}

/** Evaluate `engines.vscode` against the API level AXIOM implements. */
export function reportCompatibility(
  manifest: VsCodeManifest,
  apiVersion: string = AXIOM_VSCODE_API_VERSION,
): CompatibilityReport {
  const declaredRange = manifest.engines.vscode ?? null;
  if (declaredRange === null) {
    return {
      engineSatisfied: null,
      declaredRange: null,
      minimumApiVersion: null,
      summary: 'This extension does not declare which editor version it needs.',
    };
  }
  const satisfied = satisfiesRange(apiVersion, declaredRange);
  const minimum = minimumForRange(declaredRange);
  if (satisfied === null) {
    return {
      engineSatisfied: null,
      declaredRange,
      minimumApiVersion: minimum,
      summary: `This extension declares an editor requirement AXIOM cannot evaluate (${declaredRange}).`,
    };
  }
  return {
    engineSatisfied: satisfied,
    declaredRange,
    minimumApiVersion: minimum,
    summary: satisfied
      ? 'Compatible with this version of AXIOM.'
      : `Needs a newer editor API than AXIOM provides${minimum ? ` (${minimum} or later)` : ''}.`,
  };
}
