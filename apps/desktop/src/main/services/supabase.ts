import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { rootLogger } from '@axiom/shared';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../config';
import { authStorage } from './authStore';

/**
 * The centralized Supabase client (Main process, PRD Epoch E). Configured for a
 * desktop PKCE flow with secure, OS-encrypted session storage. The renderer
 * never holds this client or its tokens; all backend access is mediated here.
 */
let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!client) {
    // Electron's main process runs on Node, which has NO global WebSocket before
    // Node 22. Supabase Realtime requires one — without it, sign-in fails with
    // "native WebSocket not found". Polyfill it with the `ws` implementation.
    // Best-effort: realtime degrades gracefully if unavailable; auth + HTTP still work.
    const g = globalThis as { WebSocket?: unknown };
    if (typeof g.WebSocket === 'undefined') {
      try {
        g.WebSocket = require('ws');
      } catch (error) {
        rootLogger.child('supabase').warn('ws WebSocket polyfill unavailable', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        // We capture the OAuth redirect ourselves via a loopback server.
        detectSessionInUrl: false,
        storage: authStorage,
      },
    });
  }
  return client;
}
