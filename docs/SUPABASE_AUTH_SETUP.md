# Supabase Google OAuth — setup (auth only)

Axiom uses **Supabase Auth with Google as the only provider**, brokered by
Supabase. The desktop app talks to Supabase with the public **anon key** (already
in `apps/desktop/src/main/config.ts`) and a PKCE loopback flow — it never holds
the Google Client Secret. The Client ID/Secret are configured **server-side in
the Supabase dashboard**; no application code change is required.

> 🔐 **Do not commit the Client Secret to this repo.** It belongs only in the
> Supabase dashboard. (This file intentionally omits the secret value.)

## Project

- Project URL: `https://bmdprpuehhalabhtndmf.supabase.co`
- Google **Client ID**: `18254413364-hv1ci0h4ac4rgcedr9jla2f0h54qphj2.apps.googleusercontent.com`
- Google **Client Secret**: _paste into the Supabase dashboard (kept private, not stored here)_

## 1. Google Cloud Console

APIs & Services → Credentials → your OAuth 2.0 Client → **Authorized redirect URIs**,
add the Supabase callback:

```
https://bmdprpuehhalabhtndmf.supabase.co/auth/v1/callback
```

(Also complete the OAuth consent screen if you haven't.)

## 2. Supabase Dashboard

**Authentication → Providers → Google** — enable it and paste:

- Client ID: `18254413364-hv1ci0h4ac4rgcedr9jla2f0h54qphj2.apps.googleusercontent.com`
- Client Secret: _your secret_

**Authentication → URL Configuration → Redirect URLs** — add the desktop
loopback that the app listens on (`OAUTH_REDIRECT_URL` in `config.ts`):

```
http://localhost:8770
```

## 3. Nothing else

- No database schema/tables are needed for auth — Supabase manages `auth.users`.
- The app flow (system browser → Google → Supabase callback → loopback capture →
  PKCE code exchange → encrypted session) is already implemented in
  `main/services/{supabase,googleOAuth,sessionManager,authStore,auth}.ts`.

Once steps 1–2 are saved, click **Continue with Google** in Axiom and it will
complete end-to-end.
