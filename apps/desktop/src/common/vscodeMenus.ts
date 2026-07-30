/**
 * Menu resolution (PRD Phase 5 §7, §10).
 *
 * `contributes.menus` is a map from a menu location to a list of items, and every item can carry a
 * `when` clause and a `group@order` string. Resolving a menu means: take the items declared for
 * one location, drop the ones whose clause is false right now, group them, sort the groups, sort
 * within each group, and hand the renderer a list it can draw without knowing any of that.
 *
 * Two decisions:
 *
 *   1. **A menu item names a command; it never carries one.** The resolved item holds a command
 *      *id* and the title that came from `contributes.commands`. An item whose command was never
 *      declared is dropped, which is upstream's behaviour and also the answer to "menus cannot
 *      execute injected commands": there is no path from a manifest string to an invocation that
 *      does not pass through the command registry's own validation.
 *   2. **Resolution is a pure function of (contributions, context).** The renderer re-resolves
 *      when the context-key version moves, and `menuReadsKeys` lets a caller skip locations whose
 *      clauses do not mention any changed key — which is what makes "menus update dynamically"
 *      affordable with a few hundred contributed items.
 *
 * Pure: no I/O.
 */

import { evaluateWhen, whenReadsAnyOf } from './vscodeContextKeys';
import type { MenuItemContribution, SubmenuContribution } from './vscodeManifest';
import type { ContextKeyValues } from './contextKeyExpr';

export const MAX_MENU_ITEMS = 1_000;
export const MAX_MENU_ITEMS_PER_LOCATION = 200;
export const MAX_SUBMENU_DEPTH = 3;

/**
 * Locations this build draws.
 *
 * An item contributed to a location not in this list is kept in the registry and reported as
 * unsupported rather than dropped silently — the extension manager shows it, and a later phase
 * that adds notebooks or the timeline needs only to add the id here.
 */
export const SUPPORTED_MENU_LOCATIONS: ReadonlySet<string> = new Set([
  'commandPalette',
  'editor/context',
  'editor/title',
  'editor/title/context',
  'editor/title/run',
  'explorer/context',
  'view/title',
  'view/item/context',
  'scm/title',
  'scm/resourceGroup/context',
  'scm/resourceState/context',
  'scm/change/title',
  'extension/context',
  'menuBar/edit/copy',
  'file/newFile',
]);

/** Groups upstream draws before every other group, in this order. */
const PINNED_GROUPS: readonly string[] = ['inline', 'navigation'];

export interface ResolvedMenuItem {
  extensionId: string;
  /** Exactly one of `command` / `submenu` is set. */
  command: string | null;
  submenu: string | null;
  title: string;
  icon: string | null;
  /** The alternate command, used when the menu is opened with Alt held. */
  alt: string | null;
  group: string;
  order: number;
  /** False when the command's own `enablement` clause fails: drawn, but not clickable. */
  enabled: boolean;
}

export interface ResolvedMenuGroup {
  id: string;
  items: ResolvedMenuItem[];
}

/** What the caller knows about a command id, taken from `contributes.commands`. */
export interface MenuCommandInfo {
  title: string;
  icon: string | null;
  enablement: string | null;
}

export interface MenuContributor {
  extensionId: string;
  menus: readonly MenuItemContribution[];
  submenus: readonly SubmenuContribution[];
}

export interface MenuRegistry {
  /** Location → declaration-ordered items. */
  byLocation: Map<string, Array<MenuItemContribution & { extensionId: string }>>;
  submenus: Map<string, SubmenuContribution & { extensionId: string }>;
  /** Locations that were contributed to but are not drawn by this build. */
  unsupportedLocations: Array<{ extensionId: string; location: string; items: number }>;
  total: number;
}

/** Split `"navigation@2"` into its parts. An absent group sorts last, as upstream's does. */
export function parseMenuGroup(raw: string | null | undefined): { group: string; order: number } {
  if (typeof raw !== 'string' || raw.length === 0) return { group: 'z_end', order: 0 };
  const at = raw.lastIndexOf('@');
  if (at <= 0) return { group: raw.slice(0, 128), order: 0 };
  const order = Number.parseInt(raw.slice(at + 1), 10);
  return {
    group: raw.slice(0, at).slice(0, 128),
    order: Number.isFinite(order) ? order : 0,
  };
}

function compareGroups(a: string, b: string): number {
  const pinnedA = PINNED_GROUPS.indexOf(a);
  const pinnedB = PINNED_GROUPS.indexOf(b);
  if (pinnedA !== -1 || pinnedB !== -1) {
    if (pinnedA === -1) return 1;
    if (pinnedB === -1) return -1;
    return pinnedA - pinnedB;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildMenuRegistry(contributors: readonly MenuContributor[]): MenuRegistry {
  const byLocation = new Map<string, Array<MenuItemContribution & { extensionId: string }>>();
  const submenus = new Map<string, SubmenuContribution & { extensionId: string }>();
  const unsupportedLocations: MenuRegistry['unsupportedLocations'] = [];
  const unsupportedCounts = new Map<string, { extensionId: string; items: number }>();
  let total = 0;

  for (const contributor of contributors) {
    for (const declared of contributor.submenus) {
      if (submenus.has(declared.id)) continue;
      submenus.set(declared.id, { ...declared, extensionId: contributor.extensionId });
    }
    for (const item of contributor.menus) {
      if (total >= MAX_MENU_ITEMS) break;
      const isSubmenuLocation = submenus.has(item.location) || item.location.includes('/');
      if (!SUPPORTED_MENU_LOCATIONS.has(item.location) && !isSubmenuLocation) {
        const key = `${contributor.extensionId}:${item.location}`;
        const seen = unsupportedCounts.get(key);
        if (seen === undefined) {
          unsupportedCounts.set(key, { extensionId: contributor.extensionId, items: 1 });
        } else {
          seen.items += 1;
        }
        continue;
      }
      const bucket = byLocation.get(item.location) ?? [];
      if (bucket.length >= MAX_MENU_ITEMS_PER_LOCATION) continue;
      bucket.push({ ...item, extensionId: contributor.extensionId });
      byLocation.set(item.location, bucket);
      total += 1;
    }
  }

  for (const [key, entry] of unsupportedCounts) {
    unsupportedLocations.push({
      extensionId: entry.extensionId,
      location: key.slice(entry.extensionId.length + 1),
      items: entry.items,
    });
  }

  return { byLocation, submenus, unsupportedLocations, total };
}

/**
 * Resolve one menu location against the current context.
 *
 * `commands` is the command registry's view of what exists; an item naming a command that is not
 * in it is dropped. A submenu item resolves to its own title and is only kept if the submenu has
 * at least one visible item, because upstream hides an empty submenu rather than drawing a dead
 * row.
 */
export function resolveMenu(
  registry: MenuRegistry,
  location: string,
  context: ContextKeyValues,
  commands: ReadonlyMap<string, MenuCommandInfo>,
  depth = 0,
): ResolvedMenuGroup[] {
  const declared = registry.byLocation.get(location) ?? [];
  const groups = new Map<string, ResolvedMenuItem[]>();

  for (const item of declared) {
    if (!evaluateWhen(item.when ?? null, context)) continue;
    const { group, order } = parseMenuGroup(item.group ?? null);
    let resolved: ResolvedMenuItem | null = null;

    if (item.submenu !== undefined && item.submenu !== null) {
      if (depth >= MAX_SUBMENU_DEPTH) continue;
      const submenu = registry.submenus.get(item.submenu);
      if (submenu === undefined) continue;
      const inner = resolveMenu(registry, item.submenu, context, commands, depth + 1);
      if (inner.every((entry) => entry.items.length === 0)) continue;
      resolved = {
        extensionId: item.extensionId,
        command: null,
        submenu: item.submenu,
        title: submenu.label,
        icon: submenu.icon ?? null,
        alt: null,
        group,
        order,
        enabled: true,
      };
    } else if (item.command !== undefined && item.command !== null) {
      const info = commands.get(item.command);
      if (info === undefined) continue;
      const alt =
        item.alt !== undefined && item.alt !== null && commands.has(item.alt) ? item.alt : null;
      resolved = {
        extensionId: item.extensionId,
        command: item.command,
        submenu: null,
        title: info.title,
        icon: info.icon,
        alt,
        group,
        order,
        enabled: info.enablement === null ? true : evaluateWhen(info.enablement, context),
      };
    }

    if (resolved === null) continue;
    const bucket = groups.get(group) ?? [];
    bucket.push(resolved);
    groups.set(group, bucket);
  }

  return [...groups.entries()]
    .sort(([a], [b]) => compareGroups(a, b))
    .map(([id, items]) => ({
      id,
      items: items.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)),
    }));
}

/** Does a context-key change affect this location at all? Used to skip untouched menus. */
export function menuReadsKeys(
  registry: MenuRegistry,
  location: string,
  changed: ReadonlySet<string>,
): boolean {
  const declared = registry.byLocation.get(location);
  if (declared === undefined) return false;
  return declared.some((item) => whenReadsAnyOf(item.when ?? null, changed));
}

/** Every location that has at least one declared item, for diagnostics. */
export function contributedLocations(registry: MenuRegistry): string[] {
  return [...registry.byLocation.keys()].sort();
}
