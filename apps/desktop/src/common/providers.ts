/**
 * AI provider registry (PRD Epoch F, Phase 135). A single source of truth for the
 * built-in providers: their adapter *family* (which wire format to speak),
 * default endpoint, default models, and whether a key is optional. Used by the
 * engine to dispatch by family and by routing/failover to build fallback chains
 * with sensible defaults. Pure data + lookups — safe to import in Main or the
 * renderer.
 */
export type ProviderFamily = 'openai' | 'anthropic' | 'gemini';

export interface ProviderInfo {
  id: string;
  label: string;
  /** Wire format the adapter speaks. */
  family: ProviderFamily;
  /** Default API base URL ('' when the user must supply one, e.g. custom). */
  defaultBaseUrl: string;
  /** Recommended model ids (first is the default). */
  defaultModels: string[];
  /** True when the provider may run without an API key (e.g. a local server). */
  keyless: boolean;
}

export const PROVIDER_REGISTRY: Record<string, ProviderInfo> = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    family: 'openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModels: ['gpt-4o', 'gpt-4o-mini'],
    keyless: false,
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    family: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModels: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'],
    keyless: false,
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    family: 'gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    defaultModels: ['gemini-1.5-pro', 'gemini-1.5-flash'],
    keyless: false,
  },
  /**
   * Local Ollama server. Speaks the OpenAI-compatible wire format on loopback, so
   * it needs NO API key and sends nothing off the machine (zero egress). Models are
   * discovered from the running server rather than hard-coded.
   */
  ollama: {
    id: 'ollama',
    label: 'Ollama (local, free)',
    family: 'openai',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    defaultModels: [],
    keyless: true,
  },
  custom: {
    id: 'custom',
    label: 'Custom (OpenAI-Compatible)',
    family: 'openai',
    defaultBaseUrl: '',
    defaultModels: [],
    keyless: true,
  },
};

/** Loopback base URLs Axiom will probe for a local, keyless model server. */
export const LOCAL_MODEL_ENDPOINTS: readonly string[] = [
  'http://127.0.0.1:11434',
  'http://localhost:11434',
];

/** True when a provider runs entirely on this machine (no outbound egress). */
export function isLocalProvider(id: string, baseUrl: string): boolean {
  if (id === 'ollama') return true;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || host.startsWith('127.');
  } catch {
    return false;
  }
}

/** Provider metadata, or null when unknown. */
export function providerInfo(id: string): ProviderInfo | null {
  return PROVIDER_REGISTRY[id] ?? null;
}

/** Adapter family for a provider id (defaults to the OpenAI-compatible family). */
export function providerFamily(id: string): ProviderFamily {
  return PROVIDER_REGISTRY[id]?.family ?? 'openai';
}

/** Default base URL for a provider id (or ''). */
export function defaultBaseUrl(id: string): string {
  return PROVIDER_REGISTRY[id]?.defaultBaseUrl ?? '';
}

/** Default (first recommended) model for a provider id, or ''. */
export function defaultModel(id: string): string {
  return PROVIDER_REGISTRY[id]?.defaultModels[0] ?? '';
}

/** Parse a persisted failover list ('anthropic, openai') into known provider ids. */
export function parseFailoverList(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s in PROVIDER_REGISTRY);
}
