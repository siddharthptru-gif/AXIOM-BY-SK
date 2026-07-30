# Axiom — Privacy Policy

_Last updated: 2026-07-10_

Axiom ("Axiom", "the app", "we") is a local-first, AI-native desktop coding IDE. This
policy explains what data Axiom handles, where it lives, and the control you have over
it. **Axiom is free to use — there are no charges, subscriptions, ads, or paid tiers,
and we do not sell your data.**

## Summary (the short version)

- **Your code and files stay on your machine.** Axiom is local-first. Your projects,
  settings, prompts, chat history, and memory are stored locally in your OS user-data
  directory — not on our servers.
- **Bring-your-own-key (BYOK).** You connect your own AI provider accounts. Your API
  keys are stored in your operating system's encrypted secret store and are **never sent
  to Axiom**. Prompts and code you send to an AI model go **directly from your machine to
  the provider you chose** (e.g. OpenAI, Anthropic, Google, or a local model) — not
  through Axiom's servers.
- **The cloud is optional and minimal.** Axiom's own cloud (built on Supabase) is used
  only for: Google sign-in, optional cross-device preference/prompt sync, and **opt-in**
  telemetry and crash reports. Every cloud row is locked to your account.
- **No ads. No data sales. No hidden tracking.**

## 1. What Axiom stores locally

The following stay on your device (in your OS user-data folder and your workspace):

- Editor settings, keybindings, themes, and UI preferences.
- Workspace files you open or edit (Axiom never uploads your source code to us).
- Chat history, prompts, saved prompts, workspace rules, and custom agents.
- Long-term memory entries and the local audit/checkpoint history.
- A local, on-device search/index of your workspace.

You can delete this data at any time by clearing the app's user-data directory or using
in-app controls (e.g. clearing chat history or the index).

## 2. Bring-your-own-key (AI providers)

- Axiom does not provide AI models. You configure your own provider(s) and API key(s).
- **API keys are stored only in your operating system's encrypted credential store**
  (e.g. Windows Credential Manager / DPAPI) and are never transmitted to Axiom.
- When you use an AI feature, your prompt and the code/context you include are sent
  **directly from your device to the provider you selected**, over TLS. That provider's
  own privacy policy and terms govern that data. Axiom is not an intermediary for these
  requests.
- Estimated token usage and cost are calculated **locally** for your visibility; the
  actual billing relationship is strictly between you and your provider.

## 3. What Axiom's cloud (Supabase) handles — and only when you opt in

Axiom uses [Supabase](https://supabase.com) as its backend. Cloud features are optional;
if you never sign in, nothing leaves your device except your direct-to-provider AI calls.

- **Authentication (Google Sign-In).** If you sign in, authentication is brokered by
  Supabase using Google as the identity provider. We receive a basic profile (your
  Supabase user id, email, and display name/avatar if provided by Google). Access tokens
  are stored only in your OS-encrypted store on your device.
- **Preferences & content sync (optional).** If you enable sync, your **settings** and,
  where you choose, your **prompts / rules / custom agents** are mirrored to your account
  so they follow you across devices. Your source code is **never** synced.
- **Telemetry & crash reports (opt-in only).** If you opt in, anonymized usage events and
  crash diagnostics may be sent to help improve stability. This is off by default and can
  be turned off at any time. Secrets and code are never included.
- **Feature flags.** Axiom may read remote feature flags to enable/disable features and
  stage rollouts. This is a read of configuration, not a collection of your data.

Every cloud table is protected by **Row-Level Security (RLS)**: your rows are readable and
writable only by your authenticated account. The public/anon key shipped in the app cannot
read another user's data.

## 4. What we do NOT do

- We do **not** sell, rent, or share your personal data for advertising.
- We do **not** upload your source code to Axiom's servers.
- We do **not** read your API keys or your provider traffic.
- We do **not** charge you — Axiom is free.

## 5. Your controls and rights

- **Access / export:** export a local copy of your settings, memory, custom agents,
  feature flags, and audit summary as JSON (AI panel → "Export my data"). API keys and
  code are never included.
- **Delete your account:** account deletion removes all of your rows across Axiom's cloud
  tables (settings, sync records, telemetry, crashes, devices, profile) and your auth
  user. This is irreversible.
- **Sign out:** clears your local session; you can also sign out globally.
- **Disable cloud features:** simply don't sign in, or turn off sync/telemetry.
- Depending on your region (e.g. GDPR/CCPA), you may have additional rights to access,
  correct, or erase your data. The controls above satisfy these; contact us for anything
  else.

## 6. Third-party services

- **Supabase** — authentication, database, and functions for the optional cloud features.
- **Google** — used only as the sign-in identity provider (via Supabase Auth).
- **Your chosen AI provider(s)** — receive your prompts/code directly when you use AI
  features. Review their privacy policies.

## 7. Security

- API keys and session tokens live only in your OS-encrypted secret store; the renderer
  process never sees them.
- All network traffic uses TLS. Cloud data is isolated per user via RLS.
- Axiom is local-first by design, minimizing what ever leaves your machine.

## 8. Children

Axiom is a developer tool intended for adults and is not directed to children under 13
(or the minimum age required in your jurisdiction). We do not knowingly collect data from
children.

## 9. Changes to this policy

We may update this policy as Axiom evolves. Material changes will be noted in-app and by
updating the "Last updated" date above.

## 10. Contact

Questions about privacy or a data request: **privacy@axiom.dev** _(replace with your
preferred contact address before publishing)_.

> This document describes how the Axiom application handles data based on its actual
> architecture. It is provided for transparency and is not legal advice.
