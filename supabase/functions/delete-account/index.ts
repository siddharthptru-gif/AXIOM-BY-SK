// ============================================================================
// Axiom Edge Function — delete-account (PRD Phases 118 / 124)
// ============================================================================
// Full account deletion. Verifies the caller's JWT, then uses the SERVICE ROLE to
// delete the auth user; every application table references `auth.users` with
// `on delete cascade`, so all of the user's rows (settings, sync records,
// telemetry, crashes, devices, profile) are removed atomically.
//
// Requires the SUPABASE_SERVICE_ROLE_KEY secret (set via
// `supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...`). Deno runtime.
// Deploy: `supabase functions deploy delete-account`
// ============================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'missing_authorization' }, 401);

  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!serviceKey) return json({ error: 'server_misconfigured' }, 500);

  // 1) Identify the caller from their JWT (anon client + forwarded auth header).
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: authError,
  } = await userClient.auth.getUser();
  if (authError || !user) return json({ error: 'unauthorized' }, 401);

  // 2) Delete the auth user with the service role → cascades to app tables.
  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) return json({ error: 'delete_failed', detail: error.message }, 500);

  return json({ deleted: true, userId: user.id });
});
