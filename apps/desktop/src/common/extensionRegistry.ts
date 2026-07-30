import type { ExtensionManifest } from './extensionManifest';

/**
 * Extension contribution registry core (PRD Epoch I §117.2/§19.2 / Phases 240/241).
 * Pure: merge the `contributes` of ENABLED extensions into namespaced registries
 * (commands / tools / prompts / context providers) that the workbench + AI
 * subsystem read. Ids are namespaced by extension id to avoid collisions. Actual
 * live execution of a contribution requires the sandboxed host (deferred). Pure —
 * smoke-tested.
 */
export interface RegisteredCommand {
  extId: string;
  id: string;
  qualifiedId: string;
  title: string;
}
export interface RegisteredTool {
  extId: string;
  name: string;
  qualifiedName: string;
  description: string;
}
export interface RegisteredPrompt {
  extId: string;
  id: string;
  qualifiedId: string;
  title: string;
  body: string;
}
export interface RegisteredContextProvider {
  extId: string;
  id: string;
  qualifiedId: string;
  title: string;
}

export interface ContributionRegistry {
  commands: RegisteredCommand[];
  tools: RegisteredTool[];
  prompts: RegisteredPrompt[];
  contextProviders: RegisteredContextProvider[];
}

/**
 * Build the merged contribution registry from a set of manifests. Only ENABLED
 * extensions contribute; ids are namespaced by extension id. Later extensions do
 * not clobber earlier ones (qualified ids are unique by construction).
 */
export function buildContributionRegistry(
  manifests: readonly ExtensionManifest[],
): ContributionRegistry {
  const registry: ContributionRegistry = {
    commands: [],
    tools: [],
    prompts: [],
    contextProviders: [],
  };
  for (const m of manifests) {
    if (!m.enabled) continue;
    for (const c of m.contributes.commands ?? []) {
      registry.commands.push({
        extId: m.id,
        id: c.id,
        qualifiedId: `${m.id}.${c.id}`,
        title: c.title,
      });
    }
    for (const t of m.contributes.tools ?? []) {
      registry.tools.push({
        extId: m.id,
        name: t.name,
        qualifiedName: `ext/${m.id}/${t.name}`,
        description: t.description,
      });
    }
    for (const p of m.contributes.prompts ?? []) {
      registry.prompts.push({
        extId: m.id,
        id: p.id,
        qualifiedId: `${m.id}:${p.id}`,
        title: p.title,
        body: p.body,
      });
    }
    for (const cp of m.contributes.contextProviders ?? []) {
      registry.contextProviders.push({
        extId: m.id,
        id: cp.id,
        qualifiedId: `${m.id}:${cp.id}`,
        title: cp.title,
      });
    }
  }
  return registry;
}

/** Total number of contributions in a registry. */
export function countContributions(reg: ContributionRegistry): number {
  return reg.commands.length + reg.tools.length + reg.prompts.length + reg.contextProviders.length;
}
