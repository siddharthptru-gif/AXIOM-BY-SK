// ============================================================================
// Axiom Edge Function — telemetry-ingest (PRD Phases 118 / 126)
// ============================================================================
// Batched, opt-in telemetry ingest. The desktop client POSTs a batch of events
// with the signed-in user's JWT; this validates the caller and inserts the rows
// UNDER THAT USER'S identity (RLS `telemetry_insert_own` enforces user_id), so no
// service-role secret is needed. Deno runtime.
//
// Deploy: `supabase functions deploy telemetry-ingest`
// ============================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';

interface IncomingEvent {
  event: string;
  props?: Record<string, unknown>;
  ts?: string;
}

interface IngestBody {
  sessionId: string;
  appVersion?: string;
  platform?: string;
  events: IncomingEvent[];
}

const MAX_EVENTS = 500;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'missing_authorization' }, 401);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } },
  );

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) return json({ error: 'unauthorized' }, 401);

  let body: IngestBody;
  try {
    body = (await req.json()) as IngestBody;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  if (!body || typeof body.sessionId !== 'string' || !Array.isArray(body.events)) {
    return json({ error: 'invalid_body' }, 400);
  }
  if (body.events.length === 0) return json({ ingested: 0 });
  if (body.events.length > MAX_EVENTS) return json({ error: 'too_many_events' }, 413);

  const rows = body.events
    .filter((e) => e && typeof e.event === 'string' && e.event.length > 0)
    .map((e) => ({
      user_id: user.id,
      session_id: body.sessionId,
      event: e.event,
      props: e.props ?? {},
      app_version: body.appVersion ?? null,
      platform: body.platform ?? null,
      ...(typeof e.ts === 'string' ? { ts: e.ts } : {}),
    }));

  const { error } = await supabase.from('telemetry_events').insert(rows);
  if (error) return json({ error: 'insert_failed', detail: error.message }, 500);

  return json({ ingested: rows.length });
});
