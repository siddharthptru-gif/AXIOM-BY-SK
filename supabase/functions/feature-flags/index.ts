// ============================================================================
// Axiom Edge Function — feature-flags (PRD Phase 129)
// ============================================================================
// Returns the feature flags evaluated for the calling user. A flag is on when it
// is enabled AND the user falls inside its staged `rollout` percentage, decided
// by a STABLE hash of (userId + flagKey) so a given user is consistently in or
// out as the rollout widens. Live updates also flow over Supabase Realtime on the
// `feature_flags` table (see 0001_core_schema.sql). Deno runtime.
//
// Deploy: `supabase functions deploy feature-flags`
// ============================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';

interface FlagRow {
  key: string;
  enabled: boolean;
  rollout: number;
  description: string | null;
}

/** Deterministic 0..99 bucket from a string (FNV-1a based). */
function bucket(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100;
}

function evaluate(flag: FlagRow, userId: string | null): boolean {
  if (!flag.enabled) return false;
  const rollout = Math.max(0, Math.min(100, flag.rollout ?? 100));
  if (rollout >= 100) return true;
  if (rollout <= 0) return false;
  if (!userId) return false;
  return bucket(`${userId}:${flag.key}`) < rollout;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST' && req.method !== 'GET') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'missing_authorization' }, 401);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .from('feature_flags')
    .select('key, enabled, rollout, description');
  if (error) return json({ error: 'query_failed', detail: error.message }, 500);

  const flags = (data ?? []) as FlagRow[];
  const resolved = flags.map((f) => ({
    key: f.key,
    enabled: evaluate(f, user?.id ?? null),
    description: f.description ?? '',
  }));

  return json({ flags: resolved });
});
