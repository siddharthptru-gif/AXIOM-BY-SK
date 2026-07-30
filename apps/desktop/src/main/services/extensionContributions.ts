import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { rootLogger } from '@axiom/shared';
import {
  convertVsCodeTheme,
  mergeIncludedTheme,
  type ConvertedTheme,
} from '../../common/vscodeTheme';
import type { VsCodeManifest } from '../../common/vscodeManifest';
import {
  contributionKey,
  type ContributedGrammarSource,
  type ContributedSnippet,
  type ExtensionContributionCatalog,
  type IconThemeDefinition,
  type LanguageConfiguration,
} from '../../common/contributions';
import { installedExtensionDetail, listInstalledExtensions } from './marketplaceExtensions';
import { normalizeSnippetFile, snippetsForLanguage } from '../../common/snippetFiles';
import {
  attributeKeybindings,
  compileExtensionKeybindings,
  normalizeKeybindingChord,
  platformChordOf,
  type DropReason,
  type KeybindingPlatform,
} from '../../common/extensionKeybindings';

/**
 * Declarative contribution loading.
 *
 * Installed extensions contribute data — colour themes, icon themes, snippets,
 * keybindings, language configurations, settings schemas. This module turns that data
 * into something the renderer can apply, and it is the only place that reads a file out
 * of an extension directory.
 *
 * Three things are handled here that are easy to get wrong:
 *
 *   1. **These files are JSONC, not JSON.** VS Code theme, snippet and
 *      language-configuration files routinely carry comments and trailing commas, and
 *      `JSON.parse` rejects a large fraction of real themes. Microsoft's own
 *      `jsonc-parser` is used, so what AXIOM accepts is what VS Code accepts.
 *   2. **`include` chains.** Most theme families ship a base file plus a thin override.
 *      A converter that ignores `include` produces a theme missing most of its colours,
 *      so the chain is followed (to a bounded depth) and merged.
 *   3. **Containment.** Every path comes from an extension's manifest, which is
 *      attacker-controlled. Each read resolves through `realpath` and must land inside
 *      the extension's own directory, so a crafted `"path": "..."` cannot read the user's
 *      files even if it survives manifest validation.
 *
 * Nothing here executes extension code.
 */
const log = rootLogger.child('extension-contributions');

/** The host platform, in the form the keybinding policy expects (PRD Ch. 25). */
function keybindingPlatform(): KeybindingPlatform {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'win';
  return 'linux';
}

/** Largest contribution file AXIOM will read. Big themes are ~200 KB. */
const MAX_CONTRIBUTION_BYTES = 4 * 1024 * 1024;
/** `include` chains longer than this are a loop or an abuse, not a theme family. */
const MAX_INCLUDE_DEPTH = 8;
/** Icon definitions per theme. Large sets run to a couple of thousand entries. */
const MAX_ICON_DEFINITIONS = 4_000;
/** Total inlined icon payload for one theme, bounding the IPC message and renderer memory. */
const MAX_ICON_PAYLOAD_BYTES = 12 * 1024 * 1024;
/** A single icon larger than this is not an icon. */
const MAX_SINGLE_ICON_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Bounded, contained file reads
// ---------------------------------------------------------------------------
/**
 * Resolve a declared path to a real file, refusing anything outside the extension.
 *
 * The containment boundary is the extension directory; `baseDirectory` is only the point
 * the path is resolved *from*. That distinction matters and was learned the hard way:
 * icon themes legitimately declare paths like `../../icons/file_type_js.svg`, because the
 * theme JSON sits in a build output directory and the icons live at the package root.
 * Forbidding `..` outright — correct for a manifest path, which is always root-relative —
 * silently produced icon themes with a full set of filename mappings and no icons.
 *
 * So relative navigation is allowed and the boundary is enforced after resolution, on the
 * canonical path. `realpath` also collapses any symlink that might otherwise have pointed
 * out of the package.
 *
 * Returns null rather than throwing: one bad contribution path must degrade that
 * contribution and leave the rest of the extension working.
 */
async function resolveContained(
  extensionDirectory: string,
  baseDirectory: string,
  declaredPath: string,
): Promise<string | null> {
  if (typeof declaredPath !== 'string' || declaredPath.length === 0) return null;
  if (declaredPath.includes('\0') || declaredPath.includes('\\')) return null;
  if (isAbsolute(declaredPath) || /^[A-Za-z]:/.test(declaredPath)) return null;
  const normalized = declaredPath.replace(/^\.\//, '');
  if (normalized.length === 0 || normalized.length > 1_024) return null;
  try {
    const root = await realpath(extensionDirectory);
    const target = await realpath(join(baseDirectory, ...normalized.split('/')));
    const rel = relative(root, target);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
    const stats = await stat(target);
    if (!stats.isFile() || stats.size > MAX_CONTRIBUTION_BYTES) return null;
    return target;
  } catch {
    return null;
  }
}

/**
 * Read and parse a contribution file as JSONC.
 *
 * Parse errors are logged and reported as null. `jsonc-parser` recovers from many of
 * them and still returns a value; a value is accepted when one is produced, because a
 * theme with one malformed rule is still a usable theme and refusing it would be
 * stricter than VS Code.
 */
async function readJsonc(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch {
    return null;
  }
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(text.replace(/^\uFEFF/, ''), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    log.info('A contribution file had recoverable syntax problems', {
      path,
      problems: errors.length,
    });
  }
  return value ?? null;
}

// ---------------------------------------------------------------------------
// Aggregated contribution catalog
// ---------------------------------------------------------------------------
function emptyCatalog(): ExtensionContributionCatalog {
  return {
    themes: [],
    iconThemes: [],
    keybindings: [],
    languages: [],
    settings: [],
    commands: [],
    grammars: [],
    configurationDefaults: {},
    snippetLanguages: [],
    inert: [],
  };
}

/**
 * The selection key for a contributed theme.
 *
 * Delegates to the shared derivation so Main and the renderer cannot drift: the renderer
 * persists this string and hands it back later to load the theme.
 */
const themeKey = contributionKey;

interface LoadedExtension {
  id: string;
  displayName: string;
  directory: string;
  manifest: VsCodeManifest;
}

/**
 * Every enabled extension, with its manifest and directory.
 *
 * Disabled extensions are excluded here rather than filtered later, so a disabled theme
 * genuinely disappears from the picker instead of being offered and then failing.
 */
async function loadEnabledExtensions(workspaceRoot: string | null): Promise<LoadedExtension[]> {
  const installed = await listInstalledExtensions(workspaceRoot);
  const enabled = installed.filter((extension) => extension.enabled);
  const loaded: LoadedExtension[] = [];
  for (const extension of enabled) {
    try {
      const detail = await installedExtensionDetail(extension.id, workspaceRoot);
      loaded.push({
        id: detail.id,
        displayName: detail.displayName,
        directory: detail.directory,
        manifest: detail.manifest,
      });
    } catch (error) {
      log.warn('An enabled extension could not be read', {
        id: extension.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return loaded;
}

/**
 * Build the catalog of everything installed extensions contribute.
 *
 * Theme and snippet *bodies* are not loaded here — only their identities. Reading every
 * theme file of every installed extension on startup would cost hundreds of file reads to
 * populate a picker the user may never open, so bodies load when something is selected.
 */
export async function buildContributionCatalog(
  workspaceRoot: string | null,
): Promise<ExtensionContributionCatalog> {
  const extensions = await loadEnabledExtensions(workspaceRoot);
  const catalog = emptyCatalog();
  const snippetCounts = new Map<string, number>();

  for (const extension of extensions) {
    const contributes = extension.manifest.contributes;

    for (const theme of contributes.themes) {
      catalog.themes.push({
        key: themeKey(extension.id, theme.id ?? null, theme.label),
        extensionId: extension.id,
        extensionName: extension.displayName,
        id: theme.id ?? null,
        label: theme.label,
        kind: theme.uiTheme === 'vs' || theme.uiTheme === 'hc-light' ? 'light' : 'dark',
      });
    }

    for (const iconTheme of contributes.iconThemes) {
      catalog.iconThemes.push({
        key: themeKey(extension.id, iconTheme.id, iconTheme.label),
        extensionId: extension.id,
        extensionName: extension.displayName,
        id: iconTheme.id,
        label: iconTheme.label,
      });
    }

    // KB-10/KB-11: policy is decided by the shared compiler so the catalog, the Keyboard
    // Shortcuts editor and dispatch cannot disagree. The displayed `key` stays the raw
    // manifest string — normalizing it here would change what the UI has always shown.
    const compiledBindings = compileExtensionKeybindings(
      contributes.keybindings.map((binding) => ({
        ...binding,
        extensionId: extension.id,
        extensionName: extension.displayName,
      })),
      { platform: keybindingPlatform() },
    );
    const rejectedBindings = new Map<string, DropReason>();
    for (const drop of compiledBindings.dropped) {
      rejectedBindings.set(`${drop.command}\u0000${drop.chord}`, drop.reason);
      log.warn('extension keybinding ignored', {
        extensionId: extension.id,
        command: drop.command,
        reason: drop.reason,
        message: drop.message,
      });
    }
    const bindingAttribution = new Map(
      attributeKeybindings(compiledBindings.rules).map((entry) => [entry.command, entry]),
    );
    for (const binding of contributes.keybindings) {
      const raw = platformChordOf({ ...binding, extensionId: extension.id }, keybindingPlatform());
      const chord = normalizeKeybindingChord(raw);
      const rejected = rejectedBindings.get(`${binding.command}\u0000${chord ?? raw ?? ''}`);
      catalog.keybindings.push({
        extensionId: extension.id,
        extensionName: extension.displayName,
        command: binding.command,
        key: binding.win ?? binding.key,
        when: binding.when ?? null,
        // A keybinding is only useful if its command can run, which needs the host.
        active: false,
        overridesDefault: bindingAttribution.get(binding.command)?.overridesDefault ?? false,
        ...(rejected !== undefined ? { rejected } : {}),
      });
    }

    for (const language of contributes.languages) {
      const configuration =
        language.configuration === undefined
          ? null
          : await loadLanguageConfiguration(extension.directory, language.configuration);
      catalog.languages.push({
        extensionId: extension.id,
        id: language.id,
        aliases: language.aliases ?? [],
        extensions: language.extensions ?? [],
        filenames: language.filenames ?? [],
        configuration,
      });
    }

    for (const grammar of contributes.grammars) {
      const path = await resolveContained(extension.directory, extension.directory, grammar.path);
      if (path === null) continue;
      catalog.grammars.push({
        extensionId: extension.id,
        language: grammar.language ?? null,
        scopeName: grammar.scopeName,
        path,
      });
    }

    for (const block of contributes.configuration) {
      for (const property of block.properties) {
        catalog.settings.push({
          extensionId: extension.id,
          extensionName: extension.displayName,
          key: property.key,
          type: property.type ?? null,
          description: property.description ?? null,
          hasDefault: property.hasDefault,
          default: property.hasDefault ? property.default : undefined,
          enum: property.enum ?? null,
        });
      }
    }

    for (const [key, value] of Object.entries(contributes.configurationDefaults)) {
      catalog.configurationDefaults[key] = value;
    }

    for (const command of contributes.commands) {
      catalog.commands.push({
        extensionId: extension.id,
        extensionName: extension.displayName,
        command: command.command,
        title: command.title,
        category: command.category ?? null,
        // Invocable when the extension ships an entry point, because that is what a command
        // needs to exist at runtime: the extension host registers the handler during
        // activation. A command declared by an extension with no `main` has nothing behind it
        // and is still listed — declared and unrunnable is a real state, and hiding it would
        // make the manifest and the palette disagree.
        invocable:
          typeof extension.manifest.main === 'string' && extension.manifest.main.length > 0,
      });
    }

    for (const snippet of contributes.snippets) {
      // A `.code-snippets` bundle declares no language; its scopes are only known once the
      // file is read, so it contributes no per-language count here.
      if (snippet.language === undefined) continue;
      snippetCounts.set(snippet.language, (snippetCounts.get(snippet.language) ?? 0) + 1);
    }

    // Everything this extension declares that will not act. `commands` and `keybindings`
    // are modelled and listed, but invoking either runs extension code, so they belong
    // here alongside the points AXIOM does not model at all.
    const inertPoints = [
      ...(contributes.commands.length > 0 ? ['commands'] : []),
      ...(contributes.keybindings.length > 0 ? ['keybindings'] : []),
      ...contributes.unmodelled,
    ];
    if (inertPoints.length > 0) {
      catalog.inert.push({
        extensionId: extension.id,
        extensionName: extension.displayName,
        points: inertPoints,
      });
    }
  }

  catalog.snippetLanguages = [...snippetCounts.entries()]
    .map(([language, count]) => ({ language, count }))
    .sort((a, b) => a.language.localeCompare(b.language));
  catalog.themes.sort((a, b) => a.label.localeCompare(b.label));
  catalog.iconThemes.sort((a, b) => a.label.localeCompare(b.label));
  return catalog;
}

// ---------------------------------------------------------------------------
// Theme loading
// ---------------------------------------------------------------------------
/**
 * Load a contributed colour theme, following its `include` chain.
 *
 * The chain is walked from the child outward, then merged base-first so the child's values
 * win. Depth is bounded, which also terminates a file that includes itself.
 */
export async function loadContributedTheme(
  key: string,
  workspaceRoot: string | null,
): Promise<ConvertedTheme | null> {
  const extensions = await loadEnabledExtensions(workspaceRoot);
  for (const extension of extensions) {
    for (const theme of extension.manifest.contributes.themes) {
      if (themeKey(extension.id, theme.id ?? null, theme.label) !== key) continue;
      const chain: unknown[] = [];
      let relativePath: string | null = theme.path;
      let currentDirectory = extension.directory;
      for (let depth = 0; depth < MAX_INCLUDE_DEPTH && relativePath !== null; depth += 1) {
        const path = await resolveContained(extension.directory, currentDirectory, relativePath);
        if (path === null) break;
        const parsed = await readJsonc(path);
        if (parsed === null) break;
        chain.push(parsed);
        const record =
          typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
        const include = typeof record.include === 'string' ? record.include : null;
        if (include === null) break;
        // An `include` is relative to the file that declares it, not to the extension
        // root, so the search directory moves with the chain.
        currentDirectory = dirname(path);
        relativePath = include;
      }
      if (chain.length === 0) return null;
      // Merge outermost base first so the originally-requested file wins.
      let merged = chain[chain.length - 1];
      for (let index = chain.length - 2; index >= 0; index -= 1) {
        merged = mergeIncludedTheme(merged, chain[index]);
      }
      const converted = convertVsCodeTheme(merged, {
        label: theme.label,
        ...(theme.uiTheme !== undefined ? { uiTheme: theme.uiTheme } : {}),
      });
      if (converted === null) {
        log.warn('A contributed theme produced no usable colours', { key });
        return null;
      }
      return converted;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Icon theme loading
// ---------------------------------------------------------------------------
/**
 * Icon file types AXIOM will inline.
 *
 * SVG is included, and that is a deliberate, narrow decision. An SVG injected as markup
 * into the DOM is a script-capable document and would be a real injection surface. An SVG
 * referenced as an *image source* is not: the browser renders it in secure static mode,
 * where scripts do not execute and external references are not fetched. Every value
 * produced here is consumed only as an image source, which the renderer's CSP already
 * permits (`img-src 'self' data: blob:`).
 *
 * Excluding SVG instead would have been the easier line to write and the wrong one — the
 * most widely used icon themes ship nothing but SVG, so a blanket refusal produces an icon
 * theme that loads with a full set of filename mappings pointing at icons that do not
 * exist.
 */
const ICON_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/**
 * Load an icon theme and inline its icons as data URLs.
 *
 * Inlining is what lets the renderer show icons without being handed filesystem access or
 * a custom protocol. See `ICON_MIME` for why SVG is included and what constrains its use:
 * these values are image sources, never markup.
 */
export async function loadIconTheme(
  key: string,
  workspaceRoot: string | null,
): Promise<IconThemeDefinition | null> {
  const extensions = await loadEnabledExtensions(workspaceRoot);
  for (const extension of extensions) {
    for (const iconTheme of extension.manifest.contributes.iconThemes) {
      if (themeKey(extension.id, iconTheme.id, iconTheme.label) !== key) continue;
      const path = await resolveContained(extension.directory, extension.directory, iconTheme.path);
      if (path === null) return null;
      const parsed = await readJsonc(path);
      const record =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      if (!record) return null;

      const baseDirectory = dirname(path);
      const definitions: IconThemeDefinition['iconDefinitions'] = {};
      const rawDefinitions =
        record.iconDefinitions && typeof record.iconDefinitions === 'object'
          ? (record.iconDefinitions as Record<string, unknown>)
          : {};
      // A total byte budget rather than only a count: icon sets range from a handful of
      // glyphs to a couple of thousand small SVGs, and it is the aggregate that matters
      // for the IPC payload and renderer memory.
      let inlinedBytes = 0;
      for (const [name, rawDefinition] of Object.entries(rawDefinitions).slice(
        0,
        MAX_ICON_DEFINITIONS,
      )) {
        const definition =
          rawDefinition && typeof rawDefinition === 'object'
            ? (rawDefinition as Record<string, unknown>)
            : null;
        if (!definition) continue;
        const fontCharacter =
          typeof definition.fontCharacter === 'string' ? definition.fontCharacter : null;
        const fontColor = typeof definition.fontColor === 'string' ? definition.fontColor : null;
        const iconPath = typeof definition.iconPath === 'string' ? definition.iconPath : null;
        let dataUrl: string | null = null;
        if (iconPath !== null && inlinedBytes < MAX_ICON_PAYLOAD_BYTES) {
          const extensionIndex = iconPath.lastIndexOf('.');
          const suffix = extensionIndex >= 0 ? iconPath.slice(extensionIndex).toLowerCase() : '';
          const mime = ICON_MIME[suffix];
          if (mime !== undefined) {
            const resolved = await resolveContained(extension.directory, baseDirectory, iconPath);
            if (resolved !== null) {
              try {
                const bytes = await readFile(resolved);
                if (bytes.length <= MAX_SINGLE_ICON_BYTES) {
                  dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
                  inlinedBytes += dataUrl.length;
                }
              } catch {
                dataUrl = null;
              }
            }
          }
        }
        if (dataUrl === null && fontCharacter === null) continue;
        definitions[name] = {
          ...(dataUrl !== null ? { dataUrl } : {}),
          ...(fontCharacter !== null ? { fontCharacter } : {}),
          ...(fontColor !== null ? { fontColor } : {}),
        };
      }

      /**
       * Filename and language mappings, pruned to definitions that actually exist.
       *
       * Any mapping whose definition was dropped — an unsupported image type, a file that
       * failed to read, or one past the payload budget — is dropped with it. Keeping it
       * would hand the renderer a name it cannot resolve, which shows up as a blank icon
       * with no explanation. Pruning makes the payload self-consistent by construction
       * instead of relying on the budget never being reached.
       */
      const stringMap = (value: unknown): Record<string, string> => {
        const source =
          value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
        const out: Record<string, string> = {};
        for (const [mapKey, mapValue] of Object.entries(source).slice(0, MAX_ICON_DEFINITIONS)) {
          if (typeof mapValue !== 'string') continue;
          if (definitions[mapValue] === undefined) continue;
          out[mapKey.toLowerCase()] = mapValue;
        }
        return out;
      };
      const single = (value: unknown): string | null =>
        typeof value === 'string' && definitions[value] !== undefined ? value : null;

      return {
        key,
        label: iconTheme.label,
        iconDefinitions: definitions,
        file: single(record.file),
        folder: single(record.folder),
        folderExpanded: single(record.folderExpanded),
        rootFolder: single(record.rootFolder),
        fileExtensions: stringMap(record.fileExtensions),
        fileNames: stringMap(record.fileNames),
        languageIds: stringMap(record.languageIds),
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// TextMate grammars
// ---------------------------------------------------------------------------
/**
 * Read one contributed TextMate grammar by scope name.
 *
 * The renderer asks for a *scope name*, never a path. Scope names are the identifiers
 * grammars use to reference each other (`source.js` embedded in `text.html.basic`), so the
 * renderer already has them from the catalog, and keeping paths on this side means a
 * compromised renderer cannot turn the grammar loader into a file reader.
 *
 * The format is reported rather than inferred later because it decides which parser runs:
 * `.tmLanguage` files are XML property lists while `.json`/`.tmLanguage.json` files are
 * JSON. The renderer would otherwise have to guess from content, and both formats start
 * with characters the other tolerates.
 */
export async function loadGrammar(
  scopeName: string,
  workspaceRoot: string | null,
): Promise<ContributedGrammarSource | null> {
  if (typeof scopeName !== 'string' || scopeName.length === 0 || scopeName.length > 200) {
    return null;
  }
  const extensions = await loadEnabledExtensions(workspaceRoot);
  for (const extension of extensions) {
    for (const grammar of extension.manifest.contributes.grammars) {
      if (grammar.scopeName !== scopeName) continue;
      const path = await resolveContained(extension.directory, extension.directory, grammar.path);
      if (path === null) continue;
      let content: string;
      try {
        content = await readFile(path, 'utf-8');
      } catch {
        continue;
      }
      const lower = grammar.path.toLowerCase();
      return {
        scopeName,
        format: lower.endsWith('.json') ? 'json' : 'plist',
        content: content.replace(/^\uFEFF/, ''),
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------
/**
 * Load every snippet contributed for a language.
 *
 * Normalization (body arrays, prefix arrays, `.code-snippets` scopes, per-entry error
 * isolation) lives in `common/snippetFiles.ts` so the same rules apply wherever a snippet
 * file is read. One `ContributedSnippet` is emitted per prefix, because an entry may bind
 * several and the IPC shape carries one — dropping the extra prefixes would make a
 * snippet unreachable by the trigger its author documented.
 */
export async function loadSnippets(
  language: string,
  workspaceRoot: string | null,
): Promise<ContributedSnippet[]> {
  const extensions = await loadEnabledExtensions(workspaceRoot);
  const out: ContributedSnippet[] = [];
  for (const extension of extensions) {
    for (const snippet of extension.manifest.contributes.snippets) {
      // A language-scoped file only matters for its own language; a `.code-snippets`
      // bundle has to be read before its scopes are known.
      if (snippet.language !== undefined && snippet.language !== language) continue;
      const path = await resolveContained(extension.directory, extension.directory, snippet.path);
      if (path === null) continue;
      const parsed = await readJsonc(path);
      const normalized = normalizeSnippetFile(parsed, { defaultLanguage: snippet.language });
      for (const error of normalized.errors) {
        log.warn('snippet entry skipped', { extensionId: extension.id, path: snippet.path, error });
      }
      for (const entry of snippetsForLanguage(normalized.entries, language)) {
        for (const prefix of entry.prefixes) {
          out.push({
            extensionId: extension.id,
            language,
            prefix,
            body: entry.body,
            description: entry.description,
          });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Language configuration
// ---------------------------------------------------------------------------
/**
 * Load a language configuration file: comment markers, bracket pairs, auto-closing.
 *
 * These are the rules that make comment-toggling and bracket-matching behave like they do
 * in VS Code for a language AXIOM has no built-in knowledge of.
 */
async function loadLanguageConfiguration(
  extensionDirectory: string,
  declaredPath: string,
): Promise<LanguageConfiguration | null> {
  const path = await resolveContained(extensionDirectory, extensionDirectory, declaredPath);
  if (path === null) return null;
  const parsed = await readJsonc(path);
  const record =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  if (!record) return null;

  const comments =
    record.comments && typeof record.comments === 'object'
      ? (record.comments as Record<string, unknown>)
      : {};
  const lineComment = typeof comments.lineComment === 'string' ? comments.lineComment : null;
  const blockCommentRaw = Array.isArray(comments.blockComment) ? comments.blockComment : null;
  const blockComment: [string, string] | null =
    blockCommentRaw !== null &&
    typeof blockCommentRaw[0] === 'string' &&
    typeof blockCommentRaw[1] === 'string'
      ? [blockCommentRaw[0], blockCommentRaw[1]]
      : null;

  const pairList = (value: unknown): Array<[string, string]> => {
    if (!Array.isArray(value)) return [];
    const out: Array<[string, string]> = [];
    for (const item of value.slice(0, 100)) {
      if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string') {
        out.push([item[0], item[1]]);
      }
    }
    return out;
  };

  const openClose = (value: unknown): Array<{ open: string; close: string }> => {
    if (!Array.isArray(value)) return [];
    const out: Array<{ open: string; close: string }> = [];
    for (const item of value.slice(0, 100)) {
      if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string') {
        out.push({ open: item[0], close: item[1] });
        continue;
      }
      const entry = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
      if (entry && typeof entry.open === 'string' && typeof entry.close === 'string') {
        out.push({ open: entry.open, close: entry.close });
      }
    }
    return out;
  };

  return {
    lineComment,
    blockComment,
    brackets: pairList(record.brackets),
    autoClosingPairs: openClose(record.autoClosingPairs),
    surroundingPairs: openClose(record.surroundingPairs),
  };
}
