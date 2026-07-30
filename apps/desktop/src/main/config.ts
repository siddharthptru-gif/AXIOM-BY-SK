/**
 * Centralized runtime configuration (PRD Epoch E). The single source of truth
 * for backend endpoints — never scatter these across the codebase. Values are
 * development defaults and can be overridden via environment variables.
 *
 * The Supabase publishable (anon) key is a public, client-side key protected by
 * Row-Level Security; it is safe to ship. Real secrets never live here.
 */
export const SUPABASE_URL =
  process.env.AXIOM_SUPABASE_URL ?? 'https://bmdprpuehhalabhtndmf.supabase.co';

export const SUPABASE_ANON_KEY =
  process.env.AXIOM_SUPABASE_ANON_KEY ?? 'sb_publishable_Dp1MR6pahT8-HY1IPulZTg_WAw4fLGC';

/**
 * Fixed loopback port for the desktop OAuth redirect. `OAUTH_REDIRECT_URL` must
 * be added to the Supabase Auth "Redirect URLs" allow-list.
 */
export const OAUTH_LOOPBACK_PORT = 8770;
export const OAUTH_REDIRECT_URL = `http://localhost:${OAUTH_LOOPBACK_PORT}`;
