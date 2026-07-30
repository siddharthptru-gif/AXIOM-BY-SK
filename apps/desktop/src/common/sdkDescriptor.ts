/**
 * Provider plugin SDK & custom-agent SDK (Phase 246).
 *
 * PURE module (no I/O, no Electron). The SCHEMA + VALIDATION core of the public SDKs:
 * a third party describes a provider adapter (`IProviderAdapter`) or a custom agent
 * as a JSON descriptor, and this validates it (required fields, enums, non-empty
 * collections) into a typed descriptor + a clear error list, and emits starter
 * TEMPLATES. The runtime SDK packages + generated docs are the out-of-core follow-up;
 * this is the honest descriptor contract. Deterministic; never throws.
 */

export type ProviderFamily = 'openai' | 'anthropic' | 'gemini' | 'custom';
export type ProviderAuth = 'apiKey' | 'none' | 'oauth';

export interface ProviderAdapterDescriptor {
  id: string;
  displayName: string;
  family: ProviderFamily;
  auth: ProviderAuth;
  models: string[];
  baseUrl?: string;
  capabilities?: { tools?: boolean; vision?: boolean; streaming?: boolean };
}

export interface CustomAgentDescriptor {
  id: string;
  name: string;
  persona: string;
  /** 'all' or an explicit tool-id list. */
  tools: 'all' | string[];
}

export interface ValidationResult<T> {
  ok: boolean;
  errors: string[];
  descriptor?: T;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,47}$/;
const FAMILIES: readonly ProviderFamily[] = ['openai', 'anthropic', 'gemini', 'custom'];
const AUTHS: readonly ProviderAuth[] = ['apiKey', 'none', 'oauth'];

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function strArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
}

/** Validate a provider-adapter descriptor (SDK contract). */
export function validateProviderAdapter(raw: unknown): ValidationResult<ProviderAdapterDescriptor> {
  const errors: string[] = [];
  const o = asRecord(raw);
  if (!o) return { ok: false, errors: ['descriptor must be an object'] };
  const id = typeof o.id === 'string' ? o.id : '';
  if (!SLUG.test(id)) errors.push('id must be a slug (a-z0-9-, 2–48 chars)');
  const displayName = typeof o.displayName === 'string' ? o.displayName.trim() : '';
  if (displayName.length === 0) errors.push('displayName is required');
  const family = o.family as ProviderFamily;
  if (!FAMILIES.includes(family)) errors.push(`family must be one of ${FAMILIES.join('|')}`);
  const auth = o.auth as ProviderAuth;
  if (!AUTHS.includes(auth)) errors.push(`auth must be one of ${AUTHS.join('|')}`);
  const models = strArray(o.models);
  if (models.length === 0) errors.push('models must be a non-empty string array');
  if (errors.length > 0) return { ok: false, errors };
  const cap = asRecord(o.capabilities);
  const descriptor: ProviderAdapterDescriptor = {
    id,
    displayName,
    family,
    auth,
    models,
    ...(typeof o.baseUrl === 'string' && o.baseUrl.length > 0 ? { baseUrl: o.baseUrl } : {}),
    ...(cap
      ? {
          capabilities: {
            ...(typeof cap.tools === 'boolean' ? { tools: cap.tools } : {}),
            ...(typeof cap.vision === 'boolean' ? { vision: cap.vision } : {}),
            ...(typeof cap.streaming === 'boolean' ? { streaming: cap.streaming } : {}),
          },
        }
      : {}),
  };
  return { ok: true, errors: [], descriptor };
}

/** Validate a custom-agent descriptor (SDK contract). */
export function validateCustomAgent(raw: unknown): ValidationResult<CustomAgentDescriptor> {
  const errors: string[] = [];
  const o = asRecord(raw);
  if (!o) return { ok: false, errors: ['descriptor must be an object'] };
  const id = typeof o.id === 'string' ? o.id : '';
  if (!SLUG.test(id)) errors.push('id must be a slug (a-z0-9-, 2–48 chars)');
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (name.length === 0) errors.push('name is required');
  const persona = typeof o.persona === 'string' ? o.persona.trim() : '';
  if (persona.length < 10) errors.push('persona is required (>= 10 chars)');
  let tools: 'all' | string[];
  if (o.tools === 'all') tools = 'all';
  else {
    const t = strArray(o.tools);
    if (t.length === 0) errors.push('tools must be "all" or a non-empty tool-id array');
    tools = t;
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [], descriptor: { id, name, persona, tools } };
}

/** A starter provider-adapter descriptor (SDK template). */
export function providerAdapterTemplate(): ProviderAdapterDescriptor {
  return {
    id: 'my-provider',
    displayName: 'My Provider',
    family: 'custom',
    auth: 'apiKey',
    models: ['my-model-latest'],
    baseUrl: 'https://api.example.com/v1',
    capabilities: { tools: true, vision: false, streaming: true },
  };
}

/** A starter custom-agent descriptor (SDK template). */
export function customAgentTemplate(): CustomAgentDescriptor {
  return {
    id: 'my-agent',
    name: 'My Agent',
    persona: 'You are a focused specialist that…',
    tools: ['read_file', 'search_text'],
  };
}
