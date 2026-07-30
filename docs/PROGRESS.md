# Axiom — PRD Build Progress Tracker

> **Purpose.** Persistent, cross-session source of truth for how much of `PRD.md`
> (Part XIV: 290 phases across Epochs A–K) is built. Updated at the end of every
> build session. Scoring: **Done = 1.0**, **Partial = 0.5**, **Missing = 0**.
> Percentages are an honest engineering assessment from code evidence, not exact.

**End goal:** complete all 290 PRD phases → then ship a signed Windows 10/11
`.exe` with a proper wizard installer that auto-installs dependencies, with the
correct Axiom logo + name.

---

## Overall status (as of 2026-07-10, session 77)

| Metric                   | Value                    |
| ------------------------ | ------------------------ |
| Phases fully done (1.0)  | **164 / 290**            |
| Phases partial (0.5)     | **97 / 290**             |
| Phases not started (0)   | **29 / 290**             |
| **Weighted completion**  | **≈ 212.5 / 290 = ~73%** |
| **Remaining (weighted)** | **≈ 27%**                |

> **s77 note (UX overhaul from user feedback — UI/UX + config; no phase-count change):**
> **(1) Colors → universal black & white.** Removed the blue accent + violet AI chrome app-wide:
> a theme-aware `mono` accent added in `themes.ts` (near-white on dark, near-black on light) is now
> the default; `tokens.css` `--accent/--focus/--ai/--fg-on-accent` → monochrome; Monaco
> cursor/selection (`monacoEnv.ts`), terminal cursor/selection (`TerminalView.tsx`), the login aurora
>
> - brand gradients (`global.css`) and file-icon purple (`treeIcons.tsx`) all neutralized. Signal
>   colors (diagnostics red/amber/green) + the syntax palette are intentionally KEPT (functional,
>   Cursor-like). **(2) Removed the Extensions section** (activity-bar item + view + command; deleted
>   `ExtensionsView.tsx`). **(3) Top menu bar is now functional** — `TitleBar.tsx` rewritten as
>   data-driven dropdowns (File/Edit/View/Go/Terminal/Help) that list + run the live registered commands
>   by category (outside-click / Esc close). **(4) Model switcher shows ALL models from a custom
>   endpoint** — the fetched list is now persisted (`ai.custom.models`) + fed to the chat switcher, so
>   after "Fetch Models" every model is switchable (was: only the one saved default). Verified typecheck
>   0 / build 3 bundles / prettier. **Auth:** the `redirect_uri_mismatch` is a Google-Console setting
>   (add the Supabase callback `https://<ref>.supabase.co/auth/v1/callback` to the OAuth client); user
>   rotated to a new OAuth client, so the Client ID in `docs/SUPABASE_AUTH_SETUP.md` was updated (the
>   secret stays dashboard-only, never in the repo). **(5) Blank chat replies FIXED** — many
>   OpenAI-compatible endpoints ignore `stream: true` and return a plain JSON completion, so the SSE
>   pump found no `data:` lines and the reply rendered blank; `main/services/ai.ts` now detects a
>   non-SSE (`application/json`) response and parses the whole completion (`extractNonStreamCompletion`,
>   smoke 6/6). **(6) Right-docked chat (Cursor/VS Code layout)** — the AI chat moved out of the left
>   sidebar into a resizable RIGHT dock (explorer left · editor center · chat right): new transient
>   layout state (`aiPanelVisible`/`aiPanelWidth`), a `side='right'` `SidebarResizer`, and the
>   activity-bar AI button now toggles the dock. **(7) Chat UI polish + spacing** — roomier thread /
>   composer / message bubbles + a larger input. The open-folder → explorer flow
>   (`openFolder`→`switchToFolder`→`rootPath`→`FileTree`) reads as correct in code. Verified typecheck 0
>   / build 3 bundles / prettier throughout. **Counts unchanged (212.5/290)** — UI/UX + runtime work,
>   tracked separately from PRD phase scoring.

> **s76 note:** **FIXED sign-in failure** (`Error invoking remote method 'auth:signInGoogle':
Node.js detected but native WebSocket not found`). Root cause: Electron 33's main process runs on
> **Node 20**, which has no global `WebSocket`; `@supabase/realtime-js` (used by the client for
> auth-token propagation + the s69 Realtime channels) requires one, so sign-in threw. Fix:
> `main/services/supabase.ts` now **polyfills `globalThis.WebSocket` with the `ws` package**
> (guarded `require`, best-effort — realtime degrades gracefully if unavailable; auth + HTTP always
> work). Added `ws` (dep) + `@types/ws` (dev). Verified typecheck 0 / build 3 bundles / prettier.
> **Rebuild the .exe** to pick this up (it needs `npm install` for `ws`, which the build scripts do).
> If sign-in then shows a _different_ error (e.g. redirect mismatch), add `http://localhost:8770` to
> the Supabase Auth "Redirect URLs" allow-list + the Google OAuth console (see docs/SUPABASE_AUTH_SETUP.md).
> **Counts unchanged (212.5/290)** — a runtime bug fix.

> **s75 note:** built the **AI-provenance gutter ribbon** foundation (UI/UX PDF Part 6.2) — pure
> `common/aiProvenance.ts` (AI-authored line-range tracking: `mergeRanges` / `addRange` /
> `shiftRangesOnEdit` / `toGutterDecorations` / `aiLineCount`, smoke 12/0) + the
> `.ai-provenance-gutter` CSS (a 2px `--ai` violet lane). Wiring it into EditorPane + the AI-edit
> flow is the remaining step (deferred deliberately — not risking the just-fixed editor). **Honest
> remaining-phase reality:** ~**79 weighted points** remain to 290; the pool is dominated by work
> that **cannot be completed or verified in this sandbox** and would be fake if marked done:
> **Epoch J** (installers need a code-signing cert from the user + a real build machine/CI; perf
> gates + pen-test/chaos/soak need reference hardware), **Epoch E** tail (live-backend round-trip
> confirmation is the user's), **Epoch K** (macOS/Linux need those OSes), and runtime-heavy tails
> in F (native streaming), I (real axe/screen-reader audits), C (persisted Rust-core graph). The
> genuinely pure-completable pool is nearly exhausted (as noted since s53). **Counts unchanged
> (212.5/290)** — no phase inflated. See "Biggest MISSING blocks" for the per-epoch specifics.

> **s74 note:** **CRITICAL FIX — the app failed to open on Windows 10.** Root cause: `terminal.ts`
> did a top-level `import { spawn } from 'node-pty'` (eager native load), and `ipc.ts` imports the
> terminal service at module top, which runs during `registerIpcHandlers()` **before the window is
> created**. If the packaged `node-pty` binary is missing / wrong-ABI (exactly what a build without
> a correct native rebuild produces), that import **throws and the whole app dies before any window
> appears**. **Fix:** node-pty is now a **type-only import** + loaded **lazily via a guarded
> `require`** the first time a terminal is created; if it can't load, the terminal is disabled with
> a clean error (`ipcMain.handle` → renderer rejection) but **the app opens normally**. Also
> hardened startup: `registerIpcHandlers`, `startBackendSync`, and `validateServiceGraph` are
> wrapped in try/catch so no subsystem can block `createMainWindow`, and `uncaughtException` /
> `unhandledRejection` are now logged (no more silent death). **Builds default to x64-only** now
> (electron-builder.yml + build-axiom-exe.cmd + CI matrix + Gemini prompt) per user request.
> **Counts unchanged (212.5/290)** — this is a launch-blocking bug fix, not a phase.

> **s73 note:** **(1) UI polish** — applied the **Part 6.3 syntax palette** + spec editor ramp to
> both Monaco themes (`monacoEnv.ts`): the 8-color low-saturation token set (plain #C4CAD3 /
> keyword #8B9DE0 / string #9FC08A / number #D6A87A / function #C9B98E / type #7FB8C4 / comment
> #5A616B / punctuation #8A929E), blue caret + selection (was violet), `bg.editor` canvas, faint
> gutter numbers. Wired the ad-hoc CSS transitions to the **`--motion-*` tokens**. (The
> AI-provenance gutter ribbon `--ai` remains — it's a Monaco decoration tied to the AI-edit flow,
> deferred honestly.) **(2) Actual installer build ATTEMPTED** (network is reachable; Electron
> 33.2.0 downloaded fine). It could **not** produce verified binaries here — three concrete,
> reproduced blockers: **(a)** in this npm-workspaces monorepo, electron-builder's own "installing
> production dependencies" step **prunes the hoisted `node_modules`, deleting `7zip-bin`** (its
> compression tool) → `ENOENT … 7za.exe` (reproduced twice, even after restoring it); **(b)** **no
> MSVC C++ toolchain** — `node-pty`'s native addon can't compile against Electron's ABI (no
> `cl.exe`, no Visual Studio, `npm install` of node-pty exits 1, no `pty.node`); **(c)** headless —
> a GUI Electron `.exe` can't be launch-verified here even if produced. **The signed x64 + arm64
> installers must be built on a Windows dev machine** (VS Build Tools "Desktop development with
> C++" + Python 3, then `cd "AXIOM EXE"; ./build-axiom-exe.ps1`). Repo restored to GREEN after the
> attempt. **Counts unchanged (212.5/290).**

> **s72 note:** COMPLETED the first full **UI/UX design-spec alignment pass** — Parts 12–18 (the
> PDF's final 7 parts; the document has only 18, so "12–25" = 12–18). **Part 14 Motion:** added the
> closed motion system to tokens (`--ease-standard/entrance/exit/inout/linear` +
> `--motion-instant…deliberate` = 0/100/140/160/220/320ms; no spring/bounce; nothing > 320ms);
> reduced-motion already enforced. **Part 13 Components:** aligned the primitives — buttons (28px,
> radius.sm, weight 500, accent press, `shadow.focus` ring, motion-fast), dialogs (bg.raised +
> elevation.3 + 480px + bg.void 40% scrim), text inputs (radius.sm + border + bg.overlay + focus
> ring), toasts (bg.raised + elevation.2 + 4px signal edge + 360px), 6px state dots. **Parts
> 15/16 (a11y/keyboard):** confirmed satisfied — the `shadow.focus` ring, the contrast linter,
> non-color-reliance (signal + glyph), reduced-motion, and the keybinding system + keycaps.
> **Part 18 governance:** the program removed the key "looks-AI-generated" tells (the accent-blue
> status bar, a hardcoded editor/terminal color, off-grid chrome) and enforced monochrome +
> token-only. **Parts 12/17** consume the updated tokens. **Counts unchanged (212.5/290 — no phase
> inflated).** The full 18-part design system is now aligned; remaining is deep per-pixel/motion
> wiring + the AI-provenance gutter ribbon + syntax palette (Monaco/runtime), then the signed
> `.exe` on the user's machine.

> **s71 note:** continued the **UI/UX design-spec alignment** program (user directive: UI
> before EXE). Aligned **Parts 3–11** (9 parts) of `axiom_pdf.txt` to the app, all through the
> token system + `global.css` (no CSS in `.tsx`). **Part 3/4/5 (frame + chrome):** chrome-sizing
> tokens set to the spec frame inventory — title bar 28, activity bar 48 (40px items), sidebar
> 280 (220–560), status bar 24, panel 280 (120), + new `--ai-sidebar-w` 380 (300–720), header 32,
> tab strip/toolbar 36, tree row 24, menu 28, breadcrumb 28, editor floor 360; `layout.tsx`
> default sidebar 264→280 / min 180→220; the **activity bar** now recedes to bg.base with a 2px
> inner-edge accent indicator + muted/strong icon states. **Big fix:** the **status bar** was
> accent-blue (a Constitution violation) → now recedes to bg.base with muted text + hairline top.
> **Part 6:** active editor tab connects to bg.editor + fg.strong + accent top edge; 6px dirty dot.
> **Part 7:** tree rows use fg.default + radius.sm + bg.overlay hover + active accent left-edge;
> icons monochrome; git decorations routed through signal tokens. **Part 8:** terminal fixed a
> hardcoded `#0e0e11` → bg.panel token; dock tab row 32px. **Part 10:** command palette → bg.raised
>
> - radius.md + elevation.2 + a bg.void 24% scrim. **Parts 9/11:** hairline separators; already
>   token-aligned. **Counts unchanged (212.5/290 — no phase inflated):** this is design-spec
>   alignment tracked separately from the 290 PRD phases. Remaining UI: Parts 12–18 + deep
>   per-pixel/motion/latency polish (needs runtime measurement).

> **s70 note:** kicked off the **UI/UX design-spec alignment** program against the 74-page
> "AXIOM — UI/UX Product Requirements Document" (extracted to `axiom_pdf.txt`) and built the
> **AXIOM EXE installer kit**. **UI foundation (Part 2 Design Token System):** aligned
> `settings/themes.ts` (runtime source of truth) + `styles/tokens.css` (fallback) to the spec's
> **Graphite Dark** neutral ramp; switched the default accent from violet to the spec's single
> **restrained blue `#3B82F6`** (violet `#8B7FF0` is now reserved ONLY for AI provenance); added
> semantic **signal** colors, **elevation** tokens + a two-layer **focus ring**, corrected radii
> (md 6 / lg 8), and added the Inter / AXIOM-Mono **type scale** — all non-breaking (legacy token
> names re-valued or aliased). **AXIOM EXE kit:** `apps/desktop/electron-builder.yml` now targets
> **x64 + ARM64** on Win10/11 with a branded NSIS wizard — license page (EULA) +
> `build/installer.nsh` prerequisite/environment checks (Win10/11 guard, 64-bit guard, VC++
> runtime provisioning) — output to `AXIOM EXE/dist`, plus `AXIOM EXE/BUILD.md` and a
> one-command `build-axiom-exe.ps1`. **The `.exe` binary is produced on the user's Windows
> machine** (electron-builder + node-pty native rebuild + optional cert); the sandbox cannot emit
> a binary. **Counts unchanged (212.5/290 — no phase inflated):** this is design-system +
> packaging foundation. The remaining UI-UX parts (3–18: layout, screens, AI surfaces, component
> system, motion, a11y) are a multi-session program tracked separately from the 290 PRD phases.

> **s69 note:** activated **Epoch E cloud delivery** now that the Supabase backend went
> live in s68. Wired the desktop client to the deployed schema + Edge functions and moved
> **three phases partial→done**. **(120) Offline Persistence & Sync Engine:** the
> preferences sync engine now runs a full cloud lifecycle — an initial reconcile, a
> Supabase **Realtime** subscription on `user_settings` that pulls + LWW-merges on remote
> changes (burst-debounced via a pure `shouldPullNow` gate), and a periodic flush
> (push/pull/LWW already existed; a stale "no-op" docstring was corrected). **(126)
> Telemetry Upload Pipeline:** the local buffer now uploads to the deployed
> `telemetry-ingest` Edge function under the signed-in user — batched, **sampled**
> (crash reports never dropped), consent-gated, with a remote **kill switch** (feature
> flag), backoff, and a FIFO reconcile on full success (a pure `toIngestBody` fixes the
> client↔Edge shape). **(129) Feature Flags:** flags now **fetch** from the deployed
> `feature-flags` function, **subscribe** over Realtime, and **cache** to disk — fail-safe
> (offline → cache → compiled defaults). A new `backendSync` orchestrator starts all three
> loops off the first-paint path and re-kicks a reconcile on sign-in. Also **deepened (127)
> Analytics Instrumentation** (stays partial): a reviewed **event-schema registry** + a
> **no-PII/no-code validator** (drops undeclared / wrong-typed / bad-enum / oversized props)
>
> - registry-validated `recordAnalytics`, with `app_start` + `signin` instrumented. Net:
>   **161→164 done, 211.0→212.5/290 (~73%)**; Epoch E 19.0→20.5 (68%→73%). Every pure core is
>   Node-smoke-verified (11/10/9/13); the live cloud round-trip needs a signed-in app (the
>   sandbox cannot exercise a live backend), so 120/126/129 are recorded on
>   deployed-backend + complete-client + verified-offline/fail-safe evidence. Remaining big
>   lever: the **signed installer `.exe`** (needs a cert + electron-builder toolchain on the
>   user's machine/CI).

Fully-done-only view: 164/290 ≈ 57% strictly complete.

---

## Per-epoch breakdown

| Epoch     | Theme                             | Phases       | Done    | Partial | Missing | Weighted  | %        |
| --------- | --------------------------------- | ------------ | ------- | ------- | ------- | --------- | -------- |
| A         | Foundation & Tooling              | 1–20 (20)    | 7       | 10      | 3       | 12.0      | 60%      |
| B         | Core Workbench & Editor           | 21–48 (28)   | 23      | 4       | 1       | 25.0      | 89%      |
| C         | Rust Core & Indexing              | 49–72 (24)   | 12      | 10      | 2       | 17.0      | 71%      |
| D         | Dev Tooling (Term/Git/LSP/Debug)  | 73–104 (32)  | 18      | 11      | 3       | 23.5      | 73%      |
| E         | Identity & Backend (Supabase)     | 105–132 (28) | 19      | 3       | 6       | 20.5      | 73%      |
| F         | AI Engine                         | 133–170 (38) | 17      | 16      | 5       | 25.0      | 66%      |
| G         | Core AI Features                  | 171–200 (30) | 29      | 1       | 0       | 29.5      | 98%      |
| H         | Agentic & Advanced AI             | 201–238 (38) | 34      | 1       | 3       | 34.5      | 91%      |
| I         | Extensions/Themes/i18n/A11y/Novel | 239–264 (26) | 5       | 21      | 0       | 15.5      | 60%      |
| J         | Hardening/Perf/Security/Release   | 265–286 (22) | 0       | 17      | 5       | 8.5       | 39%      |
| K         | Post-1.0 & Cross-Platform         | 287–290 (4)  | 0       | 3       | 1       | 1.5       | 38%      |
| **Total** |                                   | **290**      | **164** | **97**  | **29**  | **212.5** | **~73%** |

---

## What's DONE (strong areas)

- **Editor (Epoch B, 86%):** Monaco host, tabs, splits/groups, file tree + ops,
  command palette, quick open, keybindings + editor, settings UI, in-file
  find/replace, workspace search (ripgrep + Rust Core), status bar, notifications,
  session restore, recents, welcome.
- **Rust Core (Epoch C, 67%):** sidecar + NDJSON-RPC, ignore-aware walker, native
  watcher, Tree-sitter symbols, ripgrep search, SQLite catalog, semantic chunking,
  offline embedder + semantic retrieve, a file-level **knowledge graph** with
  dependency / dependent / transitive-impact / cycle analysis (s10) surfaced in a
  **Dependencies panel** (s11), and **automatic project understanding**
  (frameworks, languages, scripts, monorepo; s12).
- **Terminal + Git (Epoch D):** xterm + node-pty terminal (multi/split/profiles),
  isomorphic-git status/stage/commit/branch/diff/log/init, SCM view, diff editor,
  Problems panel, **LSP** for TS/JS (hover, completion, diagnostics, definition,
  type-definition, implementation, references, highlight, rename, signature help,
  code actions, document symbols, inlay hints, formatting) + JSON/CSS/SCSS/LESS/
  HTML (diagnostics, completion, hover, formatting) via a multi-server registry
  (typescript-language-server + vscode-langservers-extracted; sessions 4–9).
- **Identity & onboarding (Epoch E):** **Google-OAuth-only** sign-in via the
  system browser (loopback + PKCE), refactored into dedicated modules (Supabase
  client / Google OAuth handler / session manager / OS-encrypted session store /
  auth-service facade / renderer auth state), with server-side **session
  validation**, offline-tolerant restore, auto-refresh, and clean logout (s23);
  plus the secret vault, account button, and a first-run **onboarding wizard** (s22).
- **AI chat (Epoch F/G):** streaming chat with native **OpenAI, Anthropic, and
  Gemini** adapters (any OpenAI-compatible/custom endpoint too), model fetch,
  test-connection, conversation history, **per-turn token usage, estimated cost,
  and latency** (s13), **automatic context grounding** (active file, semantic
  retrieval, and graph dependencies, token-budgeted; s14/s18), **inline editor
  actions** (Explain/Refactor/Fix/Add Docs on a selection; s18), and a **spend
  ledger + dashboard** with an optional daily budget (s18).
- **Debugger (Epoch D, Phases 96–100):** a DAP client (Content-Length framing +
  the full initialize/launch/breakpoints/stepping/inspection handshake, verified
  against a live adapter), editor-gutter breakpoints, a Debug panel (run/step
  controls, call stack, variables, output), plus **watch expressions, conditional
  breakpoints / logpoints, and evaluate** in the Run & Debug view (s18/s21).
- **AI engine (Epoch F):** a provider registry with family-based adapter dispatch
  and **failover** across an ordered provider chain (s21), plus an **egress
  gateway** (every outbound AI request is policy-checked — HTTPS, or plain HTTP
  only to loopback — with host-only logging so API keys never leak, not even
  Gemini's query-string key), a **response cache** (TTL and LRU; identical
  requests replay for free), and per-host **rate limiting** (a token bucket)
  (s25), plus policy-based **model routing** that orders the provider chain by
  cost, latency, quality, privacy (prefer local), or required capability (s26),
  plus **long-term memory** (local curated notes, relevance-selected and injected
  into chat context; s27), plus **prompt management** (layered system prompts with
  non-overridable guardrails, injection-safe interpolation, and versioned
  templates; s28), plus **code-skeleton context compression** (large dependency
  files reduced to signature-level structure to fit the budget; s29), plus
  **reasoning-model support** (extended-thinking / reasoning-effort params —
  OpenAI reasoning_effort, Anthropic thinking budget — auto-enabled only for
  reasoning-capable models and off by default, so non-reasoning models are
  unaffected; s30), atop streaming chat, cost and token tracking, and the
  context builder.
- **Agent (Epoch H):** a provider-agnostic, tool-using agent — a ReAct loop with
  read-only tools (read file, list dir, search, project profile) and
  **approval-gated actions** (write_file, replace_in_file, run_command), now with
  a **plan-first phase** (the agent drafts an ordered plan, surfaced in the panel,
  before it acts; s25) and a **diff preview** on every write approval (a real
  unified diff of the pending change instead of a blind confirm; s25), streaming
  each tool step then the final answer, plus an **agent library** of specialized
  presets (coder, reviewer, researcher, test-writer, documenter — each a persona
  with a scoped tool set; s26) and **sub-agents** (delegate a focused, read-only
  research/review sub-task, depth-guarded; s27), and a **task queue** (background
  and parallel runs tracked with live status and cancel in an Agent Tasks panel;
  s28), and **custom agents** (user-defined personas with scoped tools, created in
  the panel and merged into the library; s29), and a **code-review agent**
  (reviews the active file into structured, severity-tagged findings —
  blocker/major/minor/nit with category, line, rationale, and a suggested fix —
  in a Code Review panel with click-to-line; s30), via a Chat/Agent toggle in
  the AI panel (s21/s22/s24/s25/s26/s27/s28/s29/s30). Plus **workflow automation &
  hooks** (236 — a pure rule engine with event triggers, glob scoping, chained
  plan→implement→test→review→doc pipelines with human gates and a pre-run cost
  estimate; a Workflows panel runs a pipeline as an approval-gated agent task, and
  on-save matching notifies rather than auto-running) and an **MCP client** (237 —
  a JSON-RPC-over-stdio client that connects configured Model Context Protocol
  servers, discovers their tools, and bridges them into the agent registry as
  approval-gated tools whose output is treated as untrusted data; an MCP panel to
  add / enable / connect servers) (s37). Plus a full **specialized-agent library** —
  research (221), testing (223), bug-fix/debugging (224), and graph-grounded
  refactoring (225), backed by a read-only **graph_impact** agent tool; **workspace
  rules & standards** (233 — `.axiom/rules/*.md` + global + AGENTS.md/.cursorrules,
  glob/priority scoped, non-overridable guardrails, injected into chat generation);
  a **prompt library** (234 — reusable `{{variable}}` prompts, tags, search, a
  composer picker, usage stats); and the **reliability differentiators** (238 —
  KG-aware refactor-safety blast-radius in graph_impact, a grounded-answer strict
  mode that flags uncited Ask answers, and agent evals — success rate / avg steps /
  per-preset — in the Agent Tasks panel) (s38). Plus the **remaining specialized
  agents** — documentation (226), architecture (227), deployment (228, high-risk-
  gated, never auto-deploys), dependency/security (229), and migration (230) — a
  read-only **graph_impact** tool, and **Git AI** (231 — Conventional-Commits commit
  messages generated from the staged diff, wired into the SCM view) (s39). The full
  specialized-agent library (research, review, testing, bug-fix, refactor, docs,
  architecture, deployment, dependency/security, migration) plus Git AI now ships.
- **Themes & visual a11y (Epoch I, partial):** a pure WCAG **contrast linter**
  (relative luminance / contrast ratio / AA-AAA levels) that validates the active
  theme + accent, **VS Code color-theme import** (into Axiom tokens), and visual-
  accessibility prefs — **UI density, zoom, and reduced-motion** (Appearance
  settings, applied to the workbench root; reduced motion honors the OS) (247/248/255
  partial, s39).
- **Perf & security tooling (Epoch J, partial):** a pure **performance-budget
  engine** (pass/warn/fail against SLO targets with tolerance) surfaced in a
  Performance panel that measures real in-app metrics (navigation timing + heap),
  and a local **secret scanner** (AWS/GitHub/OpenAI/Google/Slack/private-key +
  hard-coded-secret patterns, redacted previews) in a Security panel that scans the
  active file (265/271 partial, s39).
- **Audit log (Epoch E / Part X §187):** a local, append-only, **hash-chained**
  (tamper-evident) audit log of trust events (agent runs and approvals,
  secret/provider config changes), with a verify pass that pinpoints any altered
  or deleted entry, surfaced in a collapsible Explorer panel; never records
  secrets or code (s26).
- **Privacy & telemetry (Epoch E §52–53):** opt-in, default-off telemetry consent
  (crash / analytics / performance toggles in Settings) feeding a sanitized, gated
  **local buffer** — events carry only bucketed numbers, booleans, and short enums
  (never code, prompts, or free text), and a disabled category records nothing (s27).
  Plus a **feature-flags client** (compiled fail-safe defaults, version/OS
  targeting, stable percentage rollout, kill switches) that gates features like
  sub-agents, with an Experiments viewer (s28). Plus **data export** — save a
  redacted JSON bundle of your local data (settings, memory, custom agents, flags,
  audit summary); never includes API keys or code (s29). Plus a **preferences
  sync engine** — a local last-writer-wins mirror with an offline write queue
  (conflict resolution, additive merge, queue coalesce and reconcile) that backs
  up settings locally now and activates cross-device cloud sync once a backend is
  configured; nothing leaves the device until then (s30).
- **Foundation:** monorepo + Cargo workspace, shared kernel, hardened Electron
  (sandbox/contextIsolation/CSP), typed IPC, local settings, design tokens/themes.
- **Trust substrate (Epoch G):** the reversible-edit foundation every AI edit
  feature builds on — a **snapshot & checkpoint system** (content-addressed local
  store with sha256 dedup, an AI-change timeline, one-click file/checkpoint
  restore, TTL + count pruning with object GC; Checkpoints panel; s31), a **safe
  edit engine** (staged edits validated as an all-or-nothing batch, stale-hash
  conflict rejection, snapshot-before-apply, atomic temp+rename writes, and
  automatic rollback on any failure; s31), and a **visual diff review** model
  (one shared line-diff engine, hunk grouping, and per-hunk accept/reject that
  reconstructs the exact resulting text) wired into the Checkpoints panel so a
  checkpoint's changes can be reviewed hunk-by-hunk and applied through the
  safe-edit engine (s31).
- **Everyday AI (Epoch G):** **slash commands** in chat (`/explain`, `/fix`,
  `/tests`, `/docs`, `/review`, `/plan`, `/search` — an autocomplete menu in the
  composer, expanded to the versioned prompt templates on send; s32); an
  **approval workflow & guardrails** engine (action classes read/write/exec/
  network/git-write × autonomy levels manual/guided/autopilot → allow/ask/deny,
  with per-class overrides and a high-risk-command safety net, wired into the
  agent loop and exposed as an "Agent autonomy" setting; guided default preserves
  today's approve-writes behavior; s32); and **code explanation** at a chosen
  depth (brief / normal / deep, with line citations) from the editor's right-click
  / command palette, streamed through the grounded chat (s32). Plus the chat
  surface itself: **code-block actions & citations** (create/update the file a code
  block declares — through the Safe Edit Engine, so it is snapshotted — and
  clickable `file:line` citations), **`@`-mention context** (autocomplete workspace
  files into chat attachments, with @selection/@repo/@git/@terminal/@problems
  sources), and **model A/B compare** (run one prompt against two models side by
  side, streams routed by message id) (s33). Plus the **multi-file Composer**: describe
  a change, the model returns a coordinated create/modify/delete plan, which is
  shown as a per-file, per-hunk **review** (accept/reject) and applied as ONE
  all-or-nothing Safe-Edit batch (single snapshot), with an **iterative refine**
  input that revises the plan from feedback (s34). Plus **inline completion (ghost
  text)** — a Monaco inline provider that requests a short AI completion when typing
  pauses (debounced, cancellable, LRU+TTL cached; off by default for cost; a
  priority setting arbitrates with IntelliSense so they coexist), **next-edit
  prediction** (after a single-token rename it finds the other occurrences and
  offers "Propagate Rename"), and **dependency-aware Composer context** (the
  knowledge graph's importers + impact are pulled in so cross-cutting edits update
  call sites) (s35). Plus **chat history, threads & search** (179 — full-text search
  across titles and message bodies, pinned-first ordering, inline rename, and
  Markdown/JSON export from a searchable history overlay), a **context manifest &
  cost footer** (181 — a collapsible "what was sent" breakdown with per-part token
  estimates, plus the model in the per-turn footer), and **inline edit (Cmd-K)**
  (187 — describe a change to the selection and get a snapshot-protected, reviewable
  inline diff to accept / reject / refine) (s36). Plus the **AI chat shell + Ask
  mode** (175–176 — a Chat/Ask toggle where Ask is a read-only, grounded Q&A that
  forces workspace context and answers with citations, no edits) and **inline chat**
  (188 — an anchored Cmd-I bubble for a quick local question that escalates to the
  Cmd-K inline edit) (s37). Epoch G is now ~97%, essentially complete.

## Biggest MISSING blocks (drive the remaining ~47%)

- **LSP** (89–95): TS/JS full language features (s4–s7); multi-server registry
  with bundled JSON/CSS/SCSS/LESS/HTML servers (s8, Phase 90); go-to
  type-definition and implementation (s9, completing §108 navigation).
  Monaco-standalone ceiling: call/type hierarchy (95) has no
  `registerCallHierarchyProvider` (needs a custom panel); semantic tokens (94)
  need legend plumbing vs lazy server start; code lens (94) needs tsserver
  config. Also remaining: Python/YAML/Markdown servers and on-demand install.
  **Debugger/DAP** (96–100): DAP client (verified against a live adapter),
  gutter breakpoints (+ conditions/logpoints), stepping, call stack, variables,
  watch/evaluate, and a Debug panel are done (s18/s21); bundled per-language
  adapters and remote / multi-session debugging (101) remain.
- **AI Engine internals** (Epoch F): native OpenAI/Anthropic/Gemini streaming
  adapters, per-turn token and cost tracking (151), an automatic context builder
  (153, graph-aware), spend budgets and a dashboard (152/197), a **provider
  registry and failover** (135/165/167, s21), an **egress gateway, response cache,
  and rate limiter** (s25), **policy-based model routing** (165/§73, s26),
  **long-term memory** (160–162, s27), **prompt management** (163/164, s28), and
  **code-skeleton context compression** (§69.5, s29), and **reasoning-model
  support** (149, s30) all exist; the AI engine is now largely complete —
  remaining F items are engine polish, native per-provider streaming adapters,
  and long-tail model phases. **Prompt / context caching** (157) landed partial
  (s52 — `common/promptCache.ts`: stable-prefix segmentation + cache-key +
  cached-vs-fresh token/savings model + per-provider directives, wired to send an
  Anthropic `cache_control` breakpoint on a large stable system prefix; full
  hit-accounting in the spend ledger + Gemini cachedContent handles remain).
  **Context sources & prioritization** (155) landed partial (s53 —
  `common/contextSources.ts`: a ten-source taxonomy with per-source budget shares +
  hard caps, proportional `allocateBudget` with redistribution, and `rankAndSelect`
  → an included/dropped/bySource manifest; wired main-side into `contextBuilder.ts`
  as a non-invasive source-budget plan surfaced in the context header; replacing the
  builder's selection with the allocator + richer source feeds landed in 154, below).
  **Context source providers** (154) landed partial (s54 —
  `common/contextSourceFeeds.ts`: eight source adapters (rules / selection /
  attachments / open files / recent edits / symbols / memory / repo map) →
  `SourceItem[]`, plus `prioritizeItems` (pinned-kind budget reservation +
  `rankAndSelect`) and `composeSources`; wired into `contextBuilder.ts` so the
  prioritizer now DRIVES selection — the active file is pinned, two new provider feeds
  (project-understanding repo map + active-file symbols) join active / retrieval /
  dependency, and the Phase 156 fitter runs after on the survivors; renderer-supplied
  rules / recent-edits / memory feeds remain). **AI safety layer** (170) landed partial
  (s55 — `common/aiSafety.ts`: prompt-injection / jailbreak heuristics + secret / PII
  detection with Luhn-gated card matching and never-echoed (masked) previews +
  `redact` / `sanitizeForEgress` + `scanUntrusted` / `scanEgress` + an `evaluateEgress`
  allow/sanitize/block decision; wired non-mutating main-side — the egress gateway
  audits outbound bodies for leaked HIGH-severity credentials, and the context builder
  flags indirect prompt-injection in untrusted grounding content; active
  redaction/blocking behind a future policy setting remains). **Cost-aware autopilot**
  (261) landed partial (s56 — `common/costAutopilot.ts`: complexity+risk capability
  floors, `planAutopilot` builds a cheapest-viable-draft → escalate ladder within a
  per-task/remaining budget, `shouldEscalate` (verification-failed / low-confidence /
  high-risk) + `nextModel`, and an `autopilotOrder` comparator; wired as a new
  **'autopilot' routing policy** (`common/routing.ts`) so the failover chain orders
  draft-cheap → escalate, selectable in the AI panel; the live draft-then-escalate loop
  landed s57 (`common/autoEscalate.ts` + `agent.ts`: the run holds a mutable model over a
  provider-model ladder and escalates to the next rung on a failed self-verification —
  budget-capped cross-provider escalation + mid-stream confidence signals remain, so 261
  stays partial).
- **Agentic** (Epoch H): a tool-using **agent runtime** (ReAct loop), read-only
  tools, **approval-gated write and command tools** with a **diff preview** of
  each pending edit (s25), a **plan-first phase** (s25), an **agent library** of
  presets (s26), **sub-agents** (depth-guarded delegation, s27), a **task
  queue** with background/parallel run tracking (s28), **custom agents**
  (s29), and a **code-review agent** (222, s30), plus **workflow automation & hooks**
  (236) and an **MCP client** (237, s37), plus the **specialized-agent library**
  (research/testing/bug-fix/refactoring 221/223/224/225), **workspace rules** (233),
  a **prompt library** (234), the **reliability differentiators** (238 — refactor
  safety, grounded-answer mode, agent evals), the full **specialized-agent library**
  (221/223/224/225/226/227/228/229/230), **Git AI** (231), **planning mode** (214),
  **thinking mode** (215), and the **agent-library UI + invocation** (232) are done
  (s21/s22/s24/s25/s26/s27/s28/s29/s30/s37/s38/s39/s40/s48/s49); Epoch H is now
  ~88% — background + parallel agents now run under a main-process bounded pool
  (218/219 done, s49). Remaining: agent run persistence/resume + timeline depth
  (209 done / 210 partial — s55 deepened the RESUME half with `common/runResume.ts`:
  a replay-safe checkpoint model over the journal — completeStep / planResume /
  `checkpointFromRun` — that skips completed (esp. side-effecting) plan steps on
  resume, wired main-side as `listResumableRuns` + `buildResumePlan` + an
  `agent:runsResumable` IPC; resume EXECUTION + a run-history UI remain, so 210 stays
  partial); the autonomous-loop controller landed (216 partial, s50 — full
  multi-file autonomy that drives successive passes remains). Resume/branch EXECUTION
  deepened (s56 — `common/runReinvoke.ts`: `buildResumeReinvoke` / `buildBranchReinvoke`
  compose a self-contained task from the journal-derived resume/branch context, wired as
  `buildRunReinvoke` + an `agent:runReinvoke` IPC so a fresh run can be seeded via the
  proven `agent:run` path; s57 shipped the run-history UI actions in TasksView (a
  **Resume** button + per-step **"Redo here"** branch buttons that call
  `runs.reinvoke` → `agent.run`, via `common/runsView.ts`), so resume/branch are now
  end-to-end; true event-log replay that skips completed side-effecting steps in the new
  run remains, so 210 stays partial).
- **Backend data** (Epoch E): a local hash-chained **audit log** (s26), opt-in
  **telemetry consent + local buffer** (s27), a **feature-flags client** (s28),
  and **data export/portability** (s29), and the local **preferences sync engine**
  (mirror + offline write queue, LWW conflict resolution; s30) are done. The Postgres
  schema, RLS policies, and Edge functions were **deployed live** by the user (115/116/118
  done, s68). s69 then wired the desktop client to that live backend: the **sync engine**
  cloud lifecycle (Realtime `user_settings` subscription + reconcile; 120 done), the
  **telemetry upload** pipeline (authenticated `telemetry-ingest` POST + sampling + remote
  kill switch + backoff; 126 done), and **Realtime feature-flag delivery** (fetch +
  subscribe + disk cache, fail-safe to compiled defaults; 129 done). Remaining E: Storage
  integration (119), settings/artifact sync depth (121/125), profile + device-management
  UIs (122/123), backend abuse controls (130), and full analytics-instrumentation coverage
  (127 partial — the event-schema registry + no-PII validator landed s69).
- **Infra (Epoch A):** the auto-update **check** client + channel policy +
  hash-verify + restart policy landed (17 partial, s51 — download/apply/signing +
  staged rollout remain, Epoch J); **CI/CD pipeline scaffolding** (2) landed partial (s59 —
  `common/ciPlan.ts`: a CI workflow model + validator + GitHub Actions YAML renderer, emitting a
  usable `.github/workflows/ci.yml` that runs typecheck / format:check / build; CD — release /
  deploy / signing / on-runner execution — remains). The **DI container / service registry**
  (8) landed partial (s58 — `common/serviceRegistry.ts`: typed register/resolve/singleton/dispose
  - cycle detection + a static `validateGraph`, wired as a startup service-graph validation in
    `main/services/serviceGraph.ts`; migrating each service's construction onto the container
    remains). Crash-recovery
    journal (s42), telemetry buffer, and feature-flags client are done (s27/s28/s42).
- **Knowledge graph** (65–68): file-level import graph + dependency / impact /
  cycle analysis + query API + Dependencies panel (s10–s11) + project
  understanding (68, s12) done; symbol-level edges (65), NL graph Q&A, and
  interactive graph visualization (§127.3) remain.
- **Core AI features** (Epoch G): the trust substrate — **snapshots** (171),
  **safe-edit engine** (172), and **visual diff review** (173) — is done (s31),
  plus **approval workflow** (174), **slash commands** (180), **code explanation**
  (191, s32), **code-block actions & citations** (178), **`@`-mention context**
  (177), and **model A/B compare** (182, s33), plus the **multi-file Composer**
  with per-hunk review + refinement (193/195/196, s34), plus **inline completion +
  IntelliSense coexistence + next-edit prediction** (183–186) and **dependency-aware
  edit targeting** (194, s35), plus **chat history/threads/search** (179), the
  **context manifest + cost footer** (181), and **inline edit (Cmd-K)** (187, s36),
  plus the **chat shell + Ask mode** (175–176) and **inline chat** (188, s37);
  Epoch G is now ~97% (essentially complete). Semantic search (190) already ships;
  the small remainder is quick-actions/hover/lightbulb polish (189) and long-tail
  §144–§151 items.
- **Release (Epoch J):** perf gates, security tests, pen-test. **Installer**:
  electron-builder NSIS wizard config + scripts + branding assets are done (s22)
  and verified up to the packaging step; producing the signed `.exe` needs a
  code-signing cert (CSC_LINK), an `icon.ico`, node-pty native rebuild, and the
  electron-builder toolchain binaries (absent in this sandbox).
- **Extensions, i18n, most a11y, novel AI systems** (Epoch I): the WCAG contrast
  linter, VS Code theme import, and visual-a11y prefs (density/zoom/reduced-motion)
  landed (247/248/255 partial, s39), plus the **extension foundation** — manifest +
  capability broker (242), contribution registry (240/241 partial) — and now the
  supervised **extension host runtime** (239, s41, crash-isolated + brokered) and
  **i18n infrastructure** (250, s41 — catalog + ICU subset + hard-coded-string lint);
  still missing are the extension marketplace federation (243/244/246; 245
  management landed partial s50 — bulk update + recommendations + workspace
  enablement), RTL/CJK depth (251) and more locales (252 partial s51 — a
  coverage + human-review pipeline + English-fallback merge + a first in-progress
  Spanish locale landed), screen-reader/editor a11y (253–254; s52 deepened 254
  with `common/audioCues.ts` — WebAudio notification cues gated by an
  `a11y.audioCues` setting; s54 deepened the **component a11y audit** (253) with
  `common/a11yRules.ts` — a serializable `A11yNode` tree descriptor + a nine-rule
  WCAG/ARIA pack (icon-only control name, img alt, control label, positive tabindex,
  keyboard focusable/handler, duplicate id, heading-order skip, and low-contrast via
  the theme contrast linter) + `auditTree`/`summarizeAudit`, wired into
  `A11yAuditView` over a sampled live-DOM tree rendered as a roving-tabindex listbox;
  253 stays partial — a real runtime axe scan + a full screen-reader pass remain out
  of the sandbox), and the novel AI systems (256–264 — s55 landed the first, **256
  Time-Travel Agent Review**, partial: `common/timeTravel.ts` builds a scrub timeline
  (side-effect + branchable annotations) and `planBranch` "redo from step N" plans that
  preserve the kept prefix as history (never re-executed), wired main-side as
  `buildRunBranch` + an `agent:runBranch` IPC; s57 shipped the scrubber UI + branch
  execution (the TasksView run timeline + per-step "Redo here" buttons that run a branched
  agent), so 256's remaining is true event-log replay; and **Local-First Autonomy** (262)
  landed s57 partial — `common/localFirst.ts`: capability-fit gating (`decideLocalFirst` →
  fit / marginal / unfit / no-local vs the autopilot answer floor) with a transparent
  remote fallback + offline-only mode, wired as a run-start local-first readout in
  `agent.ts`; full local-first routing that picks a local model at run start remains; and
  **multi-model debate/critic** (257) landed s58 partial — `common/debate.ts` parses critic
  findings into a merged verdict (accept / revise / reject) + disagreements + a self-consistency
  `consensus`, wired into code-review so `reviewCode` yields a verdict shown in ReviewView; full
  multi-model proposer+critic orchestration remains); **convention learner** (260) landed partial (s56 —
  `common/conventionLearner.ts`: infers indentation / quote style / semicolons /
  identifier casing from a workspace sample as dominant-ratio conventions gated by
  evidence + confidence, nudged by accept/reject edit feedback, and `proposedToRule`
  turns them into workspace rules; wired as `proposeConventions` + a
  `rules:proposeConventions` IPC that samples the repo — auto-gathering edit feedback +
  an approval UI remain); keymap **presets +
  profiles** (249) landed partial (s53 — `common/keymapProfiles.ts`: VS Code /
  JetBrains / Sublime / Emacs presets, order-independent + multi-chord conflict
  detection, and portable export/import profiles, wired to a `keymap.preset` setting
  - a live conflict readout in the Keyboard Shortcuts view; applying a preset's
    bindings app-wide + a profile-manager UI remain).
- **Perf & security (Epoch J):** an in-app perf-budget engine + Performance panel
  (265 partial), a local secret scanner + Security panel (271 partial — s59 added a
  dependency **license audit** `common/licenseAudit.ts`: SPDX category classification +
  allow/flag/deny policy over installed dependency licenses, in the Security panel),
  **security
  fitness functions** (270 partial), a **memory watchdog** (266 partial), and a
  **hot-path frame-latency** readout (269 partial, s49) landed (s39/s40/s49); still
  missing are CI perf gates on reference hardware (265), startup/
  V8-snapshot + large-file hardening (266/268), large-repo hardening depth (267
  partial, s50 — scale-tier policy + readout shipped; s58 added a scoped incremental indexer
  scheduler — priority by active/open/recency, budget-bounded batches; the 1M-file walker feeding
  it remains),
  full SAST/SCA/fuzzing +
  secrets/egress + RLS audits (271/272/273), the pen-test GA gate (274), and
  producing the signed installer on a real machine. **Recovery / resilience /
  chaos** (277) landed partial (s52 — `common/recovery.ts`: safe-mode / store-
  reset-rebuild-quarantine / bad-update-rollback decision core, consumed at
  startup via the crash journal; a real chaos-test harness — power-loss, corrupt-DB
  rebuild execution, network-loss failover — remains). A **compatibility matrix**
  (276) landed partial (s53 — `common/compatMatrix.ts`: an OS × arch × hardware-tier
  × GPU × shell × encoding support model + graceful-fallback plan + a cartesian
  matrix builder/summary, with a live `main/services/compat.ts` probe, a
  `compat:report` IPC, and a Performance-panel readout; real cross-hardware CI
  runners remain out of the sandbox). **Startup performance / deferred-init** (268)
  landed partial (s54 — `common/startupPlan.ts`: `planStartup` builds a
  dependency-respecting, phase-grouped schedule (critical / deferred / idle) via a
  priority topological sort with urgency promotion + cycle-safety, plus a
  critical-path budget verdict (≤ 1500 ms); wired main-side — the recorded pre-paint
  marks become the critical path with their real measured durations, the known
  post-paint init steps are classified deferred/idle, and the plan is logged at
  startup + surfaced in the Performance panel; a real V8 startup snapshot / blob needs
  build tooling outside the sandbox, so 268 stays partial).

---

## Session changelog

### Session 76 — 2026-07-10 (FIX: Google sign-in failed — "native WebSocket not found" in Electron's Node main)

- **Symptom (from the user's screenshot).** Clicking "Continue with Google" showed:
  `Error invoking remote method 'auth:signInGoogle': Error: Node.js detected but native WebSocket
not found. Suggested solution: Ensure you are running Node.js 22+ or provide a WebSocket
implementation via the transport option.`
- **Root cause.** Electron 33's main process runs on **Node 20**, which has no global `WebSocket`.
  `@supabase/realtime-js` (pulled in by the client — for realtime auth-token propagation and the s69
  Realtime feature-flag/sync channels) requires a `WebSocket`; without one it throws, and the throw
  surfaced on the sign-in IPC call.
- **Fix.** `main/services/supabase.ts` now polyfills `globalThis.WebSocket` with the **`ws`** package
  via a guarded lazy `require` before creating the client (best-effort — if `ws` is somehow missing,
  it logs and continues; auth + HTTP still work, only realtime degrades). Added `ws@^8.18.3`
  (dependency) + `@types/ws@^8.18.1` (devDependency); installed (ws 8.21.0).
- **Counts unchanged (212.5/290)** — a runtime bug fix, not a phase.
- **Gates (all green):** typecheck 0 `error TS`; prettier clean; build 3 bundles (renderer 13.02s);
  no temp files.
- **Action for the user:** rebuild the `.exe` (the build scripts run `npm install`, which fetches
  `ws`). If sign-in then shows a _different_ error (redirect mismatch), add `http://localhost:8770`
  to the Supabase Auth Redirect URLs allow-list + the Google OAuth console.

### Session 75 — 2026-07-10 (AI-provenance ribbon core + honest remaining-phase roadmap)

- **AI-provenance gutter ribbon (UI/UX PDF Part 6.2) — foundation.** New pure
  `common/aiProvenance.ts`: 1-based inclusive line-range tracking of AI-authored regions since the
  last commit — `mergeRanges` (coalesce overlap/adjacency, drop invalid), `addRange`,
  `shiftRangesOnEdit` (keeps ranges aligned as the user types above/inside/below), `toGutterDecorations`,
  `aiLineCount`. Node smoke 12/0. Added `.ai-provenance-gutter` CSS (a 2px `--ai` violet lane, Monaco
  `linesDecorationsClassName`). Wiring into EditorPane + the AI-edit apply flow + clear-on-commit is
  the remaining step (deliberately deferred to avoid destabilizing the editor just after the s74
  launch-crash fix).
- **Honest remaining-phase roadmap (user asked to "complete all phases").** ~79 weighted points
  remain. The completable-in-sandbox pool is nearly exhausted; the remainder is infra-gated and would
  be dishonest to mark done: Epoch J (code-signing cert + build machine/CI + reference hardware for
  perf/pen-test/chaos), Epoch E tail (live-backend round-trip confirmation = user), Epoch K
  (macOS/Linux need those platforms), and runtime tails in F/I/C. Documented so the path is explicit.
- **Counts unchanged (212.5/290)** — no phase inflated.
- **Gates (all green):** typecheck 0 `error TS`; prettier clean; build 3 bundles (renderer 23.00s);
  smoke 12/0 run + removed; no temp files.

### Session 74 — 2026-07-10 (CRITICAL: app-won't-open-on-Win10 fix — lazy/fail-safe node-pty + hardened startup; x64-only builds)

- **Symptom.** User's installed build did not open at all on Windows 10.
- **Root cause (diagnosed from code).** `main/services/terminal.ts` had a top-level
  `import { spawn } from 'node-pty'` — an eager native-module load. `main/ipc.ts` imports the
  terminal service at module top, and `registerIpcHandlers()` runs **before** `createMainWindow()`.
  If the packaged `node-pty` native binary is missing or ABI-mismatched (what a build without a
  correct per-Electron rebuild yields), the import **throws during startup and the app quits before
  any window is shown**.
- **Fix.**
  - `terminal.ts`: `node-pty` is now a **type-only import** (`import type { IPty }`) plus a lazy,
    `try/catch`-guarded `require('node-pty')` (`loadPty()`) invoked only when the first terminal is
    created. If it fails, `createTerminal` throws a clear error (surfaced to the renderer via
    `ipcMain.handle`) and the terminal is disabled — **the rest of the app runs**. `listShells`
    never touches node-pty, so shell discovery still works.
  - `main/index.ts`: wrapped `registerIpcHandlers()`, `initCrashJournal()`, `startBackendSync()`,
    and `validateServiceGraph()` in `try/catch` so no subsystem can prevent `createMainWindow()`.
    Added `process.on('uncaughtException')` + `unhandledRejection` logging so a stray main-process
    error is logged instead of silently closing the app.
- **Builds default to x64-only** (ARM64 dropped per user): `apps/desktop/electron-builder.yml`
  (`arch: [x64]`), `AXIOM EXE/build-axiom-exe.cmd` (`--x64`), `.github/workflows/build-installers.yml`
  (matrix x64 only), and `AXIOM EXE/GEMINI_BUILD_PROMPT.md` (x64 recipe; notes the app now launches
  even if node-pty fails).
- **Counts unchanged (212.5/290)** — a launch-blocking bug fix, not a phase.
- **Gates (all green):** typecheck 0 `error TS`; prettier clean; build 3 bundles (renderer 21.47s);
  no temp files. (Note: the actual .exe still builds on the user's machine / CI, but the app will
  now OPEN even if the terminal module can't load.)

### Session 73 — 2026-07-10 (UI polish: syntax palette + motion wiring; installer build attempted → blocked, documented)

- **UI polish.** `editor/monacoEnv.ts`: replaced both Monaco themes with the **Part 6.3 syntax
  palette** (8 low-saturation roles) + the spec editor ramp — `editor.background` #0E0F12
  (bg.editor), foreground #C4CAD3, **blue caret + selection** (`#3B82F6*`, was violet), faint
  gutter line numbers brightening on the active line, indent guides on border.subtle/strong,
  bracket-match on border.strong. `styles/global.css`: migrated the ad-hoc `transition: … 0.12s/
0.14s/0.25s ease` rules to the `--motion-fast/quick/slow` + `--ease-standard` tokens.
- **Deferred (honest):** the AI-provenance gutter ribbon (`--ai`) — a Monaco line-decoration keyed
  to AI-authored ranges, tied to the AI-edit flow; a real feature, not a CSS tweak.
- **Installer build — genuinely attempted, could not produce verified binaries here.** Network is
  reachable (GitHub 200; electron-builder downloaded Electron 33.2.0). Three concrete blockers,
  reproduced:
  1. **Workspace-hoisting prune.** electron-builder's "installing production dependencies" step
     prunes the hoisted root `node_modules` and deletes `7zip-bin` (its own compression tool),
     then fails at `chmod … win/x64/7za.exe` (ENOENT). Restoring `7zip-bin` (`npm i 7zip-bin
--no-save`, +347 pkgs) fixed it once, but the next run pruned it again — a monorepo/electron-
     builder interaction, not a code bug.
  2. **No MSVC C++ toolchain.** `node-pty`'s native addon must compile against Electron's ABI;
     there is no `cl.exe`, no Visual Studio, `npm install` of node-pty exits 1, and no `pty.node`
     is produced. Without it the packaged terminal cannot load.
  3. **Headless.** A GUI Electron `.exe` cannot be launch-verified in this sandbox even if built,
     so any binary produced here would be unverifiable (and, with node-pty broken, misleading).
- **Resolution.** The x64 + arm64 installers must be produced on a Windows dev machine with VS
  Build Tools ("Desktop development with C++") + Python 3, via the ready kit:
  `cd "AXIOM EXE"; ./build-axiom-exe.ps1`. The partial `AXIOM EXE/dist` from the attempt was
  removed; `node_modules` was restored (`npm install`).
- **Counts unchanged (212.5/290).** UI-UX alignment stays complete through Part 18; the build is
  infra-gated on a real toolchain (not sandbox-producible).
- **Gates (all green after restore):** typecheck 0 `error TS`; prettier clean; build 3 bundles
  (renderer 12.18s); no temp files.

### Session 72 — 2026-07-10 (UI/UX alignment COMPLETE: Parts 12–18 — full 18-part pass done)

- **Directive.** User asked for "Parts 12–25"; the PDF has **only 18 parts**, so this finished
  **Parts 12–18** — completing the first full alignment pass over the entire UI/UX PDF. Still no
  EXE. All via `tokens.css` + `global.css` (never CSS in `.tsx`).
- **Part 14 — Motion & Interaction Choreography.** Added the spec's closed motion system to
  `tokens.css`: easing `--ease-standard` (0.2,0,0,1) / `--ease-entrance` (0,0,0,1) / `--ease-exit`
  (0.4,0,1,1) / `--ease-inout` (0.4,0,0.2,1) / `--ease-linear`; durations `--motion-instant` 0 /
  `--motion-fast` 100 / `--motion-quick` 140 / `--motion-base` 160 / `--motion-slow` 220 /
  `--motion-deliberate` 320. No spring/bounce/elastic; nothing exceeds 320ms. Reduced-motion
  neutralizer already present (global.css). Buttons now use the motion tokens.
- **Part 13 — Component System.** Aligned the shared primitives: **buttons** (28px, radius.sm,
  type.ui.body weight 500, space-3 padding, `:focus-visible` → `--shadow-focus`, primary `:active`
  → accent.press, secondary/ghost → bg.overlay → overlay.strong, motion-fast fill); **dialogs**
  (bg.raised + elevation.3 + 480px + bg.void 40% scrim); **text inputs** (radius.sm + border.default
  - bg.overlay + UI font + focus ring); **toasts** (bg.raised + elevation.2 + 4px left signal edge
  - 360px); **state dots** 6px + radius.full + signal tokens (toast + problems). Command palette +
    context menus were already aligned in s71 / via tokens.
- **Parts 15 & 16 (Accessibility / Keyboard) — confirmed satisfied.** The universal `shadow.focus`
  ring, the WCAG contrast linter (`checkThemeContrast`), non-color-reliance (signal color + glyph),
  the reduced-motion path, and the keybinding system + keycap styling are all in place.
- **Part 18 — Quality Bar / Governance.** The alignment program removed the primary
  "looks-AI-generated" anti-patterns (18.3): the accent-blue status bar → monochrome, a hardcoded
  `#0e0e11` terminal color → token, off-grid chrome → the 4px grid, and enforced the monochrome +
  single-accent + token-only laws (18.4). Binding latency/motion budgets (18.1) need runtime
  measurement (not sandbox-verifiable).
- **Parts 12 & 17 (Agent workspace / Onboarding-Auth-Settings).** Consume the updated tokens
  (surfaces, accent, radius, elevation, type); no bespoke edits this pass.
- **Honesty.** No PRD phase count changed (still **212.5/290**). Remaining UI work is deep polish:
  wiring every component's transitions to the `--motion-*` tokens, the AI-provenance gutter ribbon
  (`--ai`, a Monaco decoration), the 8-color syntax palette (`monacoEnv.ts`), and a visual check of
  status-bar sub-items that assumed the old blue bar.
- **Gates (all green):** typecheck 0 `error TS`; prettier clean; build 3 bundles (renderer 12.52s);
  no temp files.

### Session 71 — 2026-07-10 (UI/UX design-spec alignment: Parts 3–11 aligned to the workbench)

- **Directive.** User: do the UI/layout now, not the EXE. Aligned **Parts 3–11** (9 parts) of the
  UI/UX PDF (`axiom_pdf.txt`) to the existing workbench, entirely through the token system +
  `styles/global.css` + `state/layout.tsx` (never CSS in `.tsx`).
- **Parts 3–5 (frame + navigation chrome).** `tokens.css` chrome sizing → spec frame inventory:
  `--titlebar-h` 28, `--activitybar-w` 48 (+`--activitybar-item` 40), `--sidebar-w` 280
  (`--sidebar-min-w` 220 / `--sidebar-max-w` 560), `--statusbar-h` 24, `--panel-h` 280
  (`--panel-min-h` 120), new `--ai-sidebar-w` 380 (300–720), `--sidebar-header-h` 32,
  `--tabstrip-h`/`--toolbar-h` 36, `--tree-row-h` 24, `--menu-item-h` 28, `--breadcrumb-h` 28,
  `--editor-floor-w` 360. `layout.tsx`: default sidebar 264→280, min 180→220. Activity bar
  recedes to bg.base + hairline + a 2px inner-edge (right) accent indicator (20px) + fg.muted /
  fg.strong icon states + 40ms hover. Sidebar header 35→32px; panel dock tab strip → hairline.
- **Status bar (5.4) — Constitution fix.** Was `background: var(--accent)` (a blue chrome bar,
  violating "monochrome, color = signal only"). Now recedes to bg.base with fg.muted text + a
  hairline top border.
- **Editor (6.4).** Active tab connects to the canvas: bg.editor + fg.strong + a 1px accent top
  edge; dirty indicator 8→6px fg.default dot.
- **Explorer (7.1).** Tree rows: fg.default label, radius.sm, bg.overlay hover, active-file accent
  left-edge + fg.strong; icons monochrome (folder was accent-tinted); git decorations routed
  through `--signal-*` (were hardcoded legacy hexes). Breadcrumb 26→28px + monochrome icon.
- **Terminal (8.2).** Fixed a hardcoded `#0e0e11` background → `var(--bg-surface)` (bg.panel,
  token-only); dock tab bar 30→32px + hairline.
- **Command palette (10).** bg.overlay→bg.raised, radius.lg→md, heavy shadow→`--elevation-2`,
  scrim 0.35→0.24 (bg.void 24%).
- **SCM (9) / AI panel (11).** Hairline separators; both already consume the updated tokens
  (signal badges, radius.sm inputs, accent states).
- **Honesty.** No PRD phase counts changed (still **212.5/290**) — this is design-spec alignment,
  tracked separately from the 290 phases. Not done: the AI-provenance gutter ribbon (`--ai`, a
  Monaco editor decoration), and per-pixel/motion/latency budgets (Parts 6.9/14) that need runtime
  measurement. Status-bar sub-items that assumed the old blue bar may need a follow-up visual check.
- **Gates (all green):** typecheck 0 `error TS`; prettier clean; build 3 bundles (renderer 14.03s);
  no temp files.

### Session 70 — 2026-07-10 (UI/UX design-spec alignment kickoff: Part 2 tokens + AXIOM EXE installer kit)

- **Context.** The user supplied a 74-page "AXIOM — UI/UX Product Requirements Document" (PDF)
  and asked to (1) build the app's UI/layout to that spec, then (2) produce a branded Windows
  installer. Extracted the PDF to `axiom_pdf.txt` (pypdf; 74 pages, ~146 KB) — a
  "final/implementation-ready" spec: a Design Constitution (monochrome, density-first,
  editor-as-protagonist, no gradients/glow), a design-token system, and pixel-precise specs for
  18 parts. This is a multi-session program; s70 delivered the highest-leverage foundation +
  the packaging kit.
- **UI — Part 2 Design Token System (foundation).** Aligned the design tokens to spec across the
  two sources of truth: `renderer/src/settings/themes.ts` (runtime — writes CSS vars, overrides
  tokens.css) and `renderer/src/styles/tokens.css` (pre-JS fallback + structural/constant tokens).
  - **Neutral ramp → Graphite Dark** (`bg.void/base/editor/panel/raised/overlay/overlay-strong`,
    `fg.faint/muted/default/strong/max`, `border.subtle/default/strong`) across all four themes;
    Graphite Light re-derived; signals made constant per theme (spec §2.8).
  - **Single accent → restrained blue `#3B82F6`** (hover `#5A97F8`, press `#2E6FD6`, subtle 12%).
    Default accent switched violet→blue; **violet `#8B7FF0` reserved ONLY for AI provenance**
    (`--ai`). Focus ring now uses accent base (spec).
  - Added **signal** colors (`error/warn/success/info/added/removed`), **elevation** (`1/2/3` +
    two-layer `--shadow-focus`, no glow), corrected **radii** (md 6px, lg 8px; + none/full), full
    **spacing** scale (added 2px/6px/48px + space-0), and the **type scale** (Inter UI +
    AXIOM Mono code; micro/small/body/strong/title/display/code/terminal) + tracking.
  - **Non-breaking:** every legacy token name is preserved (re-valued or aliased), so all ~60
    components adopt the spec look without edits. Verified via typecheck + full build.
- **AXIOM EXE — installer kit (everything except the binary).** `apps/desktop/electron-builder.yml`
  upgraded: `productName: AXIOM`, **targets x64 + ARM64** (was x64 only), output to
  `../../AXIOM EXE/dist`, branded NSIS wizard with a **license page** (`build/license.txt` EULA),
  installer icons, and `include: build/installer.nsh`. New **`apps/desktop/build/installer.nsh`**:
  `preInit` guards (Windows 10/11 required, 64-bit required) + `customInstall` best-effort **VC++
  runtime** provisioning (detect → silent install). New **`AXIOM EXE/`** kit: `README.md`
  (overview + the mandatory "by Siddharth" auto-update flow), `BUILD.md` (build/sign/release +
  build-machine prereqs), `legal/README.md`, and `build-axiom-exe.ps1` (one-command build).
  The signed `.exe` is produced on the user's Windows machine.
- **Honesty.** No PRD phase counts changed (still **212.5/290**). This is design-system +
  packaging foundation, not a numbered-phase completion; the full UI-UX implementation (Parts
  3–18) and the actual signed installer remain. `apps/desktop/build/` is `.gitignore`d (existing
  repo policy) — the branding/installer resources live on disk for the build; force-add them if
  version-controlling.
- **Gates (all green):** typecheck 0 `error TS`; prettier `format` + `format:check` clean; build
  3 bundles (main 1.35s / preload 62ms / renderer 13.71s); PDF-extract temp removed; no temp
  files remain.

### Session 69 — 2026-07-10 (Epoch E cloud activation: sync 120 / telemetry 126 / flags 129 → done; analytics 127 deepened)

- **Context.** MEMORY.txt was stale at s66; the repo was actually at **s68 (211.0/290)**.
  Verified before building: typecheck 0 `error TS`, Supabase CLI linked to the user's
  project `bmdprpuehhalabhtndmf`, and the deployed `0001_core_schema.sql` creates
  `user_settings` + `telemetry_events` + `feature_flags` (all RLS in `0002`) with the
  `telemetry-ingest` + `feature-flags` Edge functions present. So Epoch E's client wiring
  was the biggest newly-unblocked lever.
- **Phase 129 — Feature Flags (feature_flags + Realtime) → DONE.** Pure
  (`common/featureFlags.ts`): `parseFlagsPayload` (fail-safe parse of the Edge response into
  resolved boolean overrides — garbage yields no overrides), `isFlagCacheFresh` +
  `FLAG_CACHE_TTL_MS`. Service (`main/services/featureFlags.ts`): `fetchFlags`
  (`functions.invoke('feature-flags')` under the signed-in user → overrides + disk cache),
  `loadCachedFlags`, `startFlagSync` (cache → fetch → Realtime `postgres_changes` subscribe
  on `feature_flags` → re-fetch on change, + a 15-min safety poll), `stopFlagSync`. Every
  layer fails safe: offline → cache → compiled `DEFAULT_FLAGS`. Node smoke 11/0.
- **Phase 126 — Telemetry Upload Pipeline → DONE.** Pure (`common/telemetryUpload.ts`):
  `toIngestBody` maps the client buffer (`{ts,category,type,props}`) to the deployed
  `telemetry-ingest` body (`{sessionId,appVersion,platform,events:[{event:"cat.type",props,
ts:ISO}]}`), plus deterministic `sampleEvents`/`eventBucket` (crash reports never sampled
  out). Service (`main/services/telemetry.ts`): `uploadTelemetry` (remote **kill switch** via
  `isFlagEnabled('telemetry.killSwitch')` → consent → sample → signed-in check → batched
  `functions.invoke('telemetry-ingest')` → concurrency-safe FIFO reconcile on full success),
  `startTelemetryUpload`/`stopTelemetryUpload` (backoff scheduler). `uploadPreview` now
  reports `endpointConfigured = !killed`. Node smoke 10/0.
- **Phase 120 — Offline Persistence & Sync Engine → DONE.** Discovery: `flushQueue` already
  performed push (`upsert user_settings`) + pull + LWW; the module docstring was stale and
  was corrected. Added the **Realtime subscription lifecycle**: pure `shouldPullNow` +
  `MIN_PULL_INTERVAL_MS` (burst debounce), and `startSyncEngine` (initial reconcile +
  `postgres_changes` subscribe on `user_settings` with leading/trailing-debounced pull+merge
  - a 5-min periodic flush) / `stopSyncEngine`. Node smoke 9/0.
- **Phase 127 — Analytics Instrumentation (deepened; stays partial).** New
  `common/analyticsEvents.ts`: a reviewed `EVENT_REGISTRY` (app_start / app_exit / signin /
  provider_added / ai_action / agent_run / error) + `validateAnalyticsEvent` — the
  **no-PII/no-code gate** that strips undeclared / wrong-kind / bad-enum / oversized props —
  - `knownEventNames`. Service `recordAnalytics` records only registry-validated events under
    the registry's category (still consent-gated). Instrumented `app_start` (cold-start ms) and
    `signin`. Full app-wide instrumentation + routing the existing ad-hoc events through the
    registry remain, so 127 stays partial. Node smoke 13/0.
- **Orchestrator.** New `main/services/backendSync.ts` (`startBackendSync`/`stopBackendSync`)
  starts all three loops off the first-paint path and, via `supabase.auth.onAuthStateChange`,
  re-kicks `fetchFlags` + `flushQueue` + `uploadTelemetry` on SIGNED_IN / INITIAL_SESSION /
  TOKEN_REFRESHED. Wired into `main/index.ts` (after window creation) + `before-quit` teardown.
- **Honesty.** 120/126/129 are recorded done on **deployed-backend + complete-client +
  verified-offline/fail-safe** evidence; the live signed-in round-trip cannot be exercised
  from the build sandbox (same basis as s68's 115/116/118). No count was inflated: 127 was
  deliberately kept partial.
- **Counts:** done 161 → **164**, partial 100 → **97**, missing 29; weighted
  **211.0 → 212.5 / 290 (~73%)**. Epoch E 19.0 → **20.5 (68% → 73%)**.
- **Gates (all green):** typecheck 0 `error TS`; prettier `format` + `format:check` clean;
  build 3 bundles (main 1.36s / preload 38ms / renderer 12.99s); Node smokes 11+10+9+13 = 43/0
  run + removed; no temp files remain.

### Session 68 — 2026-07-10 (automatic update system + Supabase backend live + keymap profiles)

- **Automatic update system (Phase 17 → DONE; UPDATEFEATURE).** A production-grade,
  Supabase-driven auto-updater. Pure cores: `common/updateConfig.ts` (`ReleaseConfig`,
  tolerant `parseReleaseConfig`, and `decideUpdate` with a downgrade/spoof guard, a
  minimum-supported-version gate, and mandatory→block policy) and `common/updateState.ts`
  (phase reducer, error classification, progress formatting). Main services:
  `releaseService.ts` (fetches the newest public `app_releases` row for the channel,
  offline-graceful) and `updateService.ts` (orchestrates check → background download with
  progress → SHA-256 verify → install + restart; primary backend is **electron-updater**
  loaded through a typed dynamic-import adapter so it compiles/builds without the package
  and uses it in a packaged build, with a direct-HTTPS Downloader + IntegrityVerifier
  fallback; periodic checks back off on failure). IPC: `update:check/download/install/
getState` + a `update:status` event stream. Renderer: `UpdateView` (checking / available
  / downloading / verifying / ready / installing / error + release notes) and a
  **non-dismissible full-screen mandatory-update guard**. Config: `update.autoDownload` +
  `update.channel` settings, an `electron-builder` `publish` (generic feed) block,
  `electron-updater` added to `apps/desktop` deps, and `supabase/migrations/
0003_app_releases.sql` (public-read RLS table; never client-writable). Node smoke 32/0.
- **Supabase backend LIVE (Phases 115 schema / 116 RLS / 118 Edge Functions → DONE).** The
  user deployed `0001_core_schema.sql` + `0002_rls_policies.sql` + the Edge Functions, so
  Google identity, preference/prompt sync, telemetry ingest, and feature flags are now
  active against the live project. Recorded per the user's confirmed deployment (a live
  backend cannot be verified from the build sandbox).
- **Phase 249 — Keymaps & Profiles → DONE.** Added the keymap **profile manager**
  (`ProfilesView` + `profilesBus`): save the current preset + editor keymap + shortcut
  overrides as a named profile, apply / delete saved profiles, and export / import a
  profile as portable JSON (round-trips via `exportProfile`/`importProfile`). New pure
  converters `bindingsToOverrides`/`overridesToBindings`; a `replaceOverrides` action on the
  keybindings provider applies a profile's shortcuts live. Completes 249 on top of s67's
  app-wide preset application + conflict detection. Node smoke 14/0.
- **Branding + legal verified present** for the user's build: `apps/desktop/build/icon.ico`
  - `build/logo.png`, root `logo.png`, `docs/legal/PRIVACY.md` + `TERMS.md`, and the
    in-app About & Legal view.
- **Counts:** done 156 → **161**, partial 105 → **100**, missing 29; weighted
  **208.5 → 211.0 / 290 (~73%)**. Epoch A 11.5→12.0 (60%), E 17.5→19.0 (68%), I 15.0→15.5 (60%).
- **Gates (all green):** typecheck 0 `error TS`; prettier clean; build 3 bundles; Node
  smokes 32/0 (update cores) + 14/0 (profiles) run + removed.
- **Release process (current correction; supersedes the original session recipe):** (1) bump
  `version` consistently in the root, desktop, and shared manifests; (2) direct npm package
  commands are always unsigned—set `CSC_LINK`, `CSC_KEY_PASSWORD`, `AXIOM_SIGNER_SHA1`, and
  `AXIOM_SIGNER_SUBJECT`, then run `AXIOM EXE/build-axiom-exe.ps1` without `-AllowUnsigned`
  for a signed release; (3) upload the final signed installer, blockmap/update metadata when
  applicable, and matching final-byte sidecars through an approved authenticated channel—there
  is no `publish.url` and stale generic `latest.yml` is removed; (4) insert a verified row into
  `public.app_releases` (channel/latest_version/minimum_supported_version/update_type/
  download_url/checksum=SHA-256/size_bytes). Every installed copy auto-checks on startup + every
  ~6h, compares versions, downloads + verifies, and prompts (optional) or blocks (mandatory).
- **Remaining lever:** the **signed installer `.exe`** (CA-backed certificate plus the dedicated,
  identity-pinned signing boundary on the user's machine/CI). The update system is built and
  verified and can drive releases after a signed artifact passes the full release checklist.

### Session 67 — 2026-07-10 (AI-safety active egress policy + agent-run resume replay + app-wide keymap preset)

- **Phase 170 — AI Safety & Guardrails (Epoch F): partial → DONE.** The outbound-AI egress
  path now ENFORCES a configurable safety policy instead of only detecting. Pure core
  (`common/aiSafety.ts`): `EgressMode` (`off`/`audit`/`sanitize`/`block`), `EgressPolicy`
  (+ a `blockSeverity` threshold), `parseEgressPolicy` (never-throws settings parser), and
  `resolveEgress(text, policy) → SafetyDecision`. Wired into the single chokepoint
  (`main/services/aiGateway.guardedFetch`): `block` throws `EgressBlockedError` before the
  request leaves the machine, `sanitize` sends a redacted body, `audit` (default) logs
  high-severity leaks only. The policy is loaded at startup and kept in sync on settings
  write (`main/index.ts` + `main/ipc.ts`); two new settings (`ai.safety.egressMode`,
  `ai.safety.blockSeverity`) appear under Settings → AI. API keys (headers / query string)
  are never altered — only message-body content. Node smoke 14/0.
- **Phase 210 — Agent-run resume EXECUTION (Epoch H): partial → DONE.** Resuming a run now
  performs true event-log REPLAY: `common/runReplay.ts` builds a ledger of the prior run's
  COMPLETED, effective side-effecting actions (`write_file` / `replace_in_file` /
  `create_file` / `run_command`, keyed by a normalized tool+target signature) and a stateful
  guard so the resumed loop SKIPS each already-done action (replaying its recorded
  observation) rather than re-executing it — no duplicated edits or re-run commands, and no
  re-prompt for approval on replayed steps. The run journal (`common/runJournal.ts`) was
  enriched to capture `tool`/`args`/`observation` per step; `agent.ts` records them, builds
  the guard from `agentRuns.getRun(resumeRunId)`, and honors it in `runAgentLoop`; the
  Tasks-panel "Resume" button threads `resumeRunId` end-to-end (branch intentionally does
  not replay). Node smoke 21/0.
- **Phase 249 — Keymaps & Profiles (Epoch I): deepened (stays partial).** A selected keymap
  preset now actually applies APP-WIDE. `common/keymapProfiles.ts` gained
  `PRESET_COMMAND_ALIASES` (preset command → real app command id for six workbench
  commands), `presetAppBindings(preset)` (single-chord bindings only — multi-chord Emacs
  sequences are skipped since the global dispatcher matches one keystroke), and
  `applyPresetBindings(base, bindings)` (layers the preset over the compiled defaults,
  freeing conflicting chords). The renderer keybindings provider layers this into the
  effective chord map (a headless `KeymapPresetSync` under `SettingsProvider` bridges the
  `keymap.preset` setting into the dispatcher); the default VS Code preset is a verified
  no-op. Remaining for 249: a profile-manager UI + multi-chord sequence dispatch. Node
  smoke 14/0.
- **Counts:** done 154 → **156**, partial 107 → **105**, missing 29 (unchanged); weighted
  **207.5 → 208.5 / 290 (~72%)**. Epoch F 24.5 → 25.0 (64→66%); Epoch H 34.0 → 34.5 (89→91%).
- **Gates (all green):** typecheck 0 `error TS`; prettier "All matched files use Prettier
  code style!"; build 3 bundles; three Node smoke suites (14 / 21 / 14, 0 failed) run + removed.
- **Two user levers unchanged (still the biggest unlocks):** (1) **Supabase backend deploy**
  — run `supabase/migrations/0001_core_schema.sql` + `0002_rls_policies.sql` then
  `supabase functions deploy` (activates Phases 115/116/118 + sync/telemetry/flags); (2)
  **signed installer `.exe`** — needs a code-signing cert + the electron-builder toolchain on
  real hardware/CI.

### Session 66 — 2026-07-10 (symbol-level knowledge graph + in-app About/Legal + installer config final)

Two full-power features + the installer configuration finalized. **No phase count change** (honest —
genuine work, but nothing crosses to _done_).

- **Symbol-level knowledge graph (Phase 65, strengthened).** New pure `common/symbolGraph.ts`:
  `extractSymbols` (function/class/interface/type/enum/const declarations) + a single-pass
  identifier-frequency scan + `buildSymbolReferences` (cross-file usage, own-declarations skipped) +
  `summarizeSymbolGraph` → totals + most-referenced symbols (smoke 19/0). Wired: `core.graph.edges`
  now returns an optional `symbols` summary (computed in `graphEdges.ts`), surfaced as a 🧩 readout in
  the Dependencies panel. Phase 65 now spans file-level imports (s64) **and** symbol-level references
  with reachability/impact — but stays **partial** (PRD 65 wants a persisted Rust-core graph; this is
  an on-demand TS heuristic, not scope-exact resolution).
- **In-app About & Legal + Cloud Setup.** New `AboutView` (modal via `aboutBus`) + a command
  "About Axiom & Legal": shows the AXIOM brand + tagline + version, states plainly that the app is
  **completely free** (no charges/subscriptions/ads), summarizes the Privacy Policy + Terms (full text
  in `docs/legal/`), and gives the one-time Supabase activation steps. Ties the s65 branding/legal work
  into the UI. GA-readiness; not a numbered PRD phase.
- **Windows installer — configuration complete (no `.exe`).** Verified `electron-builder.yml` (appId
  `com.axiom.ide`, productName Axiom, © 2026 Axiom, NSIS wizard, `CSC_LINK` signing hook) plus the
  AXIOM `build/icon.ico` + `build/logo.png` assets are all present and coherent. Per the user, the
  actual installer was **not built** — producing the signed `.exe` needs a code-signing certificate
  and the electron-builder toolchain (+ `node-pty` rebuild), a user/CI step.
- **Gates:** typecheck 0, Prettier clean, build = 3 bundles, no temp files. Counts unchanged:
  154 done / 107 partial / 29 missing = **207.5 / 290 (~72%)**. `MEMORY.txt` refreshed to this state.

### Session 65 — 2026-07-10 (AXIOM branding + legal docs + Supabase config confirmed)

User supplied the Supabase publishable key + URL, the AXIOM logo, and asked me to write the
legal docs + branding myself (the app is **fully free — no charges**). Genuine release-readiness
work; **no phase count change** (nothing crosses to _done_ without a live deploy / signed build).

- **Supabase config — already correct.** `apps/desktop/src/main/config.ts` already targets the
  user's project (`https://bmdprpuehhalabhtndmf.supabase.co`, publishable key
  `sb_publishable_…`, env-overridable via `AXIOM_SUPABASE_*`). No change needed — the app is
  wired to the project. **Honest:** the publishable/anon key is RLS-protected and client-side, so
  it **cannot run DDL**; the `supabase/migrations/*.sql` schema still has to be applied by the
  user (dashboard SQL editor, or `supabase db push` with CLI/service-role login) before the cloud
  round-trips work. So E **115/116/118 stay partial** until that live deploy.
- **AXIOM brand assets added.** Copied the logo to `apps/desktop/build/logo.png` (1254×1254) and
  generated `apps/desktop/build/icon.ico` from it (a valid PNG-compressed `.ico`, ≥256 as
  electron-builder requires). `electron-builder.yml` was already fully configured (appId
  `com.axiom.ide`, productName Axiom, © 2026 Axiom, NSIS wizard, `CSC_LINK` signing hook,
  `buildResources: build` auto-picks `icon.ico`), so the installer is now branding-complete in
  config + assets. Updated `build/README.md`. (ImageMagick isn't available here — the committed
  `icon.ico` was produced without it; a multi-size regen is optional.)
- **Legal docs written** (`docs/legal/`): **PRIVACY.md** and **TERMS.md**, reflecting Axiom's
  actual behavior — free (no charges/subscriptions/ads, no data sales), BYOK (keys in the OS vault,
  prompts go directly to the user's chosen provider, never through Axiom), local-first (code stays
  on device), Supabase used only for Google sign-in + optional sync + opt-in telemetry/crash (all
  RLS-scoped), plus export/delete-account controls and an as-is/no-warranty/liability-limit stance.
  Contact addresses are placeholders to replace before publishing.
- **Gates:** typecheck 0, Prettier clean (docs + README), build = 3 bundles, no temp files. Counts
  unchanged: 154 done / 107 partial / 29 missing = **207.5 / 290 (~72%)**.
- **To finish the two blocked levers (user action):**
  1. **E backend live:** open the Supabase dashboard → SQL editor → paste
     `supabase/migrations/0001_core_schema.sql` then `0002_rls_policies.sql` (or run
     `supabase link` + `supabase db push`), then `supabase functions deploy …`. After that,
     115/116/118 can move partial → done.
  2. **Signed installer:** provide a code-signing certificate (`CSC_LINK` + `CSC_KEY_PASSWORD`)
     and run `npm run package --workspace apps/desktop` on a machine with the electron-builder
     toolchain (it rebuilds `node-pty`), which yields the branded, signed NSIS installer (280/279).

### Session 64 — 2026-07-09 (write the Epoch E backend + full-repo graph IPC + QA)

> **⛳ ACTION NEEDED FROM YOU — Windows installer.** The signed installer is the last
> deliverable and is deferred pending your **branding**: product/brand name, an `icon.ico`
> (+ PNG logo), publisher/company name, copyright string, and (for a _signed_ build) a
> code-signing certificate (`CSC_LINK` / `CSC_KEY_PASSWORD`). Send those and I'll wire the
> electron-builder NSIS config + assets and produce the installer. (The packaging config
> exists; producing a signed `.exe` also needs the electron-builder toolchain + node-pty
> native rebuild, which aren't in this sandbox.)

Unblock-the-lever session — built the recommended #1/#2/#3 autonomously; only the installer waits on you.

- **Epoch E Supabase backend — written as real code (`supabase/`).** Postgres schema +
  triggers (**115**: `profiles`, `user_settings` [exact match to the shipped sync client],
  `sync_records`, `telemetry_events`, `crash_reports`, `feature_flags` + Realtime, `devices`,
  `set_updated_at`, `handle_new_user`); RLS policies + a **pgTAP** policy-test suite (**116**);
  and three Deno Edge Functions — `telemetry-ingest` (RLS-scoped batch insert), `delete-account`
  (service-role cascade delete), `feature-flags` (staged-rollout evaluation) (**118**); plus a
  deploy README. **Honest status: authored + structurally reviewed but NOT verified against a
  live Supabase project** (needs the project credentials + the `supabase` CLI), so
  **115/116/118 move missing → partial, not done.** (`feature_flags`/129 backend is written too
  but 129's count is left unchanged, conservatively, since its client is already partial.)
- **REC#3 — full-repo knowledge graph (Phase 65, strengthened).** New pure `common/importGraph`
  (regex specifier extraction + relative-import resolution → file-level `KnowledgeNode`/`Edge`,
  smoke 18/0); a TS main-process builder (`main/services/graphEdges`, reusing the ignore-aware
  `listFiles`) behind a new `core.graph.edges` IPC; wired into the **Dependencies panel** so it
  reports the active file's whole-repo **transitive impact + dependency reach** via
  `knowledgeGraph`. 65 stays **partial** (symbol-level edges + NL Q&A + viz remain).
- **REC#2 — static QA, two real bugs fixed** (both in the REC#3 wire, caught before shipping):
  the repo graph was re-fetched (a ≤2000-file walk) on every active-file switch → now fetched
  **once per workspace root** with a memoized in-memory query; and the readout showed a
  misleading `0/0` for non-source files → now hidden unless the file is a graph node. Reviewed
  the s62–s63 features (189 lightbulb/hover, ChatPanel A/B + pin, gaGate/sdkDescriptor/vscodeCompat).
  A true GUI smoke needs a display (not available here); QA here is types + build + review.
- **No forced partial → done.** Investigated for a clean conversion and declined — 65 genuinely
  still needs symbol-level edges/Q&A/viz, and the E backend phases are honestly _partial_ until a
  live deploy. Not inflated.
- **Net:** 154 done / 107 partial / 29 missing = **207.5 / 290 (~72%)**. Only count change:
  **E 16.0 → 17.5** (63%; 115/116/118 missing → partial, +1.5). Weighted column re-verified to
  sum exactly to 207.5; counts 154 + 107 + 29 = 290. All gates green: typecheck 0, Prettier
  clean, build = 3 bundles. New Node smoke (importGraph 18/0) written, run, deleted — no temp files.

### Session 63 — 2026-07-09 (partial → done: Phase 189; deepen knowledge-graph + contract cores)

Recommendation-driven: shift from new cores to completing existing partials. Net counter change is
one phase (189), with two cores deepened and honest limits documented.

- **Quick Actions, Hover Explain & Lightbulb (G / 189 — partial → DONE).** The editor's AI actions
  (Explain / Refactor / Fix / Add-Docs) already existed as **context-menu** items; the missing
  **lightbulb** and **hover-explain** are now built in `editor/aiCodeActions.ts`
  (`registerAiEditorProviders`, registered once): a `registerCodeActionProvider('*')` surfaces the
  four actions in the Monaco lightbulb (Ctrl+.) on the selection or current line, and a
  `registerHoverProvider('*')` adds a trusted `command:`-link "Explain this line". Both route through
  the existing `requestAiAction` bus; `monaco.editor.registerCommand` backs the invocation. Epoch G →
  **29.5 / 30 (98%)**.
- **`knowledgeGraph` (65) deepened** (verified; still partial): added `reachableFrom` (forward
  transitive closure), `transitiveImpact` (reverse closure = blast radius), and `shortestPath` (BFS,
  edge-kind-filterable), over a shared `adjacency`/`traverse` core (smoke 13/0). Not wired further —
  the renderer only has 1-hop dependency data per file; meaningful reachability/path queries need a
  Core full-repo edge-list IPC (part of what keeps 65 partial, alongside symbol-level extractors,
  NL Q&A, and viz).
- **`providerContract` (146) deepened** (verified; still partial): added `observeFromEvents` — the
  pure fixture-recorder core that folds a recorded adapter event stream (delta / usage / toolCall /
  reasoning / error) into an `Observation` for the contract checker (smoke 8/0). Live event capture +
  the scheduled refresh remain the I/O follow-up.
- **Not faked:** a second G conversion was investigated and declined — 197 (Cost & Usage Dashboard) is
  already done (`SpendStatusItem` is a full dashboard). I 249 (keymap presets) was investigated for
  partial → done but its preset bindings use abstract command ids that don't match the real registry,
  and Emacs multi-chord sequences can't dispatch through the single-chord handler, so a genuine "done"
  needs command-id mapping + sequence support + runtime proof — more than a clean, verifiable sandbox
  change. Left partial rather than inflate.
- **Net:** 154 done / 104 partial / 32 missing = **206.0 / 290 (~71%)**. Per-epoch: **G 29.0 → 29.5**.
  Weighted column re-verified to sum exactly to 206.0; counts 154 + 104 + 32 = 290. All gates green:
  typecheck 0, Prettier clean, build = 3 bundles. Two Node smokes (13 / 8, all 0 failed) written, run,
  deleted — no temp files.
- **Honest status + next lever.** Partial → done is now largely gated by things this sandbox can't
  verify: **Epoch E backend** (Supabase project + creds), **Epoch J release infra** (code signing,
  installers, CI perf gates on reference hardware), the **LSP/DAP Monaco ceiling** (Epoch D), and
  runtime-heavy UX (screen-reader passes, live keybinding rebind). Further weighted progress most
  credibly comes from the user **unblocking E or the signing/installer toolchain**, or from
  runtime-QA passes on already-built features. New pure cores and pure partial-deepening are largely
  exhausted.

### Session 62 — 2026-07-09 (close ChatPanel wire + wire 3 s61 cores + 2 new builds)

Three parts. **#1 — closed the twice-deferred ChatPanel wire** (no count change; strengthens two
partials): `providerCompare` (258) now adjudicates an A/B run — each leg's latency + cost + output
length is captured and `compareRuns` renders a "⚖ A/B" verdict banner under the thread; `convSwitch`
(166) adds a per-thread model **Pin** (the header select locks + a Pin toggle, and `resolveModel`
drives the effective model for the turn, the A/B pair, and the capability re-fit). **#2 — wired the
three s61 pure cores** into real surfaces (no count change):

- `gaGate` (274) → **SecurityView**: a "🚀 GA readiness gate" that folds the panel's actual audit
  results (secrets / SAST / fitness / deps / egress / RLS → security, licenses → docs, health score
  → stability; un-run checks count as skip) into a go / conditional / no-go verdict with blocker +
  warning rows.
- `sdkDescriptor` (246) → **CustomProviderForm**: a "Validate descriptor" action that maps the custom
  provider config to the plugin SDK's provider-adapter contract and reports validity + errors.
- `vscodeCompat` (244) → **ExtensionsView**: a VS Code compatibility readout (supported / partial /
  unsupported of the mapped API surface + coverage). Honest — Axiom extensions use their own manifest,
  so this surfaces the compat layer's support matrix, not a per-extension audit; the runtime host remains.

**#3 — 2 new missing → partial builds** (+1.0), each pure module + Node smoke + typecheck-clean:

- **Knowledge graph construction (C / 65 — missing → partial).** `knowledgeGraph.ts`: typed
  node/edge graph with `buildKnowledgeGraph` (id de-dupe + dangling-edge drop), neighbour / caller /
  root / orphan queries, DFS `detectCycles`, incremental `applyUpdate`, and `summarizeGraph` (smoke
  19/0). Wired into the **Dependencies panel** — the active file's import / imported-by neighbourhood
  is assembled from the real Core graph and its structural summary is shown. Symbol-level extractors +
  NL Q&A + viz remain.
- **Provider contract-test harness (F / 146 — missing → partial).** `providerContract.ts`:
  `checkCapability` (streaming / tools / reasoning / usage / errorMapping), the canonical error
  taxonomy, `checkContract` (claims vs observation), and `runFixtureSuite` → conformance (smoke 23/0).
  The adjudicator is verified pure-core; the fixture recorder/player + scheduled live refresh are the
  PRD's documented I/O follow-up.
- **Net:** 153 done / 105 partial / 32 missing = **205.5 / 290 (~71%)**. Per-epoch: **C 16.5 → 17.0**
  (71%), **F 24.0 → 24.5** (64%). Weighted column re-verified to sum exactly to 205.5; counts
  153 + 105 + 32 = 290. All gates green: typecheck 0, Prettier clean, build = 3 bundles. Two new Node
  smokes (19 / 23, all 0 failed) written, run, deleted — no temp files.
- **Honest status:** the pure-friendly _missing_ pool is now nearly exhausted. The remaining 32
  not-started phases are dominated by **backend/Supabase** (Epoch E, 9 — blocked pending go-ahead),
  **release infra** (Epoch J — CI perf gates on reference hardware, code signing, installers — needs a
  real toolchain/certs), the **LSP/DAP Monaco ceiling** (Epoch D — call/type hierarchy, semantic
  tokens, remote debugging), interactive **graph/viz UI**, and **enterprise** groundwork (K 288).
  Further weighted progress will come mainly from deepening existing partials → done, not new pure cores.

### Session 61 — 2026-08-07 (wire s60 cores + 3 new builds; Epoch I hits 0 unstarted)

Two parts. **#1 — wired 4 of s60's pending pure-core modules** into real consumers (no count
change; strengthens those partials): `improvementEngine` (290) + `feedbackLoop` (287) → the
Performance panel (real perf-budget results → improvement suggestions + a stabilization backlog);
`uxStates` (264) → the A11y Audit panel (a UX-states self-audit over the app's views); `repoTour`
(263) → a **new Repo Tour sidebar panel** driven by project understanding. **#2 — 3 new
missing → partial builds** (+1.5), each pure module + Node smoke + typecheck-clean:

- **VS Code compatibility layer (I / 244 — missing → partial).** `vscodeCompat.ts`: `classifyApi`
  (curated API-support map + namespace heuristics → supported/partial/unsupported) + `assessExtension`
  → a per-extension compat verdict + label (smoke 21/0). Core shipped; the runtime shim + per-extension
  API extraction remain.
- **Provider/agent SDK descriptor (I / 246 — missing → partial).** `sdkDescriptor.ts`:
  `validateProviderAdapter` + `validateCustomAgent` (slug/enum/models/tools/persona validation) +
  starter templates (smoke 17/0). The descriptor contract; the runtime SDK packages + docs remain.
- **GA readiness gate (J / 274 — missing → partial).** `gaGate.ts`: `evaluateGaGate` aggregates
  category checks (tests/security/perf/a11y/stability/docs) into go / conditional / no-go with
  per-category blocker rules (smoke 16/0). The adjudicator; the real pen-test/CI feeding it remains.
- **Deferred (honest):** the ChatPanel-coupled wires for `providerCompare` (258) + `convSwitch` (166)
  were not done — ChatPanel's A/B result + model state are deeply coupled via props, so a surgical
  wire was high-risk this session; both stay tested pure-core (integration pending).
- **Net:** 153 done / 103 partial / 34 missing = **204.5 / 290 (~70%)**. Per-epoch: **I 14.0 → 15.0**
  (Epoch I now has **0 unstarted phases** — 244/246 were its last two, → 58%); **J 8.0 → 8.5** (39%).
  Weighted column re-verified to sum exactly to 204.5; counts 153 + 103 + 34 = 290. All gates green:
  typecheck 0 errors, Prettier clean, build = 3 bundles. Three new Node smokes (21 / 17 / 16, all
  0 failed) written, run, deleted — no temp files.

### Session 60 — 2026-08-06 (large batch: 10 fully-verified pure-core builds across I / J / K / F)

Ten new pure `common/*.ts` modules, each with a Node smoke (all passed) + typecheck-clean +
Prettier-clean; build = 3 bundles; no temp files left. Eight moved a phase **missing → partial**
(+4.0); two **deepened** already-partial phases (no count change). Four are wired into the app;
six are tested pure-core modules with app integration still pending (honest partial).

- **Provider A/B compare full (I / 258 — deepened).** `providerCompare.ts`: score two provider
  runs on quality/latency/cost with weights → weighted winner + reasons (smoke 13/0). Extends the
  Phase 182 model A/B core; A/B-UI integration pending.
- **Ambient codebase health (I / 259 — missing → partial).** `codebaseHealth.ts`: `aggregateHealth`
  → 0–100 score + fixable-first prioritized backlog (13/0). Wired into SecurityView (aggregates the
  real dep/SAST/secret/fitness findings).
- **Repo Q&A onboarding (I / 263 — missing → partial).** `repoTour.ts`: `buildRepoTour` — overview
  → entry points → config → graph hotspots, a guided architecture tour (13/0). Core shipped; view
  pending.
- **UX polish states checklist (I / 264 — missing → partial).** `uxStates.ts`: `auditUxStates` —
  empty/loading/error/success/offline coverage per view + gaps (12/0). Core shipped; view pending.
- **Secrets & egress hardening review (J / 272 — deepened).** `egressReview.ts`: `reviewEgress` —
  protocol/allowlist/secret-exposure policy over the egress surface → pass/warn/fail (12/0). Wired
  into SecurityView (reviews the app's real egress surface: providers over HTTPS + first-party
  Supabase + a loopback model server).
- **RLS & Edge audit (J / 273 — missing → partial).** `rlsAudit.ts`: an RLS-policy linter (tables
  without RLS, RLS-without-policies, policies not user-scoped) (10/0). Wired into SecurityView
  (audits the known `user_settings` schema).
- **Cross-platform groundwork (K / 289 — missing → partial).** `platformTargets.ts`: OS/arch target
  matrix, path/EOL/shell normalization, remote-workspace descriptor (27/0). Wired into main startup
  (logs the detected target from real `process.platform`/`arch`).
- **Post-GA stabilization / feedback loop (K / 287 — missing → partial).** `feedbackLoop.ts`:
  `buildStabilizationBacklog` — group crash/telemetry/report/review signals, weight by source ×
  occurrences × severity → prioritized backlog (12/0). Core shipped; integration pending.
- **Continuous improvement engine (K / 290 — missing → partial).** `improvementEngine.ts`:
  `analyzeMetrics` (off-target suggestions + on-target score) + `scoreRoadmap` (value-per-effort
  ranking) (16/0). Core shipped; integration pending.
- **Mid-conversation switching/pinning/overrides (F / 166 — missing → partial).** `convSwitch.ts`:
  `resolveModel` precedence (pin > override > conversation) + switch/pin (17/0). Core shipped;
  ChatPanel integration pending.
- **Net:** 153 done / 100 partial / 37 missing = **203.0 / 290 (~70%)**. Per-epoch: **F 23.5 → 24.0**
  (63%), **I 12.5 → 14.0** (54%), **J 7.5 → 8.0** (36%), **K 0.0 → 1.5** (Epoch K opens at 38%).
  Weighted column re-verified to sum exactly to 203.0; counts 153 + 100 + 37 = 290. The user's 210
  target was not reached — honestly, that needs ~14 more builds; 203.0 is delivered with every
  credited phase backed by real, smoke-verified code (no inflation).

### Session 59 — 2026-08-05 (Epoch I reconciliation + two builds: dependency license audit, CI/CD scaffolding)

- **#1 Epoch I reconciliation (correctness, not a feature).** Audited phases 239–264 against
  the actual codebase (a 112-module inventory of `common/*.ts`). Epoch I's per-epoch "missing"
  tally had drifted to **0**, which was wrong: five phases have no implementing code and were
  restored to **missing** — 244 (VS Code Compatibility Layer), 246 (Provider/Custom-Agent SDKs),
  259 (Ambient Codebase Health Agent), 263 (Repo Q&A Onboarding), 264 (UX Polish Pass). Phase
  **261** (Cost-Aware Autopilot), which is an Epoch-I novel-AI phase (239–264) but had been tracked
  under Epoch F since s56, was **moved to I**. Result: **I 15.0 → 12.5** (4 done / 17 partial / 5
  missing) and **F 24.0 → 23.5** (16 / 15 / 7, phantom 261 removed). This is a deliberate downward
  correction of prior over-crediting; done-count is unchanged (153).
- **#2 Dependency license audit (Epoch J / Phase 271 depth — deepened, no count change).** New pure
  `common/licenseAudit.ts`: classifies an SPDX id/expression into a risk category (public-domain /
  permissive / weak- / strong- / network-copyleft / proprietary / unknown), resolving `(A OR B)` to
  the least-restrictive operand and `(A AND B)` to the most-restrictive; applies an allow / flag /
  deny policy; and rolls a dependency set up into a compliance report (`evaluateLicenses`). Wired
  into the Security panel: an "Audit dependency licenses" action reads each installed dependency's
  `package.json` license and lists denied/flagged results. Smoke: 33/33. Complements the existing
  `depScan`/`sbom`/`sastRules` (SCA/Phase 271, already partial), so J stays 7.5.
- **#3 CI/CD pipeline scaffolding (Epoch A / Phase 2, missing → partial — new).** New pure
  `common/ciPlan.ts`: a CI workflow model (jobs → steps, `needs` deps + build matrix), a validator
  (unique ids, non-empty steps, and a sound `needs` graph — reusing the DI container's `validateGraph`
  for missing/cycle detection), and a GitHub Actions YAML renderer; `defaultCiWorkflow()` is this
  repo's pipeline. Emitted a real, usable **`.github/workflows/ci.yml`** (checkout → setup-node@20 →
  `npm ci` → typecheck → format:check → build). Smoke: 26/26. CD (release/deploy/signing) + on-runner
  execution remain → partial.
- **Net:** 153 done / 92 partial / 45 missing = **199.0 / 290 (~69%)**. Per-epoch: **A 11.0 → 11.5**
  (Phase 2, → 58%); **F 24.0 → 23.5** (261 refiled, → 62%); **I 15.0 → 12.5** (reconciled, → 48%);
  **J 7.5** unchanged (license audit deepens 271). Weighted column re-verified to sum exactly to
  199.0; counts 153 + 92 + 45 = 290. All gates green: typecheck 0 errors, Prettier clean (incl. the
  new `ci.yml`), build = 3 bundles. Two Node smokes (33 / 26, all 0 failed) written, run, deleted —
  no temp files.

### Session 58 — 2026-08-04 (three-build run: DI service registry, scoped indexer scheduler, multi-model debate/critic)

- **#1 DI container / service registry (Epoch A / Phase 8, missing → partial — new).** New pure
  `common/serviceRegistry.ts`: a typed container — `register(id, factory, { deps, singleton,
dispose })` + `resolve` (constructs deps first, caches singletons, cycle-safe with the offending
  path) + `dispose` (reverse construction order) — plus pure graph helpers (`findMissingDeps`,
  `findCycle`, `resolutionOrder`, `validateGraph`) that statically check a dependency graph without
  constructing anything. Wired main-side: `main/services/serviceGraph.ts` declares the app's ~18
  core services + their real dependencies and `validateServiceGraph()` runs at startup (logs a
  warning on a missing dep / cycle, never blocks). Smoke: 22/22. Migrating each service's actual
  construction onto the container remains → partial.
- **#2 Scoped incremental indexer scheduler (Epoch J / Phase 267 — deepened, no count change).**
  Extended `common/largeRepo.ts` with `planIndexSchedule`: ranks `IndexCandidate`s by priority
  (`indexPriority` — active editor > open tabs > recency-decayed mtime > source files), selects up
  to the scale-appropriate budget (recent/open first), and shards the selection into byte- and
  file-bounded batches (`nextIndexBatch` walks them) so a 1M-file repo never indexes in one
  unbounded chunk. Wired into the Performance panel's repo readout (projected batch count + mode).
  Smoke: 26/26. The full candidate walk (all files + mtimes) comes from the Rust walker (out of the
  sandbox), so 267 stays partial.
- **#3 Multi-model debate / critic (Epoch I / Phase 257, missing → partial — new).** New pure
  `common/debate.ts`: `parseFindings` turns a critic's free text into severity-tagged findings,
  `runDebate` merges/dedupes findings across critics into a **verdict** (any blocker → reject, any
  major → revise, else accept) + surfaces the substantive disagreements, and `consensus` does
  self-consistency majority voting across independent proposals. Wired into the code-review path:
  `common/review.ts` gains `adjudicateReview` (the review's severity-tagged findings map straight
  onto the debate protocol) so `reviewCode` now returns a `verdict` + summary, shown as a line in
  `ReviewView`. Smoke: 32/32. Full multi-model orchestration (separate proposer + N critic LLM
  passes / self-consistency runs) remains → partial.
- **Net:** 153 done / 97 partial / 40 missing = **201.5 / 290 (~69%)**. Per-epoch: **A 10.5 → 11.0**
  (53 → 55%, Phase 8); **I 14.5 → 15.0** (56 → 58%, Phase 257); **J 7.5** unchanged (Phase 267
  deepened). Weighted column re-verified to sum exactly to 201.5. All gates green: typecheck 0
  errors, Prettier clean, build = 3 bundles. Three Node smokes (22 / 26 / 32, all 0 failed) written,
  run, and deleted — no temp files.
- **Honest accounting notes (for a future reconciliation).** (1) Phase 261 (Cost-Aware Autopilot,
  built s56) is technically an Epoch-I novel-AI phase (239–264) but has been tracked under Epoch F
  since s56; left as-is here so the per-epoch sums stay consistent. (2) Epoch I's per-epoch
  "missing" tally now reads 0, but several novel-AI / marketplace phases (258/259/263/264,
  243/244/246) remain stub-level or unbuilt — the per-epoch counts are an approximate engineering
  assessment (as this tracker states) and a full per-phase reconciliation of Epoch I is
  recommended. The weighted total remains an honest overall estimate.

### Session 57 — 2026-08-03 (three-build run: run-history actions, live escalation loop, local-first autonomy)

- **#1 Run-history UI + Resume/Branch actions (Epoch H/I, Phase 210/256 — deepened, no count
  change).** New pure `common/runsView.ts` (row view-models: title/status/relative-time +
  resume/branch enablement via `isRunResumable` + `listBranchPoints`). Wired into the existing
  `TasksView` run-history: each expanded run now shows a **Resume** button (when resumable) and
  a per-step **"Redo here"** branch button, both calling `agent.runs.reinvoke` → `agent.run`
  with the current AI target (mirroring the WorkflowsView run-start), so resume / branch /
  time-travel are now **end-to-end executable** from the UI. Smoke: 29/29. Two minimal CSS rules
  added. True event-log replay (skipping completed side-effecting steps in the new run) remains,
  so 210/256 stay partial (materially stronger).
- **#2 Live draft-then-escalate loop (Epoch F, Phase 261 — deepened, no count change).** New pure
  `common/autoEscalate.ts`: `decideEscalation` composes the autopilot ladder (`nextModel`) +
  `shouldEscalate` + `atAnswerModel` into an escalate/stay decision after each verification.
  Wired into `agent.ts` `runAgent`: the run now holds a MUTABLE model over a provider-model
  ladder (built from `providerInfo(provider).defaultModels` via `deriveRouteMeta` → `planAutopilot`),
  and on a failed `run_command` self-verification it escalates to the next more-capable rung for
  subsequent passes (same provider ⇒ same key/endpoint), recording a journal note. Smoke: 25/25.
  Budget-capped cross-provider escalation + mid-stream confidence signals remain → partial.
- **#3 Local-First Autonomy (Epoch I, Phase 262, missing → partial — new).** New pure
  `common/localFirst.ts`: `decideLocalFirst` compares the best local model's capability against
  the autopilot answer floor to yield fit / marginal / unfit / no-local, choosing zero-egress
  local execution when capable, a transparent remote-fallback suggestion when not, and an
  offline-only mode that runs local anyway with an honest capability caveat; `canRunOffline`
  helper. Wired as a run-start local-first readout in `agent.ts` (journal note when a local model
  is present). Widened `costAutopilot.answerFloor`/`draftFloor` to `Pick<TaskProfile,
'complexity' | 'risk'>` (safe). Smoke: 35/35. Full local-first routing (picking local at run
  start) remains → partial.
- **Net:** 153 done / 95 partial / 42 missing = **200.5 / 290 (~69%)**. Per-epoch: **I 14.0 →
  14.5** (54 → 56%, Phase 262); **F 24.0** and **H 34.0** unchanged (same-count deepenings of the
  already-partial 261 / 210 / 256). Weighted column re-verified to sum exactly to 200.5. All gates
  green: typecheck 0 errors, Prettier clean, build = 3 bundles. Three Node smokes (29 / 25 / 35,
  all 0 failed) written, run, and deleted — no temp files left.

### Session 56 — 2026-08-02 (three-build run: cost-aware autopilot, resume/branch execution, convention learner)

- **#1 Cost-aware autopilot (Epoch F / Phase 261, missing → partial — new).** New pure
  `common/costAutopilot.ts`: `AutopilotModel` (tier / capability / per-1K costs), a
  `TaskProfile` (complexity + risk + token estimates), and a budget. `answerFloor` /
  `draftFloor` derive capability thresholds from complexity+risk; `planAutopilot` picks the
  cheapest viable DRAFT model and builds a cheap→capable escalation LADDER (affordable +
  capable-enough), names the ANSWER model (first clearing the answer floor), and reports
  start/max cost + a budget verdict; `shouldEscalate` climbs on verification-failure /
  low-confidence / high-risk; `nextModel` walks the ladder. Wired as a new **'autopilot'
  routing policy** (`common/routing.ts` — delegates to an `autopilotOrder` comparator:
  local-first, cheapest, then quality) so the existing failover chain now orders
  draft-cheap → escalate, selectable in the AI panel (the dropdown renders from
  `ROUTING_POLICIES`, no schema change). Smoke: 43/43. The live draft-then-escalate loop
  (mid-run escalation from verification signals) remains → partial.
- **#2 Resume/branch EXECUTION (Epoch H / Phase 209 done, 210 partial — deepened, no count
  change).** New pure `common/runReinvoke.ts`: `buildResumeReinvoke` / `buildBranchReinvoke`
  (+ a `buildReinvoke` dispatcher) turn a persisted run's journal-derived resume context
  (`resumeContext`) or time-travel branch plan (`planBranch`) into a self-contained composed
  task + preset — so "continue this run" and "redo from step N differently" become
  executable. Wired main-side: `agentRuns` gains `buildRunReinvoke` + a full 4-step
  `agent:runReinvoke` IPC; the renderer gets a `{ task, preset, ok }` request and starts a
  fresh run through the proven `agent:run` path (no provider-resolution duplication). Smoke:
  25/25. The run-history UI + a Resume/Branch button remain, so 210 stays partial.
- **#3 Convention learner (Epoch I / Phase 260, missing → partial — new).** New pure
  `common/conventionLearner.ts`: detectors infer indentation (tabs vs spaces + unit), quote
  style, semicolons, and identifier casing from a workspace code sample as dominant-ratio
  conventions, gated by a minimum evidence count + confidence, then nudged by accepted /
  rejected edit feedback (which can drop a borderline convention); `learnConventions` returns
  `ProposedRule[]` and `proposedToRule` turns each into a workspace `Rule` (Phase 233) for
  approval — never auto-applied. Wired main-side: `rules` service gains a bounded workspace
  sampler + `proposeConventions`, exposed via a full 4-step `rules:proposeConventions` IPC.
  Smoke: 24/24. Auto-gathering real edit feedback + an approval UI remain → partial.
- **Net:** 153 done / 94 partial / 43 missing = **200.0 / 290 (~69%)**. Per-epoch: **F 23.5 →
  24.0** (62 → 63%), **I 13.5 → 14.0** (52 → 54%); **H unchanged 34.0** (89% — a same-count
  deepening of the already-partial Phase 210). Weighted column re-verified to sum exactly to
  200.0. All gates green: typecheck 0 errors, Prettier clean, build = 3 bundles. Three Node
  smokes (43 / 25 / 24, all 0 failed) written, run, and deleted — no temp files left.

### Session 55 — 2026-08-01 (three-build run: AI safety layer, agent-run resume depth, time-travel review)

- **#1 AI safety layer (Epoch F / Phase 170, missing → partial — new).** New pure
  `common/aiSafety.ts`: rule-pack heuristics for prompt-injection / jailbreak
  (`detectInjection` — ignore-previous, reveal-system-prompt, role-override,
  bypass-guardrails, smuggled delimiters), secrets (`detectSecrets` — private keys,
  AWS/OpenAI/GitHub/Slack/Google tokens, JWTs, credential assignments) and PII
  (`detectPii` — email, SSN, phone, Luhn-validated card numbers). Findings carry a
  MASKED preview so a raw secret / PII value is never echoed. `redact` /
  `sanitizeForEgress` replace matches with `[REDACTED:<category>]` (overlap-safe);
  `scanUntrusted` (injection + secrets) and `scanEgress` (secrets + PII) roll up into a
  severity report; `evaluateEgress` yields an allow / sanitize / block decision (opt-in,
  never blocks unless asked). Wired NON-mutating main-side: the egress gateway
  (`guardedFetch`, the single chokepoint) audits the outbound body for leaked
  HIGH-severity credentials and logs the count + rule ids (never the value); the context
  builder scans assembled untrusted grounding content and prepends an
  indirect-prompt-injection caution when a high-severity attempt is present. Smoke: 35/35.
  Active redaction/blocking behind a policy setting remains → partial.
- **#2 Agent-run resume depth (Epoch H / Phase 209 done, 210 partial — deepened, no count
  change).** New pure `common/runResume.ts`: a replay-safe checkpoint model over the run
  journal — `initCheckpoint` / `completeStep` (idempotent, cursor = first incomplete) /
  `setStatus`, `planResume` → { skip, remaining, cursor, resumable, context } where any
  completed step is skipped regardless of order (so side-effecting steps are never
  re-executed — the count of skipped mutating steps is reported), and `checkpointFromRun`
  reconstructs a best-effort checkpoint from a persisted journal alone. Wired main-side:
  `agentRuns` gains `listResumableRuns` (record-level `isRunResumable`) + `buildResumePlan`,
  plus a full 4-step `agent:runsResumable` IPC. Smoke: 35/35. Resume EXECUTION (re-invoking
  the agent from the plan) + a run-history UI remain, so 210 stays partial.
- **#3 Time-travel agent review (Epoch I / Phase 256, missing → partial — new, first novel-AI
  system).** New pure `common/timeTravel.ts`: `buildScrubTimeline` annotates a run's steps
  for a scrubber (offset + side-effect + branchable), `listBranchPoints` enumerates redo
  points, and `planBranch` builds a "redo from step N with a different approach" plan that
  preserves steps [0, N) as history (never re-executed — prior side effects counted, not
  duplicated) + a natural-language continuation seed. Wired main-side: `agentRuns` gains
  `buildRunBranch` + a full 4-step `agent:runBranch` IPC (arg-validated). Smoke: 31/31.
  Executing the branched run + the scrubber UI stay out of core → partial.
- **Net:** 153 done / 92 partial / 45 missing = **199.0 / 290 (~69%)**. Per-epoch: **F 23.0 →
  23.5** (61 → 62%), **I 13.0 → 13.5** (50 → 52%); **H unchanged 34.0** (89% — a same-count
  deepening of the already-partial Phase 210). All gates green: typecheck 0 errors, Prettier
  clean, build = 3 bundles. Three Node smokes (35 / 35 / 31, all 0 failed) written, run, and
  deleted — no temp files left.

### Session 54 — 2026-07-31 (three-build run: context source providers, startup deferred-init, component a11y audit depth)

- **#1 Context source providers (Epoch F / Phase 154, missing → partial — new).** New pure
  `common/contextSourceFeeds.ts`: eight adapters that turn the IDE's real state into ranked
  `SourceItem[]` per kind — `fromRules` / `fromSelection` / `fromAttachments` / `fromOpenFiles`
  / `fromRecentEdits` / `fromSymbols` / `fromMemory` / `fromRepoMap` (each scored by recency /
  explicitness / relevance, token-estimated via the shared `contextManifest` heuristic) +
  `gatherSourceItems`. Extracted a `prioritizeItems(items, { budget, pinnedKinds })` core
  (reserves pinned-kind tokens first, then runs the Phase 155 `rankAndSelect` on the rest and
  folds pinned items back in as always-kept) with `composeSources` layered on top. Wired
  main-side into `main/services/contextBuilder.ts`: each candidate carries an explicit source
  `kind`; two NEW provider feeds join the pipeline — a project-understanding **repo map**
  (`coreProjectUnderstand`) and the active file's **symbol outline** (`coreSymbols`), both
  best-effort + synthetic (kept out of the cited `sources[]`); the previously-cosmetic
  `rankAndSelect` call is replaced with `prioritizeItems(..., { pinnedKinds: ['selection'] })`
  that now **drives** selection (the active file is pinned and can never be evicted, and
  lowest-priority sources are dropped over budget before the Phase 156 fitter runs on the
  survivors). Smoke: 40/40 (adapter mapping + scoring, cross-kind ranking, over-budget drops,
  pinned-kind survival, ample-budget keep-all). Renderer-supplied rules / recent-edits / memory
  feeds remain, so F/154 stays partial.
- **#2 Startup performance / deferred-init (Epoch J / Phase 268, missing → partial — new).** New
  pure `common/startupPlan.ts`: a `StartupTask { id, phase: 'critical' | 'deferred' | 'idle',
estMs, deps }` model and `planStartup` that produces a dependency-respecting, phase-grouped
  schedule via a **priority topological sort** (most-urgent ready task first), with **urgency
  promotion** (anything an urgent task depends on is promoted to that phase, via a fixpoint) and
  **cycle-safety** (offending ids reported + still scheduled). Returns `order`, per-phase id
  lists, `criticalPathMs` (sum of critical work), deferred/idle sums, and a critical-path
  **budget verdict** (`budgetOk` at ≤ `CRITICAL_BUDGET_MS` = 1500). Wired main-side: the
  recorded pre-paint startup marks become the critical path (with their real measured
  durations), the known post-paint init steps (core sidecar / workspace index / file watcher /
  LSP servers deferred; prefs-sync / telemetry-flush idle) are classified off the paint path;
  `getStartupReport` now includes the plan (same `perf:startupReport` IPC — no new channel), the
  plan is logged once after `window-created`, and the **Performance panel** shows a critical
  budget readout (reusing `perf-watchdog` classes, no new CSS). Smoke: 31/31 (topo/dep order,
  critical-sum semantics, phase exclusion, promotion, budget flip at 1500/1501, cycle-safety,
  dedupe/clamp). A real V8 startup snapshot needs build tooling outside the sandbox → partial.
- **#3 Component a11y audit DEPTH (Epoch I / Phase 253, already partial — deepened, no count
  change).** New pure `common/a11yRules.ts`: a serializable `A11yNode { tag, role?, attrs?,
text?, children? }` **tree** descriptor (complements the flat `a11yAudit.ts` pass) + a
  **nine-rule** WCAG/ARIA pack emitting `A11yTreeFinding { ruleId, severity, path, node, message
}` — `control-name` (icon-only button/link), `img-alt`, `control-label`, `positive-tabindex`,
  `keyboard-focusable`, `keyboard-handler`, `duplicate-id`, `heading-order` (level skips), and
  `low-contrast` (via the theme `contrastRatio`/`meetsAA` linter) — with `auditTree` (pre-order
  DFS = document order) and `summarizeAudit` (severity + per-rule counts). Wired into
  `renderer/.../A11yAuditView.tsx`: a bounded DOM → `A11yNode` adapter samples the live workbench
  subtree, `run()` now executes BOTH the flat and the tree audits (filtering `keyboard-handler`,
  which static DOM can't verify), and the tree findings render as a `role="listbox"` with roving
  tabindex + arrow-key navigation (reusing `focusNav` + existing `dep-row`/Problems classes, no
  new CSS). Smoke: 38/38 (each rule flags a bad node + passes a good one — incl. decorative
  `alt=""`, hidden input, tabindex 0/-1, native button, duplicate ids, sequential headings,
  no-text-skips-contrast — plus `summarizeAudit` counts). A full runtime axe scan + a
  screen-reader pass stay out of the sandbox → 253 stays partial.
- **Net:** 153 done / 90 partial / 47 missing = **198.0 / 290 (~68%)**. Per-epoch: **F 22.5 →
  23.0** (59 → 61%), **J 7.0 → 7.5** (32 → 34%); **I unchanged 13.0** (50%, a same-count
  deepening like s52's audio cues). All gates green: typecheck 0 errors, Prettier clean, build =
  3 bundles. Three Node smokes (40 / 31 / 38, all 0 failed) written, run, and deleted — no temp
  files left.

### Session 53 — 2026-07-30 (three-build run: compatibility matrix, keymaps + profiles, context sources & prioritization)

- **#1 Compatibility matrix (Epoch J / Phase 276, missing → partial — new).** New pure
  `common/compatMatrix.ts`: an `EnvProfile` (os / arch / hardware tier / GPU / shell / encoding /
  locale) with `classifyHardwareTier` (low / mid / high from cores + RAM) and `classifyOs`
  (win10 vs win11 via build ≥ 22000, macos / linux / unknown); per-dimension support functions
  (os / arch / tier / gpu / shell / encoding) reduced by `worstLevel`; `evaluateCompatibility →
CompatReport` ({ os, arch, tier, overall, checks[], fallbacks[], blockers[], summary } built via
  `Omit<…,'summary'>` then attach); plus `DEFAULT_MATRIX_AXES` + `cellLevel` +
  `buildCompatibilityMatrix` (cartesian) + `summarizeMatrix` ({ total, supported, degraded,
  unsupported, coverage }). Wired: `main/services/compat.ts` probes the live environment
  (os / process / `app.getGPUFeatureStatus` / `app.getLocale` / proxy + CA env), a full four-step
  `compat:report` IPC (ipc.ts + main/ipc.ts + preload + env.d.ts), and a **Performance-panel
  readout** (reused `perf-watchdog` / `perf-wd-*` / `perf-dot` classes). Partial: real
  cross-hardware CI runners remain out of the sandbox. Verified: typecheck 0, prettier, 3-bundle
  build, 40/40 smoke.
- **#2 Keymaps + profiles (Epoch I / Phase 249, missing → partial — new).** New pure
  `common/keymapProfiles.ts`: `KeymapPreset` (vscode / jetbrains / sublime / emacs) +
  `KEYMAP_PRESET_LABELS` + `parseKeymapPreset`; order-independent chord normalization
  (`normalizeKeystroke` / `normalizeChord` with modifier aliases control→ctrl, cmd/win/super→meta,
  option→alt, a canonical `ctrl,shift,alt,meta` ordering, key aliases, and multi-chord SEQUENCES
  such as Emacs `Ctrl+X Ctrl+S`); `PRESET_BINDINGS` (12 representative commands per preset, each
  internally conflict-free); `detectConflicts` (group by normalized key + `when`; > 1 distinct
  command = conflict; the same command is deduped; a different `when` does not conflict); and
  portable `SettingsProfile`s with `resolveKeymap` (overrides win over the preset), `exportProfile`
  / `importProfile` (versioned `axiom.settingsProfile` envelope + sanitize + slugify), and
  `createProfile`. Wired: a new **`keymap.preset`** settings enum next to `editor.keymap`, and the
  **Keyboard Shortcuts view** now shows the active preset + a **live conflict count** over the
  effective bindings (via `detectConflicts`, reusing existing classes — no new CSS). Partial:
  applying a preset's bindings app-wide and a full profile-manager UI remain. Verified: typecheck 0,
  prettier, 3-bundle build, 49/49 smoke.
- **#3 Context sources & prioritization (Epoch F / Phase 155, missing → partial — new).** New pure
  `common/contextSources.ts`: a ten-way `SourceKind` (system / rules / selection / attachments /
  openFiles / recentEdits / symbols / retrieved / memory / repoMap) with `SOURCE_CONFIG` per kind
  ({ priority, share, maxTokens }, the raw shares summing to exactly 1.0); `allocateBudget` splits a
  token budget across the sources actually present — proportional to share (normalized over the
  present sources), clamped by each source's hard `maxTokens`, with the capped remainder
  redistributed and any rounding remainder handed to the highest-priority source; `rankAndSelect`
  greedily includes the highest-scoring items that fit each source's budget, orders the survivors by
  source priority then score, and returns a `{ included, dropped, bySource, summary }` manifest
  (reusing the shared ~4-chars/token `estimateTokens`). This is the COMPOSE / PRIORITIZE step that
  precedes the Phase 156 `fitContext` truncation. Wired main-side into
  `main/services/contextBuilder.ts`: candidate reasons map to source kinds (active→selection,
  retrieval→retrieved, dependency→symbols), `rankAndSelect` computes the plan, and the per-source
  token budget is surfaced in the context header (`(Source budget: …)`, shown when ≥ 2 sources) + a
  debug log — **non-invasively** (the pinned active file and the existing `fitContext` selection are
  untouched). Partial: replacing the builder's selection with the source allocator and adding richer
  sources (recent-edits / memory / repo-map feeds) remain. Verified: typecheck 0, prettier, 3-bundle
  build, 33/33 smoke.
- **Net:** three fully-verified features, all **missing → partial** (J §276, I §249, F §155). Done
  holds at **153**, partial **85 → 88**, missing **52 → 49**; weighted **195.5 → 197.0 / 290
  (~68%)**; fully-done-only **153/290 (~53%)**. Per-epoch: F 22.0 → 22.5 (58→59%), I 12.5 → 13.0
  (48→50%), J 6.5 → 7.0 (30→32%); the per-epoch weighted column sums exactly to 197.0. Standing asks
  unchanged: cloud sync is active (user ran the SQL); further Epoch-E backend (Postgres schema / RLS
  / Edge / the telemetry ingest endpoint / Realtime flag delivery) needs a live backend + the user's
  go-ahead; the signed Windows installer is deferred until feature-complete, then built with full
  Axiom branding (ask the user for special requirements first). All temp smoke tests removed.

### Session 52 — 2026-07-29 (three-build run: recovery/resilience core, audio cues, prompt/context caching)

- **#1 Recovery / resilience / chaos (Epoch J / Phase 277, missing → partial — new).** New
  pure `common/recovery.ts`: `planStoreRecovery` (ok → keep; missing → reset a critical store
  else rebuild a derived one; corrupt → restore-from-backup, else quarantine a critical store /
  rebuild a derived one) and `planRecovery(RecoveryInputs) → RecoveryPlan` — enters **safe mode**
  at `SAFE_MODE_CRASH_THRESHOLD = 3` consecutive unclean exits OR when a critical store is
  corrupt with no backup, plans a **bad-update rollback** when the last update applied but never
  reported healthy, and reports resumable agent runs (0 in safe mode). Wired into
  `main/services/crashJournal.ts` `initCrashJournal`: a consecutive-crash counter
  (`recovery-crashes.json`), `gatherStoreSignals` (parse-check settings / telemetry-buffer /
  agent-runs / memory JSON → ok / corrupt / missing), `countInterruptedRuns`, then `planRecovery`
  **enriches the existing startup `RecoveryNotice.summary`** (the `{unclean, summary}` IPC shape
  is unchanged; App.tsx already surfaces it as a toast). Partial: the decision core + startup
  consumption ship; a real chaos-test harness (power-loss, corrupt-DB rebuild execution,
  network-loss failover, live bad-update rollback) remains. Verified: typecheck 0, prettier,
  3-bundle build, 14/14 smoke.
- **#2 Audio cues (Epoch I / Phase 254, partial — deepened).** New pure `common/audioCues.ts`:
  `CueEvent` (error / warning / success / info / breakpoint / taskComplete / agentApproval),
  `CUE_DEFS` (frequency / duration / waveform kind buzz|beep|chirp|ding / pulse count),
  `isCueEnabled` (a master switch + per-event overrides + a DEFAULT_ON set — error / warning /
  breakpoint on, the rest off), `selectCue`, `cueForLevel`, `cueForDiagnosticSeverity`
  (1 → error, 2 → warning, else none), `shouldThrottle` (`MIN_CUE_GAP_MS = 400`), and
  `summarizeCues`. Wired: a new `renderer/src/a11y/audioCue.ts` `installAudioCues` subscribes to
  the notifications bus and plays a short WebAudio oscillator tone per cue (waveform + pulses +
  a gain ramp), throttled; App.tsx installs it reading a new **`a11y.audioCues`** setting
  (boolean, default off, Appearance) live. Deepens the already-partial 253/254 (no count change —
  honest); a full runtime axe scan + manual screen-reader testing remain out of the sandbox.
  Verified: typecheck 0, prettier, 3-bundle build, 17/17 smoke.
- **#3 Prompt / context caching (Epoch F / Phase 157, missing → partial — new).** New pure
  `common/promptCache.ts`: `segmentMessages` splits a request into the maximal leading STABLE
  prefix (system + `pinned` rules/context) and the VOLATILE suffix; `stablePrefixKey` (FNV-1a
  content hash + length tag); `estimateMessageTokens`; `cacheDirectiveFor` per provider family
  (Anthropic explicit `cache_control`/ephemeral, read 0.1× / write 1.25×, min 1024 tok; OpenAI
  automatic prefix caching, read 0.5×, min 1024; DeepSeek automatic, read 0.1×; Gemini explicit
  cachedContent, read 0.25×, min 4096; custom none); `cacheBreakpointIndices` (mark the last
  stable block for explicit providers); `planPromptCache` → a `CachePlan` (cacheable, cacheHit
  vs a prior key, cached / fresh tokens, hit ratio, breakpoint indices, summary); and
  `effectiveInputTokens` / `savedTokens` (bill cached tokens at the read multiplier on a hit,
  the write premium on the first turn). Wired into `main/services/ai.ts` `streamAnthropic`: when
  the stable system prefix is large enough to be cacheable, the `system` field is sent as a
  content-block array marked with `cache_control: { type: 'ephemeral' }` (instead of a plain
  string) → real Anthropic prompt caching; small prefixes stay a plain string. Partial: per-
  conversation prior-key tracking + hit accounting in the spend ledger, OpenAI/Gemini
  cachedContent handle management, and a context-manifest UI surface remain. Verified:
  typecheck 0, prettier, 3-bundle build, 56/56 smoke.
- **Net:** three fully-verified features. **+2 missing → partial** (J §277, F §157) and **+1
  deepening** (I §254, already partial — no count change, honest). Done holds at **153**, partial
  **83 → 85**, missing **54 → 52**; weighted **194.5 → 195.5 / 290 (~67%)**; fully-done-only
  **153/290 (~53%)**. Per-epoch: F 21.5 → 22.0 (57→58%), J 6.0 → 6.5 (27→30%); I unchanged at
  12.5 (48%); the per-epoch weighted column sums exactly to 195.5. Standing asks unchanged: cloud
  sync is activated (user ran the SQL); prompt-cache hit accounting / telemetry upload / auto-
  update download stay client-only pending an endpoint / real machine; the signed Windows
  installer is deferred until feature-complete, then built with full Axiom branding. All temp
  smoke tests removed.

### Session 51 — 2026-07-28 (three-build run: auto-update client, telemetry/crash upload client, first localization)

- **#1 Auto-update client (Epoch A / Phase 17, missing → partial — new).** New pure
  `common/autoUpdate.ts`: channel-aware `evaluateUpdate` (a user on stable/beta/alpha/dev
  accepts releases at their rank or stabler; picks the highest version, never a downgrade;
  available / mandatory / up-to-date), `verifyDownload` (sha256 + size — a missing/mismatched
  hash is a hard refusal, supply-chain safety), `restartPlan` (apply-and-restart for mandatory,
  else prompt), `nextCheckDelayMs` (exp backoff, capped 24h), and `summarizeUpdate`. Full
  end-to-end wire: `main/services/autoUpdate.ts` reads `app.getVersion()` + a LOCAL dev feed
  (`userData/updates/feed.json`, no network) → `autoUpdate:check` IPC → preload →
  `env.d.ts` → a **"Check for Updates"** command-palette action that surfaces the result as a
  notification. Partial: the actual download/apply + signing + a remote feed + staged
  rollout/rollback (Epoch J) run on a real machine. Verified: typecheck 0, prettier, 3-bundle
  build, 19/19 smoke.
- **#2 Telemetry / crash-report upload client (Epoch E §53 / Phase 18-upload, missing →
  partial — new).** New pure `common/telemetryUpload.ts`: `selectUploadable` (re-checks consent
  at send time), `redactEvent` (defensive re-redaction — only bucketed numbers / booleans /
  short enums ever leave the device, INV-3), `buildBatches` (FIFO), `buildUploadPayload`
  (versioned + fully redacted), `dropUploaded` (FIFO reconcile after a successful upload),
  `shouldUpload`, `nextUploadDelayMs` (exp backoff), and `previewUpload`. Crash reports flow
  through the same pipeline. Wired: `telemetry.uploadPreview()` (consent + buffer + endpoint
  setting) surfaced in the **data-export** bundle as a privacy-transparency view of exactly how
  much telemetry would upload. NO network / NO live backend — the authenticated POST is deferred
  until an ingest endpoint is configured + the user opts in (like the s47 sync client).
  Verified: typecheck 0, prettier, 3-bundle build, 17/17 smoke.
- **#3 First localization + coverage pipeline (Epoch I / Phase 252, missing → partial — new).**
  New pure `common/i18nCoverage.ts`: `computeCoverage` (a locale's % vs the English source,
  missing / extra keys), `mergeCatalog` (a target over English so untranslated keys fall back to
  English, never a raw key), `buildReviewQueue` (missing + untranslated-copy keys, each with the
  source as an MT-suggested placeholder to review), and `formatCoverage`. New
  `common/locales/es.ts` — a first, in-progress **Spanish** catalog (6/7 keys incl. both ICU
  plurals; one string intentionally pending review, falling back to English). Wired: the
  renderer i18n binding now merges the selected locale over English (real fallback improvement)
  - exposes `localeCoverage`, `SUPPORTED_LOCALES` = en/es, and Settings offers **Español (beta)**.
    Partial: bundled CJK/Cyrillic fonts (a font-stack shipped s42), full locale completion, and a
    real MT step remain. Verified: typecheck 0, prettier, 3-bundle build, 10/10 smoke.
- **Net:** three fully-verified features, all **missing → partial** (A §17, E §18-upload,
  I §252). Done holds at **153**, partial **80 → 83**, missing **57 → 54**; weighted **193.0 →
  194.5 / 290 (~67%)**; fully-done-only **153/290 (~53%)**. Per-epoch: A 10.0 → 10.5 (50→53%),
  E 15.5 → 16.0 (55→57%), I 12.0 → 12.5 (46→48%); the per-epoch weighted column sums exactly to
  194.5. Standing asks unchanged: cloud sync is activated (user ran the SQL); telemetry upload +
  auto-update download stay client-only pending an endpoint / real machine; the signed Windows
  installer is deferred until feature-complete, then built with full Axiom branding. All temp
  smoke tests removed.

### Session 50 — 2026-07-27 (three-build run: extension management UI, autonomous-loop controller, large-repo hardening)

- **#1 Extension management (Epoch I / Phase 245, missing → partial — new).** New pure
  `common/extensionManagement.ts`: `resolveEnablement` (per-workspace override > global >
  trust-aware default-disabled), `planBulkUpdate` (installed extensions with a newer version
  in the local registry → an update plan, sorted by name), and trust-aware
  `recommendExtensions` (ranks local-registry entries by keyword / name / description match to
  the project's languages + frameworks, excluding installed). Built on the existing registry
  index (`compareVersions` / `RegistryEntry` / `InstalledRef`). Wired into the Extensions
  view's Marketplace tab: an **"N updates available — Update all"** bar (installs each
  candidate) and a **"Recommended for this project"** section driven by a best-effort project
  profile, de-duplicated from the full list. Partial: a pre-install permission diff for remote
  packages and a full per-workspace override UI remain (install/enable/disable/upgrade + the
  local registry already shipped, 239–243). Verified: typecheck 0, prettier, 3-bundle build,
  10/10 smoke.
- **#2 Autonomous coding-agent loop controller (Epoch H / Phase 216, missing → partial — new).**
  New pure `common/autoLoop.ts`: the OUTER goal → plan → act → verify → iterate controller —
  `createAutoLoop` + strict phase-guarded transitions (`recordPlan` / `recordAction` /
  `recordVerification` / `recordSummary`) that, from each verification verdict, decide
  `summarize` (green), `act` (iterate), or `aborted` (iteration cap OR no-progress cap; a drop
  in failing checks resets the no-progress counter), plus `nextAction` / `isAutoTerminal` /
  `summarizeAutoRun`. Wired into `agent.ts`: `verificationPassed` reads the `run_command`
  `[VERIFICATION]` prefix, an autoLoop instance advances per verification during the ReAct
  pass, and the honest convergence summary is appended to the run timeline. Non-breaking
  (read-only accounting — no status/chat change, no new IPC). Partial: full autonomy that
  DRIVES successive ReAct passes end-to-end with checkpoints between iterations remains future
  work. Verified: typecheck 0, prettier, 3-bundle build, 18/18 smoke.
- **#3 Large-repository hardening (Epoch J / Phase 267, missing → partial — new).** New pure
  `common/largeRepo.ts`: `classifyRepoScale` (small ≤5k / medium ≤50k / large ≤200k / huge ≤1M
  / extreme >1M), `planScopedIndex` (full / partial / scoped / on-demand indexing + a file
  budget + lazy flag), `watcherStormPolicy` (native → debounced → polling → suspended by the
  FS-event rate, to survive a watcher storm), and `degradationPlan` (which features to disable
  at scale — auto graph build, live search — plus a scale-scaled Git-status cadence), with
  `summarizeRepoHardening`. Complements the file-level `largeFile.ts`. Wired into the
  Performance panel: a **"Repo: &lt;scale · N files · index mode&gt;"** readout from the live
  project profile, graded ok / warn / fail by scale (reuses the perf-watchdog classes). Partial:
  the walker / indexer / watcher consuming these decisions at 1M-file scale (and the Rust-core
  virtualization) remain — this ships the policy + a live readout. Verified: typecheck 0,
  prettier, 3-bundle build, 28/28 smoke.
- **Net:** three fully-verified features, all **missing → partial** (I §245, H §216, J §267).
  Done holds at **153**, partial **77 → 80**, missing **60 → 57**; weighted **191.5 → 193.0 /
  290 (~67%)**; fully-done-only **153/290 (~53%)**. Per-epoch: H 33.5 → 34.0 (88→89%),
  I 11.5 → 12.0 (44→46%), J 5.5 → 6.0 (25→27%); the per-epoch weighted column sums exactly to
  193.0. Standing asks unchanged: cloud sync is activated (user ran the SQL); the signed
  Windows installer is deferred until the app is feature-complete, then built with full Axiom
  branding. All temp smoke tests removed.

### Session 49 — 2026-07-26 (three-build run: hot-path latency engine, context truncation & compression, main-process agent-pool enforcement)

- **#1 Editor hot-path latency & rendering (Epoch J / Phase 269, missing → partial — new).**
  New pure `common/hotPath.ts`: `FRAME_BUDGET_MS` (one 60fps frame ≈ 16.667 ms),
  `isHotPath(WorkKind)` (keystroke/caret/scroll/render/layout/selection vs
  ai/index/agent/… background), `computeLatencyStats` (nearest-rank p50/p95/p99 + mean +
  max), `gradeFrames` (ok / warn / breach vs the budget with a tolerance ceiling +
  long-frame count), `hotPathAdvice`, plus the background-yielding policy —
  `frameHeadroom`, `shouldDeferBackground`, and `planYield` (admit background tasks into
  the frame's remaining budget, defer the rest, with a starvation guard so an idle frame
  always makes progress) — encoding INV-1 ("background work never breaches the hot
  path"). Wired into the Performance panel: a live `requestAnimationFrame` sampler (a
  ~4s ring buffer) grades the hot path each second and shows a **Hot path: p95 X ms ·
  N/M long — advice** readout (reuses the existing perf-watchdog classes; no new
  CSS/IPC). Partial: GPU tuning + universal adoption of the yielder by every background
  caller remain. Verified: typecheck 0, prettier, 3-bundle build, 30/30 smoke.
- **#2 Context truncation & compression (Epoch F / Phase 156, missing → partial — new).**
  New pure `common/contextBudget.ts`: `fitContext(items, budget)` fits prioritized
  context items into a token budget "without breaking quality" — pinned-first then
  highest-priority-first; each item is kept whole if it fits, else **compressed** (symbol
  skeleton) or **windowed** (a budget-sized slice) before the **lowest-priority items are
  dropped** last; pinned items (system/rules/active file) are never dropped (an overflow
  is reported honestly). Returns a per-item plan (`none`/`skeleton`/`window`/dropped) in
  input order plus totals, with `summarizeFit`. Wired into `main/services/contextBuilder`:
  the crude whole-block tail-drop is replaced by `fitContext` (builds a full + skeleton
  form per candidate via the existing skeletonizer, pins the active file, materializes the
  windowed/skeleton text) and appends a visible **"(Context fitted: ~T/B tokens, C
  compressed, W windowed, D dropped.)"** note — the `ContextResult` IPC shape is
  unchanged. Partial: hierarchical multi-level summarization + per-source manifest
  strategy tags remain. Verified: typecheck 0, prettier, 3-bundle build, 13/13 smoke.
- **#3 Bounded agent-pool enforcement (Epoch H / Phases 218 Background + 219 Parallel,
  partial → done).** New pure `common/agentPool.ts`: a `PoolState`
  (running / queued / ceiling) state machine — `submit` / `complete` / `remove` return a
  `{ state, admit[] }` transition that drains the queue up to the ceiling in fair order
  (via the s48 `agentScheduler.planAdmissions`). Wired into `main/services/agent.ts` so it
  actually **enforces** the ceiling: every top-level `runAgent` is submitted to the pool
  and either starts now (a free slot) or is recorded **queued** and awaits admission;
  when a run finishes (or is cancelled) the freed slot releases the next queued run(s).
  Sub-agents run inline and never take a slot; cancellation of a queued run is handled via
  the abort signal. Added a `queued` `AgentTaskStatus` (surfaced in the Tasks panel — a
  Queued badge + a real "N queued" figure in the bounded-pool line; no new IPC, reusing
  the existing task-update broadcast). This promotes the s48 renderer-only admission
  policy to genuine main-process background/parallel enforcement. Remaining polish: a
  dedicated completion popup toast + per-run priority from the UI. Verified: typecheck 0,
  prettier, 3-bundle build, 13/13 smoke.
- **Net:** three fully-verified features. **+2 done** (H §218 + §219 partial → done) and
  **+2 new partials** (J §269 and F §156, both missing → partial), so the two new partials
  net against the two promoted ones — **partial holds at 77**, done **151 → 153**, missing
  **62 → 60**. Weighted **189.5 → 191.5 / 290 (~66%)**; fully-done-only **153/290 (~53%)**.
  Per-epoch: F 21.0 → 21.5 (55→57%), H 32.5 → 33.5 (86→88%), J 5.0 → 5.5 (23→25%); the
  per-epoch weighted column sums exactly to 191.5. Standing asks: the cloud-sync backend is
  now activated (the user ran `docs/SUPABASE_SYNC_SETUP.md`); the signed Windows installer
  is deferred until the app is feature-complete, then built with full Axiom branding (per
  the user). All temp smoke tests removed.

### Session 48 — 2026-07-25 (three-build run: streamed tool-call/reasoning assembler, bounded-pool agent scheduler, component a11y audit)

- **#1 Streamed tool-call & reasoning assembler (Epoch F / Phase 148, partial — new).** New
  pure `common/streamAssembler.ts`: `deltasFromOpenAIChunk` normalizes an OpenAI-style
  streaming chunk (`choices[0].delta`) into flat deltas (content / reasoning — incl. the
  `reasoning_content` alias / tool-call fragments / finish), and `assembleStream` folds a
  delta sequence into a finalized result — merging tool-call fragments by `index` (concatenated
  partial-JSON arguments, then JSON-parsed via `parseToolArguments`) and separating reasoning
  from the answer. Wired into `main/services/ai.ts`: the OpenAI/custom streaming pump now runs
  through the module (content streams live, byte-identical for ordinary turns), previously
  **dropped** `reasoning_content` deltas are wrapped in `<think>…</think>` so the existing
  thinking-mode UI shows them, and a tool-only turn surfaces a concise "Requested tool call"
  summary instead of a blank message. Partial: Anthropic/Gemini streamed tool-call parity and
  full agent-loop consumption of streamed calls remain. Verified: typecheck 0, prettier,
  3-bundle build, 32/32 smoke.
- **#2 Bounded-pool fair agent scheduler (Epoch H / Phases 218 Background + 219 Parallel Agents,
  partial — new).** New pure `common/agentScheduler.ts`: `freeSlots`/`canAdmit` (never exceed a
  concurrency ceiling), `fairOrder` (priority tiers high → normal → low, round-robin across
  groups so one group cannot starve others, FIFO within a group), `planAdmissions` (admit the
  first free-slots tasks in fair order), and `aggregateResults` (overall + per-group
  success/failure/cancelled tallies). Wired renderer-only into the Tasks panel: a bounded-pool
  utilization line (`Pool: N / 4 running · X free|full`) and an aggregated run-history outcome
  line — reusing existing classes, no new IPC/CSS. Partial: the admission policy is built +
  surfaced, but main-process enforcement (actual background/parallel queuing + completion
  toasts) remains. Verified: typecheck 0, prettier, 3-bundle build, 16/16 smoke.
- **#3 Component a11y audit (Epoch I / Phase 253, partial — deepened).** New pure
  `common/a11yAudit.ts`: `auditComponents` inspects component descriptors and reports ARIA /
  keyboard findings — missing accessible name (error), interactive-without-role (warn),
  positive tabindex (warn), aria-hidden-on-focusable (error), missing live-region (warn),
  duplicate focus order (warn) — each with a fix, plus a weighted 0–100 score and
  `formatA11ySummary`. A new **A11y Audit** Explorer panel scans the live workbench DOM
  (bounded, only DOM-reliable rules to avoid false positives) and lists the findings + score.
  Reuses existing `dep-*`/`oe-*` classes — no new CSS. Deepens the already-partial 253/254
  (s45); a full runtime axe scan + manual screen-reader testing remain out of the sandbox.
  Verified: typecheck 0, prettier, 3-bundle build, 20/20 smoke.
- **Net:** three fully-verified features. **+3 partials** — F §148 (missing → partial) and
  H §218/§219 (both missing → partial); I §253 was already partial (deepened, no count change).
  No new fully-done phase, so fully-done-only holds at **151/290 (~52%)**; weighted **188.0 →
  189.5 / 290 (~65%)**; 151 done / 77 partial / 62 missing. Per-epoch: F 20.5→21.0,
  H 31.5→32.5 (I unchanged). Standing asks unchanged: run the `docs/SUPABASE_SYNC_SETUP.md` SQL
  to activate cloud sync; the signed Windows installer still needs a real machine + the user's
  special requirements (ask first). All temp smoke tests removed.

### Session 47 — 2026-07-24 (four-build run: cloud-sync client, agent run persistence/timeline, graph metrics/hotspots, call-hierarchy panel)

- **#1 Cloud preferences sync client (Epoch E §55, partial — new).** New pure
  `common/syncProtocol.ts`: `buildPushRows` / `parsePullRows` / `ackedIds` map the offline
  op-queue to and from Supabase `user_settings` rows. `main/services/sync.ts` `flushQueue`
  (previously a no-op) now pushes queued ops (upsert on `user_id,key`), reconciles the queue,
  then pulls + applies remote records; a **Back up preferences for sync** button in the AI
  panel triggers it. New `docs/SUPABASE_SYNC_SETUP.md` (table + RLS SQL). Partial: the network
  round-trip is unverified in-sandbox (no live table) and needs the user to run the SQL.
  Verified: typecheck 0, prettier, 3-bundle build, 18/18 smoke.
- **#2 Agent run persistence & timeline (Epoch H / Phase 209 done, 210 partial — new).** New
  pure `common/runJournal.ts`: `RunRecord` + `startRun` / `appendRunStep` / `isRunTerminal` /
  `summarizeRun` / `buildTimeline` / `pruneRuns` / `resumeContext`. New
  `main/services/agentRuns.ts` persists runs to `userData/agent-runs.json` (atomic writes,
  capped at 100); `agent.ts` records each run + step; a 2-step IPC exposes
  `agent.runs.list/clear`. The Tasks panel gained a **Run history** section (per-run
  status/preset/steps/duration + an expandable timeline). Verified: typecheck 0, prettier,
  3-bundle build, 22/22 smoke.
- **#3 Knowledge-graph metrics & hotspots (Epoch C §127, partial — new).** New pure
  `common/graphMetrics.ts`: `computeFileMetrics` (fan-in/fan-out, coupling, instability,
  category, hotspot flag) + `rankHotspots`. The Dependencies panel now renders a metrics line
  (label + fan-in/fan-out/instability, flagged when a hotspot) beneath the impact count — no
  new IPC, no new CSS. Verified: typecheck 0, prettier, 3-bundle build, 19/19 smoke.
- **#4 Call-hierarchy panel (Epoch D / Phase 95, partial — new).** New pure
  `common/callHierarchy.ts`: `buildCallHierarchy` dedupes reference locations, groups them by
  file, and sorts (files by count desc then path, locations by line/column), with a
  `relFromRoot` helper. A new **Axiom: Show Call Hierarchy** editor action (context menu +
  palette) resolves the symbol's incoming references via the language server and publishes
  them on a new `callHierarchyBus`; a new **Call Hierarchy** Explorer panel renders the
  grouped, click-to-jump tree (reuses existing `dep-*`/`oe-*` classes — no new CSS). Partial:
  incoming references ("callers") only — outgoing calls + a full call-hierarchy provider
  remain (Monaco exposes none). Verified: typecheck 0, prettier, 3-bundle build, 19/19 smoke.
- **Net:** four fully-verified features. **+1 done** (H §209 run persistence) and **+4
  partials** (E §55 sync, H §210 resume, C §127 graph metrics, D §95 call hierarchy) — five
  previously-missing phases moved forward. Weighted total **185.0 → 188.0 / 290 (~65%)**; 151
  done / 74 partial / 65 missing; fully-done-only 151/290 (~52%). Per-epoch: C 16.0→16.5,
  D 23.0→23.5, E 15.0→15.5, H 30.0→31.5. Standing asks: run the `docs/SUPABASE_SYNC_SETUP.md`
  SQL to activate cloud sync; the signed Windows installer still needs a real machine + the
  user's special requirements (ask first). All temp smoke tests removed.

### Session 46 — 2026-07-23 (three-build run: roving-focus keyboard nav, per-model budgets, SAST rule pack)

- **#1 Keyboard navigation & focus (Epoch I / Phase 254, partial — deepened).** New pure
  `common/focusNav.ts`: a roving-tabindex focus-order reducer (`nextFocusIndex` for
  Arrow/Home/End/PageUp/PageDown with orientation + wrap, `rovingTabIndex`). The Problems
  panel is now a single-Tab-stop **roving `listbox`** — Up/Down/Home/End/Page move focus
  between rows (role=option, aria-selected), Enter/click still jumps to the line. Verified:
  typecheck 0, prettier, 3-bundle build, 24/24 smoke.
- **#2 Per-model spend budgets (Epoch F / Phases 152/197, deepened).** New pure
  `common/modelBudget.ts`: parse a `model=usd, …` budget map and evaluate each model's
  today-spend against it (ok / warn / over / none, with a summary). The spend dashboard now
  shows each top model's spend as `used / budget` (flagged when over/approaching) and adds a
  **per-model budgets** field (`ai.modelBudgets`) — per-model granularity atop the global
  daily budget + enforcement. Verified: typecheck 0, prettier, 3-bundle build, 23/23 smoke.
- **#3 SAST rule pack (Epoch J / Phase 271, partial — deepened).** New pure
  `common/sastRules.ts`: a 10-rule regex SAST pass (SQL concat/template injection, shell
  command-injection, `new Function`, string `setTimeout`, weak MD5/SHA-1, `Math.random`,
  disabled TLS verification, `innerHTML` assignment, `document.write`) with severities +
  categories + recommendations, plus `summarizeSast`. It complements the Electron/config
  fitness checks (no overlap). A **Run SAST rules** button in the Security panel scans the
  active file, shows a severity summary + click-to-line findings. Verified: typecheck 0,
  prettier, 3-bundle build, 30/30 smoke.
- **Net:** three fully-verified features shipped, but **no phase-count change** — each
  deepens an already-partial phase (I §254 keyboard a11y, J §271 SAST) or an already-done
  one (F §152/197 budgets), so the weighted total honestly holds at **185.0 / 290 (~64%)**.
  Broad completion of §254 (full SR/keyboard audit across every panel) and §271 (fuzzing +
  CI-on-HW + full SAST/SCA) remains out of the in-app sandbox. All temp smoke tests removed.

### Session 45 — 2026-07-22 (three-build run: memory-soak analyzer, screen-reader/editor a11y, response-cache dedup)

- **#1 Memory-soak analyzer (Epoch J / Phase 266, partial — deepened).** New pure
  `common/memorySoak.ts`: a least-squares fit of heap-vs-time over a rolling window
  yields a growth rate (MB/min) classified ok / suspect / leak — catching the slow
  upward drift a soak test reveals (complementing the single-sample memory watchdog).
  The Performance panel now samples the heap every 10s while open and shows a **Memory
  trend** row. Deepens 266 (V8-snapshot startup + the fix for any leak found stay
  out-of-sandbox; 266 remains partial). Verified: typecheck 0, prettier, 3-bundle
  build, 15/15 smoke.
- **#2 Screen-reader + editor accessibility (Epoch I / Phases 253/254, partial).** New
  pure `common/a11y.ts` (announcement builders with polite/assertive politeness, a
  diagnostics summary, an editor ARIA-label builder, and a repeat-suppression guard). A
  visually-hidden **LiveRegion** (polite + assertive `aria-live` regions) announces every
  notification and explicit announcement to screen readers, and the Monaco editor gains
  `accessibilitySupport: 'auto'` + a per-file ARIA label (and announces file opens). Purely
  additive — sighted UI is unchanged. Verified: typecheck 0, prettier, 3-bundle build,
  21/21 smoke.
- **#3 Response-cache prompt-normalization dedup (Epoch F, partial).** New pure
  `common/requestDedup.ts`: conservative content normalization (CRLF→LF, per-line
  right-trim, collapse blank-line runs, trim blank lines at the ends — never lowercasing
  or reordering) plus a Jaccard `similarity` + `isNearDuplicate` for a future near-dup
  layer. The egress gateway's cache key now normalizes message content, so requests
  differing only in whitespace / blank lines **share a cache entry** — cutting BYOK spend
  without changing the answer. Verified: typecheck 0, prettier, 3-bundle build, 22/22
  smoke.
- **Net:** +3 new partials (weighted 183.5 → 185.0 = **64%**; fully-done unchanged at
  150/290 ~52%). **Epoch F 53% → 54%**, **Epoch I 40% → 44%**; **Epoch J 23%** unchanged
  (the soak analyzer deepens the already-partial 266). Honestly partial: full SR/keyboard
  a11y audit across every panel, V8-snapshot startup, and embedding-based semantic dedup
  remain. The per-epoch weighted column sums exactly to 185.0. All temp smoke tests removed.

### Session 44 — 2026-07-21 (three-build run: large-file/large-repo hardening, provider circuit breaker, keymaps + Vim mode)

- **#1 Large-file & large-repo hardening (Epoch J / Phases 268/269, partial).** New
  pure `common/largeFile.ts`: `classifyFileForEditor` (normal / large / huge → which
  perf features to disable), `shouldIndexFile` (skip oversized, lockfile, minified, and
  generated artifacts), and `planRepoIndex` (a large-repo file budget). Wired: the
  editor now opens a **large-file mode** (huge files are backed by a plaintext model so
  Monaco skips tokenization; the minimap, wrapping, and bracket colorization are
  disabled, with a one-time notice); the AI context builder skips files `shouldIndexFile`
  rejects; and the Quick Open walker's cap is centralized on the pure repo budget.
  Verified: typecheck 0, prettier, 3-bundle build, 24/24 smoke.
- **#2 Provider health & circuit breaker (Epoch F / Phases 167/168).** New pure
  `common/providerHealth.ts`: a per-provider circuit breaker — consecutive failures trip
  the circuit **open** (skipped in the failover chain); after a cooldown it goes
  **half-open** (one trial); a success **closes** it. The Main failover handler now
  filters the chain to healthy providers, then records which attempt succeeded / which
  failed over (`ai:providerHealth` IPC surfaces the state), and the AI panel flags a
  tripped-open (with a retry countdown) or recovering provider. Verified: typecheck 0,
  prettier, 3-bundle build, 20/20 smoke.
- **#3 Keymaps + Vim-mode foundation (Epoch I / Phase 249, partial).** New pure
  `common/keymaps.ts` (keymap profiles: default / Vim) and `common/vim.ts` — a modal
  state machine (normal / insert / visual) with motions (`h j k l w b 0 $ gg G`), insert
  entries (`i a I A o O`), operators (`x`, `dd`, `dw`, visual `d`/`x`), counts, undo, and
  paste, returning abstract actions. Wired into Monaco via a keydown interceptor +
  `applyVimActions` (cursor commands, `*Select` variants in visual mode), a `-- NORMAL /
INSERT / VISUAL --` status-bar indicator, and a new `editor.keymap` setting. A
  foundation (no registers / marks / ex-commands / macros yet). Verified: typecheck 0,
  prettier, 3-bundle build, 45/45 smoke.
- **Net:** +1 fully-done phase and +3 new partials (149 → 150 done; weighted 181.0 →
  183.5 = **63%**; fully-done ~52%). **Epoch F 50% → 53%**, **Epoch I 38% → 40%**,
  **Epoch J 18% → 23%**. Large-file/large-repo (streaming huge-file editing, incremental
  reindex, V8-snapshot startup) and Vim (full parity) are honestly partial. The per-epoch
  weighted column sums exactly to 183.5. All temp smoke tests removed.

### Session 43 — 2026-07-20 (three-build run: spend-budget enforcement + capability matcher, SBOM + startup timing, extension marketplace)

- **#1 AI-engine — spend-budget enforcement + model-capability matcher (Epoch F /
  Phases 152/197 + 166).** New pure `common/budgetGate.ts` (`evaluateBudget` → allow /
  warn / block from today's estimated spend, a daily budget, and an enforcement mode,
  with an 80% warn band) and `common/modelCapabilities.ts` (`analyzeRequestNeeds` +
  `checkModelFit` + `suggestModelSwitch`, built on the routing capability heuristics).
  Wired renderer-side: ChatPanel runs a **pre-send budget gate** (blocks or warns before
  spending more — once enforcement is on, an over-budget request never leaves) and a
  **capability re-fit** note (long context from the turn's token estimate, image input
  from an attached image → suggests a fitting model from the provider's list), plus a
  Budget-enforcement selector + live gate status in the spend dashboard and a new
  `ai.budgetEnforcement` setting. Verified: typecheck 0, prettier, 3-bundle build,
  30/30 smoke.
- **#2 Hardening — SBOM generator + startup-phase timing (Epoch J / Phases 271 + 266,
  partial).** New pure `common/sbom.ts` (a CycloneDX-ish document from package.json + a
  package-lock's resolved versions — `library` components with purls + scope,
  `parseLockResolved` for v2/v3 `packages` + legacy v1 lockfiles) surfaced in the Security
  panel as **Export SBOM (CycloneDX)**. New pure `common/startupTiming.ts` (a phase
  breakdown + total from real marks → perf-budget measurements); the Main process now
  records genuine `process → app-ready → window-created → dom-ready` marks (via
  `performance.now()` + a one-time renderer ready-ping) and the Performance panel shows a
  **cold-start phase breakdown** graded against the budgets. Both **deepen** their
  partials — full fuzzing / CI-on-reference-HW / V8-snapshot work stays out of the
  sandbox. Verified: typecheck 0, prettier, 3-bundle build, 40/40 smoke.
- **#3 Extensions — marketplace / local registry (Epoch I / Phase 243, partial).** New
  pure `common/extensionRegistryIndex.ts` (validate a registry index, semver-ish
  `compareVersions`, ranked `searchRegistry`, and `buildInstallPlan` →
  install / upgrade / downgrade / up-to-date). New Main service reads a **local registry**
  (userData/registry: an optional `index.json` + a `packages/<name>/` scan + a workspace
  `.axiom/registry.json`) and an **install flow** that copies a package folder into
  userData/extensions (then picked up by the existing discovery + capability broker). A
  **Marketplace tab** in the Extensions view searches the registry and installs each entry
  with a plan-aware action button. Partial — local/first-party registry only; no live
  remote marketplace. Verified: typecheck 0, prettier, 3-bundle build, 25/25 smoke.
- **Net:** +2 fully-done phases (147 → 149; weighted 179.0 → 181.0 = **62%**; fully-done
  ~51%). **Epoch F 46% → 50%**, **Epoch I 37% → 38%**; **Epoch J 18%** unchanged (both J
  items honestly deepen existing partials rather than completing a phase). The per-epoch
  weighted column sums exactly to 181.0. All temp smoke tests removed.

### Session 42 — 2026-07-19 (three-build run: RTL/fonts, dependency+egress security, crash recovery)

- **#1 RTL & fonts (Epoch I / Phases 251/252, partial).** New pure `common/rtl.ts`
  (RTL locale detection, direction resolution, and pseudo-localization — accent +
  ~40% expansion, preserving `{placeholders}` — for layout-robustness testing). The
  ThemeController now sets `document.dir`/`lang` from the locale and applies a
  pseudo-locale dev toggle; a CJK/Latin/Cyrillic font-stack + RTL mirroring CSS land
  in global.css. Verified: typecheck 0, prettier, 3-bundle build, 18/18 smoke.
- **#2 Dependency + egress security (Epoch J / Phases 271/272, partial).** New pure
  `common/depScan.ts` (SCA: flags wildcard/`latest` versions, git/http/file installs,
  deprecations, and TYPOSQUATS of popular packages via bounded edit-distance) wired
  into the Security panel as **Scan dependencies** (reads the workspace package.json).
  New pure `common/egressAudit.ts` (HTTPS/loopback-only egress decision, host-only URL
  redaction, secret-in-log detection) as testable hardening assertions. Verified:
  typecheck 0, prettier, 3-bundle build, 24/24 smoke.
- **#3 Crash-recovery journal (Epoch A / §88.6).** New pure `common/crashJournal.ts`
  (breadcrumb ring, phase marks, clean-exit marker, unclean-shutdown detection +
  recovery summary) + a Main service that reads the prior journal on startup (detects
  an unclean prior exit), starts + synchronously persists a new session journal, marks
  phases, and marks a clean exit on before-quit. A startup toast surfaces the recovery
  notice (work is snapshot-protected + sessions restore). Verified: typecheck 0,
  prettier, 3-bundle build, 22/22 smoke.
- **Net:** +1 fully-done phase and +3 new partials (146 → 147 done; weighted 176.5 →
  179.0 = **62%**; fully-done ~51%). **Epoch A 45% → 50%**, **Epoch I 33% → 37%**,
  **Epoch J 16% → 18%**. RTL/CJK, SCA, and egress items are honestly partial (full
  mirroring audit, SBOM/fuzzing, and DPAPI/memory-hygiene review remain). The per-epoch
  weighted column sums exactly to 179.0. All temp smoke tests removed.

### Session 41 — 2026-07-18 (three-build run: extension host runtime, i18n, self-verification — crosses 61%)

- **#1 Extension host runtime (Epoch I / Phase 239).** New pure
  `common/extensionHost.ts` (host↔extension newline-delimited JSON protocol —
  activate / command / capability request+result / log — plus message guards and
  capability ROUTING through the pure broker). New Main service spawns a supervised
  Node child (ELECTRON_RUN_AS_NODE) running a bootstrap that loads the extension and
  round-trips capability requests; every request is brokered (undeclared → deny,
  secrets → deny, fs-read fulfilled only within the workspace root), crashes are
  isolated, and enabling an extension now activates its host (a "running" badge shows
  in the Extensions view). Verified: typecheck 0, prettier, 3-bundle build, 20/20
  smoke. (239 → done: real supervised host + broker + crash isolation.)
- **#2 i18n infrastructure (Epoch I / Phase 250).** New pure `common/i18n.ts` — a
  message catalog, a brace-balanced ICU-subset interpolator ({var} + {n, plural, =0 /
  one / other {…}} with `#` and nested vars), `t()` with missing-key fallback, and a
  hard-coded-string LINT (JSX text + title/placeholder/aria-label attributes). A base
  English catalog, a renderer `t()` binding driven by a `workbench.locale` setting,
  and sample strings externalized. Verified: typecheck 0, prettier, 3-bundle build,
  20/20 smoke. (250 → done: pipeline + catalog + ICU subset + lint gate.)
- **#3 Self-verification loop (Epoch H / Phase 217).** New pure `common/selfVerify.ts`
  — classify a command (typecheck/build/test/lint), interpret its output into a real
  pass/fail with extracted failures, and `decideIterate` / `buildVerifySummary` that
  only allow a "done" claim when EVERY verification passed (honest reporting). Wired
  into the agent's `run_command`: every command result is prefixed with a
  `[VERIFICATION] …` verdict so the agent must acknowledge a real pass/fail before
  finishing. Verified: typecheck 0, prettier, 3-bundle build, 25/25 smoke.
- **Net:** +3 fully-done phases (143 → 146; weighted 174.0 → 176.5 = **61%**;
  fully-done crosses **50%**). **Epoch H 76% → 79%**, **Epoch I 27% → 33%**. The
  per-epoch weighted column sums exactly to 176.5. All temp smoke tests removed.

### Session 40 — 2026-07-17 (three-build run across Epochs H, I, J — crosses 60%)

- **#1 Epoch H tail — Planning Mode + Thinking Mode + Agent Library UI (214/215/232).**
  New pure `common/planMode.ts` (an editable/trackable plan model — step statuses,
  advance/edit/progress) tracked live in the Agent panel as a checklist with a
  progress %, advancing as the agent runs. New pure `common/thinking.ts` (reasoning
  visibility + split a `<think>`/labeled reasoning block off the answer + token cost)
  surfaced as a collapsible **Reasoning** block in chat with a visibility setting. A
  proper **agent-library** list (all built-in + custom presets, descriptions, tool
  scope, one-click invoke). Verified: typecheck 0, prettier, 3-bundle build, 24/24
  unit smoke.
- **#2 Epoch I — extension foundation (239/240/241/242).** New pure
  `common/extensionManifest.ts` (validate a manifest; a least-privilege **capability
  broker** — declared → allow, undeclared → deny, secrets always denied) and
  `common/extensionRegistry.ts` (merge enabled extensions' contributions into
  namespaced command/tool/prompt/context registries). New Main service discovers +
  validates manifests (userData + workspace `.axiom/extensions`), persists enable
  state, and builds the registry; an **Extensions** view lists installed extensions
  with permissions + contribution counts + enable/disable. The sandboxed host that
  runs extension code is deferred (239 partial). Verified: typecheck 0, prettier,
  3-bundle build, 21/21 unit smoke.
- **#3 Epoch J — security fitness + memory watchdog (270/266 partial).** New pure
  `common/securityFitness.ts` (hardening invariant checks — renderer-imports-secret,
  nodeIntegration/contextIsolation/sandbox flags, dangerouslySetInnerHTML, eval,
  plain-HTTP egress to non-loopback) run over the active file in the Security panel.
  New pure `common/memoryWatchdog.ts` (classify heap usage ok/soft/hard vs a budget)
  surfaced as a watchdog badge in the Performance panel. Verified: typecheck 0,
  prettier, 3-bundle build, 19/19 unit smoke.
- **Net:** +4 fully-done phases and +5 new partials (139 → 143 done; weighted 167.5 →
  174.0 = **60%**). **Epoch H 68% → 76%**, **Epoch I 17% → 27%**, **Epoch J 11% →
  16%**. Extension execution, CI/HW perf gates, and full SAST/SCA are honestly still
  partial/out-of-sandbox. The per-epoch weighted column sums exactly to 174.0. All
  temp smoke tests removed.

### Session 39 — 2026-07-16 (eleven-phase run across Epochs H, I, J)

- **#1 Epoch H — remaining agents + Git AI (Phases 226–231).** Completed the
  specialized-agent library: enhanced the **documentation** agent (226) and added
  **architecture** (227), **deployment** (228 — high-risk-gated, never auto-deploys),
  **dependency/security** (229), and **migration** (230) agents, plus a read-only
  **graph_impact** tool. New pure `common/gitAi.ts` (`buildDiffText` via the shared
  line-diff, Conventional-Commits + PR + changelog prompt builders, reply cleaners) +
  a Main runner + `ai:commitMessage` IPC + a **Generate** button in the SCM view that
  writes a commit message from the staged diff (231). Verified: typecheck 0, prettier,
  3-bundle build, 23/23 unit smoke.
- **#2 Epoch I — themes, contrast & visual a11y (Phases 247/248/255, partial).** New
  pure `common/theme.ts`: hex parsing, WCAG relative-luminance / contrast-ratio /
  AA-AAA **contrast linter**, theme-color validation, and **VS Code color-theme
  import**. New pure `common/uiPrefs.ts`: density, UI zoom (clamped), and
  reduced-motion resolution. Three Appearance settings (density / zoom / reduced
  motion) auto-render in Settings and apply to the workbench root via the
  ThemeController, which also runs the contrast linter on the active theme + accent.
  Verified: typecheck 0, prettier, 3-bundle build, 32/32 unit smoke.
- **#3 Epoch J — perf budget + secret scanner (Phases 265/271, partial).** New pure
  `common/perfBudget.ts` (SLO budgets + pass/warn/fail with tolerance + summary) with
  a **Performance** panel measuring real in-app metrics (navigation timing + JS heap).
  New pure `common/secretScan.ts` (AWS/GitHub/OpenAI/Google/Slack/private-key +
  hard-coded-secret + risky-pattern detection, redacted previews) with a **Security**
  panel that scans the active file. Verified: typecheck 0, prettier, 3-bundle build,
  23/23 unit smoke.
- **Net:** +6 fully-done phases and +5 new partials (133 → 139 done; weighted 160.0 →
  167.5 ≈ 58%). **Epoch H 53% → 68%** (specialized-agent library + Git AI complete),
  **Epoch I 15% → 17%**, **Epoch J 7% → 11%**. Epoch I/J items are honestly PARTIAL —
  the in-app cores landed, but full marketplace / icon-theme / SR / CI-on-reference-HW
  / SAST-SCA-fuzzing scope is out of the sandbox. The per-epoch weighted column sums
  exactly to 167.5. All temp smoke tests removed.

### Session 38 — 2026-07-15 (seven-phase run: Epoch H — specialized agents, rules, prompts, differentiators)

- **#1 Specialized agents (Epoch H §134–§138 / Phases 221, 223, 224, 225).** Extended
  the agent library: enriched **research** (221 — structured cited report + compared
  approaches) and **testing** (223 — framework-detect, coverage-aware, run + repair)
  personas, and added **bug-fix/debugging** (224 — reproduce → root-cause → smallest
  verified fix) and graph-grounded **refactoring** (225) agents. New read-only
  **graph_impact** agent tool (knowledge-graph dependents + transitive impact) grounds
  the refactoring agent, added to the read-only tool scope. Verified: typecheck 0,
  prettier, 3-bundle build, 28/28 unit smoke.
- **#2 Workspace rules + prompt library (Epoch H §145/§146 / Phases 233 + 234).** New
  pure `common/rules.ts` (parse `.axiom/rules/*.md` frontmatter, glob/priority scoping,
  guardrail-first non-overridable composition) + a Main service (workspace files +
  global store + AGENTS.md/.cursorrules import) + a Rules panel; rules are injected
  into the chat system prompt. New pure `common/promptLibrary.ts` (`{{variable}}`
  extraction, injection-safe single-pass interpolation, ranked search) + a store + a
  Prompt Library panel + a composer prompt-picker. Verified: typecheck 0, prettier,
  3-bundle build, 25/25 unit smoke.
- **#3 Reliability differentiators (Epoch H §138/§151/§217 / Phase 238).** New pure
  `common/refactorSafety.ts` (predict blast-radius risk pre-edit, verify completeness
  post-edit — wired into the graph_impact tool), `common/grounded.ts` (citation
  detection + a strict grounded-answer gate that flags uncited Ask answers — a
  user-toggleable setting), and `common/agentEval.ts` (success rate / avg steps /
  per-preset metrics — surfaced in the Agent Tasks panel). Verified: typecheck 0,
  prettier, 3-bundle build, 29/29 unit smoke.
- **Net:** +7 fully-done phases (126 → 133; weighted 154.0 → 160.0 ≈ 55%). **Epoch H
  37% → 53%** — a full specialized-agent library, encoded standards, a prompt library,
  and measured, reliability-focused agents. The per-epoch weighted column sums exactly
  to the 160.0 total. All temp smoke tests removed.

### Session 37 — 2026-07-14 (five-phase run: finishing Epoch G + first Epoch H automation)

- **#1 AI Chat Shell + Ask Mode (Epoch G §128.3 / Phases 175 + 176).** New pure
  `common/askMode.ts`: a Chat/Ask mode with a grounded, read-only **Ask** system
  prompt (answer only from the provided context, cite `path:line`, never propose
  edits) and a `forcesGrounding` flag. The chat header gains a Chat/Ask toggle; Ask
  forces auto-context on, swaps the system prompt, and the manifest reflects it.
  Verified: typecheck 0, prettier, 3-bundle build, 12/12 unit smoke.
- **#2 Inline Chat — Cmd-I (Epoch G §129.4 / Phase 188).** New pure
  `common/inlineChat.ts` (build a concise local Q&A prompt from the cursor/selection
  context; clean the answer) + a Main `ai:inlineChat` runner + a Monaco **Cmd/Ctrl+I**
  widget: an anchored bubble that answers a quick question about the selected code
  and can **escalate to the Cmd-K inline edit**. Verified: typecheck 0, prettier,
  3-bundle build, 14/14 unit smoke. Epoch G → ~97% (essentially complete).
- **#3 Workflow Automation & Hooks (Epoch H §148 / Phase 236).** New pure
  `common/workflows.ts`: validate/sanitize a workflow (default **disabled**, mutating
  steps **gated**), glob-scoped trigger matching (`manual` never auto-fires), pipeline
  resolution, a cost estimate, and a pipeline→agent-task composer. New Main store
  (userData/workflows.json, atomic, audited) + IPC + a **Workflows** panel: create,
  enable, and **run** a workflow as an approval-gated agent pipeline (it appears in
  Agent Tasks); an enabled on-save workflow only _notifies_ on a matching save — it
  never auto-runs. Verified: typecheck 0, prettier, 3-bundle build, 26/26 unit smoke.
- **#4 MCP Client Support (Epoch H §80.3 / Phase 237).** New pure `common/mcp.ts`:
  JSON-RPC 2.0 newline-delimited framing, initialize / tools.list / tools.call
  builders + parsers, tool namespacing (`mcp/<server>/<tool>`), an untrusted-output
  sanitizer, config validation (default disabled), and a permission-broker decision.
  New Main service spawns a configured server over stdio, runs the initialize
  handshake, discovers tools, and calls them permission-gated; connected tools are
  **bridged into the agent registry** as approval-gated tools whose output is treated
  as untrusted data (agents use MCP tools under approval). New IPC + an **MCP** panel
  (add / enable / connect / view tools). Verified: typecheck 0, prettier, 3-bundle
  build, 34/34 unit smoke.
- **Net:** +5 fully-done phases (121 → 126; weighted 150.0 → 154.0 ≈ 53%). **Epoch G
  90% → 97%** (essentially complete) and **Epoch H 32% → 37%** — the agentic epoch now
  has workflow automation and an MCP client. The per-epoch weighted column sums
  exactly to the 154.0 total. All temp smoke tests removed.

### Session 36 — 2026-07-13 (three-phase run: finishing Epoch G — history, manifest, inline edit)

- **#1 Chat History, Threads & Search (Epoch G §128.8 / Phase 179).** New pure
  `common/chatThreads.ts`: auto-title derivation, pinned-first ordering, rename,
  pin/unpin, a **full-text search** across titles + message bodies (AND semantics,
  title-weighted, ranked, with a match snippet), and **Markdown/JSON export**. The
  persisted conversation gained a `pinned` flag (defensively sanitizer-preserved). A
  new searchable **Chat History** overlay (`ChatHistory.tsx`) replaces the old
  dropdown — search, pin, inline rename, export (to a file via the save dialog or to
  the clipboard), delete, and resume. Verified: typecheck 0, prettier, 3-bundle
  build, 27/27 unit smoke.
- **#2 Context Manifest & Cost Footer (Epoch G §150 / Phase 181).** New pure
  `common/contextManifest.ts`: `buildManifest` turns the parts a turn actually sent
  (system prompt, attachments, auto-context sources, long-term memory, conversation
  history) into token-costed entries plus a context-file breakdown, with
  `summarizeManifest` and a `formatFooter` that now includes the **model**. Each
  answer gets a collapsible **"What was sent · N items · ~T tokens"** viewer, and the
  per-turn footer shows model · tokens · cost · latency. No new IPC — all data is in
  the renderer at send time. Verified: typecheck 0, prettier, 3-bundle build, 26/26
  unit smoke.
- **#3 Inline Edit — Cmd-K (Epoch G §129.3 / Phase 187).** New pure
  `common/inlineEdit.ts` (build a region-scoped rewrite prompt with surrounding
  context, clean the reply into raw replacement text, detect a meaningful change), a
  Main `ai:inlineEdit` runner (reads creds from settings, resolves the key from the
  vault, returns `{text,error?}`; full IPC — channel/types, handler, preload,
  `env.d.ts`), and a Monaco **Cmd/Ctrl+K** widget: an anchored input over the
  selection (or current line) → generate → the file is **snapshot-protected**, the
  edit applied as one undoable Monaco edit, the changed region decorated, then
  **Accept / Reject / Refine**. Region-scoped and fully reversible. Verified:
  typecheck 0, prettier, 3-bundle build, 22/22 unit smoke.
- **Net:** +3 fully-done phases (118 → 121; weighted 147.0 → 150.0 ≈ 52%). Epoch G
  80% → 90% — the flagship AI epoch is now nearly complete; only the chat-shell +
  Ask-mode polish (175–176) and inline chat (188) remain. The per-epoch weighted
  column sums exactly to the 150.0 total. All temp smoke tests removed.

### Session 35 — 2026-07-12 (five-phase run: inline completion flagship + dependency-aware edits)

- **#1 Inline Completion + Caching/Latency (Epoch G §129.1 / Phases 183 + 185).** New
  pure `common/completion.ts`: prompt builder (prefix + `<CURSOR>` + suffix), a
  `cleanCompletion` (strip fences, drop prefix echo, cap lines), a `shouldTrigger`
  heuristic (skip mid-identifier), and an LRU+TTL `CompletionCache`. New Main
  `ai:complete` runner (one-shot via the cached chat path; reads creds from settings;
  never throws) + a global Monaco inline-completions provider that debounces, cancels
  on keep-typing, and caches — rendering ghost text. Off by default (a cost-aware
  toggle in the AI panel). Verified: typecheck 0, prettier, 3-bundle build, 20/20 smoke.
- **#2 IntelliSense Coexistence + Next-Edit Prediction (Epoch G §129 / Phases 184 +
  186).** New pure `common/nextEdit.ts`: `arbitrateInline` (a priority setting lets the
  LSP widget lead after `.`/`@` so the two surfaces coexist), `diffLineToken` (detects a
  clean single-token rename on a line), and `predictNextEdit` (whole-word occurrences
  elsewhere). The editor watches for a rename on line change and offers **Axiom AI:
  Propagate Rename**, applying an undoable batch edit. Verified: typecheck 0, prettier,
  3-bundle build, 16/16 smoke.
- **#3 Dependency-Aware Edit Targeting (Epoch G §130 / Phase 194).** New pure
  `common/impactContext.ts` (`selectImpactContext`): orders the active file's importers
  (call sites) then transitive impact, de-duplicated + budgeted. Wired into the Composer
  — before generating a plan it pulls the knowledge graph's dependents + impact and
  includes those files' content, so cross-cutting changes keep call sites consistent.
  Verified: typecheck 0, prettier, 3-bundle build, 8/8 smoke.
- **Net:** +5 fully-done phases (113 → 118; weighted 142.0 → 147.0). **Crosses 50%
  weighted completion.** Epoch G 63% → 80% — the near-complete flagship AI epoch. All
  temp smoke tests removed.

### Session 34 — 2026-07-11 (three-feature run, PRD Epoch G Composer pipeline)

- **#1 Multi-File Editing / Composer (Epoch G §130 / Phase 193).** New pure
  `common/editPlan.ts`: a strict JSON edit-plan contract + `parseEditPlan` (tolerant
  extractor that sanitizes each edit — workspace-relative path, valid action, content
  required for create/modify, content clamp, dedup by path). New `main/services/
composer.ts` (`composeEdits`) runs the model through the normalized chat path and
  parses the plan (read-only). New `ai:compose` IPC and a **Composer** mode in the AI
  panel: describe a change → best-effort workspace context → a multi-file plan.
  Verified: typecheck 0, prettier, 3-bundle build, 19/19 unit smoke.
- **#2 Multi-File Diff Review Session (Epoch G §142.1 / Phase 195).** New pure
  `common/multiReview.ts` (reuses the single-file review): `buildMultiReview` diffs
  each proposed file into hunks, and `applyMultiReview` resolves per-hunk accept/reject
  selections into concrete edits (create/modify reconstructed from accepted hunks;
  delete gated by a checkbox; files with nothing accepted skipped). The Composer now
  reviews the plan per-file, per-hunk, then applies the selection as ONE all-or-nothing
  Safe-Edit batch (single snapshot). Verified: typecheck 0, prettier, 3-bundle build,
  16/16 unit smoke.
- **#3 Iterative Refinement (Epoch G §130 / Phase 196).** New pure `common/refine.ts`:
  `buildRefinementPrompt` combines the original request, a summary of the prior plan,
  and the user's feedback into a revise-this-plan instruction fed back into the
  Composer. A **Refine** input re-runs the compose→review pipeline without starting
  over. Verified: typecheck 0, prettier, 3-bundle build, 8/8 unit smoke.
- **Net:** +3 fully-done phases (110 → 113; weighted 139.0 → 142.0 ≈ 49%). Epoch G
  53% → 63%. The full generate → review → refine Composer loop now lands atomically
  through the trust substrate (snapshots + safe-edit). All temp smoke tests removed.

### Session 33 — 2026-07-10 (three-feature run, PRD Epoch G chat surface)

- **#1 Code Block Actions & Citations (Epoch G §128.6/§128.7 / Phase 178).** New pure
  `common/codeBlocks.ts`: `detectBlockPath` (reads a `// path` / `# path` marker on a
  block's first line, validated workspace-relative), `stripPathMarker`, and
  `parseCitations` (`file:line` refs, URL-guarded). ChatMarkdown code blocks gain a
  **Create/Update file** action that writes through the Safe Edit Engine (so the
  write is snapshotted), and prose `file:line` citations render as clickable links
  that open the file at the line. Verified: typecheck 0, prettier, 3-bundle build,
  21/21 unit smoke.
- **#2 Context Attachment @-mentions (Epoch G §128.2 / Phase 177).** New pure
  `common/mentions.ts`: `activeMention` (detects the `@token` at the caret, ignoring
  email-style `@`), `matchMentionFiles` (name-prefix > name > path > subsequence
  ranking), `matchSpecialMentions` (@selection/@repo/@git/@terminal/@problems),
  and `replaceActiveMention`. The chat composer shows a live mention menu; picking a
  file adds it as an attachment (reusing the existing context path). Verified:
  typecheck 0, prettier, 3-bundle build, 18/18 unit smoke.
- **#3 Model Switching & A/B (Epoch G §128.9 / Phase 182).** Per-thread model
  switching already shipped; this adds the **A/B compare** foundation. New pure
  `common/abCompare.ts` (`resolveAltModels`, `defaultAltModel`, `buildAbPair`), and
  an A/B toggle + alternate-model picker in the chat header: when on, a prompt runs
  against the current model AND an alternate concurrently, each stream routed by
  message id and labeled with its model. The non-A/B path is unchanged. Verified:
  typecheck 0, prettier, 3-bundle build, 9/9 unit smoke.
- **Net:** +3 fully-done phases (107 → 110; weighted 136.0 → 139.0 ≈ 48%). Epoch G
  43% → 53%. All temp smoke tests removed.

### Session 32 — 2026-07-09 (three-feature run, PRD Epoch G everyday-AI)

- **#1 Slash Commands (Epoch G §128.4 / Phase 180).** New pure `common/slash.ts`:
  a 7-command registry (`/explain /fix /tests /docs /review /plan /search`),
  `parseSlash`, `matchSlashCommands` (autocomplete only while typing the command
  word), and `expandSlash` — which rewrites the typed command into the actual
  prompt using the versioned prompt-template registry (or an inline instruction for
  plan/search). Non-slash and unknown-slash text is returned unchanged (zero
  regression on ordinary messages). Wired into the chat composer: a live
  autocomplete menu, and expansion on send. Verified: typecheck 0, prettier,
  3-bundle build, 16/16 unit smoke.
- **#2 Approval Workflow & Guardrails (Epoch G §144 / Phase 174).** New pure
  `common/approval.ts`: `classifyTool` (→ read/write/exec/network/git-write),
  `isHighRiskCommand` (rm -rf, force push, format, sudo, fork-bomb, …), and
  `decide(policy, action)` over three autonomy levels (manual / guided / autopilot)
  with per-class overrides and a high-risk safety net that upgrades even an
  allow-override to `ask`. Wired into the agent loop (each tool call runs through
  `decide()`), read from a new "Agent autonomy" setting in the AI panel. The guided
  default reproduces today's behavior (reads free; writes/exec/network/git ask), so
  there is no regression; every action stays snapshotted + audited. Verified:
  typecheck 0, prettier, 3-bundle build, 27/27 unit smoke.
- **#3 Code Explanation (Epoch G §141 / Phase 191).** New pure `common/explain.ts`:
  depth levels (brief / normal / deep) and `buildExplainRequest`, which combines the
  versioned `explain` template with depth-specific guidance and a line-citation
  instruction. Wired through the existing editor→chat action bus: the editor's
  right-click / command palette now offers Explain, Explain (brief), and Explain
  (in depth), streamed through the grounded chat. Verified: typecheck 0, prettier,
  3-bundle build, 15/15 unit smoke.
- **Net:** +3 fully-done phases (104 → 107; weighted 133.0 → 136.0 ≈ 47%). Epoch G
  33% → 43%. All temp smoke tests removed.

### Session 31 — 2026-07-08 (three-feature run, PRD Epoch G trust substrate)

- **#1 Snapshot & Checkpoint System (Epoch G §143 / Phase 171).** New pure
  `common/snapshot.ts` (group entries into checkpoints newest-first; `planPrune`
  by TTL then count, pruning whole checkpoints; `referencedHashes` for content GC)
  and `main/services/snapshots.ts` — a **content-addressed** local store
  (`snapshots/objects/<sha256>` + `index.json`) that captures affected files before
  an edit (dedup by hash), lists the timeline, restores a file or whole checkpoint
  (atomic write, or delete for files that did not exist), prunes + GCs orphaned
  objects, and audits every capture/restore. New `snapshot:*` IPC and a
  **Checkpoints** Explorer panel (capture active file, timeline, restore, clear).
  Verified: typecheck 0, prettier, 3-bundle build, 10/10 unit smoke.
- **#2 Safe Edit Engine (Epoch G §142.4 / Phase 172).** New pure
  `common/safeEdit.ts`: `validateEdit` (create needs an absent file, modify/delete
  need a present file, and a supplied `baseHash` that no longer matches is rejected
  as **stale/conflict**) and `planBatch` — **all-or-nothing** with duplicate-path
  rejection. New `main/services/safeEdit.ts` reads current file states + hashes,
  stages a plan, and on apply **snapshots first** (Phase 171), writes each file via
  temp+rename (or deletes), and **rolls the whole batch back** by restoring the
  snapshot if anything fails. New `safeEdit:stage`/`apply` IPC with a strict edit
  coercer. Verified: typecheck 0, prettier, 3-bundle build, 16/16 unit smoke.
- **#3 Visual Diff Review (Epoch G §142 / Phase 173).** Extracted the line-diff
  core into a shared `common/lineDiff.ts` (agentDiff now imports it — one engine
  for Main + renderer). New pure `common/reviewSession.ts`: `buildReviewHunks`
  groups a diff into hunks with stable ids, and `applySelectedHunks` reconstructs
  the exact resulting text for any accepted subset (accept none = old, accept all =
  new). Wired into the Checkpoints panel: each file in a checkpoint gets a
  hunk-by-hunk **Review** (checkpoint vs current) with per-hunk keep/revert
  checkboxes, applied through the Safe Edit Engine (so it is snapshotted + atomic) —
  tying Phases 171 + 172 + 173 together. Verified: typecheck 0, prettier, 3-bundle
  build, 15/15 unit smoke.
- **Net:** +3 fully-done phases (101 → 104; weighted 130.0 → 133.0 ≈ 46%). Epoch G
  23% → 33%. All temp smoke tests removed.

### Session 30 — 2026-07-07 (three-feature run, PRD F→H→E)

- **#1 Reasoning-model support (Epoch F §68 / Phase 149).** New pure
  `common/reasoning.ts`: `ReasoningConfig` (enabled + effort low/medium/high +
  visibility), `isReasoningModel(family, model)` capability detection (OpenAI
  o1/o3/o4/gpt-5, Anthropic 3.7/4-series/thinking, Gemini 2.5), and
  `reasoningBody` mapping to per-provider params — OpenAI `reasoning_effort`,
  Anthropic `thinking.budget_tokens` (1600/2400/3000, all under `max_tokens`),
  Gemini no-op. Additive params are **gated on both enabled AND a reasoning
  model**, and reasoning is off by default, so non-reasoning models and existing
  chats are unaffected (zero regression). Wired through `ChatParams` → the
  OpenAI/Anthropic request bodies in `ai.ts`, applied from settings to every
  failover attempt in `main/ipc.ts`, with a Reasoning toggle + effort selector in
  the AI panel. Verified: typecheck 0, prettier, 3-bundle build, 22/22 unit smoke.
- **#2 Code-Review agent (Epoch H §135 / Phase 222).** New pure
  `common/review.ts`: a strict JSON review contract, `buildReviewMessages` (line-
  numbers the code so findings cite real lines), and `parseReviewFindings` — a
  fenced/prose-tolerant extractor that sanitizes each finding (drops title-less
  entries, defaults invalid severities to `minor`, clamps fields, nulls empty
  line/suggestion) and sorts by severity. New `main/services/review.ts` runs the
  model (read-only, via the normalized chat path so it inherits routing/caching)
  and parses the reply into `ReviewFinding[]`. New IPC `ai:review` (resolves the
  API key from the vault), and a **Code Review** Explorer panel that reviews the
  active file and lists severity-tagged findings with category, rationale,
  suggested fix, and click-to-line. Verified: typecheck 0, prettier, 3-bundle
  build, 18/18 unit smoke.
- **#3 Preferences sync engine (Epoch E §49.3 / §55).** New pure `common/sync.ts`:
  `resolveConflict` (last-writer-wins by server timestamp; ties resolve to a
  deletion else the server copy; undefined-safe), `mergeRecords` (additive per-key
  union), `reconcileQueue` (drop server-acked ops, preserve order), and
  `coalesceQueue` (collapse to the latest op per key). New `main/services/sync.ts`
  keeps a local mirror + offline write queue (atomic JSON writes), `snapshotSettings`
  enqueues current settings, and `flushQueue` is a **documented no-op** until a
  cloud backend is configured (nothing is lost — the queue persists). New IPC
  `sync:status`/`snapshot`/`flush` and a "Back up preferences for sync" action in
  the AI panel's data section. Verified: typecheck 0, prettier, 3-bundle build,
  18/18 unit smoke.
- **Net:** +3 fully-done phases (98 → 101; weighted 127.0 → 130.0 ≈ 45%). Epoch F
  43% → 46%, H 29% → 32%, E 50% → 54%. All temp smoke tests removed.

### Session 29 — 2026-07-06 (three-feature run, PRD F→H→E)

- **#1 Code-skeleton context compression (Epoch F §69.5).** New pure
  `common/codeSkeleton.ts`: `skeletonize` keeps declarations, signatures, and
  braces while collapsing statement bodies into a single `/* … */` marker per run
  (brace-depth heuristic; non-brace code returned unchanged). Wired into the
  context builder so large dependency files are included at signature level
  instead of hard-truncated, fitting more real structure in the token budget.
  Verified: 12/12 (function/class/nested/non-brace/gating/shrinkage); typecheck 0,
  format, build.
- **#2 Custom agents (Epoch H, Phase 235 / §147).** `validateCustomAgent`
  sanitizes user input into an AgentPreset (name + persona required; tool scope
  restricted to known tools, defaulting read-only so a misconfigured agent can't
  gain write/exec). A local store persists them, `runAgent` resolves custom-first
  then built-in, and the Agent panel gained a merged Built-in/Custom selector with
  an inline creation form (name / persona / scope / plan) and delete. Verified:
  21/21 (validation, tool-scope safety, id/slug, clamps, custom-first resolution);
  typecheck 0, format, build.
- **#3 Data export / portability (Epoch E, Phase 124 / §32.3).** New
  `main/services/dataExport.ts` assembles a JSON bundle of the user's local data —
  settings, memory, custom agents, feature flags, telemetry consent, and an audit
  summary — with a defensive `redactDeep` pass that strips any secret-shaped field
  (API keys live only in the OS vault and are never read). An "Export my data"
  action saves it via a native dialog. Verified: 14/14 (redaction by key,
  nested/array recursion, bundle shape, no secret-value leak); typecheck 0, format,
  build.
- **Net:** three more fully-done phases → **98 / 290 done, 58 partial, 134 missing
  ≈ 127.0 / 290 (~44% weighted)**. Epoch F 41%→43%, Epoch H 26%→29%, Epoch E
  46%→50%. Twelve fully-verified phases shipped today across four rounds
  (s26–s29); the per-epoch weighted column sums exactly to the 127.0 total.

### Session 28 — 2026-07-06 (three-feature run, PRD F→H→E)

- **#1 Prompt management (Epoch F, Phases 163–164 / §71).** New pure
  `common/prompts.ts`: `composeSystem` layers a system prompt (base / guardrail /
  rules / persona / task) and **always injects non-overridable GUARDRAILS**
  (content-as-data, no secret exfiltration, approval-gated actions, minimal diffs)
  even if a caller omits them; `interpolate` does single-pass `{{var}}`
  substitution (no recursive template injection); plus a versioned template
  registry (explain/fix/review/tests/docs) with `renderTemplate`. The agent's loop
  and planning prompts now compose through it, so guardrails are guaranteed present
  (§71.6). Verified: 15/15 (guardrails-always-present, layer order, injection-safe
  interpolation, templates); typecheck 0, format, build.
- **#2 Agent task queue + background/parallel (Epoch H, Phases 218–220 / §149).**
  New pure `common/agentTasks.ts` (a status reducer folding step events into
  running / awaiting-approval / completed / failed / cancelled, with step counts).
  `agent.ts` now keeps a bounded task registry, routes every emit through it, and
  broadcasts `agent:taskUpdate`; concurrent runs are parallel and background runs
  survive closing the panel. A new **Agent Tasks** panel shows live status, preset,
  step count, and a stop control. Verified: 15/15 (all transitions, mid-run
  approval→running, summary, reducer purity); typecheck 0, format, build.
- **#3 Feature-flags client (Epoch E, Phase 129 / §57).** New pure
  `common/featureFlags.ts`: compiled fail-safe `DEFAULT_FLAGS`, FNV-1a **stable
  percentage bucketing** (a user is consistently in/out of a rollout), version/OS
  targeting, and kill switches; non-boolean flags pass through. A Main service
  derives the context (app version, OS, a stable local id) and exposes
  `getAllFlags`/`isFlagEnabled` (with a Realtime-override hook for later). Sub-agents
  are now gated behind `feature.agents.subagents` (a real consumer + kill switch),
  and an Experiments panel shows resolved flags. Per §57.4 the client works on
  compiled defaults with no fetch. Verified: 23/23 (bucketing stability, version/OS
  targeting, kill switch, rollout edges, defaults); typecheck 0, format, build.
- **Net:** three more fully-done phases → **95 / 290 done, 58 partial, 137 missing
  ≈ 124.0 / 290 (~43% weighted)**. Epoch F 38%→41%, Epoch H 24%→26%, Epoch E
  43%→46%. The per-epoch weighted column sums exactly to the 124.0 total.

### Session 27 — 2026-07-06 (three-feature run, PRD F→H→E)

- **#1 Long-term memory (Epoch F, Phases 160–162 / §70).** New pure
  `common/memory.ts` (tokenize, relevance scoring, `selectMemories` — pinned-first
  then relevance then recency, count- and char-budgeted) and a local
  `main/services/memory.ts` store (`userData/memory.json`, CRUD, size/count caps,
  `selectRelevant` over global plus the current workspace). Relevant memories are
  auto-injected into chat context at send time (always-on, best-effort), and a
  Memory panel (add / pin / forget, scope badges) surfaces them in the Explorer.
  Full IPC + preload + `env.d.ts`. Verified: 14/14 (scoring, pinned-first,
  budget caps, scope filter); typecheck 0, format, build.
- **#2 Sub-agents (Epoch H, Phase 213 / §72.9).** The agent can now delegate a
  focused sub-task via a `spawn_subagent` tool: it runs a nested, reduced-budget
  agent loop with a preset persona and **read-only tools only** (no writes/exec,
  no `spawn_subagent`), so a sub-agent needs no approval, can do nothing
  destructive, and cannot recurse (depth guard). Its findings fold back to the
  parent as the tool observation. Verified: 11/11 (parent→sub→parent flow,
  read-only scoping, depth guard, step-budget cap, missing-task error); typecheck
  0, format, build.
- **#3 Telemetry consent + gated local buffer (Epoch E, §52–53 / Part X §188).**
  Three default-off consent toggles (crash / analytics / performance) in Settings,
  a pure `common/telemetry.ts` sanitizer (bucketed numbers, booleans, short enums
  only — free text, code, long strings, objects, and bad keys are dropped), and a
  `main/services/telemetry.ts` service that records **only when the category is
  consented** into a capped local buffer (a disabled category writes nothing).
  Two gated record points wired (agent runs, AI actions). Verified: 30/30
  (consent gating, bucketing, sanitize drops free-text/secret-shaped/objects,
  buffer cap); typecheck 0, format, build.
- **Net:** three more fully-done phases → **92 / 290 done, 58 partial, 140 missing
  ≈ 121.0 / 290 (~42% weighted)**. Epoch F 36%→38%, Epoch H 21%→24%, Epoch E
  39%→43%. The per-epoch weighted column sums exactly to the 121.0 total.

### Session 26 — 2026-07-06 (three-feature run, PRD F→H→E)

- **#1 Policy-based model routing (Epoch F, Phase 165 / §73).** New pure
  `common/routing.ts`: six policies (manual/quality/cost/latency/privacy/
  capability) plus `deriveRouteMeta` (heuristic quality/cost/latency ranks and
  capabilities from the provider family and model-name markers; local =
  keyless + loopback) and a stable `orderCandidates`. The chat handler reorders
  the primary-plus-failover chain per the `ai.routingPolicy` setting (manual keeps
  the user's order); a Routing-policy selector was added to the AI settings.
  Verified: 16/16 (policy orderings, capability filtering, local detection,
  unusable/empty handling); typecheck 0, format, build.
- **#2 Agent library — specialized presets (Epoch H, Phase 232 / §134).** New
  `common/agentPresets.ts`: coder (all tools, plans), reviewer and researcher
  (read-only, no edits), test-writer (edit plus run, plans), documenter (edit, no
  run) — each a persona plus a scoped tool set. `agent.ts` applies the preset
  (filters the built-in tools by scope, injects the persona into the base and
  planning prompts, sets the plan flag); the Agent panel gained a preset selector.
  Verified: 19/19 (scoping, defaults, plan flags, persona composition, read-only
  safety); typecheck 0, format, build.
- **#3 Local hash-chained audit log (Epoch E, Phase 56 / Part X §187).** New
  `main/services/audit.ts`: an append-only JSON-lines log where each entry chains
  a SHA-256 of the previous hash, so any alteration or deletion is detectable by
  recomputing the chain (`verifyAudit` returns the first broken seq). Emit points
  record agent runs and approvals and secret/provider config changes — by summary
  only, never secrets or code. Wired IPC (`audit:read`/`audit:verify`), preload,
  the manual `env.d.ts` interface, and a collapsible Audit Log panel with a
  tamper-evidence badge. Verified: 13/13 driving a real JSONL file (append, verify,
  tamper-detect at the edited entry, deletion-detect at the orphaned link,
  truncation, no-secret-leak); typecheck 0, format, build.
- **Net:** three more fully-done phases → **89 / 290 done, 58 partial, 143 missing
  ≈ 118.0 / 290 (~41% weighted)**. Epoch F 33%→36%, Epoch H 18%→21%, Epoch E
  38%→39% (its weighted also corrected to 11.0, so the per-epoch column now sums
  exactly to the 118.0 total).

### Session 25 — 2026-07-06 (three-feature run)

- **#1 Agent diff-preview before write approval (Epoch H).** New `agentDiff.ts` —
  a pure LCS line-diff (common prefix/suffix fast-path, an `Int32Array` LCS with a
  cell-count fallback, hunks with three lines of context, a 400-line cap) that
  turns a pending `write_file` or `replace_in_file` into a real unified diff.
  `agent.ts` gained an async `diff()` tool hook; the approval step now carries an
  `AgentFileDiff` (added/removed counts, hunks, a new-file flag), and the Agent
  panel renders it inline with colored add/remove gutters — the user approves what
  they can see, not a one-line summary. Verified: 26/26 diff-logic test (new file,
  insertion, modify, deletion, no-op, trailing-newline, replace semantics,
  big-rewrite cap); typecheck 0, format, build.
- **#2 AI egress gateway, response cache, and rate limiter (Epoch F).** New
  `aiGateway.ts`: every outbound AI request now funnels through `guardedFetch`,
  the single policy chokepoint — it validates the destination (HTTPS, or plain
  HTTP only to loopback for local model servers), throttles per host with a token
  bucket, and logs the host only (never the full URL, since Gemini carries the key
  in the query string; INV-3). Identical chat requests are served from a bounded
  TTL/LRU **response cache** keyed by provider/model/endpoint/messages (credentials
  excluded). Wired into `ai.ts` (all four fetch sites; `chat()` replays on a cache
  hit and stores on a clean completion). Verified: 29/29 contract test driving a
  real loopback HTTP server (policy allow/deny, cache short-circuit, LRU and TTL
  eviction, key stability, limiter delay); typecheck 0, format, build.
- **#3 Agent planning step (Epoch H).** The agent now drafts a short, ordered plan
  before acting: a dedicated planning prompt, a robust `parseAgentPlan` (accepts
  `{"plan":[...]}`, a bare JSON array, or a numbered or bulleted list, capping at
  eight steps), a new `plan` step event rendered in the panel, and the plan seeded
  into the loop so the agent follows it. Robust — an unparseable plan is skipped
  and the loop still proceeds. Verified: 24/24 test (parser formats plus loop
  behavior: plan emitted and seeded, disabled path, unparseable-but-proceeds);
  typecheck 0, format, build.
- **Net:** five more fully-done phases → **86 / 290 done, 58 partial, 146 missing
  ≈ 115.0 / 290 (~40% weighted)**. Epoch F 25%→33%, Epoch H 13%→18%.

### Session 24 — 2026-07-06

- **Agent `run_command` tool (approval-gated) + Google OAuth setup doc.** Added a
  bounded, timed (`60s`, 8 KB output cap) shell runner and a `run_command` agent
  tool — the agent can now run tests/builds/commands, but only after the user
  Approves each one (same gate as the write tools). Verified: 3/3 (stdout + exit 0,
  non-zero exit code, timeout kill); typecheck 0, format, build. Also wrote
  `docs/SUPABASE_AUTH_SETUP.md` with the exact Google Cloud Console + Supabase
  dashboard steps (Client ID, callback + loopback redirect URIs); the Client
  Secret stays in the dashboard, never in the repo (security).

### Session 23 — 2026-07-06

- **Authentication: Google-OAuth-only, hardened + modularized (Epoch E).**
  Inspected the existing Supabase integration (live project + PKCE Google OAuth
  already wired to `bmdprpuehhalabhtndmf.supabase.co`) and **reused** it —
  confirmed the codebase has **no** email/password / OTP / magic-link / phone auth
  (nothing to remove). Refactored the auth service into the requested dedicated
  modules: `supabase.ts` (client), `googleOAuth.ts` (system-browser + loopback +
  PKCE handler), `sessionManager.ts` (lifecycle / broadcast / validation),
  `authStore.ts` (OS-encrypted session storage), `auth.ts` (thin facade), plus
  renderer `state/auth.tsx` (auth state). Hardened: **server-side session
  validation** on startup (`getUser`) that signs out only on a definitive
  401/403/400 and **keeps the cached session when offline**; event-name-only
  logging (never tokens, INV-3). Public API preserved (no IPC changes). Verified:
  typecheck 0, format, build; a logic test passed — real-HTTP loopback code
  capture + success page + error rejection, the validation decision, and user
  sanitization. **Session management → done.**

### Session 22 — 2026-07-05 (three-feature run)

- **#1 Agent write tools + approval gate (Epoch H).** `agent.ts` gained
  `requiresApproval`/`preview` on tools, a `requestApproval` hook in the loop, and
  two write tools — **write_file** and **replace_in_file** (path-guarded). The
  loop pauses on a write, emits an `approval` step, and only runs it if the user
  approves in the Agent panel (Approve/Reject); rejection feeds back an
  observation. Cancel unblocks a pending approval. Verified: 7/7 approval-gate
  test (approved runs, rejected blocks, read-only skips); typecheck 0, format, build.
- **#2 Onboarding wizard (Epoch E, Phase 132).** New `OnboardingWizard` — a
  skippable first-run modal (Welcome → Appearance theme/accent → AI provider →
  Get Started) that records `onboarding.done`. Self-contained (local settings),
  mounted in `MainApp`. Verified: 7/7 helper test (first-run predicate + step
  clamping); typecheck 0, format, build.
- **#3 Windows installer config (Epoch J).** Added **electron-builder** (24.13.3)
  - `electron-builder.yml` (NSIS **wizard** installer: choose location + shortcuts,
    code-signing via `CSC_LINK`), `package` / `package:dir` scripts, and branding
    (`build/icon.svg` + docs). Verified: electron-builder loads the config, resolves
    deps + Electron 33.2.0, and reaches the packaging step — blocked only by
    `7za.exe` missing from this sandbox. Producing/signing the `.exe` needs a normal
    build machine + a cert + `icon.ico`. **Partial** (config done; installer not yet
    produced here).

### Sessions 19–21 — 2026-07-05 (three-feature run)

- **#1 Debugger — advanced (Phases 99–100).** DAP client gained `evaluate` +
  conditional breakpoints / logpoints (`toDapBreakpoints`); breakpoints store now
  carries per-line conditions; the Debug panel added **Watch expressions**
  (evaluated on each stop), a **Breakpoints** list with condition editing, and an
  "Active file" quick-fill. Verified: 4/4 conditional-bp + evaluate wire test (on
  top of the earlier 8/8 round-trip); typecheck 0, format, build.
- **#2 Provider registry + failover (Phases 135/165/167).** New shared
  `common/providers.ts` (registry: family, default base URL/models, keyless).
  `ai.ts` dispatches by **family** and adds `runChain`/`chatWithFailover` — an
  ordered provider chain that fails over only _before_ a reply starts streaming
  (never mid-stream, never on user-abort). Main builds the chain from configured
  fallback providers (keys from the vault); a "Failover providers" field in the AI
  setup. Verified: 10/10 registry + failover-logic test; typecheck 0, format, build.
- **#3 Agent runtime (Epoch H).** New `agent.ts`: a provider-agnostic **ReAct
  loop** (`runAgentLoop`, injectable LLM + tools) with a pure JSON action parser
  (`parseAgentAction`) and **read-only, path-guarded workspace tools** (read_file,
  list_dir, search_text, project_profile). New Agent panel + a Chat/Agent toggle
  in the AI view stream tool steps + the final answer. Verified: 12/12 parser +
  loop test (tool execution, observation feedback, step cap, unknown-tool,
  direct-answer); typecheck 0, format, build. Read-only tools only; write/exec +
  planning + subagents remain.

### Sessions 15–18 — 2026-07-05 (four-feature run)

- **#4 Inline AI code actions** (Epoch G). New `editor/aiActionBus.ts` (buffered
  request + panel revealer + pure `buildActionPrompt`). Monaco right-click /
  command-palette actions **Explain / Refactor / Fix / Add Docs** on the selection
  (or whole file) reveal the AI panel and auto-send, reusing streaming + cost +
  context. `ChatPanel.send()` now takes an override text. Verified: 7/7
  prompt-builder test, typecheck 0, format, build.
- **#1 Budgets & spend dashboard** (Phases 152 + 197). New `aiSpend.ts` ledger
  (atomic writes, pure `summarize` → session/today/all-time + top models); every
  turn is recorded and pushed. New `SpendStatusItem` shows today's estimated spend
  in the status bar (red past an optional daily budget) and a dashboard modal
  (breakdown, top models, budget control, clear). Verified: 13/13 aggregation +
  sanitize test, typecheck 0, format, build.
- **#2 Graph-aware context** (extends Phase 153). `contextBuilder.ts` now also
  pulls the active file's **direct dependencies** (knowledge graph) as ranked
  candidates (active > retrieval > dependency). Verified: typecheck/format/build +
  a live `graph/dependencies` smoke returning the file's real deps.
- **#3 Debugger / DAP** (Phases 96–98). New `dap.ts` — a full **DAP client**
  (Content-Length framing, initialize → launch → setBreakpoints →
  configurationDone handshake, stopped/output/terminated events, threads /
  stackTrace / scopes / variables, continue / step / pause / stop). New
  `editor/breakpoints.ts` + editor **gutter breakpoints** (glyph + click toggle),
  and a **Debug panel** (adapter-agnostic config, run/step controls, call stack,
  variables, output) in the Run & Debug view. Verified: **8/8 DAP round-trip
  against a mock adapter**, typecheck 0, format, build. Bundled per-language
  adapters + launch presets + conditional breakpoints/watch (99–101) remain.

### Session 14 — 2026-07-05

- **Built: Automatic context builder** (Epoch F, Phase 153 / §126). New Main
  service `contextBuilder.ts` assembles grounding context for a chat message from
  the **active file** (primary) plus **on-device semantic retrieval** hits: reads
  the real line ranges from disk, merges overlapping ranges per file, ranks
  (active first, then by similarity), and packs into a **token budget** with
  labeled, fenced code blocks. Injected as a system message. New IPC
  `ai:buildContext` + `BuildContextInput`/`ContextResult`/`ContextSource` types +
  preload `ai.buildContext`. ChatPanel gained an **✨ Auto-context** toggle and a
  "🧠 Grounded on N files (~T tokens)" note; best-effort (never blocks sending).
  Selection is bounded so it can't blow a model's context window; all local (INV-4).
- Verified: typecheck 0, format clean, build green; a helper + integration test
  passed **10/10** — pure helpers (mergeRanges, packBlocks budget cut-off,
  estimateTokens, langFromPath, relFromRoot, clampChars) and a **live
  retrieve→read→assemble** pass on this repo (5 hits, formatted block, packed 3
  within a 2400-token budget). **Phase 153 → done.**

### Session 13 — 2026-07-05

- **Built: Cost & token accounting** (Epoch F, Phase 151 / §54). Real token usage
  is now captured from every provider's stream — OpenAI (`stream_options.include_usage`
  trailing chunk), Anthropic (`message_start` input + cumulative `message_delta`
  output), Gemini (`usageMetadata`) — and turned into an estimated USD cost via a
  new pricing table (`aiPricing.ts`, longest-substring model match). Main computes
  cost and pushes an `ai:chatUsage` event; the ChatPanel shows a per-answer footer:
  **↑input ↓output tokens · $cost · latency**. New `ChatUsage` IPC type + preload
  `ai.onUsage`. `ai.ts` `chat()` gained an `onUsage` callback threaded through all
  three streams; parsing/pricing kept as pure functions.
- Verified: typecheck 0, format clean, build green; a **fixture contract test**
  (recorded OpenAI/Anthropic/Gemini SSE payloads) passed **10/10** — usage
  extraction (incl. Anthropic's split start/delta accumulation) and longest-match
  pricing (gpt-4o≠gpt-4, flash-8b≠flash, unknown→null). **Phase 151 → done.**
- Note: cost is an on-screen _estimate_ (BYOK bills via the provider); persistent
  budgets/caps (152) and a spend dashboard (197) remain.

### Session 12 — 2026-07-05

- **Built: Automatic Project Understanding** (Epoch C, Phase 68). New Rust
  `project.rs` derives a project profile from manifests + an ignore-aware scan:
  package managers (lockfiles), languages (extension counts), frameworks + test
  framework (aggregated across all `package.json` files, monorepo-aware), scripts,
  entry points, and monorepo/workspaces. RPC `project/understand`; wired core.ts +
  IPC + preload `core.project.understand` + env.d.ts (`CoreProjectProfile`).
  Verified: cargo check 0 warnings, typecheck 0, format clean, build green; smoke
  test on this repo → name=axiom, npm+cargo, monorepo, frameworks React/Electron/
  electron-vite/Vite/Monaco/Supabase, 6 scripts, TypeScript top language, 133
  files. **Phase 68 → done.**
- **Note:** confirmed `ai.ts` already ships native OpenAI + Anthropic + Gemini
  streaming adapters (multi-provider BYOK chat works); remaining Epoch F gaps are
  engine infra (registry/routing/failover/context/memory/cost/caching).

### Session 11 — 2026-07-05

- **Built: Dependencies panel** — surfaces the knowledge graph in the Explorer.
  New `DependenciesView.tsx` shows, for the active file, imported-by / imports /
  transitive-impact count with click-to-open navigation; collapsed by default so
  the graph only builds on demand. Wired into the Explorer sidebar (below the
  Outline) + CSS. Pure renderer over the session-10 graph backend (already
  verified). Verified: typecheck 0, format clean, build green. **Phase 67 → done**
  — its acceptance ("path/neighborhood queries return correct results") is met by
  the query API and now surfaced in the UI; NL graph Q&A is future expansion per
  the PRD.

### Session 10 — 2026-07-05

- **Built: Knowledge graph + dependency/impact analysis** (Epoch C). New Rust
  `graph.rs`: extracts import specifiers, resolves relative imports to files
  (extensions + index), builds file→imports + imported_by + external-package
  maps cached per root; RPC `graph/build`, `graph/dependencies`,
  `graph/dependents`, `graph/impact` (transitive BFS), `graph/cycles` (DFS).
  Added `regex` dep. Wired `core.ts` client + IPC channels/types + preload
  `core.graph.*` + env.d.ts. Verified: cargo check 0 warnings, typecheck 0,
  format clean, build green; RPC smoke test on `apps/desktop/src` → 94 files /
  248 edges, dependencies(main/ipc.ts)=19, dependents(common/ipc.ts)=37,
  impact(common/ipc.ts)=54. **Phase 66 → done; 65 → partial** (symbol-level edges
  remain); **67 → partial** (query API done; NL Q&A + visualization remain).

### Session 9 — 2026-07-05

- **Built: go-to type-definition + implementation** (completes PRD §108
  navigation). Added `typeDefinition`/`implementation` LSP methods + registry
  routing + Monaco type-definition/implementation providers; IPC, preload,
  env.d.ts wired. Verified: typecheck 0, format clean, build green; real-server
  smoke test → type-definition resolves `pet` → `interface Animal` (line 0),
  implementation resolves `Animal.speak` → `Dog.speak` (line 1).
- **Finding (no fragile code shipped):** Monaco's standalone API has no
  `registerCallHierarchyProvider`, so call/type hierarchy (95) needs a custom
  panel; semantic tokens + code lens (94) need legend/config plumbing. Documented
  and deferred rather than shipping brittle features. Phase counts unchanged —
  this rounds out Phase 92 / §108 (already counted done) to its full spec.

### Session 8 — 2026-07-05

- **Built: multi-language LSP servers** (Epoch D Phase 90). Refactored `lsp.ts`
  from a single hardcoded TS server into a generic `LspServer` class + a
  `SERVER_CONFIGS` registry keyed by languageId, with a uri→server map so every
  request routes to the owning server. Installed `vscode-langservers-extracted`
  and bundled the **JSON, CSS/SCSS/LESS, and HTML** servers (spawned on demand);
  the renderer registers all LSP providers for those languages too. Verified:
  typecheck 0, format clean, build green; real JSON-server smoke test → init ok +
  "Expected comma" diagnostic on invalid JSON. **Phase 90 → done.** Remaining
  LSP: semantic tokens/code lens (94), call/type hierarchy (95), Python/YAML/
  Markdown servers + on-demand install.

### Session 7 — 2026-07-05

- **Built (high-throughput LSP batch):** signature help (P91), code actions /
  quick fixes (P93), document symbols, inlay hints (P94), and document + range
  formatting (P41) for TS/JS. Extended `lsp.ts` with the request methods +
  mappers and registered the matching Monaco providers (code-action edits +
  formatting applied through Monaco; document symbols power outline/breadcrumbs/
  quick-outline; inlay hints show inferred types). IPC channels/types, preload,
  env.d.ts wired for all. Verified: typecheck 0, format clean, build green;
  real-server smoke test → signature help `greet(name: string, times: number):
string`, document symbols `greet`+`x`, formatting 8 edits. **Phases 41, 91, 93
  → done; 94 → partial** (semantic tokens + code lens remain). Deferred:
  multi-language servers (P90) and call/type hierarchy (P95).

### Session 6 — 2026-07-05

- **Built: LSP rename** (Epoch D Phase 93 — rename portion). Added `rename` +
  `mapWorkspaceEdit` (handles LSP `changes` and `documentChanges`) to `lsp.ts`;
  Monaco `registerRenameProvider` applies edits to open models via Monaco
  (undoable + preview-safe) and writes files not open as models directly through
  the fs API (`applyTextEdits`), so cross-file renames are correct. IPC channel/
  types, preload, env.d.ts wired. Verified: typecheck 0, format clean, build
  green; real-server smoke test renamed `computeSum`→`addNumbers` across a
  definition file (1 edit) and an importing file (2 edits: import + call), with
  `applyTextEdits` producing the correct renamed text. Phase 93 → partial (rename
  done; code actions / quick fixes remain). Caveat: for the rare "Rename Preview
  → cancel" flow, closed-file writes are eager; open files stay preview-safe.

### Session 5 — 2026-07-05

- **Built: LSP navigation** (Epoch D Phase 92). Extended session-4 `lsp.ts` with
  `definition`, `references`, and `documentHighlight` (client methods + LSP
  capability advertisement + location/highlight mappers). Renderer registers
  Monaco definition / reference / document-highlight providers and a
  `registerEditorOpener` that routes cross-file go-to-definition/reference peeks
  into the workbench (`setLspNavigator` → `ws.openFileAt`). IPC channels/types,
  preload, and env.d.ts wired. Verified: typecheck 0, format clean, build green;
  real-server smoke test → definition resolves usage→def (line 0), references
  returns all 3 occurrences (lines 0/3/4). Phase 92 → done.

### Session 4 — 2026-07-05

- **Built: LSP client** (Epoch D Phases 89–91). Out-of-process
  `typescript-language-server` spawned via Electron's Node (`ELECTRON_RUN_AS_NODE`,
  works packaged), Content-Length framed JSON-RPC, initialize handshake,
  document sync (didOpen/didChange/didClose), and **hover + completion +
  diagnostics** wired into Monaco for TS/JS/TSX/JSX. New `main/services/lsp.ts`
  (432 lines) + `renderer/editor/lsp.ts`; IPC channels/types, preload, env.d.ts,
  disposal on quit. `monacoEnv` loads Monarch only, so these are the first real
  language providers — no duplication. Verified: typecheck 0, format clean, build
  green; real-server smoke test → hover `const greeting: string`, 49 completion
  members (toUpperCase/charAt), 2 diagnostics. Phase 89 → done; 90/91 → partial.

### Session 3 — 2026-07-05

- Full folder audit; established baseline: **~28% weighted** (54 done / 55 partial / 181 missing).
- Created this tracker (`docs/PROGRESS.md`).
- **Built this session:** **Outline view** (Phase 45 / §104.7; advances §108
  navigation). New `OutlineView.tsx` lists the active file's symbols (functions,
  classes, types, …) from the Rust Core (Tree-sitter), click-to-jump; wired into
  the Explorer sidebar with styling. Verified: typecheck 0, format clean, build
  green, and a `symbols` RPC smoke test returned accurate symbols for Rust + TSX.
  Phase 45 moved partial → done (Epoch B now 88%).

### Session 2 — 2026-07-05

- Installed git; built Rust core (release) + desktop app end-to-end.
- Shipped **on-device Semantic Search** end-to-end (Epoch C P59/P64 + Epoch G P190):
  wired `embed`/`retrieve` into Core RPC (0 warnings), IPC/preload/types, `≈`
  toggle in Search view; runtime-verified.

### Session 1 — 2026-07-05

- Configured workspace: `.prettierignore`, root Cargo workspace + toolchain pin,
  `.gitignore` (target/), formatting. Gates green (typecheck/format/cargo).
