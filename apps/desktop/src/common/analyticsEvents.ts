import type { TelemetryCategory } from './ipc';

/**
 * Analytics event schema registry (PRD Epoch E §52 / Phase 127). The single,
 * reviewable catalog of the product-telemetry event taxonomy. Every analytics
 * event MUST be declared here with its category and the exact set of allowed prop
 * keys + value kinds — this is the no-PII / no-code gate: only bucketed numbers,
 * booleans, and short enum strings are permitted, and any undeclared key or
 * wrong-typed / oversized / free-text value is stripped before an event is ever
 * recorded. Pure + deterministic; smoke-tested. Adding an event = one reviewed
 * entry here (prevents event sprawl + PII leakage — PRD acceptance for 127).
 */

/** Allowed value kind for an analytics prop. */
export type PropKind = 'number' | 'boolean' | 'enum';

export interface PropSpec {
  kind: PropKind;
  /** For 'enum': the exact allowed short string values. */
  values?: readonly string[];
}

export interface EventSpec {
  category: TelemetryCategory;
  props: Readonly<Record<string, PropSpec>>;
}

/** Max length for an enum string value (short enums only — never free text). */
export const MAX_ENUM_LEN = 32;

/** The reviewed analytics event taxonomy. */
export const EVENT_REGISTRY: Readonly<Record<string, EventSpec>> = {
  app_start: {
    category: 'performance',
    props: { coldMs: { kind: 'number' }, restored: { kind: 'boolean' } },
  },
  app_exit: {
    category: 'analytics',
    props: { sessionMinutes: { kind: 'number' } },
  },
  signin: {
    category: 'analytics',
    props: { provider: { kind: 'enum', values: ['google'] } },
  },
  provider_added: {
    category: 'analytics',
    props: { family: { kind: 'enum', values: ['openai', 'anthropic', 'gemini', 'custom'] } },
  },
  ai_action: {
    category: 'analytics',
    props: {
      kind: { kind: 'enum', values: ['explain', 'refactor', 'fix', 'docs', 'chat', 'compose'] },
      ok: { kind: 'boolean' },
    },
  },
  agent_run: {
    category: 'analytics',
    props: {
      preset: {
        kind: 'enum',
        values: ['coder', 'reviewer', 'researcher', 'test-writer', 'documenter', 'custom'],
      },
    },
  },
  error: {
    category: 'crashReports',
    props: {
      area: { kind: 'enum', values: ['editor', 'ai', 'agent', 'sync', 'core', 'ui'] },
      fatal: { kind: 'boolean' },
    },
  },
};

export interface ValidatedEvent {
  /** Whether the event name is a declared, reviewed event. */
  known: boolean;
  /** The telemetry category to record under (null for unknown events). */
  category: TelemetryCategory | null;
  /** The surviving, taxonomy-conformant props (safe to record). */
  props: Record<string, number | boolean | string>;
  /** Prop keys that were dropped (undeclared / wrong kind / bad enum). */
  stripped: string[];
}

/**
 * Validate an event against the registry. Unknown events are flagged
 * (`known: false`, `category: null`) so they can be dropped. For known events,
 * only declared props with a matching value kind survive; enum values must be in
 * the allow-list and ≤ `MAX_ENUM_LEN`. Everything else is stripped and listed in
 * `stripped` — the no-PII / no-code guarantee.
 */
export function validateAnalyticsEvent(
  name: string,
  props?: Record<string, unknown>,
): ValidatedEvent {
  const spec = EVENT_REGISTRY[name];
  const entries = Object.entries(props ?? {});
  if (!spec) {
    return { known: false, category: null, props: {}, stripped: entries.map(([k]) => k) };
  }
  const out: Record<string, number | boolean | string> = {};
  const stripped: string[] = [];
  for (const [k, v] of entries) {
    const ps = spec.props[k];
    if (!ps) {
      stripped.push(k);
      continue;
    }
    if (ps.kind === 'number' && typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v;
    } else if (ps.kind === 'boolean' && typeof v === 'boolean') {
      out[k] = v;
    } else if (
      ps.kind === 'enum' &&
      typeof v === 'string' &&
      v.length <= MAX_ENUM_LEN &&
      (ps.values?.includes(v) ?? false)
    ) {
      out[k] = v;
    } else {
      stripped.push(k);
    }
  }
  return { known: true, category: spec.category, props: out, stripped };
}

/** All declared event names (for review / tests / docs). */
export function knownEventNames(): string[] {
  return Object.keys(EVENT_REGISTRY);
}
