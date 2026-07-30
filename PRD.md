# AXIOM — MASTER PRODUCT REQUIREMENTS DOCUMENT

### *Think. Build. Ship.*

**A Production-Grade, AI-Native Desktop Coding IDE**

---

## 0. DOCUMENT CONTROL

| Field | Value |
|---|---|
| **Product Name** | Axiom |
| **Tagline** | Think. Build. Ship. |
| **Document Type** | Master Product Requirements Document (Master PRD) |
| **Document Class** | Internal — Confidential — Enterprise Product Specification |
| **Version** | 1.0.0 (Baseline / GA-Target Specification) |
| **Status** | Authoritative — Approved for Engineering Planning |
| **Target Release** | Axiom 1.0 (Windows-first, cross-platform-ready architecture) |
| **Primary Platform** | Windows 10 (2004+) and Windows 11 (x64, ARM64) |
| **Secondary Platforms (Architecture-Ready)** | macOS (Apple Silicon + Intel), Linux (x64, ARM64) |
| **Backend** | Supabase (Auth, PostgreSQL + Row Level Security, Storage, Realtime, Edge Functions, Migration System) |
| **Monetization Model** | Bring-Your-Own-API-Key (BYOK); zero AI inference margin cost to the vendor at launch |
| **Author** | Cross-functional Product & Engineering Leadership Council |
| **Change Authority** | Product Council + Architecture Review Board (ARB) |

### 0.1 Ownership & RACI (Council Roles)

This PRD is authored and owned by a cross-functional council. Each subsystem has a Directly Responsible Individual (DRI).

| Domain | DRI Role | Accountable | Consulted | Informed |
|---|---|---|---|---|
| Product Strategy | Product Manager | VP Product | All | Company |
| System Architecture | Staff Software Architect | CTO | Principal Systems Eng | All Eng |
| Desktop Shell | Senior Desktop / Electron-Tauri Eng | Staff Architect | Perf, Security | Product |
| AI Engine | Senior AI Engineer | Staff Architect | Backend, Security | Product |
| Backend / Data | Senior Backend + DB Architect | Staff Architect | Security, DevOps | Product |
| Frontend / Editor | Senior Frontend Engineer | Staff Architect | UX, Perf | Product |
| UX / Design | Senior UX Designer | VP Product | Frontend, A11y | All |
| Security | Senior Security Engineer | CISO | All Eng | Legal, Compliance |
| Performance | Principal Performance Engineer | Staff Architect | All Eng | Product |
| DevOps / Release | Senior DevOps Engineer | Head of Eng | Security | All |
| Quality | Principal QA Engineer | Head of Eng | All Eng | Product |
| Enterprise Readiness | Enterprise Solution Architect | VP Product | Security, Legal | Sales |

### 0.2 Distribution & Audience

This document is written for: engineering leadership, subsystem DRIs, individual contributors implementing phases, QA, security review, and executive stakeholders. It is intended to be **self-contained**: any reader can enter at their layer of interest (strategy, architecture, subsystem, phase plan) and find sufficient depth to act.

### 0.3 Reading Guide

- **Part I** defines *why* the product exists and *what* success looks like.
- **Part II** defines the *technical foundation* upon which everything else is built.
- **Parts III–XI** are the *subsystem specifications* — the bulk of the engineering contract.
- **Part XII–XIII** define *quality bars* and *per-subsystem deep documentation*.
- **Part XIV** is the *executable roadmap*: 250–300 sequenced implementation phases.

### 0.4 Terminology & Glossary (Selected)

- **BYOK** — Bring Your Own Key. Users supply their own AI provider credentials; Axiom never resells inference.
- **Agent** — An autonomous or semi-autonomous AI process that plans and executes multi-step coding tasks.
- **Turn** — A single request/response cycle between the user (or agent loop) and a model.
- **Context Window** — The token budget available to a model for a given turn.
- **Workspace** — A user-opened root (or set of roots) representing a project.
- **Indexer** — The subsystem that parses, embeds, and stores repository knowledge for retrieval.
- **Checkpoint / Snapshot** — A restorable state of the workspace prior to an AI edit batch.
- **Provider Adapter** — A normalized driver translating Axiom's internal AI protocol to a specific vendor API.
- **Renderer / Main / Core** — Process-model tiers of the desktop shell (see Part II).
- **RAG** — Retrieval-Augmented Generation, the pattern of injecting retrieved repo context into prompts.
- **DRI** — Directly Responsible Individual.
- **ARB** — Architecture Review Board.
- **SLO / SLI** — Service Level Objective / Indicator.

### 0.5 Revision History

| Version | Date | Author | Summary |
|---|---|---|---|
| 0.1 | Draft | Product Council | Initial skeleton |
| 0.9 | Review | ARB | Architecture ratified |
| **1.0.0** | **Baseline** | **Council** | **Approved authoritative specification** |

---

# PART I — PRODUCT FOUNDATION

## 1. EXECUTIVE SUMMARY

### 1.1 What Axiom Is

Axiom is a **production-grade, AI-native desktop coding IDE** for professional software developers. It combines a first-class code editing experience — comparable to Visual Studio Code and JetBrains IDEs — with a deeply integrated, multi-provider AI engine that supports autonomous agents, multi-file editing, semantic repository understanding, and a full spectrum of AI-assisted engineering workflows.

The defining strategic decision of Axiom 1.0 is its **Bring-Your-Own-Key (BYOK)** model. Rather than positioning the vendor as a reseller of AI inference (the Cursor/Copilot model, which incurs enormous variable cost and forces subscription lock-in), Axiom gives developers **complete sovereignty over their AI providers**. Users connect their own OpenAI, Anthropic, Google, OpenRouter, Groq, DeepSeek, Qwen, Mistral, local Ollama, LM Studio, or any OpenAI-compatible endpoint. Axiom orchestrates these providers with enterprise-grade routing, failover, cost tracking, and security — but never sits in the billing path of a single token.

This yields three compounding advantages:

1. **Cost transparency & control** — developers pay providers directly at wholesale rates, with Axiom providing precise cost estimation and token accounting.
2. **Privacy & data sovereignty** — code and prompts flow directly from the user's machine to the user's chosen provider (or fully local models), with Axiom's cloud limited to identity, settings, and opt-in telemetry.
3. **Future-proofing** — as the model landscape shifts monthly, Axiom users adopt new frontier models the day they ship, without waiting for a vendor to negotiate contracts.

### 1.2 The Problem We Solve

Modern developers are caught between three imperfect options:

- **Traditional IDEs (VS Code, JetBrains)** offer superb editing but bolt AI on as an afterthought through extensions, resulting in fragmented, shallow AI integration.
- **AI-reseller IDEs (Cursor, Windsurf, Copilot)** offer excellent integrated AI but lock users into opaque subscriptions, rate limits, model choices dictated by vendor economics, and force user code through vendor-controlled proxies.
- **Terminal-based agents (Claude Code, Aider)** offer power but sacrifice the visual, ergonomic richness of a full IDE.

Axiom resolves this trilemma: **full IDE ergonomics + deep native AI + total provider sovereignty**.

### 1.3 Who It's For

Professional and prosumer developers, AI engineers, indie hackers, startups, and enterprises that (a) already hold AI provider accounts, (b) demand data control, and (c) want a single, cohesive, high-performance environment for AI-augmented software engineering. (Full personas in §6.)

### 1.4 Why Now

Three tailwinds converge: (1) the commoditization and rapid proliferation of capable LLM providers; (2) growing enterprise concern over code exfiltration through third-party AI proxies; (3) the maturation of desktop application frameworks (Tauri, Electron) and code-editing components (Monaco, CodeMirror 6, Tree-sitter, LSP) that make a world-class shell feasible for a focused team.

### 1.5 What "Version 1.0" Means Here

This is **not** an MVP. Axiom 1.0 is a **complete, commercial, production-ready product**: installable, auto-updating, crash-resilient, secure, accessible, localized-ready, observable, and competitive on day one with the incumbents on both editing and AI. Every subsystem in this document is scoped for production quality, not prototype quality. Where an item is deferred, it is explicitly labeled **Post-1.0** with a rationale.

### 1.6 One-Paragraph Summary (for executives)

*Axiom is a Windows-first, cross-platform-ready desktop AI IDE that pairs a VS Code-class editing experience with a sovereign, multi-provider AI engine. Developers bring their own API keys — from OpenAI to local Ollama — and get autonomous agents, multi-file editing, semantic codebase understanding, and enterprise security, with Axiom's cloud handling only identity, sync, and opt-in telemetry via Supabase. It is designed from day one to become one of the world's leading AI IDEs.*

---

## 2. PRODUCT VISION & NORTH STAR

### 2.1 Vision Statement

> **To be the environment where developers think, build, and ship software with AI as a first-class collaborator — without surrendering control of their tools, their data, or their costs.**

### 2.2 The "Think. Build. Ship." Loop

The tagline encodes the product's core loop and organizes its feature surface:

- **Think** — Understand, plan, explore. (AI chat, planning mode, thinking/reasoning mode, semantic search, knowledge graph, architecture generation, research agent, code explanation.)
- **Build** — Implement, edit, refactor. (Inline AI, multi-file editing, autonomous coding agents, refactoring engine, test generation, autocomplete, the full editor.)
- **Ship** — Verify, review, release. (Code review agent, test/QA agents, diff review, snapshots/rollback, Git integration, deployment agent, documentation generation.)

Every feature in Axiom must map to at least one phase of this loop, and the UX must make the transitions between them frictionless.

### 2.3 North Star Metric

**Weekly AI-Accepted Engineering Actions per Active Developer (WAEA).**

An "AI-accepted engineering action" is any AI-produced artifact (edit, multi-file change, generated test, refactor, doc, review comment) that the developer *accepts and keeps* after 24 hours. This metric captures the intersection of *usage* (they used the AI), *quality* (they accepted it), and *durability* (they didn't revert it). It resists vanity inflation because rejected or reverted output does not count.

Supporting counter-metrics (guardrails): revert rate, edit-after-accept rate, crash-free sessions, p95 latency, and cost-per-accepted-action (paid to providers, tracked for the user's benefit).

### 2.4 Three-Year Product Horizon (Directional, not committed scope)

- **Year 1 (this PRD):** World-class single-developer desktop IDE with sovereign AI, Windows GA + cross-platform architecture, full agentic capabilities.
- **Year 2 (Post-1.0 directional):** Team features, shared workspace rules, collaborative agents, org-level policy, self-hosted enterprise control plane, remote/SSH & container dev, plugin marketplace maturity.
- **Year 3 (directional):** Cloud agent execution, org knowledge graph, deep CI/CD-native agents, on-prem model gateway, compliance certifications (SOC 2 Type II, ISO 27001), full localization catalog.

### 2.5 Design Tenets (the soul of the product)

1. **Sovereignty by default.** The user owns keys, data, and destiny.
2. **The editor is sacred.** AI never degrades core editing speed or reliability.
3. **Transparency over magic.** Every AI action is inspectable, costed, and reversible.
4. **Local-first, cloud-optional.** The app is fully functional offline for editing and local models.
5. **Progressive disclosure.** Simple by default, infinitely deep on demand.
6. **Trust is earned per edit.** Approval workflows, diffs, and snapshots make autonomy safe.
7. **Performance is a feature.** Cold start, large repos, and huge files are first-class concerns.
8. **Everything is a phase.** The product is buildable incrementally without architectural rewrites.

---

## 3. STRATEGIC GOALS & NON-GOALS

### 3.1 Primary Goals (1.0)

- **G1.** Deliver a code editor at parity with VS Code on the top 90% of daily editing tasks (editing, navigation, search, Git, terminal, debugging, extensions-lite).
- **G2.** Deliver a multi-provider, BYOK AI engine supporting all providers listed in the brief, with streaming, reasoning, routing, failover, and cost/token accounting.
- **G3.** Deliver autonomous & semi-autonomous agents capable of safe, reviewable multi-file changes across large repositories.
- **G4.** Deliver semantic repository understanding (indexing, embeddings, RAG, knowledge graph, semantic search).
- **G5.** Deliver enterprise-grade security: encrypted secret storage, credential isolation, threat-modeled data flows, auditability.
- **G6.** Deliver a production desktop shell: installer, auto-update, crash recovery, Windows integration, accessibility, telemetry.
- **G7.** Deliver Supabase-backed identity, settings sync, and opt-in telemetry without placing user code in Axiom's cloud.
- **G8.** Achieve performance SLOs for cold start, edit latency, indexing, and memory on large repositories.

### 3.2 Secondary Goals (1.0 if capacity allows; else early Post-1.0)

- Extension compatibility layer for a meaningful subset of the VS Code extension API.
- Settings Sync across devices via Supabase.
- Prompt library + workspace rules ecosystem.
- Rich theming and customization.

### 3.3 Explicit Non-Goals (1.0)

- **N1.** Axiom will **not** resell AI inference or operate as a metered AI subscription in 1.0. (BYOK only.)
- **N2.** Axiom will **not** ship real-time multi-user collaborative editing (Live Share-style) in 1.0. (Post-1.0.)
- **N3.** Axiom will **not** ship a full cloud IDE / browser version in 1.0. (Desktop only.)
- **N4.** Axiom will **not** attempt 100% VS Code extension API compatibility in 1.0. (Curated subset.)
- **N5.** Axiom will **not** host or execute user code in the cloud in 1.0. (All execution local.)
- **N6.** Axiom will **not** build proprietary foundation models. (Orchestration, not model training.)

### 3.4 Guardrails / Constraints

- Windows-first, but **no architectural decision may hard-block macOS/Linux**. Platform-specific code is isolated behind interfaces.
- No user source code may transit Axiom-controlled servers without explicit, per-feature opt-in.
- The core editor must remain responsive (input latency budget, §11) even under heavy AI/indexing load.

---

## 4. CORE PRINCIPLES (EXPANDED)

Each principle from the brief is expanded into concrete engineering commitments, so downstream phases can be audited against them.

### 4.1 Enterprise Quality
Every subsystem ships with error handling, observability (structured logs, metrics), documentation, tests, and graceful degradation. No "happy-path-only" code merges. Definition of Done (Part XII) is enforced in CI.

### 4.2 Production Ready
Signed installers, auto-update with rollback, crash recovery, telemetry, feature flags for safe rollout, and a support/diagnostics bundle. The app survives power loss, disk-full, network loss, and provider outages without data loss.

### 4.3 Highly Modular
The system is a set of independently testable modules communicating through well-defined interfaces (Part II). Any subsystem (e.g., a provider adapter, the indexer) can be replaced without touching unrelated code. Dependency direction is enforced (no cyclic module deps).

### 4.4 Scalable
Handles repositories with 1M+ files and multi-GB working trees through lazy loading, incremental indexing, and virtualization. AI orchestration scales to many concurrent agents via a bounded worker pool and back-pressure.

### 4.5 Secure
Secrets in OS-native secure storage (Windows Credential Manager / DPAPI), least-privilege file access, sandboxed extensions, signed updates, PostgreSQL Row Level Security + Edge Function abuse controls on the backend, and a documented threat model (Part X).

### 4.6 Fast
Explicit latency and memory budgets (Part XI). Performance regressions are release-blocking. Perceived performance is engineered (optimistic UI, skeletons, streaming).

### 4.7 Reliable
Deterministic state management, idempotent operations, transactional file edits (write-to-temp + atomic rename), and automatic recovery of interrupted agent runs.

### 4.8 Professional
Polished, consistent visual language; no jank; keyboard-complete; respects OS conventions (native dialogs, notifications, menus).

### 4.9 Modern
Contemporary stack (Rust/Tauri or Electron+Node — decided in Part II), TypeScript frontend, modern editor core, GPU-accelerated rendering where beneficial.

### 4.10 Extensible
Public extension API, provider plugin SDK, custom agent definitions, theme API, and command contributions. Third parties can extend without forking.

### 4.11 Offline Friendly
Editing, navigation, search, Git, terminal, and local-model AI (Ollama/LM Studio) all work with zero internet. Cloud features degrade gracefully with clear offline indicators and queued sync.

### 4.12 Developer First
Keyboard-driven, scriptable, transparent, respects existing workflows (uses the user's real Git, real terminal, real toolchains). No lock-in file formats.

### 4.13 AI Native
AI is not a panel bolted on; it is woven through the editor, file tree, terminal, Git, and command palette. The architecture assumes AI as a core participant, not a plugin.

### 4.14 Future Proof
Provider-agnostic AI abstraction, versioned settings/schemas with migrations, capability-based feature detection, and a protocol layer that absorbs new model modalities (vision, tools, reasoning traces).

### 4.15 Maintainable
Strong typing, linting, formatting, architectural fitness functions, ADRs (Architecture Decision Records), and comprehensive per-subsystem docs (Part XIII).

### 4.16 Cross-Platform Ready
Platform abstraction layer isolates OS-specific behavior (paths, secrets, notifications, PTY, file watching) so a macOS/Linux port is a matter of implementing interfaces, not rewriting logic.

---

## 5. MARKET & COMPETITIVE ANALYSIS

### 5.1 Competitive Landscape Overview

| Product | Category | Core Strength | Core Weakness (Axiom's opening) |
|---|---|---|---|
| **VS Code** | Editor + extensions | Ubiquity, extensions, free | AI is extension-grafted, fragmented; no native agent orchestration |
| **Cursor** | AI-reseller IDE (VS Code fork) | Best-in-class integrated AI UX | Subscription + metered AI, opaque proxying of code, vendor-dictated models |
| **Windsurf** | AI-reseller IDE | Agentic "Cascade" flows | Same reseller/lock-in economics; data routing concerns |
| **GitHub Copilot** | AI plugin + chat | Deep GitHub integration, brand | Plugin ceiling, subscription, limited provider choice |
| **JetBrains (+ AI Assistant)** | Heavy IDEs | Deep language intelligence | Heavyweight, resource-hungry, AI still maturing, subscription |
| **Claude Code / Aider** | Terminal agents | Powerful autonomous editing | No rich IDE surface, steep ergonomics |
| **Zed** | Native high-perf editor | Speed, Rust, collaboration | Younger ecosystem, AI reseller elements |
| **Replit / Cloud IDEs** | Browser IDEs | Zero-setup, cloud exec | Not local-first, latency, data residency |

### 5.2 Axiom's Differentiated Position

Axiom occupies a currently **unclaimed quadrant**: *high AI depth* + *high user sovereignty*.

```
        High AI Depth
             ▲
   Cursor    │      ★ AXIOM
   Windsurf  │   (deep AI + full sovereignty,
   Copilot   │    local-first, BYOK)
             │
   ──────────┼──────────► High User Sovereignty
             │
   JetBrains │   VS Code (raw)
   (AI addon)│   Zed
             │
        Low AI Depth
```

### 5.3 Feature Parity & Superiority Matrix (Target for 1.0)

| Capability | VS Code | Cursor | Copilot | **Axiom 1.0 Target** |
|---|---|---|---|---|
| World-class editor | ✅ | ✅ | ➖(host) | ✅ Parity |
| Native multi-file agent | ➖ | ✅ | ⚠️ | ✅ Parity+ |
| BYOK, all providers | ❌ | ⚠️ limited | ❌ | ✅ **Superior** |
| Local models (Ollama/LMStudio) | ⚠️ ext | ⚠️ | ❌ | ✅ **Superior** |
| Cost/token accounting | ❌ | ⚠️ | ❌ | ✅ **Superior** |
| Provider failover/routing | ❌ | ❌ | ❌ | ✅ **Superior** |
| Semantic index + knowledge graph | ⚠️ ext | ✅ | ⚠️ | ✅ Parity+ |
| Snapshots/rollback of AI edits | ❌ | ⚠️ | ❌ | ✅ **Superior** |
| Data sovereignty / no code proxy | ➖ | ❌ | ❌ | ✅ **Superior** |
| Custom agents / workflow automation | ⚠️ | ⚠️ | ❌ | ✅ **Superior** |
| Extension ecosystem | ✅ huge | ✅ | ➖ | ⚠️ Curated subset (1.0) |
| Real-time collaboration | ⚠️ ext | ⚠️ | ❌ | ❌ Post-1.0 |

Legend: ✅ strong · ⚠️ partial · ➖ n/a · ❌ absent

### 5.4 Competitive Risks & Responses

- **Risk:** Incumbents add BYOK. **Response:** Depth of sovereignty features (routing, failover, local, cost, audit) plus editor+agent quality create a moat beyond a single toggle.
- **Risk:** VS Code fork ecosystem lock-in (extensions). **Response:** Compatibility layer for a curated high-value subset; first-party equivalents for the most-used capabilities.
- **Risk:** Model quality gap if user picks a weak provider. **Response:** Smart routing, model recommendations, and transparent capability labeling.

### 5.5 Build vs. Fork Decision (VS Code fork vs. clean build)

This is a foundational strategic decision analyzed fully in Part II (§12). Summary of the trade space: forking VS Code (as Cursor/Windsurf did) grants instant editor maturity and extension compatibility but inherits Electron weight, a massive unfamiliar codebase, upstream-merge tax, and licensing/branding constraints. A clean build on a modern shell + Monaco/CodeMirror grants control, performance, and a coherent AI-native architecture at the cost of rebuilding editor breadth. **Part II records the ratified decision and its rationale.**

---

## 6. TARGET USERS & PERSONAS

### 6.1 Primary Persona — "Maya, the Senior Full-Stack Engineer"
- **Context:** 8 years' experience, works at a 200-person startup, already pays for OpenAI + Anthropic personally.
- **Goals:** Ship features faster, offload boilerplate, refactor safely, keep her code private.
- **Pain:** Cursor's subscription on top of API costs feels redundant; she distrusts code proxying.
- **Axiom win:** BYOK with her existing keys, multi-file agents she can review, snapshots she can trust, no code leaving to a vendor.

### 6.2 Primary Persona — "Diego, the AI Engineer"
- **Context:** Builds LLM apps; runs local models via Ollama and cloud models via OpenRouter/Groq.
- **Goals:** Rapidly switch models, compare outputs, use reasoning models, control cost.
- **Pain:** Existing IDEs lock him to 1–2 providers.
- **Axiom win:** Every provider, model switching mid-conversation, cost/token tracking, local-first.

### 6.3 Primary Persona — "Priya, the Indie Hacker / Solo Founder"
- **Context:** Builds and ships products solo; extremely cost-sensitive.
- **Goals:** Maximize output, minimize spend, autonomous agents for grunt work.
- **Pain:** Fixed subscriptions waste money in slow weeks.
- **Axiom win:** Pay-per-use via own keys, autonomous agents, planning mode.

### 6.4 Secondary Persona — "Enterprise Team Lead / Platform Engineer"
- **Context:** Evaluates tools for a regulated org; security & data residency are gating.
- **Goals:** Prevent code exfiltration, enforce standards, auditability.
- **Pain:** AI-reseller IDEs are a compliance non-starter.
- **Axiom win:** No code in vendor cloud, local storage of secrets, audit logs, workspace rules, (Post-1.0) org policy.

### 6.5 Secondary Persona — "The Learner / Junior Dev"
- **Context:** Learning to code; needs explanation, safety, guidance.
- **Goals:** Understand code, get unstuck, learn patterns.
- **Axiom win:** Code explanation, thinking mode transparency, safe reversible edits, low-friction onboarding.

### 6.6 Anti-Persona (Explicitly Not Targeting in 1.0)
- Non-technical no-code users; browser-only users; users who want fully-managed AI with no keys (that's the reseller market Axiom deliberately declines in 1.0).

### 6.7 Persona-to-Feature Traceability
Every major feature area (Parts V–IX) references which personas it serves, ensuring no feature is orphaned and no persona is underserved.

---

## 7. KEY USE CASES & USER JOURNEYS

### 7.1 First-Run Journey (Cold Install → First Value)
1. Download signed installer → install → launch.
2. Setup wizard: theme, telemetry consent, sign-in (Google via Supabase Auth), keyboard-map choice.
3. Provider setup: add first API key (or connect local Ollama), validate connection.
4. Open a folder → automatic lightweight indexing begins in background.
5. First AI action: user opens chat, asks "explain this repo," gets a grounded answer citing files. **First value < 5 minutes from launch.**

### 7.2 Daily Editing Journey
Open workspace → tabs restored → edit with autocomplete + inline AI → run terminal/tests → commit via Git panel. AI available at every step but never mandatory.

### 7.3 Autonomous Feature Journey ("Build")
User describes a feature → Planning mode drafts a task plan → user approves → agent edits multiple files with a live diff → user reviews visual diff → accepts/rejects per-hunk → snapshot created → tests generated and run.

### 7.4 Debugging Journey ("Ship")
Failing test → user invokes bug-fix agent → agent reads stack trace, searches repo semantically, proposes fix as reviewable diff → user runs debugger to confirm → commits.

### 7.5 Refactor-at-Scale Journey
User selects "rename concept X across repo" → semantic search + knowledge graph identify sites → agent proposes multi-file refactor → visual diff → staged acceptance → snapshot for rollback.

### 7.6 Provider-Sovereignty Journey
Provider outage mid-task → failover routes to configured backup provider → user notified → work continues. Cost dashboard shows spend per provider/model/session.

### 7.7 Offline Journey
On a plane: editing, Git, terminal, search, and local Ollama models all work; cloud sync queues; clear "offline" affordances; sync resumes on reconnect.

### 7.8 Recovery Journey
Crash or power loss → on relaunch, unsaved buffers, open tabs, agent run state, and terminal layout are restored from the crash-recovery journal.

*(Additional journeys — onboarding a teammate's workspace rules, importing VS Code settings, migrating from Cursor — are detailed in Part IX.)*

---

## 8. PRODUCT PILLARS & FEATURE OVERVIEW

Axiom's surface is organized into **seven pillars**. Each maps to detailed subsystem specs later.

1. **Editor Core** (Part VII) — files, tabs, split, editing, navigation, search.
2. **Developer Tooling** (Part VII) — Git, terminal, debugger, tasks, extensions.
3. **AI Engine** (Part V) — providers, models, streaming, routing, cost, memory, context.
4. **AI Features** (Part VIII) — chat, inline, agents, review, tests, refactor, semantic search.
5. **Desktop Platform** (Part VI) — installer, updates, OS integration, notifications, recovery.
6. **Identity & Cloud** (Parts III, IV) — auth, sync, telemetry, feature flags, storage.
7. **Trust & Safety** (Parts X, VIII) — security, secrets, snapshots, approval workflows, audit.

### 8.1 Feature Overview Map (high level; expanded later)
- **Think:** chat, planning, thinking/reasoning view, semantic search, knowledge graph, explanation, research agent, architecture generation.
- **Build:** inline completion, inline edit, multi-file edit, autonomous agents, parallel/background agents, task queue, refactoring, test generation, autocomplete, code actions.
- **Ship:** review agent, testing agent, deployment agent, visual diff, snapshots/rollback, Git, docs generation, dependency analysis.
- **Foundation:** editor, explorer, terminal, debugger, settings, themes, shortcuts, extensions.
- **Sovereignty:** BYOK, provider management, routing/failover, cost/token dashboards, local models.
- **Trust:** secret storage, approval workflows, audit logs, workspace rules, permissions.

---

## 9. SUCCESS METRICS & KPIs

### 9.1 North Star
- **WAEA** (Weekly AI-Accepted Engineering Actions per active dev) — defined §2.3.

### 9.2 Acquisition & Activation
- Install → sign-in conversion; sign-in → first-provider-connected; first-provider → first-accepted-AI-action (activation). Target activation < 10 min median.

### 9.3 Engagement & Retention
- DAU/WAU/MAU; D1/D7/D30 retention; sessions/week; median session length; workspaces per user.

### 9.4 AI Quality
- Suggestion acceptance rate; accept-and-keep rate (24h); revert rate; agent task success rate; diff-hunk acceptance ratio; hallucination-report rate.

### 9.5 Performance (SLIs → SLOs in Part XI)
- Cold start p50/p95; time-to-interactive; keystroke-to-render latency; index time per 10k files; memory footprint at rest and under load; crash-free sessions/users.

### 9.6 Reliability
- Crash-free session rate (target ≥ 99.5%); update success rate; recovery success rate after forced kill; provider failover success rate.

### 9.7 Cost Transparency (user-benefit metric)
- Accuracy of cost estimation vs. actual provider billing (target within ±5%); cost-per-accepted-action visibility.

### 9.8 Trust & Safety
- % AI edits made through approval workflow; snapshot/rollback usage; zero incidents of code leaving to non-user-chosen endpoints (hard invariant, monitored).

### 9.9 Support & Satisfaction
- CSAT/NPS; support ticket rate per MAU; time-to-resolution; self-serve diagnostics bundle usage.

### 9.10 Counter-Metrics (anti-gaming guardrails)
- We explicitly track revert rate and edit-after-accept so raw "acceptance" cannot be gamed by shipping low-quality suggestions.

---

## 10. ASSUMPTIONS, CONSTRAINTS, DEPENDENCIES & PRODUCT RISKS

### 10.1 Assumptions
- Target users already possess (or can obtain) AI provider API keys.
- Users have Windows 10 2004+ / Windows 11, ≥ 8 GB RAM (16 GB recommended), x64/ARM64.
- Providers expose broadly OpenAI-compatible or documented APIs.
- Supabase is an acceptable identity/sync backend for 1.0 (managed at launch; open-source and self-hostable as an enterprise/Post-1.0 option).

### 10.2 Constraints
- Windows-first delivery; cross-platform architecture mandatory.
- No user code through Axiom servers (hard invariant).
- BYOK-only monetization at launch (no inference reselling).
- Team size and timeline demand a phaseable, incrementally shippable architecture.

### 10.3 External Dependencies
- Supabase (Auth, PostgreSQL + Row Level Security, Storage, Realtime, Edge Functions, Migration System). Optional pluggable observability sink (self-hostable Sentry/PostHog) behind the telemetry abstraction.
- AI provider APIs (OpenAI, Anthropic, Google, OpenRouter, Groq, DeepSeek, Qwen, Mistral, Ollama, LM Studio).
- Editor/tooling OSS (Monaco/CodeMirror, Tree-sitter, LSP servers, xterm.js/PTY, Git).
- Code-signing certificate (EV) and update infrastructure/CDN.

### 10.4 Top Product Risks & Mitigations
- **R1 Provider API churn** → versioned adapters, capability detection, contract tests against recorded fixtures.
- **R2 Editor breadth gap vs. VS Code** → prioritize top-90% tasks; compatibility layer; phased extension support.
- **R3 Performance on huge repos** → performance budgets as release gates; incremental indexing; virtualization.
- **R4 Security incident (key leak)** → OS-native secret storage, threat model, pen-test gate before GA.
- **R5 BYOK friction (users lack keys)** → guided provider setup, local-model path, clear docs.
- **R6 Scope explosion** → strict Non-Goals, phase gates, MoSCoW prioritization per phase.
- **R7 Backend cost/limits at scale** → no code in cloud (limits data volume), caching, cost monitoring, and the `IBackendService` abstraction; because Supabase is open-source/Postgres-based and self-hostable, scaling up or migrating off managed Supabase is a first-class, low-lock-in path.

### 10.5 Open Questions (tracked, resolved in later parts)
- Final shell framework (Tauri vs. Electron) — **resolved in Part II §12**.
- Editor component (Monaco vs. CodeMirror 6) — **resolved in Part II §12**.
- Embeddings strategy (local vs. provider) for the indexer — **resolved in Part V/VIII**.

---

*End of Part I — Product Foundation.*


---

# PART II — SYSTEM ARCHITECTURE

> **Purpose of this Part.** Part II is the technical foundation that every subsequent subsystem depends on. It ratifies the foundational technology decisions (shell framework, editor core, languages), defines the process model and IPC contract, establishes the module boundaries and folder structure, and specifies cross-cutting concerns (state, dependency injection, platform abstraction, extensions, networking, error handling, observability, versioning). Nothing in Parts III–XIV may violate the invariants declared here without an approved Architecture Decision Record (ADR) and Architecture Review Board (ARB) sign-off.

---

## 11. ARCHITECTURAL OVERVIEW & PHILOSOPHY

### 11.1 Architectural Goals

The architecture is optimized, in priority order, for:

1. **Editor reliability and latency.** The code-editing hot path must never be blocked by AI, indexing, sync, or telemetry. This is the single most important architectural constraint and it dictates the process/threading model.
2. **AI-native integration.** AI is a first-class subsystem with direct, governed access to the workspace, editor, terminal, and Git — not a plugin bolted onto the side.
3. **Sovereignty & data isolation.** The architecture makes it structurally difficult (not merely policy-forbidden) for user code to reach any endpoint the user did not choose. Egress is centralized, auditable, and gated.
4. **Modularity & replaceability.** Every subsystem sits behind an interface and can be replaced, mocked, or versioned independently.
5. **Cross-platform portability.** OS-specific behavior is quarantined behind a Platform Abstraction Layer (PAL); the other ~90% of code is platform-agnostic.
6. **Incremental buildability.** The system can be constructed in the 250–300 phases of Part XIV without a mid-project architectural rewrite.
7. **Performance headroom.** Heavy, CPU-bound, or memory-bound work (indexing, embeddings, search, parsing) runs off the UI thread, in worker threads or native (Rust) sidecar processes.

### 11.2 The Layered Architecture (C4-style)

Axiom is described at four levels of zoom (Context → Containers → Components → Code). This section covers the top three; the code level lives in per-subsystem specs.

**Level 1 — System Context.**

```
        ┌───────────────────────────────────────────────┐
        │                   DEVELOPER                     │
        └───────────────┬───────────────────────────────┘
                        │ (uses)
                        ▼
        ┌───────────────────────────────────────────────┐
        │                  AXIOM (Desktop)                │
        └───┬───────────┬───────────────┬───────────────┘
            │           │               │
   (identity/sync)  (AI inference)  (local toolchains)
            │           │               │
            ▼           ▼               ▼
     ┌──────────┐  ┌──────────────┐  ┌─────────────────┐
     │ Supabase │  │ AI Providers │  │ Git / Node /    │
     │ (BaaS)   │  │ (BYOK + local│  │ compilers /     │
     │          │  │  Ollama/LMS) │  │ debuggers / PTY │
     └──────────┘  └──────────────┘  └─────────────────┘
```

Key context invariant: **the "AI Providers" arrow and the "Supabase" arrow are distinct and never merged.** User code flows only along the AI Providers arrow to the user-chosen endpoint. Supabase receives identity, settings, opt-in telemetry, and metadata — never source code — unless a discrete, explicitly consented feature says otherwise.

**Level 2 — Containers (runtime processes).**

```
┌──────────────────────────────────────────────────────────────────┐
│ AXIOM PROCESS TOPOLOGY                                             │
│                                                                    │
│  ┌────────────────────┐        ┌──────────────────────────────┐   │
│  │  MAIN PROCESS       │  IPC   │  RENDERER PROCESS(es)         │   │
│  │  (Node.js)          │◀──────▶│  (Chromium + React + Monaco) │   │
│  │  - lifecycle        │        │  - UI, editor, panels        │   │
│  │  - window mgmt      │        │  - view-model state          │   │
│  │  - service host     │        └──────────────────────────────┘   │
│  │  - egress gateway   │                                           │
│  └───┬───────┬─────────┘                                           │
│      │       │  spawn / message                                    │
│      ▼       ▼                                                      │
│  ┌────────┐ ┌───────────────┐  ┌───────────────┐ ┌──────────────┐ │
│  │ AI     │ │ CORE ENGINE    │  │ EXTENSION HOST │ │ PTY / TERM   │ │
│  │ ORCHES-│ │ (Rust sidecar) │  │ (Node, sand-   │ │ (native PTY) │ │
│  │ TRATOR │ │ index/search/  │  │  boxed)        │ │              │ │
│  │ (Node) │ │ embeddings/fs  │  │                │ │              │ │
│  └────────┘ └───────────────┘  └───────────────┘ └──────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

**Level 3 — Components.** Each container decomposes into components (services). Illustrative components inside the Main process: `WindowManager`, `ServiceRegistry`, `SecretVault`, `EgressGateway`, `UpdateService`, `TelemetryService`, `WorkspaceService`, `FileSystemService`, `SettingsService`, `SyncService`. Inside the Renderer: `EditorHost`, `LayoutManager`, `CommandPalette`, `AIChatView`, `DiffReviewView`, `ExplorerView`, `SourceControlView`, `TerminalView`, `NotificationCenter`, `StatusBar`. Inside the Core Engine (Rust): `Indexer`, `SymbolGraph`, `SearchEngine`, `EmbeddingService`, `FileWatcher`, `RipgrepBridge`. Inside the AI Orchestrator: `ProviderRegistry`, `ModelRouter`, `ContextBuilder`, `PromptManager`, `AgentRuntime`, `ToolExecutor`, `CostMeter`, `MemoryStore`.

### 11.3 Architectural Invariants (Non-Negotiable)

- **INV-1 (UI never blocks).** No synchronous CPU-bound or I/O-bound operation exceeding 16 ms may run on the renderer UI thread. Offload to workers/sidecars.
- **INV-2 (Single egress gateway).** All outbound network calls to AI providers pass through one `EgressGateway` in the Main process. No renderer or extension may open direct sockets to arbitrary hosts.
- **INV-3 (Secrets never touch the renderer).** API keys and tokens live in the OS secure store, are held only in the Main process, and are injected into provider requests inside the Main process. The renderer references credentials by handle/alias, never by value.
- **INV-4 (No user code to Axiom cloud).** Supabase writes are constrained by table schemas, CHECK constraints, and Row Level Security to structurally exclude source content unless an explicit consented feature path is used.
- **INV-5 (Deterministic, restorable state).** All mutating user-facing operations are journaled so the app can recover after a crash (see §16.4, Part VI).
- **INV-6 (Interface-first).** Cross-subsystem calls go through declared interfaces registered in the Service Registry; no subsystem imports another's internal modules directly.
- **INV-7 (Platform quarantine).** OS-specific code exists only under the PAL (§18). Business logic is platform-agnostic.
- **INV-8 (Capability gating).** Every provider/model feature (vision, tools, reasoning, streaming) is discovered via capability descriptors; no hard-coded per-model conditionals scattered in call sites.

### 11.4 Architecture Decision Record (ADR) Process

Every foundational decision is captured as an ADR (`/docs/adr/NNNN-title.md`) with: context, options considered, decision, consequences, and status (Proposed/Accepted/Superseded). Part II ratifies the initial ADR set (ADR-0001 through ADR-0020). Superseding a ratified ADR requires ARB approval. This keeps the "why" discoverable for future engineers and prevents silent architectural drift.

---

## 12. FOUNDATIONAL TECHNOLOGY DECISIONS (RATIFIED)

This section resolves the open questions from Part I §10.5. Each decision lists the trade space and the ratified choice with rationale. These are binding for 1.0.

### 12.1 ADR-0001 — Build vs. Fork VS Code

**Options.** (A) Fork VS Code (as Cursor/Windsurf). (B) Clean build on a modern shell + editor component. (C) Build on an existing OSS editor core (Zed/CodeMirror) from scratch.

**Decision: (B) Clean build, reusing best-in-class OSS components (Monaco, Tree-sitter, LSP, xterm.js, ripgrep) without forking the VS Code product.**

**Rationale.** Forking VS Code grants instant breadth but imposes (1) a perpetual upstream-merge tax, (2) a massive unfamiliar codebase that fights an AI-native redesign, (3) branding/marketplace/licensing constraints (the official Marketplace and proprietary bits are not redistributable), and (4) architectural coupling that makes our sovereignty and agent invariants harder to enforce. A clean build lets us reuse the *components* that are genuinely hard to rebuild (the Monaco editor, Tree-sitter grammars, LSP servers, ripgrep) while owning a coherent, AI-native shell. We accept the cost of rebuilding editor breadth, mitigated by phasing (Part XIV) and by targeting the top-90% of daily tasks first (Goal G1).

**Consequences.** We must implement our own workbench, layout, command system, settings, and a curated extension API. We gain full control of performance, the AI integration surface, and branding.

### 12.2 ADR-0002 — Desktop Shell Framework: Electron vs. Tauri

**Options.** (A) Electron (Chromium + Node.js). (B) Tauri (system WebView + Rust). (C) Fully native (Win32/WinUI) — rejected immediately (no cross-platform path, no web editor reuse).

**Trade space.**

| Dimension | Electron | Tauri |
|---|---|---|
| Editor maturity fit (Monaco) | Excellent (Monaco is a web component; Chromium is uniform) | Good but WebView2/WebKit rendering differences add QA cost |
| Node ecosystem (LSP, debug adapters, git libs) | First-class in-process | Requires sidecars/Rust bindings |
| Rendering consistency across OS | Uniform (bundled Chromium) | Varies by OS WebView |
| Memory / bundle size | Heavier (~150–250 MB baseline) | Lighter (~10–40 MB baseline) |
| Extension-host compatibility path (VS Code-like) | Natural (Node) | Harder |
| Team velocity / hiring | Very high | Growing |
| Security model | Mature but requires hardening | Strong defaults |

**Decision: (A) Electron for 1.0**, with three hard mitigations: (1) a **Rust Core Engine sidecar** for all heavy compute (indexing, search, embeddings, file watching) so we recover most of Tauri's performance advantage where it matters; (2) aggressive Electron hardening (context isolation on, nodeIntegration off, sandboxed renderers, strict CSP, `contextBridge`-only IPC); (3) a **Shell Abstraction Layer** so the workbench code does not depend on Electron APIs directly, preserving a **Tauri migration path** as a Post-1.0 option (ADR-0002 explicitly keeps this open).

**Rationale.** Uniform Chromium rendering removes an entire class of cross-WebView editor bugs, the Node ecosystem gives us LSP/debug-adapter/Git tooling in-process, and hiring/velocity are highest here — decisive for a team building a world-class product on a schedule. We neutralize Electron's biggest weakness (compute weight and memory) by pushing heavy work into Rust sidecars and worker threads, and by strict memory budgets (Part XI).

### 12.3 ADR-0003 — Editor Component: Monaco vs. CodeMirror 6

**Decision: Monaco Editor for 1.0.**

**Rationale.** Monaco is the editor extracted from VS Code: mature, battle-tested on massive files, with the richest built-in language features (IntelliSense, multi-cursor, minimap, diff editor, bracket colorization) and a well-known API. Its built-in **diff editor** is directly reused for our AI Visual Diff Review (Part VIII). CodeMirror 6 is lighter and more composable and remains a **Post-1.0 candidate** for a lightweight/mobile surface, but for a desktop IDE targeting VS Code parity, Monaco minimizes editor-breadth risk. We wrap Monaco behind an `IEditorHost` interface so the choice is not permanently welded into the workbench.

### 12.4 ADR-0004 — Frontend UI Framework

**Decision: React 18+ with TypeScript (strict).** Concurrent rendering for responsiveness; a component library built in-house on a design-token system (Part IX) rather than a heavy third-party kit, to guarantee visual coherence and performance. Rendering-hot components (editor gutter overlays, large lists) use virtualization. Styling via CSS variables/tokens (theme-able) plus a utility layer; no runtime CSS-in-JS on hot paths.

### 12.5 ADR-0005 — Language Strategy

- **TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)** for Main process, Renderer, AI Orchestrator, and Extension Host.
- **Rust** for the Core Engine sidecar (indexer, symbol graph, search bridge, embeddings host, file watcher) where predictable performance and memory control matter, exposed via a versioned JSON-RPC/length-prefixed protocol (not brittle FFI) so the sidecar can crash and restart independently.
- **WASM** considered for shipping select Rust logic into the renderer (e.g., tokenization, fuzzy matching) — used where it removes an IPC round-trip.

### 12.6 ADR-0006 — Parsing & Language Intelligence

- **Tree-sitter** for fast, incremental, error-tolerant syntax parsing powering highlighting, structural navigation, folding, symbol extraction, and precise context slicing for AI.
- **Language Server Protocol (LSP)** clients for deep language intelligence (hover, go-to-def, diagnostics, rename, code actions) using existing community/official language servers, hosted out-of-process.
- **Debug Adapter Protocol (DAP)** for debugging (Part VII).

### 12.7 ADR-0007 — Terminal

**xterm.js** in the renderer bound to a **native PTY** (`node-pty`/ConPTY on Windows) in the Main process, streamed over a dedicated high-throughput IPC channel with flow control.

### 12.8 ADR-0008 — Local Datastore

**SQLite** (via a well-maintained native binding) as the embedded local database for workspace metadata, settings cache, telemetry queue, audit log, prompt/agent history, and the symbol/index catalog. Rationale: transactional, single-file, zero-admin, fast, ubiquitous, and works fully offline. A thin repository layer abstracts SQL from callers.

### 12.9 ADR-0009 — Vector Store for Embeddings

**Local, embedded vector index** for semantic search / RAG. 1.0 uses an in-process approximate-nearest-neighbor index (HNSW) persisted alongside SQLite, managed by the Rust Core Engine. Rationale: keeps code embeddings **on-device** (sovereignty), avoids a cloud vector DB dependency, and scales to large repos with memory-mapped storage. Embedding *generation* may use a local model or a user-chosen provider (user's choice; see Part V/VIII); embedding *storage and search* are always local.

### 12.10 ADR-0010 — Networking Library & Egress

A single hardened HTTP/streaming client in the Main process (keep-alive pooling, HTTP/2 where available, SSE parsing, cancellation, proxy support) is the only component permitted to make provider calls (INV-2). Rationale: centralization enables the sovereignty invariant, uniform retry/backoff, cost metering, and audit.

### 12.11 Ratified Stack Summary

| Layer | Choice | ADR |
|---|---|---|
| Product base | Clean build (no VS Code fork) | 0001 |
| Desktop shell | Electron (+ Rust sidecars, Tauri path kept open) | 0002 |
| Editor | Monaco (behind `IEditorHost`) | 0003 |
| UI framework | React 18 + TypeScript strict | 0004 |
| Systems language | Rust (Core Engine) + TS | 0005 |
| Parsing | Tree-sitter | 0006 |
| Language intelligence | LSP clients | 0006 |
| Debugging | DAP | 0006 |
| Terminal | xterm.js + native PTY (ConPTY) | 0007 |
| Local DB | SQLite | 0008 |
| Vector index | Local HNSW (on-device) | 0009 |
| Networking | Central hardened client (Main only) | 0010 |
| Backend | Supabase (Auth / Postgres + RLS / Storage / Realtime / Edge Functions / Migrations) | 0011 |

### 12.12 ADR-0011 — Backend Platform: Supabase

**Options.** (A) Firebase (managed, proprietary BaaS). (B) Supabase (managed Postgres BaaS; open-source, self-hostable). (C) Custom backend on raw cloud primitives.

**Decision: (B) Supabase for 1.0**, accessed exclusively behind the `IBackendService`/`IAuthService`/`ISyncService` interfaces (§17).

**Rationale.** Supabase supplies exactly the "thin cloud plane" primitives Axiom needs — managed **PostgreSQL** (relational integrity, SQL, migrations), **Auth** (OAuth + PKCE, JWT sessions, refresh rotation), **Storage**, **Realtime**, **Edge Functions**, and **Row Level Security** — while being **open-source and self-hostable**. This directly advances sovereignty and enterprise readiness: an organization can run its own Supabase (or point Axiom at a self-hosted/region-pinned instance) with no code change, and there is no proprietary lock-in (it is standard Postgres). Relational modeling with RLS yields stronger, testable, server-authoritative access control than a document store, and the SQL migration system fits the versioned-schema requirement (§24).

**Consequences.** The data layer is relational (schemas, foreign keys, RLS policies, migrations, views). Supabase has no first-party Remote Config, Crashlytics, or Analytics equivalents, so: **feature flags/remote config** become a Postgres `config`/`feature_flags` table served over Realtime (Part IV/§57-equivalent); **crash reporting and product/perf telemetry** flow through a pluggable observability sink (opt-in) — default an Edge-Function→Postgres ingestion pipeline, with self-hostable **Sentry/PostHog** as optional drop-in sinks behind the telemetry abstraction. **App Check** has no desktop-grade equivalent (it never did on desktop); abuse control uses RLS + Edge-Function rate limiting + anomaly detection (Part X). All backend access stays behind interfaces so the platform can be swapped or self-hosted.

---

## 13. PROCESS MODEL & RUNTIME TOPOLOGY

### 13.1 Process Tiers

- **Main process (Node.js).** The trusted core. Owns app lifecycle, windows, the Service Registry, the Secret Vault, the Egress Gateway, update, telemetry, workspace/file services, and spawns/monitors all child processes. It is the only tier with secrets and network egress.
- **Renderer process(es) (Chromium).** Untrusted-by-default UI. One renderer per window; sandboxed, context-isolated, no Node integration. Communicates only via `contextBridge`-exposed, allow-listed IPC channels. Hosts React + Monaco + all views.
- **AI Orchestrator (Node worker/child).** Runs agent loops, prompt assembly, model routing, tool execution scheduling. Kept out of the renderer so long agent runs never affect UI, and out of Main so a runaway agent cannot destabilize lifecycle. It requests egress through Main's gateway (never directly).
- **Core Engine (Rust sidecar, separate process).** CPU/memory-heavy: repository indexing, incremental parsing coordination, symbol graph, ripgrep-backed search, embeddings, file watching. Crash-isolated and auto-restarted.
- **Extension Host (Node, sandboxed child).** Runs third-party/curated extensions with a restricted API and resource limits, isolated from Main so a bad extension cannot crash the app or read secrets.
- **PTY host.** Native pseudo-terminal processes for the integrated terminal.
- **Utility/worker threads.** Short-lived pools inside Main/Renderer for diffing, tokenization, JSON parsing, syntax tasks.

### 13.2 Threading & Concurrency Model

- The **renderer UI thread** does layout and input only; everything heavier goes to web workers or sidecars (INV-1).
- The **Core Engine** uses a Rust async runtime (Tokio) with a bounded work-stealing pool; indexing is chunked and cancellable.
- The **AI Orchestrator** models each agent run as a cancellable async task with a step budget and wall-clock timeout; concurrent agents share a bounded pool with fair scheduling and back-pressure.
- **Cancellation is first-class**: every long operation accepts a cancellation token propagated across IPC so the user's "Stop" is instant and honored end-to-end.

### 13.3 Sidecar Lifecycle & Supervision

Each sidecar (Core Engine, AI Orchestrator, Extension Host, PTY) is supervised by a `ProcessSupervisor` in Main implementing: health pings, exponential-backoff restart, crash-loop detection (circuit breaker after N crashes in T seconds → degrade gracefully and notify), resource ceilings, and structured crash capture routed to the opt-in crash-reporting pipeline (Part VI) and the local audit log.

### 13.4 Crash Isolation & Blast Radius

- Renderer crash → that window recovers from the recovery journal; other windows unaffected.
- Core Engine crash → search/index temporarily degrade to a slower fallback (ripgrep-only, no embeddings); editing continues.
- AI Orchestrator crash → in-flight agent run is marked `interrupted`, its snapshot preserved; user can resume.
- Extension Host crash → extensions reload; core IDE unaffected.
- Main crash → full recovery on relaunch from the journal (worst case; minimized because Main is kept lean).

---

## 14. INTER-PROCESS COMMUNICATION (IPC)

### 14.1 Channel Model & Transport

IPC uses a typed, versioned message bus. Renderer↔Main uses Electron's `contextBridge` + `ipcRenderer/ipcMain` with an allow-list of channel names. Main↔sidecars use length-prefixed JSON-RPC 2.0 over stdio (or a local socket for high-throughput streams like PTY and token streaming). A single generated TypeScript/Rust schema (see §14.2) guarantees both ends agree.

### 14.2 Message Schema, Codegen & Versioning

All IPC messages are defined once in a schema (TypeScript types as the source of truth, with Rust types generated for the Core Engine). Each message carries `{ v: protocolVersion, id, method, params | result | error, ts }`. **Protocol version negotiation** happens at sidecar handshake; mismatches trigger a controlled upgrade path rather than undefined behavior. Backward-compatible additions bump minor; breaking changes bump major and require both binaries from the same release (enforced by the updater shipping them together).

### 14.3 IPC Security

- Renderer→Main channels are **allow-listed by name**; unknown channels are dropped and logged.
- Every inbound message is **schema-validated** before handling; malformed input is rejected (defense against a compromised renderer/extension).
- **No secret ever crosses to the renderer** (INV-3). Requests that need a key are executed in Main; the renderer sends intent + a credential *alias*.
- Extension Host messages pass through a **capability broker** that enforces per-extension permissions (§19.3).

### 14.4 Streaming Over IPC

AI token streams, terminal output, indexing progress, and log tails use a streaming channel abstraction: `stream.start(id) → stream.chunk(id, data)* → stream.end(id) | stream.error(id)`. Chunks are batched/coalesced to a display-refresh cadence (≤ 60 fps) to avoid flooding the renderer. Every stream is individually cancellable by `id`.

### 14.5 Back-Pressure & Flow Control

Producers respect consumer readiness: PTY and token streams use windowed flow control (pause/resume) so a slow renderer cannot cause unbounded memory growth in Main. Indexing progress is sampled, not per-file-spammed. Queues have hard caps with drop-oldest or coalesce policies chosen per channel.

---

## 15. MODULE & PACKAGE ARCHITECTURE

### 15.1 Repository Strategy

A **monorepo** managed by a workspace-aware package manager (pnpm workspaces) + a task/build orchestrator (Turborepo/Nx-style caching) for TypeScript, and Cargo workspaces for Rust crates. Rationale: atomic cross-cutting changes, shared tooling/config, enforced dependency boundaries, and fast incremental CI via caching.

### 15.2 Top-Level Folder Structure

```
axiom/
├─ apps/
│  └─ desktop/                # Electron app entry (main + preload + bootstrap)
│     ├─ src/main/            # Main process: lifecycle, windows, supervisor
│     ├─ src/preload/         # contextBridge exposure (allow-listed IPC)
│     └─ resources/           # icons, installer assets, native binaries
├─ packages/                  # TypeScript packages (libraries/services)
│  ├─ core-ipc/               # IPC schema (source of truth), codegen
│  ├─ platform/               # PAL interfaces + Windows/mac/linux impls
│  ├─ workbench/              # Renderer shell: layout, commands, views
│  ├─ editor-host/            # Monaco wrapper behind IEditorHost
│  ├─ ui-kit/                 # design tokens + component library
│  ├─ state/                  # state stores, selectors, event bus
│  ├─ services/               # service interfaces + Main-side implementations
│  │  ├─ workspace/           # roots, projects, file tree model
│  │  ├─ filesystem/          # transactional FS, watchers (PAL-backed)
│  │  ├─ settings/            # settings schema, migrations, sync
│  │  ├─ secrets/             # SecretVault (OS secure store)
│  │  ├─ egress/              # EgressGateway (only network exit)
│  │  ├─ telemetry/           # opt-in metrics + crash pipeline
│  │  ├─ update/              # auto-update + rollback
│  │  ├─ auth/                # Supabase Auth integration (Main)
│  │  ├─ sync/                # settings/prefs sync (Supabase Postgres)
│  │  └─ scm-git/             # Git integration
│  ├─ ai/                     # AI subsystem (see Part V)
│  │  ├─ orchestrator/        # agent runtime, router, context builder
│  │  ├─ providers/           # provider adapters (openai, anthropic, ...)
│  │  ├─ prompts/             # prompt templates + prompt manager
│  │  ├─ memory/              # agent + workspace memory
│  │  └─ cost/                # token counting + cost meter
│  ├─ features/               # feature modules (chat, inline, diff-review,
│  │  │                       #  planning, review, tests, refactor, ...)
│  ├─ extensions-api/         # public extension API + host runtime
│  └─ shared/                 # types, utils, result/error, logging
├─ crates/                    # Rust workspace (Core Engine)
│  ├─ axiom-core/             # process entry, JSON-RPC server, supervisor glue
│  ├─ indexer/                # file walking, chunking, incremental index
│  ├─ symbols/                # symbol graph (Tree-sitter powered)
│  ├─ search/                 # ripgrep bridge + ranking
│  ├─ embeddings/             # embedding host + HNSW vector index
│  └─ watcher/                # cross-platform file watching
├─ supabase/                  # Supabase project: migrations, RLS policies, Edge Functions, seed
├─ docs/
│  ├─ adr/                    # Architecture Decision Records
│  └─ subsystems/             # per-subsystem deep docs (Part XIII)
├─ tests/                     # e2e, integration, perf harnesses
└─ tooling/                   # build scripts, codegen, CI config
```

### 15.3 Dependency Rules (Enforced by Fitness Functions)

- **Directional layering:** `features → services (interfaces) → shared`; `workbench → ui-kit/state → shared`. Lower layers never import higher layers.
- **Interfaces over implementations:** `features` and `workbench` depend on *service interfaces*, resolved at runtime via the Service Registry (§17). Concrete Main-side implementations are wired only at composition roots.
- **No cross-feature imports:** feature modules communicate via commands/events, not by importing each other.
- **Renderer purity:** renderer packages cannot import Node/Electron/Main-only packages (secrets, egress) — enforced by lint boundaries and build separation.
- **Cycle prohibition:** CI runs a dependency-graph check; any import cycle fails the build.

### 15.4 Package Catalog (selected responsibilities)

- `core-ipc` — the contract between processes; changing it is a reviewed, versioned event.
- `platform` — the PAL (§18); the only place with `process.platform` branches.
- `egress` — the sovereignty choke point (INV-2); heavily tested and audited.
- `secrets` — the only reader/writer of the OS secure store (INV-3).
- `shared` — `Result<T,E>` types, structured errors, logger, ids, time, cancellation tokens; zero heavy deps.

---

## 16. STATE MANAGEMENT

### 16.1 State Domains

State is partitioned by ownership and lifetime, never one global blob:

1. **Ephemeral UI state** (hover, focus, transient toggles) — component-local, not persisted.
2. **View-model state** (open tabs, layout, panel sizes, selection) — renderer store, persisted to workspace journal.
3. **Workspace/domain state** (file tree, Git status, diagnostics, index status) — sourced from Main/Core, cached in renderer, reconciled by events.
4. **Application/settings state** (preferences, keybindings, themes, provider config) — owned by Main `SettingsService`, versioned + synced.
5. **AI/agent state** (conversations, agent runs, memory) — owned by AI Orchestrator, journaled (event-sourced, §16.5).
6. **Secret state** — owned exclusively by `SecretVault` in Main; never in any store.

### 16.2 Renderer State Architecture

A predictable store (Zustand-style slices with Redux-Toolkit-grade discipline for complex flows) holds view-model and cached domain state. Rules: single source of truth per datum; derived data via memoized selectors; all cross-process data enters through typed IPC event reducers; optimistic updates for latency-sensitive actions (with reconciliation/rollback on failure). The **command system** (Part VII) is the sanctioned way to mutate state, enabling undo, keybinding, palette exposure, and telemetry uniformly.

### 16.3 Main / Core State

Main holds authoritative service state (workspace roots, watchers, settings). The Rust Core holds the index/symbol/vector state (memory-mapped, persisted). Both expose read APIs and emit change events over IPC; the renderer treats them as remote sources of truth and caches defensively.

### 16.4 Persistence & Hydration

- Layout/tabs/session → workspace journal (SQLite + write-ahead) for crash recovery (INV-5).
- Settings → versioned JSON + SQLite cache, with a **migration framework** (each schema version has an up-migration; corrupt/newer schemas fail safe to defaults with a backup copy).
- Index/vector data → on-device store, rebuildable from source if corrupted (never authoritative over the code).
- Hydration is **staged**: window frame → last workspace → tabs (lazy content) → background index resume, so time-to-interactive is minimized (Part XI).

### 16.5 Event Sourcing for Agent Runs

Agent runs are modeled as an append-only event log (`run.started`, `plan.created`, `tool.called`, `edit.proposed`, `edit.applied`, `checkpoint.created`, `run.completed|interrupted|failed`). This yields: perfect timeline/replay for the UI, resumability after crash, auditability (Part X), and the ability to compute diffs/rollbacks deterministically (Part VIII snapshots).

---

## 17. DEPENDENCY INJECTION & SERVICE ARCHITECTURE

### 17.1 Service Registry & Interfaces

A lightweight DI container hosts services keyed by interface tokens (`IFileSystemService`, `ISecretVault`, `IEgressGateway`, `IProviderRegistry`, `ISettingsService`, `IWorkspaceService`, `ITelemetryService`, `IIndexService`, `IGitService`, …). Consumers request interfaces; the container supplies the wired implementation. Benefits: testability (inject fakes), replaceability (swap implementations), and clear contracts. Proxy stubs transparently forward interface calls across IPC when the implementation lives in another process, so callers are location-agnostic.

### 17.2 Lifecycles & Activation

Services declare a lifecycle (`eager` at startup vs. `lazy` on first use) and dependencies (resolved topologically; cycles are a build-time error). Lazy activation keeps cold start fast (Part XI): e.g., the debugger, extension host, and embeddings host activate on demand.

### 17.3 Contribution Model

Extensibility uses a **contribution registry**: commands, menus, views, settings, themes, language features, providers, and agents are *contributed* (declaratively) rather than hard-wired. Both first-party features and third-party extensions use the same contribution mechanism, ensuring the platform is genuinely extensible (Principle 4.10) and dog-fooded by our own features.

---

## 18. PLATFORM ABSTRACTION LAYER (PAL)

### 18.1 Purpose

The PAL (`packages/platform`) is the single quarantine for OS-specific behavior (INV-7), making the eventual macOS/Linux port an exercise in implementing interfaces rather than editing scattered conditionals.

### 18.2 Abstracted Concerns & Interfaces

- **Paths & FS semantics** — separators, case sensitivity, long-path (`\\?\`) handling on Windows, reserved names, trash/recycle.
- **Secure storage** — `ISecretStore`: Windows Credential Manager/DPAPI now; Keychain/libsecret later.
- **File watching** — `IFileWatcher`: ReadDirectoryChangesW (Windows) vs. FSEvents/inotify; debouncing and rename coalescing normalized.
- **PTY** — `IPtyHost`: ConPTY on Windows; forkpty elsewhere.
- **Notifications & tray** — native toast/notification and system tray abstractions.
- **Shell integration** — file associations, "Open with Axiom", context-menu entries, protocol handler (`axiom://` for auth redirect).
- **Process/env** — locating toolchains (git, node), environment inheritance, shell resolution.
- **Fonts, DPI, theme** — high-DPI scaling, OS light/dark detection, accent color.
- **Autostart, power/idle events, single-instance** locking.

Every interface ships a Windows implementation (1.0) and a documented contract so mac/Linux implementations can be added without touching callers.

---

## 19. EXTENSION ARCHITECTURE

### 19.1 Extension Host

Extensions run in a dedicated, sandboxed Node child process (never the renderer, never Main). They interact with Axiom only through the `extensions-api` façade over IPC. A crash or infinite loop in an extension cannot take down the editor (§13.4) and cannot read secrets or open arbitrary network sockets (must go through brokered, permissioned APIs).

### 19.2 API Surface (1.0 curated subset)

A pragmatic, VS Code-inspired but independent API: commands, configuration, workspace/file access (permissioned), languages (register providers, diagnostics), text-document events, UI contributions (views, status bar, tree views, webviews with strict CSP), tasks, and — uniquely — **AI contribution points** (register tools, agents, prompt templates, context providers). We target compatibility with the *shapes* developers know while keeping the surface small enough to secure and maintain. Full VS Code API parity is a Non-Goal for 1.0 (N4).

### 19.3 Sandboxing, Permissions & Resource Limits

Extensions declare a manifest with requested permissions (filesystem scopes, network hosts, AI access, secret access — the last effectively denied/brokered). A **capability broker** in Main enforces these at every API call; undeclared access is denied and surfaced to the user. Extensions have CPU/memory ceilings and are killed on breach. Marketplace/distribution and signing are addressed in Part VI; a curated, reviewed initial catalog reduces supply-chain risk (Part X).

### 19.4 Provider Plugin SDK

New AI providers can be added as plugins implementing the `IProviderAdapter` contract (auth, model listing, chat/complet…, streaming, tool/function calling, capability descriptor, cost model). This lets the community/enterprises add endpoints without a core release (Part V details the contract).

### 19.5 Custom Agent SDK

Users/teams define custom agents declaratively (persona, allowed tools, model routing policy, guardrails, workspace-rule bindings) and optionally with code hooks. This powers "Workflow Automation" and "Custom Agents" (Part VIII) on the same contribution rails.

---

## 20. NETWORKING ARCHITECTURE

### 20.1 The Egress Gateway (single exit)

All provider traffic flows through `EgressGateway` in Main (INV-2). Responsibilities: credential injection (from `SecretVault`), request signing/headers per adapter, connection pooling/keep-alive, HTTP/2, timeouts, cancellation, **per-request audit metadata** (provider, model, endpoint, byte/token counts, latency — never the payload unless the user enables verbose local logging), and enforcement that the destination host matches the user-configured provider endpoint allow-list.

### 20.2 Streaming

Server-Sent Events (OpenAI-style) and provider-specific streaming formats are normalized into Axiom's internal token-stream protocol, then relayed to the renderer/orchestrator over the streaming IPC channel (§14.4) with coalescing and cancellation.

### 20.3 Proxy & Enterprise Network Support

Respects system proxy settings and explicit proxy config (HTTP/HTTPS/SOCKS), custom CA certificates (corporate MITM/inspection), and configurable TLS. Essential for enterprise personas behind proxies.

### 20.4 Resilience: Retry, Backoff, Circuit Breaking

Idempotent requests use exponential backoff with jitter and a retry budget; per-provider circuit breakers open on sustained failures and drive **failover** (Part V). Rate-limit responses (HTTP 429 + `Retry-After`) are honored precisely. All of this is centralized so every provider benefits uniformly.

### 20.5 Offline Detection & Degradation

A connectivity monitor distinguishes "no internet," "provider unreachable," and "auth/sync backend unreachable," driving accurate UI affordances (Principle 4.11): local models still work offline; cloud sync queues; and the app never spins or blocks waiting on a dead network.

---

## 21. END-TO-END DATA FLOW (WORKED EXAMPLE)

**"Explain this repository" (grounded AI answer):**

1. User invokes command in renderer → command dispatched over IPC to AI Orchestrator.
2. Orchestrator asks Core Engine for relevant context (semantic search over the on-device vector index + symbol graph) — code never leaves the machine for retrieval.
3. `ContextBuilder` assembles a token-budgeted prompt (repo map, top-k chunks, workspace rules), tracked by `CostMeter`.
4. Orchestrator requests inference via Main's `EgressGateway`, which injects the user's key from `SecretVault` and streams to the **user-chosen provider** (or local Ollama — zero egress).
5. Token stream flows back: Gateway → Orchestrator (assembles) → renderer chat view (coalesced rendering). Citations link to real files via the symbol/index map.
6. Audit log records provider/model/tokens/cost/latency locally; opt-in telemetry records only anonymized metadata (never code).

This flow demonstrates the invariants working together: heavy work in Core (INV-1), single egress (INV-2), secrets in Main only (INV-3), no code to Axiom cloud (INV-4), full local audit (Part X).

---

## 22. ERROR HANDLING & RESILIENCE ARCHITECTURE

- **Typed results everywhere.** Cross-boundary calls return `Result<T, StructuredError>` rather than throwing across IPC. Errors carry a stable `code`, user-safe `message`, `severity`, `retryable` flag, and correlation `id`.
- **Error taxonomy.** Categories: `UserInput`, `Provider` (auth/rate/quota/timeout/content), `Network`, `Filesystem`, `Permission`, `Internal`, `Extension`. Each maps to a defined UX (toast, inline, modal, silent-log) in Part IX.
- **Graceful degradation ladder.** Embeddings down → keyword search; provider down → failover → offline notice; index building → reduced-context AI with a "still indexing" note.
- **Idempotency & transactionality.** File writes are atomic (temp + fsync + rename); multi-file agent edits are staged and applied as a reviewable batch with an all-or-nothing option and a snapshot before apply.
- **Correlation IDs** thread through logs across processes so a single user action is traceable end-to-end during support/debug.

---

## 23. OBSERVABILITY ARCHITECTURE

- **Structured logging** (JSON) with levels, subsystem tags, correlation IDs, and PII/secret redaction at the sink. Local rotating log files; a user-triggerable **diagnostics bundle** (Part VI) packages logs + system info (scrubbed) for support.
- **Metrics** (opt-in): performance timers (cold start, edit latency, index throughput), counters (AI actions, accept/revert), and gauges (memory, process health) → local buffer → batched to the telemetry sink with consent (default: an Edge-Function→Postgres ingestion pipeline; optional self-hostable PostHog behind the sink abstraction).
- **Crash reporting** (opt-in) via the crash pipeline (default: Edge-Function→Postgres ingestion; optional self-hostable Sentry) with symbolication; local crash journal always kept for recovery even when telemetry is off.
- **Feature flags / remote config** gate risky features and enable staged rollout and kill-switches without shipping a new build — served from a Postgres `feature_flags` table over Supabase Realtime, with compiled fail-safe defaults (Part IV/VI).
- **Privacy-by-design:** all observability defaults to the minimum necessary, is documented in a data-flow table (Part X), and is fully disable-able.

---

## 24. BUILD, VERSIONING & SCHEMA MIGRATION ARCHITECTURE

- **Reproducible builds** via pinned toolchains and lockfiles; native binaries (Rust sidecar, node-pty) built per target triple and packaged with the app.
- **Semantic versioning** for the app and independently for the **IPC protocol**, **settings schema**, **index format**, and **extension API**. Each has a documented compatibility policy and migration path.
- **Migration framework** runs on startup: detects on-disk schema versions and applies ordered migrations with backups; unknown/newer versions fail safe (read-only or defaults + backup) rather than corrupting data.
- **Codegen** produces IPC types (TS + Rust) and settings types from single sources of truth, eliminating cross-process drift.
- **CI architecture** (detailed in Part XII): typecheck, lint/boundaries, unit, integration, e2e (Playwright-driving-Electron), Rust tests, dependency-cycle & bundle-size & performance-budget gates, and signed artifact production. Release channels: `dev → beta → stable` with staged rollout and one-click rollback (Part VI).

---

## 25. ARCHITECTURE RISKS, TRADE-OFFS & ALTERNATIVES

- **Electron memory footprint.** *Trade-off accepted*; mitigated by Rust sidecars, strict budgets (Part XI), multi-process sharing, and lazy activation. *Alternative kept open:* Tauri migration (ADR-0002) behind the Shell Abstraction Layer.
- **Clean build vs. fork editor breadth.** *Trade-off accepted*; mitigated by Monaco reuse and phasing. *Risk:* extension-ecosystem gap — mitigated by curated API + first-party equivalents.
- **Multi-process complexity.** More moving parts than a monolith; mitigated by supervision (§13.3), typed IPC (§14), and correlation-ID observability (§23). Justified by the UI-never-blocks and crash-isolation invariants.
- **Rust/TS boundary cost.** JSON-RPC over stdio adds serialization overhead vs. in-process FFI; accepted for crash isolation and language safety, and minimized by batching and WASM for hot, chatty logic.
- **Local vector index scaling.** Very large monorepos may strain memory; mitigated by memory-mapped HNSW, per-workspace budgets, and incremental/partial indexing (Part XI). *Alternative:* optional local external vector engine Post-1.0.
- **Backend lock-in.** Mitigated by keeping cloud responsibilities minimal and behind `IBackendService`/`IAuthService`/`ISyncService`, and by choosing Supabase — open-source, standard-Postgres, and self-hostable — so self-hosting or migrating off managed Supabase requires no application changes.

---

*End of Part II — System Architecture.*


---

# PART III — AUTHENTICATION & IDENTITY

> **Purpose of this Part.** Part III specifies the complete identity subsystem: how a user proves who they are, how sessions and tokens are managed on a desktop application (a materially harder problem than web auth), how multiple devices are coordinated, how accounts and profiles work, and how every failure and abuse case is handled. It honors the sovereignty principle: **authentication unlocks cloud conveniences (sync, profile, cross-device), but is never required to edit code or use BYOK AI.** Axiom is fully usable signed-out. All auth behavior obeys the invariants of Part II — especially INV-3 (secrets never touch the renderer) and INV-2 (single egress).

---

## 26. AUTHENTICATION OVERVIEW & PRINCIPLES

### 26.1 Goals

- **A1.** Frictionless, secure Google Sign-In on desktop using Supabase Auth.
- **A2.** A desktop-correct OAuth flow (system browser, never embedded webview) that satisfies Google's native-app policy and modern security standards.
- **A3.** Durable, secure sessions that survive app restarts without re-prompting, with silent token refresh.
- **A4.** Multi-device awareness: a user can be signed in on several machines, see them, and revoke them.
- **A5.** A profile/account system that stores only the minimum identity data required.
- **A6.** Clean, complete logout and account-deletion flows (privacy/compliance ready).
- **A7.** An abstraction that allows adding GitHub, Microsoft, Apple, email, magic-link, and enterprise SSO **without re-architecting**.
- **A8.** Graceful behavior offline, on token expiry, on revocation, and under attack.

### 26.2 Authentication Principles

1. **Sign-in is optional for core work.** Editing, terminal, Git, local models, and BYOK AI (with locally stored keys) all function signed-out. Sign-in is the gate for *cloud* features only (settings sync, profile, cross-device continuity, cloud backup, opt-in cloud telemetry association).
2. **System browser only.** OAuth happens in the user's real browser, never an embedded webview (Google blocks embedded webviews for OAuth per the native-app best practice; embedding is also a phishing/token-theft risk).
3. **Secrets live in Main + OS secure store.** Refresh tokens and any long-lived credentials are held only by the Main process and persisted in the OS secure store (Windows Credential Manager / DPAPI). The renderer only ever sees a sanitized identity object and a short-lived, in-memory session state — never the refresh token (INV-3).
4. **Least identity data.** We store the minimum: a stable user id, email, display name, avatar URL, and provider linkage. No passwords are ever handled by Axiom (delegated to the identity provider).
5. **Reversible & inspectable.** Users can view active devices/sessions, sign out locally or everywhere, export their data, and delete their account.
6. **Fail safe, never fail open.** If identity cannot be verified, cloud features disable gracefully; local work is never blocked or lost.

### 26.3 What Authentication Gates (and What It Doesn't)

| Capability | Requires sign-in? | Rationale |
|---|---|---|
| Editing, tabs, workspaces, search, Git, terminal, debugger | ❌ No | Local-first; core editor is sacred |
| BYOK AI with locally stored keys, local models (Ollama/LM Studio) | ❌ No | Sovereignty; keys are local |
| Settings/keybindings **sync** across devices | ✅ Yes | Requires cloud identity |
| Cloud backup/restore of preferences | ✅ Yes | Requires cloud identity |
| Profile (name/avatar), device management | ✅ Yes | Identity-scoped |
| Cross-device prompt library / workspace-rules sync | ✅ Yes | Identity-scoped |
| Opt-in cloud telemetry associated to a user | ✅ Yes (+ consent) | Consent + identity |
| Anonymous local telemetry (if consented) | ❌ No | Not user-linked |
| Future: team/org features, entitlements | ✅ Yes | Org membership |

### 26.4 Identity Model

- **Principal.** The authenticated subject, keyed by the Supabase `user.id` (a UUID; stable, provider-independent).
- **Provider identities.** One or more linked auth providers (Google in 1.0) under a single principal, enabling account linking later.
- **Session.** A per-device authenticated context bound to a Supabase refresh token, a short-lived access token (JWT), and a local device record.
- **Device.** A registered installation instance (see §31) with an app-generated device id, platform, app version, and last-seen timestamp.
- **Profile.** User-facing identity attributes (display name, avatar, email, preferences pointer).

---

## 27. AUTHENTICATION ARCHITECTURE

### 27.1 Why Supabase Auth

Supabase Auth provides managed OAuth brokering (Google in 1.0), JWT access/refresh token issuance with refresh-token rotation, server-side revocation, and — critically — **native PKCE support for the Authorization Code flow**, which is exactly what a desktop app needs (§27.2). It integrates directly with the rest of the backend (Part IV): every authenticated request carries a Supabase JWT whose `sub` claim (the user's UUID) is read by **PostgreSQL Row Level Security** policies via `auth.uid()`, giving server-authoritative, per-user data access with no bespoke identity server. Supabase Auth is **open-source and self-hostable**, so an enterprise can run it in its own tenant. It is abstracted behind `IAuthService` (Part II §17) so the provider can be replaced Post-1.0 (e.g., self-hosted OIDC/SAML for enterprise) without touching feature code.

### 27.2 The Desktop OAuth Challenge

Browser-based OAuth relies on full-page redirects or popups that assume a browser origin and cookies. A desktop app has neither a stable web origin nor a browser context in the trusted process, and **must not** embed a webview for Google OAuth. The correct pattern for native apps is the **Authorization Code flow with PKCE**, using the **system browser** and a **redirect back to the application** via either a **loopback interface** (`http://127.0.0.1:<ephemeral-port>`) or a **custom URI scheme** (`axiom://auth/callback`). Axiom uses **loopback as primary** (most robust, least hijackable) and **custom scheme as fallback**.

### 27.3 Chosen Flow (Ratified): Supabase Auth + Google OAuth + PKCE + Loopback

Supabase Auth supports the **Authorization Code flow with PKCE** natively, so **no OAuth client secret and no hosted callback helper are required on the device**:

1. **Desktop app** (Main process) starts an ephemeral loopback HTTP server on `127.0.0.1:<random-high-port>` and generates a cryptographically random `state`. The Supabase client (running in Main, configured with `flowType: 'pkce'` and a Main-side secure storage adapter) generates and persists the **PKCE** `code_verifier` and derives the `code_challenge`.
2. Main obtains an authorization URL via `supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: 'http://127.0.0.1:<port>/callback', skipBrowserRedirect: true } })` and opens that URL in the **system browser**.
3. In the browser, Supabase Auth brokers the **Google OAuth** handshake; the user sees Google's genuine consent screen. Google returns to Supabase, which then redirects to `http://127.0.0.1:<port>/callback?code=<auth_code>&state=<state>`.
4. The **loopback server** receives the redirect, **validates `state`** (constant-time compare), extracts the one-time authorization `code`, renders a friendly "You can return to Axiom" success page, and hands the code to Main. The loopback server then **shuts down immediately**.
5. Main calls **`supabase.auth.exchangeCodeForSession(code)`** — PKCE binds the exchange to the stored `code_verifier` — receiving a Supabase **session**: an **access token** (JWT, ~1h) and a **refresh token** (long-lived). The refresh token is written to the **OS secure store** via `SecretVault`.
6. Main derives a sanitized **identity object** (`id`, email, display name, avatar URL, providers) from the session user and pushes it to the renderer over IPC. **No token ever reaches the renderer.**

**Why this design:** PKCE removes the need for any client secret; the system browser keeps the user in control and shows Google's genuine consent UI (anti-phishing); loopback avoids custom-scheme interception; Supabase brokers OAuth and issues/refreshes/revokes tokens; and all secrets stay in Main. The authorization code is one-time and short-lived and the PKCE `code_verifier` never leaves the device, so interception windows are minimal.

### 27.4 Sequence (ASCII)

```
Desktop(Main)                 System Browser            Supabase Auth / Google
     |  start loopback :port                                 |
     |  gen state + PKCE (verifier/challenge)                |
     |  signInWithOAuth(google, redirectTo, PKCE) ---------->|  (build authorize URL)
     |----open authorize URL in system browser------------->|
     |                                    Google sign-in --->|  (Google consent)
     |                                                       |  broker OAuth
     |<--redirect 127.0.0.1:port/callback?code&state---------|
     | validate state (CT compare)                          |
     | exchangeCodeForSession(code)  [PKCE verifier] ------->|
     |<--- access token (JWT ~1h) + refresh token (long) ---|
     | store refresh token in SecretVault                   |
     | push sanitized identity -> Renderer                  |
```

### 27.5 Custom-Scheme Fallback

If loopback binding fails (locked-down environment, port exhaustion), Axiom registers the `axiom://` protocol handler (PAL, Part II §18) and uses `axiom://auth/callback?...` as the redirect. Additional hardening applies because custom schemes are more interceptable: the PKCE authorization `code` remains single-use and `state`-bound (and is worthless without the code verifier held only by the desktop app), and Axiom warns if multiple handlers are registered for the scheme.

### 27.6 Components

- `IAuthService` (Main) — wraps the Supabase Auth client; orchestrates flows, owns tokens, exposes `signIn()`, `signOut()`, `getIdentity()`, `getAccessToken()` (fresh), `onAuthStateChanged()`.
- `LoopbackReceiver` — ephemeral HTTP server; strict lifetime; `state` validation.
- `SecretVault` — persists the Supabase refresh token (INV-3); backs the Supabase client's Main-side storage adapter.
- `TokenManager` — proactive refresh, expiry, refresh-token rotation, and revocation handling (via the Supabase client's `onAuthStateChange` plus explicit refresh).
- `DeviceRegistry` — device identity + a `device_sessions` Postgres row per device (§31).
- Renderer `AuthView`/`AccountMenu` — sign-in CTA, profile, device management (renders identity only).

---

## 28. GOOGLE SIGN-IN FLOW — DETAILED SPECIFICATION

### 28.1 Preconditions & Initiation

- Triggered from: onboarding wizard, Account menu, or any cloud-gated action (which shows a "Sign in to enable sync" prompt rather than blocking).
- Main verifies network connectivity; if offline, sign-in is disabled with a clear message (§39).

### 28.2 Parameters & Cryptography

- `code_verifier`: 43–128 char high-entropy random string; `code_challenge = BASE64URL(SHA256(verifier))`.
- `state`: ≥ 256-bit random, single-use, stored in memory in Main, tied to this attempt with a short TTL (e.g., 5 min).
- `nonce`: ≥ 256-bit random, embedded and later verified in the provider's OIDC ID token to prevent replay.
- Loopback port: OS-assigned ephemeral port; only `127.0.0.1` (never `0.0.0.0`).

### 28.3 Browser Handoff & Consent

The system browser opens the hosted page. The user sees Google's genuine consent UI in a trusted browser (anti-phishing). Axiom shows a lightweight "Waiting for sign-in in your browser…" modal with **Cancel** and **Open link again** actions.

### 28.4 Callback Handling

- Loopback receives exactly one callback; validates `state` (constant-time), rejects and logs any mismatch (possible CSRF/hijack).
- On success: render a self-closing success page, hand the authorization `code` to `TokenManager`, call `exchangeCodeForSession` to obtain the Supabase session, persist the refresh token, emit `auth.signedIn`.
- On user cancel/deny: browser returns an error param → Axiom shows a non-blocking "Sign-in canceled" state.

### 28.5 Post-Sign-In

- `DeviceRegistry` creates/updates this device's session document (§31).
- Renderer receives sanitized identity; UI updates avatar/name; sync begins if enabled (Part IV).
- Telemetry (if consented): `auth_signin_success` with method + latency; **no PII beyond uid hash**.

### 28.6 Timeouts

- Whole flow TTL ~5 min; on expiry the loopback server closes, `state` invalidates, and the modal offers retry. This prevents dangling servers/attempts.

---

## 29. SESSION MANAGEMENT

### 29.1 Session Components

A session = { Supabase **refresh token** (long-lived, in SecretVault), current **access token** (JWT ~1h, in-memory Main), **device record** (a `device_sessions` Postgres row), **local session state** (renderer, non-sensitive) }.

### 29.2 Lifecycle

- **Create** on successful sign-in.
- **Persist** the refresh token securely so restarts don't re-prompt.
- **Hydrate** on app launch: Main reads the refresh token, silently obtains a fresh access token, validates it, and restores the signed-in identity **before** the UI needs it (staged so it never blocks editor readiness).
- **Maintain** via proactive refresh (§30).
- **Terminate** on logout, revocation, refresh failure, or account deletion.

### 29.3 Token Storage Rules

- Refresh token → OS secure store only; encrypted at rest by the OS (DPAPI). Never logged, never synced, never sent to the renderer.
- Access token (JWT) → memory only in Main; short-lived; attached as the `Authorization: Bearer` header to Supabase calls (PostgREST/Storage/Realtime/Edge Functions) as needed; the renderer receives neither.
- If the secure store is unavailable (rare), the app treats the user as signed-out and prompts re-auth rather than falling back to insecure storage.

### 29.4 Session ↔ Renderer Contract

Renderer holds only `{ id, email, displayName, avatarUrl, isSignedIn, syncEnabled }`. All privileged operations (obtaining a fresh access token for a Supabase write) are performed in Main; the renderer requests actions, not credentials.

### 29.5 Concurrent Windows

Multiple windows share one Main-held session; auth state changes broadcast to all renderers so every window's UI stays consistent.

---

## 30. TOKEN LIFECYCLE & REFRESH

### 30.1 Proactive Refresh

`TokenManager` refreshes the access token **before** expiry (e.g., at ~80% of TTL or on-demand when a call needs a valid token), using the refresh token via Supabase Auth's token endpoint through the `EgressGateway`. Refreshes are **de-duplicated** (a single in-flight refresh; concurrent callers await it) and **jittered** to avoid thundering herds.

### 30.2 Refresh-Token Rotation & Revocation

If/when the identity provider rotates refresh tokens, the new token replaces the old in `SecretVault` atomically. Server-side revocation (from "sign out everywhere," password/security change, or admin action) causes refresh to fail with a revocation error → the session is terminated locally, identity cleared, and the user is invited (not forced) to sign in again; **local work continues untouched.**

### 30.3 Failure Handling

| Condition | Behavior |
|---|---|
| Transient network error on refresh | Retry with backoff; keep last identity; enter "reconnecting" state; cloud features pause |
| Refresh token invalid/revoked | Terminate session, clear tokens, show non-blocking "signed out" notice |
| Clock skew (JWT `iat/exp` off) | Detect skew, adjust via server time, retry; warn if system clock is badly wrong |
| Secure store read failure | Treat as signed-out; prompt re-auth; never use insecure fallback |
| Authorization code expired/invalid before exchange | Restart sign-in flow automatically once, then surface error |

### 30.4 Token Validation

Supabase access tokens (JWTs) are validated (signature via the project JWT secret / JWKS, plus `aud`, `iss`, `exp`) before trust. Backend enforcement is independent — **PostgreSQL Row Level Security** evaluates `auth.uid()` on every query — so a forged or stale client token cannot reach another user's data (Part IV).

---

## 31. MULTI-DEVICE SUPPORT

### 31.1 Device Identity

On first run, Axiom generates a random, non-PII **device id** (persisted locally). On sign-in it upserts a row into the `device_sessions` table (keyed by `user_id` + `device_id`): `{ user_id, device_id, platform, os_version, app_version, device_name (editable), created_at, last_seen_at, ip_region (coarse, optional), current bool, revoked_at }`. RLS restricts every row to its owner. `device_name` defaults to the machine hostname (editable by the user).

### 31.2 Device/Session Management UI

Account → **Devices** lists all active sessions with platform, name, last-seen, and "This device" marker. Actions: **rename**, **sign out this device**, **sign out all other devices**, **sign out everywhere**. Signing out a remote device writes a revocation signal (and, where supported, revokes that device's refresh token) so it drops to signed-out on next refresh.

### 31.3 Cross-Device Continuity

Settings, keybindings, prompt library, and workspace rules sync across devices (Part IV). Continuity is metadata/preferences only — **never source code**. Conflict resolution uses last-writer-wins with a visible history for user-editable records (Part IV §55).

### 31.4 Session Limits & Anomalies

No hard device cap in 1.0 (single-user product), but the system flags anomalies (e.g., many new devices in a short window) in the audit log and can prompt the user to review devices. Enterprise device-count policy is Post-1.0.

---

## 32. ACCOUNT & PROFILE SYSTEM

### 32.1 Profile Data Model (`users/{uid}`)

`{ uid, email, emailVerified, displayName, photoURL, createdAt, lastLoginAt, locale, prefsVersion, providers: [google], flags: {…}, deletedAt? }`. Sensitive fields are never stored; email is stored for display/support and is provider-verified.

### 32.2 Profile Management UI

- View/edit display name and avatar (avatar may inherit from Google or be uploaded to Supabase Storage under the user's own path).
- View linked providers (Google in 1.0; "link more" is Post-1.0 with account linking).
- Manage sync toggle, telemetry consent, and connected devices.

### 32.3 Data Export (Portability)

"Export my data" produces a downloadable archive of the user's cloud-stored data (profile, settings, prompt library, rules, device list, audit summary) as JSON — supporting privacy-regulation portability rights. No source code is involved (none is stored).

### 32.4 Account Deletion (Right to Erasure)

A guarded, two-step **Delete Account** flow: explains consequences, requires re-authentication and typed confirmation, then: (1) revokes all sessions, (2) deletes the user's PostgreSQL rows (a single delete of the root `users` row fans out via `ON DELETE CASCADE` foreign keys) and their Storage objects — executed by a service-role **Edge Function**, (3) deletes the Supabase Auth user (`auth.admin.deleteUser`), (4) wipes local cloud-derived caches (local BYOK keys/workspaces remain the user's and are untouched unless they choose local wipe). A grace/tombstone window and audit entry are recorded per compliance needs.

### 32.5 Email Change / Verification

Delegated to the identity provider (Google) in 1.0. When email/password or other providers arrive (§35), verification and change flows are added behind the same `IAuthService`.

---

## 33. LOGOUT FLOW

### 33.1 Local Sign-Out

Clears the in-memory access token, deletes the refresh token from `SecretVault`, marks this device's `device_sessions` row inactive, stops sync, and resets the renderer identity to signed-out. **Local work, open workspaces, and locally stored BYOK keys are preserved.** A confirmation is shown if unsynced preference changes exist.

### 33.2 Global Sign-Out ("Everywhere")

Invokes revocation for all of the user's refresh tokens (a service-role **Edge Function** calling Supabase Auth admin `signOut(user, scope: 'global')`), so every device drops to signed-out on its next refresh. Useful after device loss. The initiating device signs out immediately; others follow within their refresh window.

### 33.3 Post-Logout State

App remains fully functional signed-out. Cloud-gated UI shows "Sign in to enable" affordances. No identity data lingers in memory or on disk beyond non-sensitive UI state.

---

## 34. ACCOUNT RECOVERY

### 34.1 Credential Recovery (Delegated)

Because Axiom uses Google (and later other IdPs) and **never handles passwords**, credential recovery is delegated to the identity provider (Google account recovery). Axiom surfaces a helpful link and never asks for a provider password.

### 34.2 Local Data Recovery vs. Identity

Identity loss ≠ data loss: local workspaces, settings, and BYOK keys are on-device and independent of sign-in. If a user cannot recover their Google account, they still retain full local functionality; only cloud-synced conveniences are affected. On signing in with a new/different account, local data remains and can be associated with the new identity (with a clear prompt to avoid accidental cross-account mixing).

### 34.3 Orphaned Local Data

If cloud identity is deleted but local caches remain, a startup reconciliation detects the mismatch and offers to (a) keep local data as signed-out, or (b) clear cloud-derived caches. Never destructive without explicit consent.

### 34.4 Corrupted Token / Secure Store Recovery

If the stored refresh token is corrupt/unreadable, the session is cleanly reset to signed-out with a one-tap re-sign-in; no crash, no data loss.

---

## 35. FUTURE AUTHENTICATION PROVIDERS (ARCHITECTURE-READY)

### 35.1 Provider Abstraction

`IAuthService` is provider-agnostic; each provider is a strategy implementing `startFlow()`, `handleCallback()`, `mapIdentity()`, `capabilities`. Adding a provider is additive, not structural.

### 35.2 Roadmap Providers

- **GitHub** (highly requested by developers; enables repo-scoped features later).
- **Microsoft / Azure AD** (enterprise; MSAL; org SSO).
- **Apple** (required if a future macOS App Store build ships social login).
- **Email/Password + Magic Link** (for users without a supported social account).
- **Enterprise SSO — SAML / OIDC** (org-managed identity; SCIM provisioning) — the key unlock for the enterprise persona (Post-1.0).

### 35.3 Account Linking

Multiple providers can link to one `uid` (e.g., Google + GitHub) with a guarded linking flow, conflict detection (email already in use), and unlinking with safeguards (cannot remove the last provider). Groundwork (provider array in the profile model) is laid in 1.0.

### 35.4 Enterprise Considerations (Directional)

Org-enforced provider, domain capture, session policies (max lifetime, forced re-auth), device trust, and admin-initiated revocation — all behind the same abstraction so 1.0 code survives the enterprise expansion.

---

## 36. AUTHORIZATION, ENTITLEMENTS & ROLES

### 36.1 1.0 Model

1.0 is single-user and BYOK, so authorization is minimal: signed-in vs. signed-out gates cloud features; a `flags`/`entitlements` map on the profile (driven by the `feature_flags` table, Part IV) can enable beta features per user without a release.

### 36.2 Future Roles

Post-1.0 introduces org roles (owner/admin/member), team-scoped resources, and policy inheritance. The data model reserves space (org id, role) so migration is non-breaking. Backend enforcement always lives in RLS policies / Edge Functions, never solely on the client.

---

## 37. SECURITY CONSIDERATIONS (AUTH-SPECIFIC)

*(Cross-references the full threat model in Part X.)*

- **PKCE (`code_verifier`/`code_challenge`) + `state`** defeat authorization-code interception, CSRF, and replay.
- **System browser only** eliminates embedded-webview credential theft and honors IdP policy.
- **Loopback preferred over custom scheme** to reduce redirect hijacking; custom-scheme fallback keeps tokens single-use and short-lived.
- **Secrets confined to Main + OS secure store** (INV-3); refresh tokens encrypted at rest (DPAPI); never logged or synced.
- **Short-lived access tokens + one-time authorization codes** minimize exposure windows; the PKCE `code_verifier` never leaves the device.
- **Constant-time comparisons** for `state` matching to avoid timing leaks.
- **Backend-side enforcement**: PostgreSQL Row Level Security validates `auth.uid()` on every query and Storage access, independently of the client (Part IV); a stolen/forged client token cannot bypass RLS.
- **No attestation product on desktop.** Supabase has no App Check equivalent, and desktop attestation is inherently weak on any platform; Axiom compensates with RLS + Edge-Function rate limiting + anomaly detection rather than relying on attestation. *(Explicitly noted as a known limitation.)*
- **Rate limiting & abuse controls** on sensitive Edge Functions (per-IP, per-user) to prevent abuse.
- **Revocation propagation** ensures lost/stolen devices can be cut off ("sign out everywhere").
- **No password handling** anywhere in 1.0 (delegated), removing an entire class of risk.
- **Deep-link validation**: `axiom://` callbacks are validated for `state`, rejected if unsolicited, and never auto-trusted.
- **Phishing resistance**: because consent is shown in the real browser on Google's domain, spoofing is much harder than an in-app form.

---

## 38. EDGE CASES & FAILURE SCENARIOS

| # | Scenario | Handling |
|---|---|---|
| E1 | User closes browser mid-flow | Flow times out (~5 min); loopback closes; modal offers retry |
| E2 | User denies Google consent | "Sign-in canceled"; remain signed-out; no error noise |
| E3 | Loopback port unavailable | Retry with new port; if all fail, fall back to `axiom://` scheme |
| E4 | Multiple sign-in attempts at once | Only the most recent `state` is valid; older attempts rejected |
| E5 | `state` mismatch on callback | Reject, log as potential CSRF/hijack, restart flow |
| E6 | Authorization code expires/invalid before exchange | Auto-restart flow once; then surface actionable error |
| E7 | Network drops after consent, before token | Show "couldn't complete"; retry; no partial session created |
| E8 | Refresh token revoked remotely | Session terminates gracefully; local work preserved; re-sign-in offered |
| E9 | System clock badly skewed | Use server time for validation; warn user to fix clock |
| E10 | Secure store locked/unavailable | Treat as signed-out; never store token insecurely |
| E11 | Two accounts on one machine | Explicit account switch; local data association prompt to avoid mixing |
| E12 | App updated mid-session (token/schema change) | Migration handles token/schema; session preserved or clean re-auth |
| E13 | Corrupted local identity cache | Reset to signed-out; one-tap re-auth; no crash |
| E14 | Supabase/backend outage | Cloud features disabled with clear status; local unaffected; auto-recover |
| E15 | Duplicate `axiom://` handler registered by another app | Warn user; prefer loopback; validate `state` regardless |
| E16 | User signs out on Device A while Device B offline | Device B honors revocation on next refresh when back online |
| E17 | Rapid sign-in/sign-out toggling | Debounced; in-flight flows canceled cleanly |
| E18 | Access token needed but refresh in progress | Callers await the single in-flight refresh (de-duped) |
| E19 | Account deleted while other device active | Other device detects deletion on next call; resets to signed-out |
| E20 | Malicious page hits loopback endpoint | Requires valid `state`; unsolicited hits rejected and logged; server is single-use and short-lived |

---

## 39. OFFLINE & DEGRADED AUTHENTICATION

- **Cached identity for UX:** while offline, the last-known identity (name/avatar) may display with an "offline" badge so the app doesn't feel logged-out, but no privileged cloud calls are attempted.
- **Grace behavior:** if the access token can't refresh due to no network, the session enters "reconnecting"; cloud features pause but do not force sign-out. On reconnect, a silent refresh restores full function; only a *revoked* token forces sign-out.
- **Sign-in blocked offline:** initial sign-in requires connectivity; the CTA is disabled with a clear reason. Local models and BYOK still work.
- **Queued sync:** preference changes made offline queue and reconcile on reconnect (Part IV).

---

## 40. AUTH TELEMETRY, AUDIT & COMPLIANCE

- **Local audit log** (Part X) records auth events (`signIn`, `signOut`, `tokenRefreshFailed`, `deviceRevoked`, `accountDeleted`) with timestamps and device id — for user transparency and support — **never tokens or passwords**.
- **Opt-in telemetry** records anonymized/aggregate auth metrics (success rate, latency, error categories) with a hashed uid at most; fully disable-able.
- **Privacy posture:** minimal data collection, explicit consent for cloud telemetry, delegated credential handling, export + deletion flows, and a documented auth data-flow diagram feeding Part X's compliance-readiness section (GDPR/CCPA-aligned; SOC 2 groundwork Post-1.0).
- **Support diagnostics** never include tokens; the diagnostics bundle redacts identity secrets by construction.

---

*End of Part III — Authentication & Identity.*


---

# PART IV — DATA & BACKEND (SUPABASE)

> **Purpose of this Part.** Part IV specifies Axiom's cloud data layer end to end on **Supabase**: the PostgreSQL relational schema (tables, foreign keys, constraints, indexes, views), Row Level Security policies, Supabase Storage layout, Realtime subscriptions vs. fetch-once behavior, offline synchronization and conflict resolution, caching, Edge Functions, the SQL migration system, analytics, telemetry, usage/cost tracking, preferences/settings sync, logs and audit history, feature flags, and crash reporting. Everything here is subordinate to **INV-4: no user source code enters Axiom's cloud.** The backend stores identity, preferences, small user-authored artifacts (prompts/rules), metadata, and opt-in telemetry — never repositories, never file contents, never API keys.

---

## 41. BACKEND OVERVIEW & PRINCIPLES

### 41.1 Role of the Backend (Deliberately Minimal)

Axiom's cloud is a **thin identity + preferences + telemetry plane**, not a code host or an AI proxy. Its jobs: authenticate users (Part III), sync small preference/artifact documents across devices, serve remote configuration/feature flags, and collect opt-in analytics/crash data. Because it holds no source code and no AI keys, its data volume, cost, blast radius, and compliance surface stay small.

### 41.2 Supabase Services Used

| Service | Use in Axiom |
|---|---|
| **Supabase Auth** | Identity, sessions, JWT access/refresh tokens, Google OAuth + PKCE (Part III) |
| **PostgreSQL + Row Level Security** | All structured user data: profile, device sessions, settings, prompt library, rules, custom agents, provider config, workspace metadata, opt-in usage aggregates, public config; per-user isolation via RLS |
| **Supabase Storage** | Avatars, settings backups/exports, opt-in diagnostic bundles (object storage with RLS-backed access policies) |
| **Edge Functions** (Deno) | Privileged/atomic logic: account-deletion fan-out, usage aggregation, feedback routing, provider-config validation, telemetry/crash ingestion |
| **Supabase Realtime** | Live propagation of settings, device sessions, feature flags, and announcements (Postgres change streams) |
| **Migration System** (Supabase CLI) | Versioned SQL migrations for schema + RLS policies (Part II §24) |
| **`feature_flags` table + Realtime** | Feature flags, rollout %, kill switches, default settings (replaces Remote Config) |
| **Telemetry sink** (opt-in) | Product/perf analytics + crash reports via Edge-Function→Postgres ingestion; optional self-hostable **PostHog**/**Sentry** behind the sink abstraction (replaces GA4/Crashlytics) |
| **`pg_cron`** | Scheduled retention/TTL cleanup and aggregation rollups |

### 41.3 Data Classification & the "No Source Code" Invariant

Every field is classified before it may be persisted to the cloud:

| Class | Examples | Cloud allowed? |
|---|---|---|
| **C0 Secret** | API keys, refresh tokens, OAuth secrets | ❌ Never (local OS secure store only) |
| **C1 Source/Code** | File contents, repo trees, diffs, embeddings, index data | ❌ Never (local only; INV-4) |
| **C2 User-authored small artifacts** | Prompt library entries, workspace rules text, custom-agent defs | ✅ Opt-in sync (user's own content, small) |
| **C3 Preferences/metadata** | Settings, keybindings, theme, workspace *metadata* (name, last-opened) | ✅ Sync |
| **C4 Identity** | uid, email, display name, avatar | ✅ Stored |
| **C5 Telemetry/analytics** | Anonymized events, perf metrics, crash stacks | ✅ Opt-in only |

A **schema-enforced allow-list** (client validation + `CHECK` constraints + Row Level Security + Edge Function validation) makes C0/C1 structurally unable to enter Postgres/Storage. Workspace rows store a *path hash and metadata*, never contents.

### 41.4 Data Residency & Regions

The Supabase project (Postgres + Storage) is provisioned in a chosen primary region. Because only C2–C5 data is stored (no code), residency risk is low. Enterprise data-residency (region pinning, EU-only, on-prem) is *stronger* here than with a proprietary BaaS: Supabase is **open-source and self-hostable**, so an organization can run its own instance in its own region/VPC. This is a documented **Post-1.0** capability, enabled by the `IBackendService` abstraction (Part II §17) that keeps the backend swappable.

---

## 42. DATA ARCHITECTURE OVERVIEW

### 42.1 Why PostgreSQL (Relational + RLS)

**Decision: Supabase PostgreSQL** (ADR-0011). Rationale: a relational model gives normalized schemas, foreign keys, `CHECK`/`UNIQUE` constraints, transactions, views, and rich SQL; **Row Level Security** provides server-authoritative, per-user isolation evaluated on every statement via `auth.uid()`; the **SQL migration system** fits the versioned-schema requirement (Part II §24); and **Realtime** streams row changes for cross-device propagation. Where a value is genuinely schemaless (a settings blob, a flags map) we use a typed `jsonb` column with a `CHECK` guard — relational where it matters, flexible where it helps. Postgres is standard and self-hostable, avoiding lock-in. (No realtime collaboration in 1.0, N2, so no specialized fan-out store is needed.)

### 42.2 Schema Topology (tables)

All user data lives in the `public` schema; every user-owned table carries `user_id uuid references auth.users(id) on delete cascade` and an RLS policy `user_id = auth.uid()`. Public config lives in a read-only-to-clients set (service-role writes only).

```
postgres · public schema
├─ profiles              (C4 — 1:1 with auth.users; profiles.id = auth.users.id)
├─ device_sessions       (C3 — device/session rows, Part III)
├─ settings              (C3 — one row per (user_id, scope))
├─ keybindings           (C3 — one row per (user_id, profile_id))
├─ prompts               (C2 — prompt library)
├─ rules                 (C2 — workspace/coding rules)
├─ agents                (C2 — custom agent defs)
├─ provider_configs      (C3 — provider CONFIG; never keys)
├─ workspaces            (C3 — metadata only, path-hashed; no code)
├─ usage_daily           (C5 — opt-in usage aggregates; month-partitioned)
├─ cost_ledger           (C5 — opt-in monthly cost rollups)
├─ audit_events          (C5 — opt-in cloud audit mirror; month-partitioned)
├─ feedback              (C5 — user-submitted feedback)
└─ config (read-only to clients; service-role writes only)
   ├─ app_config          (min version, urls, kill switches)
   ├─ model_catalog       (public model metadata + pricing hints)
   ├─ provider_catalog    (known providers + capability descriptors)
   ├─ announcements       (in-app announcements)
   └─ feature_flags       (flags, rollout %, targeting; replaces Remote Config)
```

### 42.3 Normalization, JSONB & Partitioning

Prefer **normalized rows** (one row per settings scope, per prompt, per device) over giant documents — cheaper writes, granular Realtime, clean RLS. Use **`jsonb`** for inherently open maps (a settings scope body, a flags map, an agent's guardrails) with `CHECK` constraints and GIN indexes where queried. High-write append tables (`usage_daily`, `audit_events`) are **range-partitioned by month** (declarative partitioning / `pg_partman`) so retention is a fast partition drop and hot writes stay on the current partition.

### 42.4 Naming & Schema Conventions

- Tables and columns: `snake_case`, tables plural. Primary keys are `uuid` (`gen_random_uuid()`), except `profiles.id` which equals `auth.users.id`.
- Every row carries `schema_version int`, `created_at timestamptz default now()`, `updated_at timestamptz` (maintained by a `set_updated_at` trigger), and — where conflict UX needs it — `updated_by_device uuid`.
- Timestamps are `timestamptz` set server-side (`now()`); client clocks are never trusted for ordering.
- Money is stored as `bigint` minor units + a `currency` text code (never floats).
- RLS is enabled on every user-owned table with owner-only policies (§46).

---

## 43. POSTGRESQL DATA MODEL — TABLE BY TABLE

Each entry lists: **purpose · schema · access (RLS) · realtime · notes**. DDL is illustrative/abbreviated. Every user-owned table has RLS enabled; the canonical owner policy is `using (user_id = auth.uid()) with check (user_id = auth.uid())` unless noted (for `profiles`, substitute `id` for `user_id`).

### 43.1 `profiles` — Profile (C4)
```sql
create table public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  email          text not null,
  display_name   text,
  avatar_url     text,
  locale         text not null default 'en-US',
  providers      text[] not null default '{google}',  -- linked auth providers
  flags          jsonb  not null default '{}'::jsonb,  -- per-user entitlements
  prefs_version  int    not null default 1,
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz,
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,                          -- tombstone during deletion grace
  schema_version int not null default 1
);
```
- **Access (RLS):** owner `select`/`update` where `id = auth.uid()`; **insert** via the `on_auth_user_created` trigger (§51); **delete** only through the `delete_account` Edge Function. **Realtime:** subscribe to this row for live profile/flag updates.

### 43.2 `device_sessions` — Device Sessions (C3) *(defined in Part III §31; recapped)*
```sql
create table public.device_sessions (
  user_id      uuid not null references auth.users(id) on delete cascade,
  device_id    uuid not null,
  device_name  text,
  platform     text, os_version text, app_version text,
  ip_region    text,
  current      boolean not null default false,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at   timestamptz,
  schema_version int not null default 1,
  primary key (user_id, device_id)
);
```
- **Access (RLS):** owner read/write. **Realtime:** subscribe to `device_sessions` for the Devices UI + revocation propagation.

### 43.3 `settings` — Settings by Scope (C3)
One row per `(user_id, scope)`; scopes: `editor`, `ai`, `terminal`, `git`, `appearance`, `telemetry`, `privacy`, `experiments`. The scope body is typed `jsonb`.
```sql
create table public.settings (
  user_id    uuid not null references auth.users(id) on delete cascade,
  scope      text not null check (scope in
             ('editor','ai','terminal','git','appearance','telemetry','privacy','experiments')),
  body       jsonb not null default '{}'::jsonb,  -- e.g. ai: {default_provider, default_model,
                                                  -- routing_policy, fallback_chain[], streaming,
                                                  -- reasoning_visibility, context_budget_tokens}
  updated_at timestamptz not null default now(),
  updated_by_device uuid,
  schema_version int not null default 1,
  primary key (user_id, scope)
);
```
- **Access (RLS):** owner. **Realtime:** subscribe per scope so a change on Device A appears on Device B. **Notes:** machine-specific settings (font, GPU) are **not** synced (§55); provider/model ids are config, **never keys**.

### 43.4 `keybindings` (C3)
```sql
create table public.keybindings (
  user_id    uuid not null references auth.users(id) on delete cascade,
  profile_id text not null default 'default',
  base       text not null default 'axiom'
             check (base in ('axiom','vscode','jetbrains','vim','sublime','emacs','custom')),
  overrides  jsonb not null default '[]'::jsonb,   -- [{command, key, when?}]
  updated_at timestamptz not null default now(),
  updated_by_device uuid,
  schema_version int not null default 1,
  primary key (user_id, profile_id)
);
```

### 43.5 `prompts` — Prompt Library (C2)
```sql
create table public.prompts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text not null check (char_length(title) <= 200),
  body        text not null check (char_length(body)  <= 32768),
  tags        text[] not null default '{}',
  scope       text not null default 'global' check (scope in ('global','workspace')),
  variables   jsonb not null default '[]'::jsonb,  -- [{name, description?}]
  usage_count int  not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by_device uuid,
  schema_version int not null default 1
);
```
- **Notes:** user-authored text; size-capped by `CHECK`; may reference variables but **not** bulk code.

### 43.6 `rules` — Workspace / Coding Rules (C2)
```sql
create table public.rules (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  title         text not null,
  body          text not null check (char_length(body) <= 65536),
  scope         text not null default 'global' check (scope in ('global','workspace')),
  workspace_key text,                       -- salted hash when scope = 'workspace'
  enabled       boolean not null default true,
  priority      int not null default 100,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by_device uuid,
  schema_version int not null default 1
);
```
- **Notes:** guidance text (style guides, conventions). Size-capped. User-authored/opt-in.

### 43.7 `agents` — Custom Agent Definitions (C2)
```sql
create table public.agents (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  description   text,
  persona       text not null,
  allowed_tools text[] not null default '{}',
  model_routing jsonb  not null default '{}'::jsonb,  -- {provider, model, fallback[]}
  guardrails    jsonb  not null default '{}'::jsonb,  -- {max_steps, require_approval, file_scopes?}
  rule_bindings uuid[] not null default '{}',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by_device uuid,
  schema_version int not null default 1
);
```

### 43.8 `provider_configs` — Provider Config (C3, **never keys**)
```sql
create table public.provider_configs (
  user_id      uuid not null references auth.users(id) on delete cascade,
  provider_id  text not null,     -- openai|anthropic|google|openrouter|groq|deepseek|
                                  -- qwen|mistral|ollama|lmstudio|custom-*
  enabled      boolean not null default true,
  label        text,
  base_url     text,             -- custom/self-hosted/local endpoints
  key_ref      text not null,    -- ALIAS/handle into local SecretVault — NOT the key
  models       text[] not null default '{}',
  default_model text,
  headers      jsonb not null default '{}'::jsonb,  -- non-secret headers only
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  updated_by_device uuid,
  schema_version int not null default 1,
  primary key (user_id, provider_id),
  -- structural no-secret guard (defense in depth with the validate trigger, §47/§51)
  constraint no_secret_headers check (not (headers ? 'authorization' or headers ? 'api-key'))
);
```
- **Critical:** `key_ref` is an opaque alias resolved locally by `SecretVault`. The **actual API key is C0 and never leaves the device.** A `CHECK` constraint plus a `validate_provider_config` trigger reject any secret-shaped field (§47/§51).

### 43.9 `workspaces` — Workspace Metadata (C3, **no code**)
```sql
create table public.workspaces (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  display_name   text not null,
  path_hash      text not null,        -- salted hash of the local path (never the path)
  last_opened_at timestamptz,
  pinned         boolean not null default false,
  color          text,
  updated_at     timestamptz not null default now(),
  schema_version int not null default 1,
  constraint no_raw_path check (path_hash !~ '[/\\]')   -- reject anything path-like
);
```
- **Notes:** enables "recent workspaces" continuity across devices **without** exposing local paths (hashed) or any file contents.

### 43.10 `usage_daily` — Usage Aggregates (C5, opt-in; month-partitioned)
```sql
create table public.usage_daily (
  user_id     uuid not null references auth.users(id) on delete cascade,
  day         date not null,
  by_provider jsonb not null default '{}'::jsonb,  -- {provider: {requests, input_tokens,
                                                   -- output_tokens, cost_minor_units, currency}}
  ai_actions  jsonb not null default '{}'::jsonb,  -- {suggested, accepted, reverted}
  updated_at  timestamptz not null default now(),
  schema_version int not null default 1,
  primary key (user_id, day)
) partition by range (day);
```
- **Notes:** authoritative token/cost accounting is **local** (§54); this cloud copy exists only with cloud usage sync enabled. Month-partitioned; retention by partition drop (§59).

### 43.11 `cost_ledger` (C5, opt-in)
Monthly rollups derived from `usage_daily` (via the `aggregate_usage` job, §51) for the cost dashboard's cross-device view: `(user_id, period_month date, totals jsonb, currency text, updated_at timestamptz)`, primary key `(user_id, period_month)`.

### 43.12 `audit_events` — Cloud Audit Mirror (C5, opt-in; month-partitioned)
```sql
create table public.audit_events (
  id        bigint generated always as identity,
  user_id   uuid not null references auth.users(id) on delete cascade,
  type      text not null,
  ts        timestamptz not null default now(),
  device_id uuid,
  summary   text not null,
  schema_version int not null default 1,
  primary key (user_id, ts, id)
) partition by range (ts);
```
- **Notes:** the **local** hash-chained audit log (Part X) is authoritative and always present; this optional cloud mirror aids cross-device transparency. Never contains code or secrets.

### 43.13 `feedback` (C5)
```sql
create table public.feedback (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  category       text not null,
  message        text not null,
  app_version    text, os text,
  contact_opt_in boolean not null default false,
  diagnostics_path text,          -- Supabase Storage object path (opt-in bundle)
  created_at     timestamptz not null default now()
);
```

### 43.14 `config` — Public, Read-Only Config (RLS: `select` to all; writes service-role only)
- `app_config`: `{ min_supported_version, latest_version, update_feed_url, status_url, kill_switches jsonb, schema_version }` (single row).
- `model_catalog`: public metadata about known models (context window, modalities, pricing hints, capability descriptors) — used for cost estimation and capability gating without hardcoding.
- `provider_catalog`: known providers + default endpoints + capability descriptors.
- `announcements`: `{ id, title, body, level, starts_at, ends_at, targeting jsonb }`.
- `feature_flags`: `{ key, value jsonb, rollout_pct, targeting jsonb, variant, updated_at }` (§57).
- **Access:** `select` policy `using (true)` (no secrets); **client writes: never** — updated via migrations, the Supabase dashboard, or CI with the service role.

---

## 44. SUPABASE STORAGE MODEL

### 44.1 Bucket Layout
Buckets are **private** (no public URLs); access is via short-lived signed URLs or the authenticated API, gated by Storage RLS policies on `storage.objects`. Object paths are prefixed by `auth.uid()`.
```
supabase storage (private buckets)
├─ avatars/{user_id}/{file}.png          (C4, ≤ 2 MB, image/* only)
├─ backups/{user_id}/{backup_id}.json.gz (C3 settings/prefs export, ≤ 5 MB)
├─ diagnostics/{user_id}/{bundle_id}.zip (C5 opt-in, scrubbed, ≤ 25 MB, TTL 30d)
└─ (no code, ever)
```

### 44.2 Storage Policies (summary; full policies §46.3)
- Owner-only read/write: RLS on `storage.objects` requires `(storage.foldername(name))[1] = auth.uid()::text`.
- Per-bucket content-type and size limits (image/* for avatars; gzip/zip with caps for backups/diagnostics).
- Diagnostic bundles are TTL-expired by a `pg_cron` job; never contain secrets/code (scrubbed at creation, Part VI/X).

---

## 45. INDEXES

### 45.1 Primary Keys & Foreign-Key Indexes
Every table has a primary key (natural composite keys for `settings`, `device_sessions`, `keybindings`; `uuid` surrogate elsewhere). Foreign keys on `user_id` are **explicitly indexed** (Postgres does not auto-index FKs) so per-user queries and cascade deletes stay fast.

### 45.2 Secondary Indexes (representative)
```sql
create index on public.prompts (user_id, scope, updated_at desc);    -- library by scope, recent
create index on public.prompts using gin (tags);                     -- filter by tag
create index on public.rules   (user_id, scope, enabled, priority);  -- active rules ordered
create index on public.device_sessions (user_id, current, last_seen_at desc);
create index on public.usage_daily (user_id, day desc);
create index on public.audit_events (user_id, type, ts desc);
create index on public.workspaces (user_id, last_opened_at desc);
create index on public.profiles using gin (flags);                   -- JSONB flag lookups
```
Large free-text columns (`prompts.body`, `rules.body`, `agents.persona`) are **not** equality-indexed; if search is needed later, a `tsvector` + GIN full-text index is added by migration.

### 45.3 Retention (pg_cron + partition drop)
Retention is enforced by scheduled `pg_cron` jobs (no managed-TTL product needed): drop `usage_daily`/`audit_events` partitions older than the window (usage ~400d, audit ~180d); delete revoked `device_sessions` ~90d after `revoked_at`; Storage diagnostics purged at 30d. Partition drops are near-instant and reclaim space cleanly (§59).

---

## 46. SECURITY RULES

### 46.1 Principles
**RLS is enabled on every table** (default deny — a table with RLS enabled and no matching policy denies all). Access is **owner-scoped** via `auth.uid()`; writes are shape/size/field-validated by column types, `CHECK` constraints, and triggers (no-secret guard); public `config` tables are `select`-only to clients; destructive/atomic ops (account delete) run in **service-role Edge Functions** only. RLS is the **authoritative server-side gate** — the client is never trusted (defense in depth with Part III JWT validation).

### 46.2 Row Level Security Policies (representative)
```sql
-- Owner policies on a user-owned table (pattern repeated per table).
alter table public.prompts enable row level security;
create policy prompts_select on public.prompts for select
  using (user_id = auth.uid());
create policy prompts_insert on public.prompts for insert
  with check (user_id = auth.uid());
create policy prompts_update on public.prompts for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy prompts_delete on public.prompts for delete
  using (user_id = auth.uid());

-- profiles: owner select/update; NO delete policy (delete only via service-role fn).
alter table public.profiles enable row level security;
create policy profiles_select on public.profiles for select using (id = auth.uid());
create policy profiles_update on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

-- provider_configs: owner-scoped; no-secret guard = CHECK (§43.8) + validate trigger (§51).
alter table public.provider_configs enable row level security;
create policy provider_configs_rw on public.provider_configs for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- workspaces: owner-scoped; the no_raw_path CHECK (§43.9) forbids path-like values.
alter table public.workspaces enable row level security;
create policy workspaces_rw on public.workspaces for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- public config: readable by anyone (no secrets); no write policy → client writes denied
-- (the service role bypasses RLS for admin/CI/migration writes).
alter table config.feature_flags enable row level security;
create policy feature_flags_read on config.feature_flags for select using (true);
```

### 46.3 Storage Policies (representative)
```sql
-- Owner-only access to objects under their uid prefix (repeat per bucket).
create policy avatars_owner on storage.objects for all to authenticated
  using      (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
```
Per-bucket size/content-type limits are configured on the bucket (avatars: 2 MB, `image/*`; backups: 5 MB; diagnostics: 25 MB).

### 46.4 RLS & Policy Testing
RLS policies and constraints are unit-tested on the **Supabase CLI local stack** with **pgTAP** (positive + negative: cross-user access denied, oversize rejected via `CHECK`, secret-shaped fields rejected, path-like `workspaces` rejected, `config` client-write denied). Policy tests are a **CI gate** (Part XII) — no migration deploys if they fail.

---

## 47. DATA VALIDATION (DEFENSE IN DEPTH)

Four enforcement layers, all required:

1. **Client (renderer/Main):** typed models + schema validators (e.g., Zod-style) reject malformed data before write; user-friendly errors.
2. **Database constraints:** column types, `NOT NULL`, `CHECK` (sizes, enums, no-secret/no-path guards), `UNIQUE`, and foreign keys — the strongest, always-on gate.
3. **RLS policies:** authoritative owner-scoping on every row (§46); the client cannot read or write another user's data.
4. **Edge Functions / triggers:** for privileged/derived writes (aggregations, deletions, provider-config validation), service-role logic re-validates and enforces invariants a client could attempt to bypass.

**Schema versioning & migration:** the schema is versioned via **SQL migrations** (Supabase CLI); each row also carries `schema_version` so the client can adapt. Structural changes ship as ordered, reviewed migrations (Part II §24) applied in CI; large data backfills run as idempotent migration steps or a scheduled job. Newer-than-known row versions are treated read-only client-side with a prompt to update the app.

---

## 48. REALTIME REQUIREMENTS

### 48.1 Realtime Subscriptions (attach while relevant)
Supabase Realtime streams Postgres change events (`postgres_changes`), filtered by table + `user_id`:
- `profiles` (live entitlement/flag changes).
- `settings` (cross-device settings propagation).
- `device_sessions` (Devices UI + revocation).
- `config.app_config` + `config.announcements` + `config.feature_flags` (kill switches, min-version, messaging, flags).

### 48.2 Fetch-Once / On-Demand
- `prompts`, `rules`, `agents` (fetched on open; may add a subscription in library views).
- `usage_daily`, `cost_ledger`, `audit_events` (queried on dashboard open).

### 48.3 Subscription Lifecycle & Cost Management
Subscriptions open on view mount / relevance and **close on unmount** to bound connection/read cost. A `SubscriptionManager` centralizes lifecycle, dedupes overlapping channels, and throttles reattachment. The local SQLite mirror (§49/§50) serves cached data instantly while subscriptions re-sync. Realtime honors RLS — only owner-visible rows are delivered.

---

## 49. OFFLINE SYNCHRONIZATION

### 49.1 Local Mirror as the Offline Layer
Unlike a document store with built-in offline persistence, the Supabase/Postgres client is online-oriented — so **the local SQLite mirror (§50) is Axiom's offline layer**. Synced rows are cached locally; reads always succeed offline from the mirror, and writes are enqueued locally and flushed on reconnect. This underpins Principle 4.11 for cloud data (editing/AI already work offline independently).

### 49.2 Sync Engine Design
A `SyncService` (behind `ISyncService`) coordinates: which tables sync, subscription lifecycle, conflict resolution, and the **SQLite mirror** for instant startup and cross-restart continuity. Sync uses `updated_at` high-water marks (pull changes since last sync) plus Realtime for live deltas. Sync is **opt-in** (tied to sign-in + sync toggle) and applies only to C2/C3 data.

### 49.3 Conflict Resolution
- **Preferences/settings (C3):** last-writer-wins by server `updated_at`, with `updated_by_device` shown in UI ("changed on Device X"). Structured merges for additive JSONB maps where safe (e.g., keybinding overrides merge by command key).
- **User artifacts (C2 — prompts/rules/agents):** LWW per row; a lightweight **version history** (recent N revisions) makes an accidental overwrite recoverable. Deletions are soft (a `deleted_at` tombstone) then hard-deleted by retention.
- **Concurrent edits, two offline devices:** on reconnect, the later server write wins; the losing edit is preserved in local history and surfaced as "a newer version exists — view diff?" rather than silently lost.

### 49.4 Queued Writes & Ordering
Offline writes queue in the local mirror with causal ordering per row; the flush is idempotent (upsert by primary key, safe to replay) and reconciles server timestamps on flush. Large backlogs flush with backoff.

---

## 50. CACHING STRATEGY

### 50.1 Layers
1. **SQLite local mirror** — the durable, primary cache of synced C2/C3 rows for instant cold-start reads and offline browsing, keyed by table + primary key + `updated_at`.
2. **In-memory query cache** — short-lived cache of recent reads in Main.
3. **Feature-flag cache** — `config.feature_flags` cached with a fetch cadence + compiled defaults (§57).
4. **Model/provider catalog cache** — `config.model_catalog` cached with TTL for cost estimation offline.

### 50.2 Invalidation & Consistency
Write-through on local mutations (update SQLite mirror + Postgres via PostgREST); Realtime reconciles the mirror on server changes (upsert/delete by primary key). Each cached row stores `updated_at` + `schema_version`; stale/version-mismatched entries are refreshed or migrated. A cache-buster clears mirrors on major schema bumps.

---

## 51. EDGE FUNCTIONS & DATABASE FUNCTIONS (BACKEND LOGIC)

### 51.1 Edge Function & Database-Function Catalog
| Function | Type | Purpose |
|---|---|---|
| `delete_account` | Edge (service role) | Re-auth-guarded fan-out deletion: delete `profiles` row (FKs cascade), Storage objects, then `auth.admin.deleteUser` (Part III §32.4) |
| `aggregate_usage` | `pg_cron` + SQL | Roll `usage_daily` → `cost_ledger`; compute anomalies |
| `ttl_cleanup` | `pg_cron` + SQL | Drop old partitions; purge revoked sessions + expired diagnostics (§59) |
| `on_auth_user_created` | Postgres trigger on `auth.users` | Initialize `profiles` row + defaults |
| `on_feedback_insert` | Edge (DB webhook) | Route feedback, attach diagnostics ref, notify support queue |
| `validate_provider_config` | Postgres `before insert/update` trigger | Re-assert the no-secret invariant on `provider_configs` |
| `ingest_telemetry` / `ingest_crash` | Edge (public, rate-limited) | Validated ingestion of opt-in telemetry/crash events → Postgres (or forward to PostHog/Sentry) |
| `mint_signed_url` | Edge (service role) | Issue short-lived signed URLs for Storage objects when needed |

### 51.2 Function Standards
- **Idempotent** (safe retries), **least-privileged** (the service-role key lives only inside Edge Functions, never shipped to the client), **input-validated**, **rate-limited** (per-IP/per-user on public ingestion + signed-URL functions), and **structured-logged** with correlation ids. No function ever accepts or stores C0/C1 data. Prefer **Postgres triggers/functions** for data-local logic (cascades, validation, aggregation) and **Edge Functions** for external I/O and privileged admin actions.

---

## 52. ANALYTICS (PRODUCT)

### 52.1 Platform & Consent
Product analytics are **strictly opt-in** and gated by the telemetry consent (Part III/VI). Disabled = zero analytics network calls. The default sink is an **`ingest_telemetry` Edge Function → Postgres `analytics_events`** pipeline; a self-hostable **PostHog** can be plugged in behind the sink abstraction. No managed Google Analytics dependency.

### 52.2 Event Taxonomy (representative; **no PII, no code**)
```
app_start { cold_ms, restored_workspace: bool }
signin { method, latency_ms, success }
provider_added { provider }            // provider name only, never key
ai_action { kind: chat|inline|multi_file|refactor|test|review,
            provider, model, accepted: bool, tokens_bucketed }
agent_run { steps_bucketed, outcome: completed|interrupted|failed }
diff_review { hunks, accepted, rejected }
snapshot_restore { }
search { kind: text|semantic, latency_ms_bucketed }
error { category, code }               // no messages with user content
feature_flag_exposure { flag, variant }
```
- Numeric values are **bucketed** to prevent fingerprinting; user identifiers are at most a hashed uid; free-text is never sent.

### 52.3 Governance
An **event schema registry** (versioned) prevents ad-hoc event sprawl; new events require review. Data-minimization and consent are audited (Part X).

---

## 53. TELEMETRY (PRODUCT & PERFORMANCE PIPELINE)

- **Local-first buffer:** metrics/events written to a local SQLite queue first (works offline).
- **Batch upload:** periodic, compressed, backoff-aware uploads (only if consented); failures retry without data loss up to a cap, then drop-oldest.
- **Sampling:** high-frequency perf metrics are sampled (e.g., keystroke latency histograms aggregated locally, uploaded as summaries — never raw keystrokes).
- **Metric types:** timers (cold start, TTI, index throughput, refresh latency), counters (AI actions, accepts, reverts, crashes), gauges (memory, process health).
- **Kill switch:** telemetry can be remotely disabled via the `feature_flags` table (Realtime-propagated) in case of incident.
- **Separation:** performance telemetry and product analytics share the consent gate but are logically distinct pipelines with distinct schemas.

---

## 54. USAGE TRACKING & COST/TOKEN ACCOUNTING

### 54.1 Local-First & Authoritative
Every AI request's token counts (input/output/reasoning), model, provider, and computed cost (from `modelCatalog` pricing) are recorded **locally** in SQLite — the authoritative ledger. This works fully offline and never depends on the cloud (sovereignty).

### 54.2 Cost Computation
Cost = tokens × per-token price (from `config/modelCatalog`, with user-overridable pricing for custom/self-hosted endpoints), stored as integer minor units + currency. Estimates are shown *before* expensive actions; actuals reconcile after responses. Target accuracy within ±5% of provider billing (Part I §9.7).

### 54.3 Optional Cloud Aggregates
If the user enables cloud usage sync, daily aggregates roll up to `usageDaily`/`costLedger` for a cross-device dashboard. Raw per-request records **never** leave the device.

### 54.4 Budgets & Alerts
Users can set spend budgets/alerts (per provider, per day/month). On threshold, Axiom warns and can require confirmation or switch routing to cheaper models (Part V). All enforced locally.

---

## 55. USER PREFERENCES & SETTINGS SYNC

### 55.1 Settings Scopes & Precedence
`default (shipped) < user (synced) < workspace (per-project) < machine (local-only)`. Machine-local settings (font, GPU flags, hardware-specific) **never sync**. User + workspace-rule + prompt-library data sync (C2/C3).

### 55.2 Sync Mechanics
Settings sync uses per-scope rows (§43.3) with Realtime subscriptions; changes propagate near-instantly across signed-in devices. Merge/conflict per §49.3. Sensitive/machine values are excluded by an allow-list at write time.

### 55.3 Import/Export & Migration
- **Import from VS Code/Cursor:** a mapper imports settings/keybindings/themes where equivalent (Part IX onboarding).
- **Export/backup:** on-demand gzip backup to Supabase Storage; restore recreates settings rows.
- **Reset:** granular reset per scope to shipped defaults, with a pre-reset backup.

---

## 56. LOGS & AUDIT HISTORY

### 56.1 Local Audit Log (Authoritative)
A tamper-evident (append-only, hash-chained) **local** audit log records security- and trust-relevant events: sign-in/out, device revocation, provider config changes, AI edits applied, snapshots created/restored, secret access, settings resets, account deletion. Stored in SQLite; viewable/exportable by the user (transparency). **Never contains secrets or full code** — edits are referenced by file + snapshot id, not content.

### 56.2 Optional Cloud Audit Mirror
If enabled, summarized audit events sync to the `audit_events` table for cross-device visibility (C5, retention-bounded). The local log remains the source of truth.

### 56.3 Application Logs
Structured rotating logs (Part II §23) live locally; included (scrubbed) in the diagnostics bundle on user request. Not uploaded automatically.

---

## 57. FEATURE FLAGS (REMOTE CONFIG REPLACEMENT)

Supabase has no managed Remote Config, so feature flags/remote config are a first-party construct: a `config.feature_flags` table (readable by all, service-role writes only) propagated via **Supabase Realtime**, read through a single `IFeatureFlags` service with compiled fail-safe defaults.

### 57.1 Purpose
Decouple release from exposure: dark-launch features, staged rollout %, A/B experiments, per-user/segment targeting, and **kill switches** for incident response — all without shipping a new build.

### 57.2 Parameters (representative)
```
feature.agents.parallel            = bool   (rollout %)
feature.semanticSearch             = bool
feature.providers.<name>.enabled   = bool
ai.default.contextBudgetTokens     = int
telemetry.enabled.master           = bool   (kill switch)
update.minSupportedVersion         = string
experiment.diffReview.variant      = enum
```

### 57.3 Targeting & Rollout
Targeting by app version, OS, locale, random bucket (percentage rollout), and user flags/entitlements. Experiment exposures are logged (`feature_flag_exposure`) for analysis. Rollbacks are instant (set flag to off/kill switch).

### 57.4 Client Behavior
- **Fetch cadence:** on startup + periodic + on foreground; the `feature_flags` table is read (and optionally subscribed via Realtime) and cached locally with sane **defaults compiled into the app** so the product works before first fetch and offline.
- **Fail-safe defaults:** if the backend is unreachable, cached/last-known or built-in defaults apply; no feature ever *requires* a successful fetch to keep the editor usable.
- **Consistency:** flags are read through a single `IFeatureFlags` service; no scattered fetches. Variants are stable per user/session.

---

## 58. CRASH REPORTING

### 58.1 Pipeline
Crash and non-fatal error reporting is **opt-in**. The default sink is an **`ingest_crash` Edge Function → Postgres `crash_reports`** table; a self-hostable **Sentry** can be plugged in behind the sink abstraction for grouping/symbolication. Symbol maps are uploaded in CI (Part VI/XII). Each report includes app version, OS, a redacted breadcrumb trail, and a correlation id.

### 58.2 Local Crash Journal (Always On)
Independent of telemetry consent, a **local** crash/recovery journal is always kept so the app can restore state after a crash (INV-5, Part VI). This is local-only and never uploaded unless the user sends a diagnostics bundle.

### 58.3 PII / Secret Scrubbing
Breadcrumbs and logs are scrubbed of file contents, secrets, tokens, prompts, and user code **before** any upload; scrubbing is applied at the sink and covered by tests. Stack traces contain symbols/paths within the app, not user data.

### 58.4 Triage
Crashes group by signature; release dashboards track crash-free session/user rates against SLOs (Part I §9.6, Part XI). Regressions can trigger a kill switch or a staged-rollout halt.

---

## 59. DATA LIFECYCLE, RETENTION & DELETION

- **Retention:** usage aggregates ~400d, cloud audit ~180d, revoked sessions ~90d, diagnostics 30d, feedback per policy; enforced via `pg_cron` (`ttl_cleanup`) + monthly **partition drops** and Storage lifecycle purges.
- **Deletion cascade:** `delete_account` deletes the root `profiles` row — `ON DELETE CASCADE` foreign keys fan out to every child table — plus Storage objects and the `auth.users` record; verified by post-deletion checks; audit entry recorded; tombstone honored during the grace window.
- **Backups:** managed Postgres backups + **Point-in-Time Recovery** and Storage backups for disaster recovery of C2–C5 data (no code to lose). Restore runbooks in Part XII/VI.
- **Data minimization:** everything defaults to the least data for the shortest time; opt-in for anything beyond core function.

---

## 60. BACKEND SCALABILITY, COST & RELIABILITY

- **Hotspot avoidance:** month-partitioned append tables, normalized per-scope rows, `uuid` keys, and indexed foreign keys to avoid sequential-write hotspots.
- **Connection management:** the Main process holds a small pooled client; **Supavisor/PgBouncer** connection pooling absorbs bursts; heavy reads come from the SQLite mirror, not the backend.
- **Cost controls:** subscription lifecycle discipline (§48.3), `pg_cron` cleanup, no equality indexes on large text, batched telemetry, and "no code in cloud" keeping volume tiny.
- **Scaling headroom (Post-1.0):** Postgres **read replicas** for read-heavy analytics, partitioning already in place, vertical scaling, and self-hosting for dedicated capacity.
- **Quotas & monitoring:** budgets/alerts on database size, Edge Function invocations, egress, and Realtime connections; dashboards + alerting on error rates and latency; SLOs for auth (token exchange/refresh p95), sync propagation, and function success.
- **Reliability:** idempotent functions, retries with backoff, client-side circuit-breaking (Part II §20.4), graceful degradation when the backend is down (local-first keeps the app fully usable).
- **Backend swappability:** all cloud access is behind `IBackendService`/`IAuthService`/`ISyncService`; because Supabase is standard Postgres and self-hostable, migrating to self-hosted/region-pinned Supabase (or another Postgres backend) does not touch feature code.

---

## 61. BACKEND SECURITY & COMPLIANCE

- **Authoritative RLS** (§46) + independent JWT validation (Part III) = defense in depth; the client is never trusted.
- **No attestation product:** Supabase has no App Check equivalent, and **desktop attestation is inherently weak** on any platform; we compensate with RLS, per-IP/per-user **Edge Function rate limiting** on sensitive endpoints, and anomaly detection rather than relying on attestation. *(Stated as a known limitation, not glossed over.)*
- **Encryption:** TLS in transit; Postgres + Storage encrypted at rest; C0 secrets never reach the cloud (local DPAPI / OS secure store).
- **No-secret / no-code invariants** enforced structurally (RLS + `CHECK` constraints + validation triggers + schema allow-lists), not merely by policy.
- **Least privilege:** the service-role key lives only inside Edge Functions; clients use the anon key + user JWT under RLS; public config is `select`-only and non-secret.
- **Compliance readiness:** data-minimization, consent gating, export + erasure flows, retention/partition-drop, audit logging, and documented data-flow diagrams position Axiom for GDPR/CCPA now and SOC 2 / ISO 27001 Post-1.0. Supabase itself offers SOC 2 (and HIPAA on higher tiers) and is self-hostable for orgs needing full control (full treatment in Part X).
- **CI gates:** pgTAP RLS/policy tests on the Supabase local stack + Edge Function unit/integration tests must pass before a migration deploys (Part XII).

---

*End of Part IV — Data & Backend (Supabase).*


---

# PART V — AI SYSTEM (THE ENGINE)

> **Purpose of this Part.** Part V specifies the **AI engine** — the provider-agnostic infrastructure that powers every AI capability. It is deliberately separated from **Part VIII (AI Features)**, which specifies the user-facing experiences (chat, inline, agents-as-products, review, tests). Part V answers: how does a request to *any* model — cloud or local — get normalized, routed, budgeted, streamed, retried, failed-over, costed, cached, remembered, and orchestrated into multi-step agentic work? It obeys the Part II invariants absolutely: single egress (INV-2), secrets in Main only (INV-3), no user code to Axiom cloud (INV-4), UI never blocks (INV-1), capability gating (INV-8). This is the beating heart of Axiom's sovereignty promise: **the user's code and prompts flow only to the user's chosen endpoint.**

---

## 62. AI ENGINE OVERVIEW & PRINCIPLES

### 62.1 Engine vs. Features

The **engine** (Part V) is the plumbing: providers, protocol, routing, context, memory, orchestration runtime, cost, caching, failover. The **features** (Part VIII) are the products built on it. This separation means a new feature (say, a "migration agent") is a thin composition over the engine, and a new provider benefits every feature at once.

### 62.2 Design Goals

- **AI-G1.** One normalized internal protocol so every feature is provider-agnostic.
- **AI-G2.** Support all listed providers + any OpenAI-compatible/custom/self-hosted/local endpoint via a uniform adapter contract.
- **AI-G3.** Streaming-first, cancellable, reasoning-aware, tool-capable.
- **AI-G4.** Deterministic context assembly within precise token budgets, grounded by the on-device index.
- **AI-G5.** Robust agentic runtime: multi-step, parallel, background, resumable, guard-railed.
- **AI-G6.** Smart routing + fallback/failover across providers with full transparency.
- **AI-G7.** Precise local cost/token accounting and caching.
- **AI-G8.** Safe by default: secret redaction, prompt-injection defense, tool sandboxing, grounding.

### 62.3 Engine Principles

1. **Provider-agnostic core, provider-specific edges.** All vendor quirks are confined to adapters; the core speaks only the internal protocol.
2. **Capability-based, never hard-coded.** Features query capabilities (vision? tools? reasoning? streaming? prompt-cache?) rather than branching on model names (INV-8).
3. **Sovereignty first.** Egress destinations are the user's configured endpoints; local models mean **zero** egress. Retrieval happens on-device.
4. **Transparency & control.** Every turn exposes model, tokens, cost, latency, and (optionally) reasoning; every agentic action is inspectable and reversible.
5. **Fail soft.** Provider/model failure degrades (failover → cheaper → local → informative error), never a dead-end crash.
6. **Bounded & cancellable.** Every operation has token/step/time budgets and honors instant cancellation end-to-end.

### 62.4 High-Level Architecture

```
Features (Part VIII)  ── request ─▶  ┌───────────────────────────────┐
                                     │      AI ORCHESTRATOR (Node)   │
                                     │  ┌────────────┐ ┌───────────┐ │
   on-device Index/Symbols ◀──────── │  │ContextBuild│ │AgentRuntime│ │
   (Rust Core, Part II)              │  └────────────┘ └───────────┘ │
                                     │  ┌────────────┐ ┌───────────┐ │
                                     │  │PromptMgr   │ │ToolExecutor│ │
                                     │  └────────────┘ └───────────┘ │
                                     │  ┌────────────┐ ┌───────────┐ │
                                     │  │ModelRouter │ │ CostMeter │ │
                                     │  └─────┬──────┘ └───────────┘ │
                                     │  ┌─────▼──────────────────────┐│
                                     │  │ ProviderRegistry (adapters) ││
                                     │  └─────┬──────────────────────┘│
                                     └────────┼───────────────────────┘
                                              │ internal protocol
                                     ┌────────▼───────────┐  (secrets injected here)
                                     │  EGRESS GATEWAY     │  INV-2 / INV-3
                                     │  (Main process)     │
                                     └───┬─────────┬───────┘
                        cloud providers  │         │  local providers (no egress)
                     OpenAI/Anthropic/…  ▼         ▼  Ollama / LM Studio
```

---

## 63. THE INTERNAL AI PROTOCOL (NORMALIZATION LAYER)

### 63.1 Why a Normalized Protocol

Providers differ in endpoints, message shapes, tool schemas, streaming formats, reasoning representations, and error codes. Axiom defines **one internal protocol**; adapters translate to/from it. Benefits: features write once; new providers plug in; routing/failover across heterogeneous providers is trivial; testing uses recorded protocol fixtures.

### 63.2 Unified Request Model
```ts
interface AiRequest {
  requestId: string;
  model: ModelRef;                 // resolved by router (provider + model id)
  messages: AiMessage[];           // normalized conversation
  system?: ContentPart[];          // normalized system instructions
  tools?: ToolSpec[];              // normalized tool/function declarations
  toolChoice?: "auto"|"none"|"required"|{name:string};
  params: {
    temperature?: number; topP?: number; maxOutputTokens?: number;
    stop?: string[]; seed?: number;
    reasoning?: { enabled: boolean; effort?: "low"|"medium"|"high";
                  budgetTokens?: number; visibility: "hidden"|"summary"|"full" };
    responseFormat?: "text"|"json"|{ schema: JSONSchema };
    cache?: { enabled: boolean; segments?: CacheSegment[] };
  };
  budget: { maxTokens?: number; maxCostMinorUnits?: number };
  cancellation: CancellationToken;
  metadata: { feature: string; workspaceId?: string; agentRunId?: string };
}
```

### 63.3 Unified Response / Stream Model
```ts
type AiStreamEvent =
  | { type:"start"; model:ModelRef }
  | { type:"reasoning.delta"; text:string }        // if reasoning visible
  | { type:"text.delta"; text:string }
  | { type:"tool_call.delta"; id:string; name?:string; argsChunk:string }
  | { type:"tool_call.complete"; id:string; name:string; args:unknown }
  | { type:"usage"; inputTokens:number; outputTokens:number;
                    reasoningTokens?:number; cachedInputTokens?:number }
  | { type:"finish"; reason:"stop"|"length"|"tool_calls"|"content_filter"|"error" }
  | { type:"error"; error:AiError };
```

### 63.4 Content Parts (Multimodal-Ready)
`ContentPart = TextPart | ImagePart | FilePart | ToolResultPart | ReasoningPart`. Text is primary; image/file parts are gated by model vision/file capabilities (INV-8); reasoning parts carry model thinking when visible. This shape absorbs future modalities (audio, video) without protocol breakage.

### 63.5 Tool / Function Calling Normalization
Tools are declared once as `ToolSpec { name, description, parameters: JSONSchema }`. Adapters map to each vendor's function/tool schema (OpenAI `tools`, Anthropic `tools`/`tool_use`, Gemini `functionDeclarations`). Tool *calls* stream as deltas then complete; tool *results* are fed back as `ToolResultPart`. The **same tool** works across every tool-capable provider.

### 63.6 Capability Descriptors
Each resolved model exposes:
```ts
interface ModelCapabilities {
  streaming:boolean; tools:boolean; parallelToolCalls:boolean;
  vision:boolean; fileInput:boolean; json:boolean; jsonSchema:boolean;
  reasoning:"none"|"builtin"|"budgeted"|"effort";
  promptCache:"none"|"auto"|"explicit";
  maxContextTokens:number; maxOutputTokens:number;
  systemPrompt:"separate"|"inline";
}
```
Features consult these; unsupported requests are adapted (e.g., JSON-schema emulated via prompt) or gracefully refused with a clear reason.

### 63.7 Error Normalization
Provider errors map to a stable taxonomy: `Auth`, `RateLimit`(+retryAfter), `Quota`, `Timeout`, `ContextOverflow`, `ContentFilter`, `InvalidRequest`, `ServerError`, `NetworkError`, `Canceled`, `Unsupported`. This drives uniform retry, failover, and UX (Part IX) regardless of vendor wording.

---

## 64. PROVIDER ABSTRACTION & ADAPTER CONTRACT

### 64.1 `IProviderAdapter`
```ts
interface IProviderAdapter {
  id: string; family: "openai-compatible"|"anthropic"|"google"|"ollama"|"custom";
  describe(): ProviderDescriptor;
  listModels(config: ProviderConfig): Promise<ModelDescriptor[]>;     // dynamic discovery
  capabilitiesFor(modelId: string): ModelCapabilities;
  chat(req: AiRequest, ctx: AdapterContext): AsyncIterable<AiStreamEvent>;
  embed?(input: string[], model: string): Promise<number[][]>;        // if supported
  countTokens?(req: AiRequest): Promise<number>;                      // native or fallback
  healthCheck(config: ProviderConfig): Promise<HealthResult>;
}
```
`AdapterContext` provides the credential *handle* (resolved by Main), the HTTP client (egress gateway), and a cancellation token. **The adapter never sees the raw key directly; the gateway injects it at send time** (INV-3).

### 64.2 Adapter Responsibilities
Translate request→vendor payload; parse vendor stream→`AiStreamEvent`; map errors→taxonomy; report usage; declare capabilities; discover models; support prompt-cache directives where available. Adapters are pure translation — no business logic, no routing, no persistence.

### 64.3 Lifecycle & Registration
Adapters register via the contribution model (Part II §17.3). Built-ins ship with the app; third-party/enterprise adapters install via the Provider Plugin SDK (Part II §19.4). The `ProviderRegistry` resolves `ModelRef → adapter + config`.

### 64.4 Per-Provider Specifics (1.0 Coverage)

| Provider | API family | Auth | Stream | Tools | Reasoning | Prompt cache | Local | Notes |
|---|---|---|---|---|---|---|---|---|
| **OpenAI** | Responses/Chat Completions | API key | SSE | ✅ (parallel) | effort (o-series) | auto | ❌ | vision, JSON schema |
| **Anthropic** | Messages | API key | SSE | ✅ | budgeted (extended thinking) | explicit (`cache_control`) | ❌ | separate system, vision |
| **Google Gemini** | generateContent/stream | API key | SSE | ✅ (functionDeclarations) | builtin/budgeted (2.5) | (varies) | ❌ | safety settings, vision |
| **OpenRouter** | OpenAI-compatible aggregator | API key | SSE | ✅ (model-dependent) | passthrough | passthrough | ❌ | one key → many models |
| **Groq** | OpenAI-compatible | API key | SSE | ✅ (subset) | model-dependent | — | ❌ | very low latency (LPU) |
| **DeepSeek** | OpenAI-compatible | API key | SSE | ✅ | R1 reasoning | — | ❌ | strong价/perf |
| **Qwen** | OpenAI-compatible / DashScope | API key | SSE | ✅ | some models | — | ❌ | multilingual |
| **Mistral** | Mistral (OpenAI-ish) | API key | SSE | ✅ | — | — | ❌ | function calling |
| **Ollama** | Ollama native + OpenAI-compat `/v1` | none (local) | stream | ✅ (subset) | model-dependent | — | ✅ | pull/list local models, **zero egress** |
| **LM Studio** | OpenAI-compatible local server | none (local) | SSE | ✅ (subset) | model-dependent | — | ✅ | local base URL, **zero egress** |
| **Custom / OpenAI-compatible** | configurable | key/none | SSE | capability-detected | detected | detected | maybe | any base URL / self-hosted gateway |

Because most providers are **OpenAI-compatible**, a single robust `OpenAiCompatibleAdapter` (parameterized by base URL, auth, and a capability profile) covers OpenRouter, Groq, DeepSeek, Qwen, Mistral, LM Studio, and arbitrary custom endpoints. Anthropic, Google, and Ollama-native get dedicated adapters. This keeps maintenance small while coverage is broad.

### 64.5 Custom / Self-Hosted Provider Onboarding
A guided "Add custom provider" flow captures: base URL, auth scheme (bearer/header/none), model list (fetched or manual), and a capability profile (auto-probed via a test call, user-adjustable). This lets enterprises point Axiom at an internal gateway (e.g., a corporate LLM proxy) — sovereignty for orgs, not just individuals.

---

## 65. MODEL REGISTRY & CATALOG

### 65.1 Model Metadata
The registry merges: **shipped defaults**, **`config/modelCatalog`** (Part IV, public metadata: context window, modalities, pricing hints, capabilities), and **live discovery** (`listModels`). Each entry: `{ provider, modelId, displayName, capabilities, contextWindow, pricing, tags }`.

### 65.2 Capability Detection & Gating
Capabilities come from catalog metadata, adapter declarations, and probe results. Features gate on capabilities (INV-8), so enabling a new model "just works" if its capabilities are known; unknown endpoints are probed and conservatively defaulted.

### 65.3 Dynamic Discovery
For providers that expose model lists (OpenAI, OpenRouter, Ollama, LM Studio, custom), Axiom fetches available models live so newly released models appear without an app update. Manual add is available where discovery is absent.

### 65.4 Model Aliases & Profiles
Users define **task profiles** (`autocomplete`, `chat`, `planning`, `refactor`, `review`, `embeddings`) each mapping to a preferred model + fallback chain. Aliases (e.g., "fast", "smart", "cheap") decouple intent from a specific model so routing policies remain stable as models change.

### 65.5 Local Model Discovery
Ollama/LM Studio are auto-detected on their default local ports; installed models are listed; pull/manage actions surface for Ollama. Local models are first-class (offline, zero egress, zero cost) and preferred by privacy-oriented routing policies.

---

## 66. CREDENTIALS & KEY MANAGEMENT (AI-SPECIFIC)

### 66.1 BYOK Storage
API keys are **C0 secrets**: stored only in the OS secure store via `SecretVault`, referenced everywhere else by an opaque `keyRef` alias (Part IV §43.8). The renderer, Postgres, logs, telemetry, and adapters never see raw keys (INV-3). Keys are injected into requests **inside the Main-process egress gateway** at send time.

### 66.2 Validation & Health Checks
On add/edit, Axiom runs a lightweight `healthCheck` (cheap models list or a tiny completion) to confirm the key works and to probe capabilities, showing clear success/failure. Periodic background health checks flag revoked/expired keys before a user hits an error mid-task.

### 66.3 Multiple Keys & Rotation
Users can store multiple keys per provider (e.g., work vs. personal, or a rotation pool). Rotation replaces a key atomically in `SecretVault`; in-flight requests finish on the old key, new ones use the new key. Optional per-key labels and spend attribution.

### 66.4 Organization / Shared Keys (Directional)
Post-1.0: an enterprise key gateway (self-hosted, custom provider) or org-managed keys distributed via policy — enabling BYOK at the org level without exposing keys to individuals. The abstraction (keyRef + adapter) already supports this.

### 66.5 Zero Exposure Guarantees
Keys are never written to Postgres/Storage, never in analytics, never in crash reports/diagnostics (scrubbed by construction), never logged (redaction at sink), and never sent to any endpoint other than the provider that key belongs to (egress allow-list). This is monitored as a hard invariant (Part X).

---

## 67. STREAMING ARCHITECTURE

### 67.1 Streaming-First
All chat/agent inference streams by default (where the model supports it) for responsiveness and cancellability. Non-streaming providers are wrapped to emit a single terminal event.

### 67.2 Normalization
Adapters parse vendor SSE/stream formats into `AiStreamEvent`s (§63.3). The engine relays them over the streaming IPC channel (Part II §14.4) to the renderer, coalescing text deltas to ≤ 60 fps to avoid flooding the UI (INV-1).

### 67.3 Partial Content, Tool & Reasoning Streaming
Text deltas render live; **tool-call arguments** stream and assemble incrementally so the UI can show "calling tool X…" early; **reasoning deltas** stream when visibility permits (§68). Interleaving (text ↔ tool calls ↔ reasoning) is preserved in order.

### 67.4 Cancellation & Interruption
A single "Stop" cancels end-to-end: renderer → orchestrator → egress → aborts the HTTP stream; partial output is retained and clearly marked incomplete. Cancellation is instant and always available during any AI operation.

### 67.5 Back-Pressure & Cadence
Windowed flow control (Part II §14.5) prevents a slow renderer from ballooning memory in Main. Extremely fast providers (e.g., Groq) are throttled to display cadence while full tokens are captured for accounting.

---

## 68. REASONING MODELS SUPPORT

### 68.1 The Reasoning Abstraction
Reasoning is normalized across families that express it differently — OpenAI o-series (`reasoning_effort`), Anthropic extended thinking (thinking token budget), Gemini 2.5 thinking, DeepSeek-R1, Qwen reasoning. The engine models it as `reasoning: { enabled, effort?, budgetTokens?, visibility }` and adapters map to each vendor.

### 68.2 Visibility Modes
- **Hidden:** reasoning consumed for quality but not shown (still counted for cost).
- **Summary:** a condensed rationale is shown.
- **Full:** the reasoning stream is displayed live (great for "thinking mode," Part VIII).
User- and feature-configurable; some providers only expose summaries — capability-gated.

### 68.3 Effort / Budget Control
Users/features tune reasoning depth (higher effort for planning/architecture; low/off for autocomplete) balancing quality vs. cost/latency. The router can auto-tune effort per task profile.

### 68.4 Cost Implications
Reasoning tokens are counted separately (`reasoningTokens`) and included in cost estimates and the ledger (Part IV §54), so users see the true price of "thinking."

### 68.5 Consistency
Where a provider lacks native reasoning, Axiom can optionally emulate a lightweight "plan-then-answer" prompt scaffold, clearly labeled as emulated, never conflated with native reasoning.

---

## 69. CONTEXT MANAGEMENT ENGINE

### 69.1 Token Budgeting
Every turn has a computed budget: `min(model.maxContextTokens, user.contextBudget) − reserved(output + safety margin)`. The `ContextBuilder` fills the remaining budget by priority, never overflowing (prevents `ContextOverflow` errors proactively).

### 69.2 Assembly Pipeline
```
gather → score/prioritize → dedupe → compress → order → budget-fit → freeze
```
Sources (see §69.4) are gathered, scored for relevance, deduped, optionally compressed/summarized, ordered for optimal attention (system + rules first, most-relevant context near the query), fit to budget, and frozen with a manifest (what was included) for transparency and caching.

### 69.3 RAG Integration (On-Device)
Retrieval queries the **on-device** index (Rust Core, Part II §12.9): semantic (vector) + lexical (ripgrep) + symbolic (symbol graph) hybrid search returns top-k code chunks with file/line provenance. **Code never leaves the machine for retrieval**; only the finally-selected context is sent to the user's chosen provider as part of the prompt.

### 69.4 Context Sources & Prioritization
Ordered by typical priority (feature-tunable): system prompt + safety → workspace rules (Part VIII) → explicit user attachments (@file, selection) → open/active files → retrieved semantic chunks → symbol/dependency context → recent edits/diffs → conversation memory → repo map. Each source has a max share of the budget to avoid any one crowding out others.

### 69.5 Truncation & Compression
When over budget: drop lowest-priority first; summarize long files/conversations (hierarchical summarization); use symbol skeletons instead of full files; window large files around relevant ranges. All lossy steps are visible in the context manifest.

### 69.6 Prompt / Context Caching
Where providers support prompt caching (Anthropic explicit `cache_control`, OpenAI automatic, others), the builder segments the prompt into a **stable prefix** (system + rules + pinned context) and a **volatile suffix** (the turn), maximizing cache hits to cut cost and latency dramatically on multi-turn/agent loops. Cached-input tokens are tracked separately in accounting.

### 69.7 Token Counting
Per-provider tokenizers (native `countTokens` where available; local tokenizer approximations otherwise, e.g., tiktoken-family via WASM) produce accurate pre-flight counts for budgeting and cost estimation. Counting runs off the UI thread.

---

## 70. MEMORY SYSTEM

### 70.1 Memory Tiers
- **Turn/Conversation memory:** the running dialog (bounded, summarized as it grows).
- **Session memory:** facts within the current working session (open task, decisions).
- **Workspace memory:** durable, per-project knowledge (conventions learned, key files, past decisions) — stored locally per workspace.
- **Agent memory:** an agent's scratchpad/plan/observations during a run (event-sourced, Part II §16.5).
- **Long-term/user memory:** cross-workspace preferences and learned user style (opt-in), stored locally.

### 70.2 Storage
All memory is **local** (SQLite + on-device vectors); optional cross-device sync applies only to small, user-authored memory (like rules/prompts, C2) — never code or raw context. Memory retrieval uses the same hybrid search as RAG.

### 70.3 Retrieval & Injection
Relevant memories are retrieved and injected into context by the builder with their own budget share and clear provenance, so the model benefits from continuity without unbounded prompt growth.

### 70.4 Editing & Forgetting
Users can view, edit, pin, and delete memories ("forget this"). Memory has TTLs and size caps; stale/low-value memories are pruned. This keeps memory trustworthy and privacy-respecting.

### 70.5 Privacy
Because memory can capture sensitive project details, it is local by default, encrypted at rest with other app data, excluded from telemetry/diagnostics, and fully user-inspectable/erasable.

---

## 71. PROMPT MANAGEMENT

### 71.1 System Prompt Architecture
Layered system prompts: **engine base** (identity, safety, tool protocol) + **feature layer** (chat vs. agent vs. review) + **workspace rules** (user/team) + **task layer**. Layers compose deterministically; precedence and provenance are explicit so behavior is debuggable.

### 71.2 Templates & Composition
Prompts are versioned templates with typed variables, composed at runtime. Templates live in `packages/ai/prompts`, are unit-tested, and are decoupled from code so prompt iteration doesn't require code churn.

### 71.3 User Prompt Library
The user's saved prompts (Part IV §43.5) are insertable via palette/slash-commands with variable interpolation, tags, and usage stats. Team-shared prompts (Post-1.0) ride the same rails.

### 71.4 Versioning & Experimentation
System/feature prompts are versioned; the feature-flags service (Part IV §57) can A/B prompt variants (exposure logged, Part IV §52) with the eval harness (§79) measuring quality deltas — so prompt improvements are data-driven, not vibes.

### 71.5 Variables & Interpolation
Safe interpolation (no injection of untrusted content into instruction slots); user/content variables are placed in clearly delimited content regions, not instruction regions (§78.1).

### 71.6 Guardrail Prompts
Baseline safety/guardrail instructions (respect approval workflows, don't exfiltrate secrets, cite sources, prefer minimal diffs) are always present and cannot be silently overridden by user prompts.

---

## 72. AGENTIC ORCHESTRATION RUNTIME

### 72.1 The Agent Loop
```
plan → select tool/action → (approval gate?) → execute → observe result
     → update memory/state → check budget/goal → repeat | finish
```
Each agent run is a cancellable async task with a plan, a step budget, a wall-clock timeout, and an event-sourced log (Part II §16.5) enabling live timeline UI, resume-after-crash, and audit.

### 72.2 Tool System
Tools are declared (`ToolSpec`) and executed by the `ToolExecutor`. Built-in tools: read/search files, edit/apply-patch (staged + reviewable), run terminal command (guarded), run tests, git ops (read-only by default), semantic search, fetch web (permissioned), and "ask user." Tools declare side-effect class (read/mutate/exec/network) driving approval policy. **External tools via MCP** (§80.3) plug into the same registry.

### 72.3 Multi-Step Planning
Planning mode (Part VIII) produces an explicit, editable plan before execution. The runtime supports plan revision when observations invalidate assumptions (re-planning), with loop-guard heuristics to detect thrashing and stop with a diagnosis (mirrors the "don't patch-loop" rule).

### 72.4 Concurrency: Parallel & Background Agents
A bounded worker pool runs multiple agents concurrently with fair scheduling and back-pressure. **Background agents** run long tasks (large refactors, test generation) without blocking the UI; **parallel agents** fan out independent subtasks (e.g., document N modules) and gather results. Resource ceilings and per-run budgets prevent runaway cost/CPU.

### 72.5 Task Queue & Scheduling
A persistent task queue (SQLite-backed) holds queued/running/paused/completed agent tasks, survives restarts, supports priorities and dependencies, and exposes a UI (Part VIII/IX). Tasks are idempotent and resumable.

### 72.6 Budgets, Timeouts, Cancellation
Every run enforces `maxSteps`, `maxCostMinorUnits`, and wall-clock limits; on breach it pauses for user decision rather than silently spending. Cancellation is instant and rolls the run to a clean, inspectable state (with its snapshot intact).

### 72.7 State & Resumability
The event log is the source of truth; a crash mid-run leaves an `interrupted` run that the user can resume or discard. Applied edits are always preceded by a snapshot (Part VIII) so nothing is unrecoverable.

### 72.8 Approval & Guardrail Integration
Mutating/exec/network tool actions pass through the **approval workflow** (Part VIII) per policy (auto-approve safe reads; require approval for writes/exec/network by default; user-configurable per agent and per workspace). Guardrails enforce file-scope allow-lists, command allow/deny lists, and secret-redaction before any provider call.

### 72.9 Sub-Agents & Composition
Agents can spawn scoped sub-agents (e.g., a "research" sub-agent, a "review" sub-agent) with their own budgets and tool scopes, results folded back into the parent. This composition powers specialized agents (Part VIII) without bespoke plumbing each time.

---

## 73. MODEL ROUTING & SELECTION

### 73.1 Routing Policies
- **Manual:** user picks the model (default, always available).
- **Auto (quality-first):** best-capability model for the task profile.
- **Cost-optimized:** cheapest model meeting the task's capability bar.
- **Latency-optimized:** fastest (e.g., Groq/local) for interactive tasks.
- **Privacy-first:** prefer local models (Ollama/LM Studio) whenever capable.
- **Capability-required:** route only to models with needed capabilities (vision, tools, big context).

### 73.2 Task-Aware Routing
Task profiles (§65.4) bind model tiers to work types: autocomplete → fast/cheap/local; chat → balanced; planning/architecture/review → strongest+reasoning; embeddings → embedding model (local or provider). Defaults are sensible; users override freely.

### 73.3 Routing Engine
`ModelRouter` inputs: task profile, policy, required capabilities, budget/spend state, provider health, latency history, locality preference. Output: an ordered candidate list (primary + fallbacks). Decisions are logged with rationale for transparency/debug.

### 73.4 Mid-Conversation Switching
Users switch models mid-thread; context is re-fit to the new model's window and capabilities (e.g., dropping images if the new model lacks vision, with a notice). Great for "draft cheap, finalize strong" workflows (Diego persona).

### 73.5 Overrides & Pinning
Any turn/agent can pin a specific model, overriding policy. Pins are visible and easily cleared.

---

## 74. FALLBACK & FAILOVER

### 74.1 Fallback Chains
Each task profile has an ordered fallback chain (e.g., `primary → alt-provider same-tier → cheaper → local → informative error`). Chains are user-editable and provider-diverse to survive single-vendor outages.

### 74.2 Triggers (from Error Taxonomy §63.7)
Failover on: `RateLimit` (after honoring `Retry-After` within budget), `Quota`, `Timeout`, `ServerError`, `NetworkError`, provider circuit-open. **No** silent failover on `ContentFilter`/`InvalidRequest` (those surface to the user; retrying elsewhere would be wrong).

### 74.3 Circuit Breakers
Per-provider breakers open after sustained failures, routing away until half-open probes succeed. Prevents hammering a down provider and cascading latency.

### 74.4 Failover UX & Transparency
Failover is visible ("OpenAI rate-limited → continued on Anthropic"), logged, and reflected in cost accounting. Users can disable auto-failover (strict single-provider mode) for cost/compliance control.

### 74.5 Degradation to Local
When all cloud options fail (or offline), routing degrades to a capable local model if available, else returns a clear, actionable error — never a hang. Local success means continued productivity with zero egress.

---

## 75. COST ESTIMATION & TOKEN TRACKING

*(Ledger mechanics in Part IV §54; here: engine integration.)*

- **Pre-flight estimate:** before expensive actions (big context, high reasoning, multi-step agents), the engine estimates cost from token counts × catalog pricing and shows it; can require confirmation past a threshold.
- **Live tracking:** `usage` stream events feed the `CostMeter` in real time (input/output/reasoning/cached tokens).
- **Reconciliation:** final usage reconciles the estimate; deltas refine future estimates.
- **Budget enforcement:** per-provider/day/month budgets and per-run caps; on breach, warn, pause, or auto-switch to cheaper/local per policy.
- **Custom pricing:** user-set pricing for self-hosted/custom endpoints so accounting stays accurate everywhere.

---

## 76. CACHING (AI-SPECIFIC)

- **Provider prompt caching** (§69.6): stable-prefix segmentation to maximize vendor cache hits (big cost/latency wins on agents).
- **Response cache (local):** exact-match cache for idempotent, deterministic requests (e.g., `temperature:0` explanations of unchanged code) keyed by normalized request hash; TTL'd and invalidated on file changes.
- **Semantic cache (optional):** near-duplicate query detection to reuse recent answers, behind a confidence threshold and clearly indicated ("reused a recent result").
- **Embedding cache:** embeddings keyed by content hash so unchanged code is never re-embedded (huge indexing savings, Part XI).
- **Autocomplete cache:** short-lived cache of completions keyed by prefix/context to cut latency and cost on repeated contexts.
- **Invalidation:** content-hash and file-watcher driven; caches never serve stale results across edits.

---

## 77. RATE LIMITING, QUOTAS & CONCURRENCY CONTROL

- **Per-provider client limits:** configurable max concurrent requests + requests/minute, respecting known provider limits to avoid 429s.
- **Client-side throttling & queue:** a fair scheduler queues requests per provider with priorities (interactive > background agent) and back-pressure.
- **429 handling:** honor `Retry-After`; count against the retry/failover budget; surface transparently.
- **Concurrency isolation:** interactive features are prioritized so background agents never starve the user's typing/chat latency (INV-1 spirit).

---

## 78. SAFETY, GUARDRAILS & CONTENT HANDLING

### 78.1 Prompt-Injection Defense
Agents read untrusted content (files, web, tool output) that may contain adversarial instructions. Mitigations: strict **instruction/content separation** (untrusted text is placed in delimited content regions, never instruction slots); a standing guardrail that tool/file/web content is *data, not commands*; approval gates on consequential actions; and detection heuristics that flag suspicious "ignore previous instructions"-style content to the user. (Mirrors Axiom's own operating principle of treating external content as untrusted.)

### 78.2 Secret Redaction Before Egress
Before any prompt/context leaves for a provider, a **secret scanner** redacts detected credentials (API keys, tokens, private keys, .env values) unless the user explicitly includes them. Redaction is on by default and logged (what type was redacted, never the value).

### 78.3 Tool Execution Safety
Exec/network/mutating tools run under the approval workflow, with command allow/deny lists, file-scope restrictions, dry-run/preview for edits, and full audit. Terminal commands proposed by agents are shown before running (per policy). Destructive operations require explicit confirmation (aligns with safety guardrails).

### 78.4 Output Validation
Structured outputs are schema-validated; code edits are parsed/linted before apply where possible; patches that don't apply cleanly are rejected with feedback to the model rather than silently corrupting files.

### 78.5 PII / Sensitive Data
The engine minimizes sensitive data in prompts, supports redaction rules, and keeps all retrieval/memory local. Nothing sensitive is sent to Axiom's cloud (INV-4); provider egress is the user's explicit choice.

### 78.6 Hallucination Mitigation
Grounding via on-device RAG with **file/line citations**; "I don't know / not found in repo" is encouraged over fabrication; agents verify (run tests, re-read files) before claiming success; answers about code prefer quoting real, retrieved content.

---

## 79. OBSERVABILITY & EVALUATION

- **AI telemetry (opt-in, Part IV §52/53):** per-turn model/provider, token buckets, latency, accept/revert, failover events, cache hit rates — **no code/prompts** uploaded.
- **Local trace & replay:** every turn and agent run is locally traceable (request manifest, context sources, tool calls, results, usage) and replayable for debugging — invaluable for support and improvement.
- **Eval harness (offline):** a curated suite of coding tasks + golden checks runs prompt/model changes through automated evals (edit correctness, test pass, diff quality) to catch regressions before release (Part XII).
- **Regression detection:** prompt/model version changes are gated on eval deltas and, in production, on accept/revert metric shifts, with kill-switch rollback via feature flags (Part IV §57).

---

## 80. EXTENSIBILITY & FUTURE-PROOFING

### 80.1 New Modalities
The `ContentPart` model and capability descriptors absorb vision (1.0), and later audio/video, without protocol changes — features light up as capabilities appear.

### 80.2 New Providers via SDK
The `IProviderAdapter` contract + Provider Plugin SDK (Part II §19.4) let community/enterprise add providers out-of-band; the OpenAI-compatible adapter already covers most.

### 80.3 MCP (Model Context Protocol) & Tool Ecosystem
Axiom acts as an **MCP client**: users/teams connect MCP servers (databases, docs, internal APIs, cloud tools) whose tools/resources register into the same `ToolExecutor`, giving agents governed access to external systems. MCP servers are configured per user/workspace, permission-brokered, and audited — extending agent capability without core releases. (This is the same MCP concept Axiom itself supports as a client.)

### 80.4 Multi-Model Ensembles
The runtime can compose models (e.g., a fast drafter + a strong critic, or majority-vote across models) for higher-quality or self-checking workflows — enabled by the provider-agnostic core.

### 80.5 Local Fine-Tunes / Adapters (Directional)
Because local providers are first-class, user LoRA/fine-tuned models served via Ollama/LM Studio work today; deeper local-adapter management is a Post-1.0 opportunity.

---

## 81. AI ENGINE RISKS, TRADE-OFFS & MITIGATIONS

- **Provider API churn** → versioned adapters, capability probing, contract tests against recorded fixtures, OpenAI-compatible consolidation.
- **Token-count/cost inaccuracy across vendors** → native counters where available, WASM tokenizers otherwise, reconciliation loop, ±5% target monitored.
- **Prompt-injection / agent misuse** → instruction/content separation, approval gates, secret redaction, audit (§78, Part X).
- **Runaway agent cost/CPU** → step/cost/time budgets, bounded pools, breakers, pause-on-breach.
- **Context-window overflow & quality loss from truncation** → proactive budgeting, hierarchical summarization, visible context manifest, prompt caching.
- **Local model capability gaps** → transparent capability labeling, routing that won't send capability-requiring tasks to incapable models, graceful "use a stronger model?" prompts.
- **Latency on huge context/agents** → prompt caching, parallelism, streaming, cheap-draft/strong-final patterns, off-thread work (INV-1).
- **Over-reliance on one vendor** → diverse fallback chains, provider-agnostic core, local degradation.

---

*End of Part V — AI System (the engine).*


---

# PART VI — DESKTOP APPLICATION

> **Purpose of this Part.** Part VI specifies everything that makes Axiom a first-class **native desktop citizen** on Windows (and, by the Platform Abstraction Layer, portable later): packaging and installers, code signing, the setup/onboarding wizard, auto-update with rollback, application lifecycle, crash recovery, deep Windows OS integration (file associations, taskbar, tray, jump lists, protocol handler, notifications), native dialogs, performance/memory at the platform level, GPU acceleration, accessibility infrastructure, localization, application-layer settings, logging/diagnostics, and uninstall/repair. It obeys Part II invariants (esp. INV-5 restorable state, INV-7 platform quarantine) and cross-references Part XI (Performance) and Part IX (UX) where those parts own the deep detail.

---

## 82. DESKTOP PLATFORM OVERVIEW & GOALS

### 82.1 Scope
This part owns the **shell and platform** — how Axiom installs, updates, launches, integrates with the OS, survives crashes, and presents native surfaces. It does **not** re-specify the editor/AI (Parts V/VII/VIII) or the visual design system (Part IX); it provides the native chassis they run in.

### 82.2 Goals
- **D1.** One-click, trustworthy install with immediate SmartScreen reputation (signed).
- **D2.** Silent, seamless auto-update with delta downloads, staged rollout, and one-click rollback.
- **D3.** Deep, tasteful Windows integration (associations, taskbar, tray, jump lists, toasts, protocol handler).
- **D4.** Bulletproof crash recovery: no lost work after crash, kill, or power loss (INV-5).
- **D5.** Native dialogs/notifications that respect OS conventions and settings (Focus Assist, high contrast, DPI).
- **D6.** Accessibility and localization built into the platform, not retrofitted.
- **D7.** Enterprise-deployable (MSI/MSIX, silent install, GPO/managed settings, controlled updates).
- **D8.** Lean footprint: fast cold start, bounded memory, reduced background/idle usage.

### 82.3 Platform Support Matrix (1.0)

| Platform | Arch | Status | Installer |
|---|---|---|---|
| Windows 11 | x64 | ✅ Primary | NSIS + MSI/MSIX + winget + portable |
| Windows 11 | ARM64 | ✅ Supported | NSIS + MSIX (ARM64 native) |
| Windows 10 (2004+) | x64 | ✅ Supported | NSIS + MSI |
| macOS (Apple Silicon/Intel) | — | 🚧 Architecture-ready (Post-1.0) | DMG + notarization |
| Linux (x64/ARM64) | — | 🚧 Architecture-ready (Post-1.0) | AppImage/deb/rpm |

### 82.4 Distribution Channels
- **Direct download** (signed installer from the Axiom site/CDN) — primary consumer path.
- **winget** — `winget install Axiom.Axiom` for developers.
- **Enterprise** — MSI/MSIX for SCCM/Intune/GPO deployment, silent flags, managed config.
- **Portable ZIP** — no-install build for restricted environments (updates manual/controlled).
- **Release channels:** `stable`, `beta`, `dev` (Insiders-style), selectable in-app; each side-by-side installable where feasible.

---

## 83. PACKAGING & INSTALLERS

### 83.1 Installer Strategy (Ratified)
Primary consumer installer: **NSIS** (via electron-builder) with integrated **auto-update** support. Enterprise: **MSI** (and **MSIX** for Store/modern management) supporting silent install, transforms, and managed policy. Rationale: NSIS gives the smoothest consumer install + delta auto-update; MSI/MSIX satisfies IT deployment (SCCM/Intune/GPO). Both are produced from one build in CI.

### 83.2 Install Modes
- **Per-user** (default, no admin): installs to `%LOCALAPPDATA%`, enables auto-update without elevation — ideal for developer laptops.
- **Per-machine** (admin/enterprise): installs to `Program Files`, for shared machines and managed fleets.
- Mode is chosen in the installer or forced via MSI properties for silent deployment.

### 83.3 Silent / Enterprise Install
MSI supports `/quiet` with properties (install dir, channel, disable-auto-update, managed-settings path), MST transforms, and GPO/Intune deployment. A documented **ADMX template** exposes managed policies (update control, telemetry off, allowed providers, proxy/CA). Enables locked-down rollout for the enterprise persona.

### 83.4 Prerequisites & Bundling
Electron bundles its own Chromium, so **WebView2 is not required** (unlike a Tauri build). Native modules (node-pty, SQLite, Rust Core sidecar) are prebuilt per target triple and bundled; any VC++ runtime dependency is bundled or checked/installed by the installer. No hidden runtime downloads on first launch.

### 83.5 Installer UX
Clean, signed installer: publisher shown, license, install-location (advanced), channel choice, "create shortcuts / add to PATH / register file associations / launch on finish" options. Progress + rollback on failure. Localized (§95). Accessible (keyboard/screen-reader). Aligns with Part IX visual language where custom UI is used.

### 83.6 Uninstall & Cleanup
Standard Add/Remove Programs entry. Uninstall offers **"keep or remove my data"** (settings, caches, local indexes, BYOK keys). Secrets in the OS store are removed only on explicit "remove my data." Clean registry/association/shortcut removal; no orphaned services. Portable build leaves nothing outside its folder.

### 83.7 PATH & CLI
Optional `axiom` CLI added to PATH (`axiom .`, `axiom file.ts`, `axiom --new-window`) mirroring the `code` command developers expect — a small but high-value integration.

---

## 84. CODE SIGNING & TRUST

- **EV code-signing certificate** for all executables, installers, and updates → immediate Microsoft SmartScreen reputation (avoids "unknown publisher" warnings that kill install conversion).
- **Signing pipeline:** signing happens in CI on protected, access-controlled runners using an HSM/cloud-KMS-held key (never on developer machines). All shipped binaries (app, native modules, sidecar, installers, update packages) are signed and timestamped.
- **Update integrity:** every update package's signature and hash are verified before apply (§86.9); tampered/unsigned updates are rejected.
- **Supply-chain:** pinned dependencies + lockfiles, SBOM generation, dependency and vulnerability scanning in CI, and reproducible builds (Part II §24, Part X). Third-party native binaries are vetted and pinned.
- **Future macOS:** Developer ID signing + **notarization** + stapling; Gatekeeper compliance. (Post-1.0, but the signing pipeline is designed to extend.)

---

## 85. SETUP / ONBOARDING WIZARD

*(Visual/UX detail in Part IX; here: structure & platform behavior.)*

### 85.1 First-Run Flow
On first launch, a multi-step wizard runs (skippable, resumable). Goal: **first value in < 5 minutes** (Part I §7.1). Every step has a "Skip / do later" path so nothing blocks reaching the editor.

### 85.2 Steps
1. **Welcome + theme** (light/dark/system, high-contrast detected).
2. **Keymap** (Axiom default / VS Code / JetBrains / Vim).
3. **Import** existing config (§85.3).
4. **Sign-in** (optional, Part III) — clearly optional, explains what it unlocks.
5. **Telemetry & privacy consent** (explicit opt-in, granular; defaults privacy-first).
6. **AI provider setup** (§85.4) — add a key or connect local Ollama/LM Studio; validate.
7. **Open a folder** — offers recent/sample; kicks off background indexing.
8. **Finish** — quick tips + a "try your first AI action" nudge.

### 85.3 Import from VS Code / Cursor
Detects installed VS Code/Cursor and offers to import settings, keybindings, and themes (mapped to Axiom equivalents), and to list installed extensions with compatibility status (Part VII). Lowers switching cost dramatically for the primary personas.

### 85.4 Provider Setup
Guided add-provider (Part V §64.5/§66): pick provider, paste key (stored in SecretVault, INV-3) or point to local endpoint, run health check, choose default model/task profiles. Local-model path requires no key and works offline.

### 85.5 Deferral & Re-entry
The wizard can be dismissed and re-run later from Help/Command Palette. Partial completion is remembered. Nothing configured here is irreversible.

---

## 86. AUTO-UPDATE SYSTEM

### 86.1 Architecture
Update client (electron-updater-style) checks a **signed update feed** per channel (stable/beta/dev) on a CDN. Checks occur on launch + periodically + on demand, respecting enterprise controls (§86.6) and feature flags (staged rollout, §86.4).

### 86.2 Delta Updates
Differential updates (blockmap-based) download only changed blocks, minimizing bandwidth for frequent releases — important for a fast-moving AI IDE. Full-package fallback if delta fails.

### 86.3 Background Download & Apply
Updates download in the background without interrupting work; when ready, Axiom prompts "Restart to update" (or applies on next quit). Never force-restarts mid-work. In-progress agent runs and unsaved buffers are protected (journal, §88) across the update restart.

### 86.4 Staged Rollout & Kill Switch
Releases roll out by percentage via feature flags (Part IV §57); a bad release can be **halted** (stop offering) and a **kill switch** can force clients off a broken version to the prior good one. Crash-free-rate SLOs gate rollout progression.

### 86.5 Rollback
If an update raises crash rates or fails health checks, clients can **roll back** to the last-known-good version (kept on disk for one generation). Manual "reinstall previous version" is available. Settings/schemas migrate forward safely and fail-safe on downgrade (Part II §24).

### 86.6 Enterprise Update Control
Managed policy (ADMX/MSI) can: disable auto-update, pin a version/channel, point to an internal update mirror, or require admin approval. Supports controlled fleet rollout.

### 86.7 Update UX
Non-nagging: a subtle status-bar/notification affordance; release notes shown; user chooses when to restart (unless a critical security update, which escalates messaging but still avoids data loss). Fully localized/accessible.

### 86.8 Native Module & Sidecar Versioning
The Rust Core sidecar, native modules, and IPC/schema versions are updated **atomically with the app** (shipped together) so protocol versions always match (Part II §14.2). No partial updates.

### 86.9 Update Security
Signature + hash verification before apply; TLS-pinned feed where feasible; downgrade-attack protection (won't silently install older than installed unless an authorized rollback); update packages are EV-signed (§84).

---

## 87. APPLICATION LIFECYCLE & PROCESS MANAGEMENT

### 87.1 Staged Startup (fast TTI)
Startup is staged so the user sees a usable window ASAP (Part XI budgets): (1) show window frame + shell skeleton, (2) restore last workspace metadata + tab list (lazy content), (3) activate essential services, (4) lazily spin up sidecars (Core Engine, extension host) and resume background indexing. Heavy work never blocks the first paint (INV-1).

### 87.2 Single-Instance Behavior
A single-instance lock ensures one primary process; launching again (or via CLI/file association) **routes to the existing instance** (open the file/folder in a new tab/window) instead of spawning a duplicate. Per-channel instances (stable vs. beta) may coexist.

### 87.3 Multi-Window
Multiple windows share the Main process/services; each has its own renderer + workspace context. Window state (position, size, monitor, maximized) persists per workspace. Drag tabs between windows (Part VII).

### 87.4 Shutdown / Quit
Graceful quit flushes journals, persists layout/session, cleanly terminates sidecars (with timeout → force-kill fallback), and cancels in-flight AI/agent work with state saved. Prompts on unsaved changes (configurable) but never loses data silently.

### 87.5 Background / Tray Mode
Optional: closing the last window can minimize to the system tray (configurable) so quick reopen is instant and background agents/indexing can continue. Fully quit from tray. Off by default to respect resource expectations.

### 87.6 Power / Sleep / Idle
Handles OS suspend/resume: pauses timers/indexing on sleep, resumes on wake, re-validates network/auth, and reduces resource use when idle (§92.3). Long agent runs survive sleep or resume cleanly.

### 87.7 Session Restore
On relaunch, restores open workspaces, tabs (content lazy-loaded), editor layout/splits, terminal sessions (layout; shells restart), panel state, and in-progress agent runs (resumable) — from the recovery journal (§88).

---

## 88. CRASH RECOVERY & RESILIENCE

### 88.1 Recovery Journal (INV-5)
A durable, write-ahead journal (SQLite WAL) continuously records restorable state: dirty buffer contents (auto-saved deltas), open tabs/layout, terminal layout, agent run event logs, and pending sync. Writes are frequent, atomic, and low-overhead (off the UI thread).

### 88.2 What's Restored After a Crash
Unsaved editor changes, tab set + active tab, split/layout, workspace(s), terminal panes (layout), in-progress agent runs (as resumable), and any queued tasks. The user is greeted with "Recovered your session" rather than a blank slate.

### 88.3 Crash Detection & Safe Mode
A "clean shutdown" flag distinguishes graceful quit from crash. Repeated crashes on startup trigger **Safe Mode** (disable extensions, disable GPU, minimal services) so the user can recover, export a diagnostics bundle, and reset the offending component instead of an unbootable app.

### 88.4 Auto-Save & Dirty-Buffer Protection
Configurable auto-save (off/afterDelay/onFocusChange). Even with auto-save off, dirty buffers are journaled so a crash never loses typing. File writes are transactional (temp + fsync + atomic rename) to avoid corruption on power loss (Part II §22).

### 88.5 Sidecar & Window Crash Isolation
Per Part II §13.4: renderer/sidecar crashes are contained and auto-recovered without losing the whole app; the offending tier restarts from journaled state. Crash-loop breakers prevent thrash.

### 88.6 Data Integrity
Local databases use WAL + integrity checks on startup; corruption triggers repair or safe rebuild (indexes are rebuildable from source; settings restore from backup). The code on disk (the user's real files) is never the app's to corrupt — edits are atomic and, for AI, snapshot-protected (Part VIII).

---

## 89. WINDOWS OS INTEGRATION

### 89.1 File Associations
Optional association for common code/text file types and an Axiom project marker; double-click opens in Axiom (routed to single instance). Associations are opt-in at install and toggleable in settings (never hijacked silently).

### 89.2 Explorer Context Menu
"**Open with Axiom**" on files and "**Open folder in Axiom**" on directories/background (the beloved VS Code behavior), via a registered shell verb (Windows 11 context menu + classic). Optional and toggleable.

### 89.3 Taskbar Integration
- **Overlay icon** for status (e.g., syncing/attention).
- **Progress bar** on the taskbar button during long ops (indexing, big agent runs, updates).
- **Jump List:** recent workspaces/files, "New Window," "New File," pinned projects.
- **Thumbnail toolbar / preview** for quick actions where valuable.

### 89.4 System Tray
Optional tray icon (tied to background mode §87.5): quick open recent, new window, agent/task status, pause background agents, quit. Respects the "off by default" stance.

### 89.5 Protocol Handler (`axiom://`)
Registered for: OAuth callback fallback (Part III §27.5) and deep links (`axiom://open?repo=…`, `axiom://file?path=…`, future share links). All deep links are **validated and permission-gated** (never auto-execute; state-checked for auth) — treated as untrusted input.

### 89.6 Startup on Login
Optional "launch Axiom at login" (off by default), managed via the OS startup mechanism through the PAL; enterprise-policy controllable.

### 89.7 Windows Recent & Jump Integration
Opened files/folders register with Windows Recent (respecting privacy settings) so they appear in OS-level recents and the jump list; can be disabled for privacy.

### 89.8 Notifications via Action Center
Native Windows toasts (§91) that land in the Action Center, with app identity and actions.

### 89.9 Native Menus & Window Chrome
A native or native-styled menu bar and window controls consistent with Windows 11 (rounded corners, snap layouts support, Mica/backdrop where appropriate and performant). Snap Assist and multi-monitor DPI-per-monitor are handled correctly.

### 89.10 Registration & Defaults
All OS registrations (associations, verbs, protocol, startup) are done through documented, reversible mechanisms, fully removed on uninstall, and never override user choices without consent.

---

## 90. NATIVE DIALOGS & SYSTEM UI

- **File/folder pickers, save dialogs, and OS message boxes** use **native** dialogs (via the shell layer) for open/save/folder-select and critical OS-level confirmations — correct look, keyboard, screen-reader, and network-location support.
- **In-app custom dialogs** (Part IX) are used for app-specific flows (settings, diff review, approval prompts) where a richer, themed experience is better, but destructive OS-level actions prefer native confirmation.
- **Consistency policy:** native for OS resource selection and platform confirmations; themed in-app for product workflows. Both are accessible and localized.
- All dialogs go through a `IDialogService` (PAL-backed) so behavior is swappable per platform.

---

## 91. NATIVE NOTIFICATIONS

- **Toast notifications** for background events: long agent run finished, update ready, indexing complete, provider failover, budget alert, error needing attention.
- **Actionable toasts:** buttons like "Review changes," "Open," "Retry," "Dismiss" that deep-link into the app.
- **Focus Assist / Do-Not-Disturb respect:** honor OS focus mode; queue non-critical notifications; never spam.
- **In-app vs OS policy:** transient/contextual feedback stays in-app (toasts/status bar, Part IX); notifications that matter when Axiom is **backgrounded** go to the OS. User-configurable per category (which events notify, and how).
- **Notification center (in-app):** a history of recent notifications/alerts for later review (Part IX).

---

## 92. PERFORMANCE & RESOURCE MANAGEMENT (DESKTOP LAYER)

*(Full budgets, SLOs, and large-repo strategy in Part XI; here: platform-level mechanisms.)*

### 92.1 Startup Performance
Staged startup (§87.1), lazy service activation (Part II §17.2), deferred sidecar spin-up, and precompiled/cached assets target the cold-start SLO. A startup profiler runs in dev/CI to guard regressions (Part XI/XII).

### 92.2 Memory Management
Multi-process design with per-process budgets; the Rust Core keeps heavy structures (index/vectors, memory-mapped) out of the Node/Chromium heaps; large lists/trees are virtualized; caches have caps + eviction. A memory watchdog surfaces pressure and can shed caches / pause background agents under low-memory conditions.

### 92.3 Idle & Background Reduction
When idle/backgrounded: throttle timers, pause/slow indexing and background agents, reduce render frame rate, and release non-essential caches — cutting CPU/GPU/battery use. Resumes fully on focus.

### 92.4 Process Reuse & Pooling
Worker pools (diffing, tokenization, syntax) and sidecars are reused across operations; bounded and recycled to avoid leaks. New windows reuse shared services.

### 92.5 Disk & Cache Footprint
Local caches (index, embeddings, response cache, logs) have size ceilings, LRU eviction, and a "clear caches" action. Disk-full is handled gracefully (pause writes, warn, degrade) rather than crashing (Part II §22).

---

## 93. GPU ACCELERATION

### 93.1 Where GPU Helps
Chromium GPU-accelerates UI compositing, scrolling, animations, and canvas/WebGL surfaces (e.g., large diff/graph visualizations, minimap). This keeps the editor buttery at high refresh/DPI.

### 93.2 Fallback & Robustness
Automatic **software-rendering fallback** if the GPU is unavailable/blocklisted or the GPU process crashes; the app stays usable (degraded smoothness). GPU process crashes are isolated and auto-restarted (Chromium behavior) without taking down the app.

### 93.3 Blocklist & Driver Issues
Respect Chromium's GPU blocklist for known-bad drivers; provide a setting to force software rendering (for problem systems) and a "GPU status" diagnostic (equivalent to chrome://gpu) in the diagnostics bundle.

### 93.4 Local Model GPU
Axiom does not run models itself; local-model GPU utilization is delegated to Ollama/LM Studio (which use the user's GPU). Axiom surfaces local-runtime status/health but doesn't manage GPU inference directly.

### 93.5 Diagnostics
GPU acceleration state, driver, and any fallback reason are recorded for support; a toggle allows quick A/B when diagnosing rendering issues.

---

## 94. ACCESSIBILITY (PLATFORM INFRASTRUCTURE)

*(Component-level a11y specs in Part IX; here: platform foundation and standards.)*

- **Screen readers:** full support via Chromium's UI Automation (UIA) bridge for Narrator/NVDA/JAWS; Monaco's screen-reader mode enabled for the editor; all custom controls expose correct ARIA roles/names/states.
- **Keyboard-complete:** every action reachable without a mouse; visible focus indicators; logical tab order; no keyboard traps; full command palette coverage.
- **High contrast & themes:** honor Windows High Contrast; ship accessible high-contrast themes; ensure contrast ratios meet targets.
- **Zoom, scaling & DPI:** per-monitor DPI awareness, UI zoom, editor font scaling; layouts reflow without clipping.
- **Reduced motion:** honor OS "reduce motion"; provide a setting; disable non-essential animations.
- **Captions/announcements:** live-region announcements for async events (AI streaming start/stop, task completion) so non-visual users stay informed.
- **Standards target:** design toward **WCAG 2.1 AA** for UI surfaces. *Full conformance requires manual testing with assistive technologies and expert accessibility review; automated checks alone are insufficient* — so we include AT-based manual testing in QA (Part XII).

---

## 95. LOCALIZATION & INTERNATIONALIZATION

- **i18n infrastructure:** all user-facing strings externalized into locale catalogs; **no hard-coded UI text**. A lint rule flags un-externalized strings.
- **Formatting:** ICU MessageFormat for pluralization, gender, number/date/currency formatting per locale; locale-aware sorting/collation.
- **RTL support:** logical CSS properties + `dir` handling so Arabic/Hebrew layouts mirror correctly (Post-1.0 language activation, but infra built in 1.0).
- **Locale detection:** follow OS locale by default; user override in settings; hot-swap without restart where feasible.
- **Fonts:** bundle/fall back to fonts covering Latin/CJK/Cyrillic/etc.; correct CJK/complex-script rendering; monospace font stack for code with good glyph coverage.
- **Launch scope & roadmap:** 1.0 ships **English** fully localized-ready with the pipeline in place; high-demand locales (e.g., CJK, ES, PT-BR, DE, FR) follow via the catalog without code changes. Machine-assisted translation + human review workflow (dogfooding Axiom's own AI, optionally).
- **Content separation:** code, user content, and identifiers are never "translated"; only chrome/UI/messages are localized.

---

## 96. SETTINGS (DESKTOP / APPLICATION LAYER)

*(Sync mechanics: Part IV §55; UI: Part IX; here: platform storage & policy.)*

- **Precedence:** `shipped defaults < managed policy (enterprise) < user (synced) < workspace < machine-local`. Managed policy can lock specific settings (grayed out, with a "managed by your organization" note).
- **Storage:** human-readable JSON (VS Code-familiar) plus a SQLite cache; machine-local settings never sync; policy settings come from the ADMX/managed-config path.
- **Machine-specific:** GPU/rendering flags, font, hardware paths, window state — local only.
- **Enterprise policy:** GPO/Intune-delivered managed settings (allowed providers, telemetry off, proxy/CA, update control) via a documented ADMX template.
- **Reset & backup:** granular per-scope reset to defaults with pre-reset backup; export/import; "open settings JSON" for power users alongside the GUI.

---

## 97. LOGGING & DIAGNOSTICS (DESKTOP)

- **Storage & rotation:** structured JSON logs per process, size/time-rotated, capped total footprint, stored under the app data dir; never contain secrets/code (redaction at sink, Part II §23).
- **Levels:** error/warn/info/debug/trace; user can raise verbosity temporarily for troubleshooting; a "trace this action" mode captures a correlated cross-process trace.
- **Diagnostics bundle:** one-click export packaging scrubbed logs, app/OS/GPU info, versions, config (redacted), recent non-fatal errors, and (optional) a recent trace — for support. Preview-before-send; nothing uploaded without consent; secrets/code excluded by construction.
- **Self-help:** built-in troubleshooting (reset caches, rebuild index, safe mode, GPU toggle, re-run health checks) so many issues self-resolve.
- **Privacy:** all diagnostics are local unless the user explicitly shares them; scrubbing is tested (Part X/XII).

---

## 98. TELEMETRY (DESKTOP INTEGRATION)

*(Pipeline/schema: Part IV §52/53.)* Desktop-specific concerns: a clear, granular **consent UI** at onboarding and in settings (separate toggles for crash reporting, product analytics, performance telemetry); a persistent, easy-to-find "telemetry: on/off" indicator; OS/hardware context (bucketed) for perf analysis; and a **remote kill switch** (feature flags, Part IV §57) to disable telemetry fleet-wide during an incident. Default posture is **privacy-first** (opt-in), and turning telemetry off disables the network calls entirely (not just hides UI).

---

## 99. UNINSTALL, REPAIR & DATA MANAGEMENT

- **Uninstall:** standard OS uninstall; explicit choice to keep or remove user data (settings, caches, indexes, secrets). Clean removal of registrations/shortcuts.
- **Repair:** MSI repair + in-app "repair install" (re-verify/redownload components); "reset app" (clear caches/state to defaults, preserving user files) as a recovery step short of reinstall.
- **Data locations documented:** app data, logs, caches, and secret-store locations are documented for IT and power users.
- **Migration:** upgrading across major versions runs settings/index/schema migrations (Part II §24) with backups; downgrades fail safe.

---

## 100. DESKTOP RISKS, TRADE-OFFS & MITIGATIONS

- **Electron footprint/startup weight** → staged startup, lazy activation, Rust sidecars for heavy work, strict budgets (Part XI); Tauri path kept open (Part II §12.2).
- **SmartScreen "unknown publisher" friction** → EV signing from day one; reputation monitored.
- **Auto-update breaking a fleet** → staged rollout, health gates, kill switch, one-gen rollback, enterprise update control.
- **OS-integration overreach** (hijacking associations) → all integrations opt-in, reversible, uninstall-clean.
- **Crash/power-loss data loss** → WAL journal, atomic writes, auto-save, safe mode, resumable agents (INV-5).
- **Accessibility gaps** → AT-based manual QA + WCAG target (with the honest caveat that full conformance needs expert review).
- **Localization debt** → externalized strings + lint gate from 1.0 so late localization needs no code churn.
- **Enterprise lockdown needs** → ADMX/managed settings, silent MSI/MSIX, controlled updates designed in, not bolted on.

---

*End of Part VI — Desktop Application.*


---

# PART VII — IDE CORE

> **Purpose of this Part.** Part VII specifies the professional IDE — the editor and developer tooling that must reach parity with VS Code on the top-90% of daily tasks (Goal G1). It covers the workbench shell, command system, file explorer, tabs and split editors, the Monaco-based code editor, language intelligence (LSP), code navigation, autocomplete, search/replace, workspaces and multi-root, the integrated terminal, Git source control, the debugger (DAP), tasks, diagnostics, extensions, themes, keyboard shortcuts/keymaps, settings and settings sync, and snippets. AI is woven throughout but its features are specified in **Part VIII**; here we define the surfaces AI plugs into. All of this honors Part II invariants (editor is sacred, UI never blocks, interface-first) and cross-references Part XI for performance budgets and Part IX for visual/UX detail.

---

## 101. IDE OVERVIEW & GOALS

### 101.1 Scope
The "IDE core" is the developer's working surface minus the AI features: everything needed to open, navigate, edit, run, debug, and version code comfortably and fast. It is built as a clean workbench (Part II §12.1) reusing Monaco/Tree-sitter/LSP/DAP/xterm/ripgrep.

### 101.2 Goals
- **IDE-G1.** VS Code-class editing (multi-cursor, folding, minimap, IntelliSense, refactors) with equal or better latency.
- **IDE-G2.** Full workspace model: single-folder, multi-root, per-workspace settings, workspace trust.
- **IDE-G3.** First-class Git, terminal, and debugging using the user's real toolchains.
- **IDE-G4.** Fast, scalable search/navigation on large repos (ripgrep + index).
- **IDE-G5.** Familiar keymaps (VS Code/JetBrains/Vim) and import path so switching is painless.
- **IDE-G6.** A curated extension model + theming for customization without compromising security/perf.

### 101.3 The Workbench Model
The workbench is a composition of **contributed** parts (Part II §17.3): views, editors, panels, commands, menus, status items, and keybindings. First-party features and extensions use the same contribution rails, so the IDE is uniformly extensible and internally consistent.

---

## 102. WORKBENCH LAYOUT & SHELL

### 102.1 Layout Regions
- **Title bar** — app menu, window controls, workspace name, layout/command entry points, AI quick-actions.
- **Activity Bar** — switch primary side-bar views (Explorer, Search, Source Control, Run/Debug, Extensions, AI).
- **Primary Side Bar** — the active view (file tree, search, SCM, etc.).
- **Editor Area** — one or more editor groups (tabs + editors), splittable.
- **Secondary Side Bar** (optional) — for auxiliary panels (e.g., AI chat docked right).
- **Panel** — bottom (or movable): Terminal, Problems, Output, Debug Console, Search results, Task output.
- **Status Bar** — Git branch, diagnostics counts, language mode, encoding, line/col, indexing/AI status, cost meter, notifications.

### 102.2 Customization
Drag to move the panel (bottom/left/right), move side bars, resize, hide/show any region, **Zen Mode**, full-screen, centered layout, and "focus editor." AI panels can dock in the secondary side bar, the panel, or float. Layouts are per-workspace.

### 102.3 Persistence
Full layout (region sizes, visibility, active views, editor grid, tab order) persists per workspace and restores on reopen (Part VI §87.7). A "reset layout" command restores defaults.

### 102.4 Responsive/Adaptive
Layout gracefully adapts to small windows (collapsing bars to icons, overflow menus) and multi-monitor/high-DPI. No clipping; keyboard reachable at all sizes (Part VI §94).

---

## 103. COMMAND SYSTEM & PALETTE

### 103.1 Command Registry
Every action is a registered command with an id, title, category, optional icon, and a `when` context expression. Commands are the single sanctioned way to mutate state (Part II §16.2), giving uniform keybinding, palette exposure, menu placement, undo, and telemetry.

### 103.2 Command Palette
`Ctrl+Shift+P` fuzzy-searches all commands (with keybinding hints, recent-first). Extensible by features/extensions. Supports command arguments and multi-step quick-pick flows.

### 103.3 Quick Open
`Ctrl+P` fuzzy file open (by path/name, ranked by recency/relevance), with `@` (go to symbol in file), `#` (workspace symbol), `:` (go to line), `>` (commands), and `?` help — the familiar unified quick-access model.

### 103.4 Keybindings & Context Keys
Commands bind to keys via the keybinding system (§119) gated by **context keys** (`editorFocus`, `terminalFocus`, `inDiffEditor`, `aiChatFocus`, etc.), so the same key does the right thing per context.

---

## 104. FILE EXPLORER

### 104.1 Tree Model & Virtualization
A virtualized tree renders only visible nodes, scaling to very large folders (Part XI). Backed by the workspace file model (Main) fed by the PAL file watcher (Part II §18). Lazy directory expansion; incremental loading.

### 104.2 Operations
Create/rename/delete/move files & folders; drag-and-drop (incl. between windows and from OS); cut/copy/paste; duplicate; copy path/relative path; reveal in OS Explorer; open in terminal here; compare selected files. All destructive ops confirm and use OS recycle bin where possible (recoverable).

### 104.3 Context Menus
Right-click menus are contributed and context-aware (file vs folder vs multi-select vs root), including Git actions, AI actions ("Explain," "Refactor," "Generate tests," "Add to chat context"), and extension contributions.

### 104.4 File Decorations
Overlay badges/colors for Git status (modified/untracked/ignored/conflict), Problems (error/warning counts), and AI (e.g., "pending AI edit," "in agent scope"). Decorations are provider-based and stackable.

### 104.5 Filtering & Search-in-Tree
Type-to-filter the visible tree; toggle show/hide ignored & hidden files; respect `.gitignore`/`files.exclude` with overrides.

### 104.6 Large-Folder Handling
Directories with tens of thousands of entries load incrementally with a "showing N of M" affordance; watchers use efficient recursive OS APIs with debouncing/coalescing (Part II §18).

### 104.7 Auxiliary Views
- **Open Editors** — list of open/dirty editors.
- **Outline** — symbol tree of the active file (Tree-sitter/LSP).
- **Timeline** — Git history + local file-save history for the active file (local snapshots).

### 104.8 Edge Cases
Symlinks (follow with loop detection), case-only renames (handled on case-insensitive Windows), long paths (`\\?\`), permission-denied (graceful), files changed on disk (reload prompt/auto), and binary/large files (open with appropriate viewer or warn).

---

## 105. EDITOR TABS & GROUPS

### 105.1 Tabs
Per-group tabs with: dirty indicator, **preview tabs** (single-click preview, italic; replaced until "kept"), **pinned tabs**, drag-reorder, drag across groups/windows, middle-click close, close-others/right/saved, and overflow dropdown. Tab labels disambiguate same-named files by path.

### 105.2 Editor Groups & Splits
Split editors horizontally/vertically into an arbitrary **grid**; move/duplicate editors between groups; maximize/restore a group; "grid" layouts. Independent scroll/selection per group; the same file can be open in multiple groups (synced content).

### 105.3 Special Editors
- **Diff editor** (side-by-side + inline) reused for Git diffs and AI diff review (Part VIII).
- **Merge editor** (3-way) for conflicts (§113.6).
- **Image/binary/markdown-preview** editors and a generic hex/large-file viewer.
- **Settings editor**, **keybindings editor** (§120/§119).

### 105.4 Breadcrumbs
Path + symbol breadcrumbs above the editor for quick navigation and structural jumping (backed by Outline/LSP).

---

## 106. THE CODE EDITOR (MONACO)

### 106.1 Editing Features
Multi-cursor & column selection, smart selection expand/shrink, find widget, code folding (indentation + syntax-aware), minimap, sticky scroll, drag-select, duplicate/move line, join lines, transform case, sort lines, trim whitespace, and rich undo/redo with a persistent per-file history.

### 106.2 Syntax Highlighting
**Tree-sitter** for fast, incremental, structure-aware highlighting and folding, with **TextMate grammar** fallback for languages lacking a grammar. **Semantic highlighting** overlays LSP token info for accurate coloring (e.g., distinguishing parameters vs. properties).

### 106.3 Indentation & Formatting Aids
Auto-indent, bracket auto-close/surround, bracket-pair colorization + guides, indentation guides, detect-indentation-from-file, convert tabs/spaces.

### 106.4 Large File Handling
Files above thresholds switch to a performance mode (disable minimap/heavy tokenization/word-wrap as needed), stream/virtualize content, and warn before operations that would be slow — editing stays responsive (Part XI).

### 106.5 Encodings & Line Endings
Detect/convert encodings (UTF-8/16, etc., with BOM handling), display + change EOL (LF/CRLF), guard against accidental EOL churn, and honor `.editorconfig`.

### 106.6 Formatting
Format document/selection; **format on save / on type / on paste** (configurable, per-language); default formatter selection when multiple exist; range formatting; integrates with LSP/extension formatters and `.editorconfig`/Prettier-style configs when present.

### 106.7 Display Options
Word wrap modes, rulers/guides, render whitespace/control chars, font/ligatures, line height, cursor styles/animation, and per-language overrides.

### 106.8 Inline Hints & Lens
Inlay hints (parameter names, inferred types) from LSP; a "code lens" line for references/run/test/AI actions above symbols. AI inline suggestions render as ghost text (Part VIII) coexisting cleanly with these.

### 106.9 AI Surface (pointer)
The editor exposes hooks for inline completion (ghost text), inline edit (Cmd-K style), selection actions, hover AI explain, and diff overlays — all specified in Part VIII, but architected here so AI never degrades core editing latency (INV-1).

---

## 107. LANGUAGE INTELLIGENCE (LSP)

### 107.1 Architecture
LSP clients run out-of-process (language servers as child processes, Part II §13), one (or more) per language, managed by a `LanguageService`. Multiple servers can attach to one document (e.g., a linter + a type server); results are merged.

### 107.2 Features
Hover, completion + resolve, signature help, publish diagnostics, code actions/quick fixes, rename (with preview across files), find references, go-to-definition/declaration/type/implementation, document/workspace symbols, document highlights, formatting, folding ranges, semantic tokens, inlay hints, call/type hierarchy, and code lens.

### 107.3 Server Management
Bundled servers for top languages (TS/JS, Python, JSON/YAML/HTML/CSS, Markdown) work out of the box; others install on demand (from language tooling or extensions) with a clear "install language support?" prompt. Servers have lifecycle supervision (restart on crash), configurable settings, and per-workspace enablement.

### 107.4 Tree-sitter Structure
Independent of LSP, Tree-sitter provides always-available structure (outline, folding, selection, structural navigation) even for languages without a running server or while a server is starting.

### 107.5 Performance
Servers start lazily on first relevant file; heavy operations are cancellable; results stream; the editor never blocks awaiting a server (shows progressive results). Diagnostics are debounced.

---

## 108. CODE NAVIGATION

- **Go to** definition/declaration/type-definition/implementation/references, with **Peek** (inline overlay) and open-to-side variants.
- **Symbol search:** in-file (`@`) and workspace (`#`) via LSP workspace symbols + index fallback.
- **Breadcrumbs & Outline** for structural jumping.
- **Call hierarchy** and **type hierarchy** (incoming/outgoing).
- **Go to line/column**, **go to bracket**, **go to next/prev problem/change**.
- **Navigation history:** back/forward across jump locations and files; "last edit location."
- **Bookmarks** (optional): mark/jump lines.
- All navigation is keyboard-first and mouse-accessible (Ctrl/Alt-click), and integrates with AI "explain/trace this symbol" (Part VIII).

---

## 109. AUTOCOMPLETE & INTELLISENSE

### 109.1 Sources
Completions merge from: LSP servers (semantic), snippets, word-based (buffer), path completion, and — distinctively — **AI inline completion** (Part VIII). A unified completion controller ranks and de-dupes.

### 109.2 AI vs. IntelliSense Coexistence
Two complementary surfaces: the **suggestion widget** (dropdown list, LSP-driven) and **AI ghost text** (multi-line inline prediction). They coexist without fighting: ghost text shows the AI prediction; the widget shows precise symbols; keybindings are distinct (Tab to accept ghost text, Enter to accept widget selection, configurable). Users can prioritize one or run both.

### 109.3 Ranking & UX
Relevance ranking (recency, type-match, LSP sort text, frequency); fuzzy matching; details/documentation flyout; auto-import on accept; parameter hints on call. Fast (<~50ms perceived) and non-intrusive; easy to dismiss.

### 109.4 Snippets
Built-in + user + extension snippets with tab-stops, placeholders, choices, variables, and transforms; snippet suggestions inline in completion; a snippet manager UI.

### 109.5 Word-Based Fallback
When no LSP is present, buffer/word completions keep basic assistance available, and AI completion can fill the gap (great for niche languages).

---

## 110. SEARCH & REPLACE

### 110.1 In-File Find/Replace
Find widget with case-sensitive, whole-word, regex, in-selection, match count/navigation, and replace/replace-all with capture-group support. Incremental highlight of all matches.

### 110.2 Workspace Search
**ripgrep**-backed (via the Rust Core, Part II) for fast full-text search across huge repos, respecting `.gitignore` by default with toggles. Regex, case, whole-word, and **include/exclude glob** filters. Streams results as they're found.

### 110.3 Search & Replace Across Files
Preview all matches grouped by file with per-match/per-file accept/exclude, then apply; changes are undoable as a batch. Regex replacement with capture groups.

### 110.4 Results UI
Tree of files → matches with context lines, open-on-click, dismiss match/file, "replace in this file," and a results count. Keyboard-navigable.

### 110.5 Semantic Search (pointer)
AI-powered semantic/code-meaning search ("where do we validate JWTs?") is specified in Part VIII, layered on the on-device index; it complements (doesn't replace) lexical search here.

### 110.6 Performance
Search is cancellable, streamed, and bounded (max results with "load more"); large binary files skipped; results virtualized (Part XI).

---

## 111. WORKSPACES, PROJECTS & MULTI-ROOT

### 111.1 Workspace Concept
A **workspace** is one or more root folders opened together, with shared/merged settings, search scope, and layout. Opening a single folder is the common case; a saved multi-root workspace supports polyrepo/monorepo-slice workflows.

### 111.2 Multi-Root
Add/remove multiple root folders; settings/search/Git operate across roots; per-root and workspace-level settings resolve by precedence (Part VI §96). Explorer shows roots as top-level nodes.

### 111.3 Workspace File
A portable `*.axiom-workspace` (JSON) stores root list, workspace settings, and recommended extensions — shareable with a team (checked into a repo). Also imports VS Code `.code-workspace` where feasible.

### 111.4 Per-Workspace Settings & Rules
`.axiom/` in a workspace can hold settings, tasks, launch configs, workspace AI rules (Part VIII), and recommended extensions — enabling project-specific config and team standards.

### 111.5 Recent Workspaces
Recent list (with pinning) in Quick Open, jump list (Part VI §89.3), and the welcome page; syncs metadata cross-device (Part IV §43.9, path-hashed).

### 111.6 Workspace Trust
A **trust model**: opening an unfamiliar folder starts in **Restricted Mode** (no auto-run tasks, no auto-start of certain extensions/servers, no auto-execution of workspace-provided tooling) until the user grants trust. Protects against malicious repos (Part X). Trusted state is remembered per workspace.

### 111.7 Project Detection & Scaffolding
Detects project type (package.json, pyproject, cargo, etc.) to suggest language support, tasks, run/debug configs, and AI onboarding ("I see a Next.js app…"). "New Project" scaffolding (optionally AI-assisted, Part VIII) offers templates.

---

## 112. INTEGRATED TERMINAL

### 112.1 Architecture
xterm.js in the renderer bound to native PTY (ConPTY on Windows) in Main over a flow-controlled channel (Part II §14.4/§18). GPU-accelerated rendering for smooth high-throughput output.

### 112.2 Multiple Terminals
Many terminals; split panes; tabs/list; rename; color/icon; move to editor area; per-terminal cwd. Kill/restart; clear; scrollback with configurable buffer size.

### 112.3 Shell Integration
Optional shell integration injects markers to detect: command start/end, exit codes, and cwd — enabling command decorations (success/fail), "rerun command," "copy output," navigate between commands, and accurate cwd tracking. Works with cmd, PowerShell, Git Bash, and WSL.

### 112.4 Profiles
Auto-detected profiles: **PowerShell, Command Prompt, Git Bash, WSL distros**, and custom. Default profile configurable; per-workspace overrides; environment variable and args customization.

### 112.5 Interaction
Clickable links (URLs, file paths → open in editor at line), find-in-terminal, copy-on-select/paste options, right-click menu, and accessibility (screen-reader mode for terminal output).

### 112.6 AI Integration (pointer)
AI can read terminal output (with permission), explain errors, propose fix commands (shown before running), and drive commands as an agent tool under the approval workflow (Part VIII/V §72). Terminal is a first-class agent tool.

### 112.7 Performance
Handles high-volume output without freezing (throughput throttling, virtualized scrollback, GPU renderer); large pastes warned/confirmed; long-running processes never block the UI (INV-1).

### 112.8 Tasks Link
Tasks (§115) can run in the terminal with problem-matcher parsing; task output is navigable.

---

## 113. SOURCE CONTROL (GIT)

### 113.1 Architecture
Uses the **user's installed Git** (real toolchain, sovereignty) via a Git service (libgit2/CLI hybrid) behind `IGitService`. Detects repos per root; supports multiple repos in multi-root; watches `.git` for external changes.

### 113.2 SCM View
Grouped changes (staged/unstaged/merge), stage/unstage per-file/per-hunk/per-line, discard (with confirm/recycle), commit with message box, amend, sign-off, and commit staged/all. Multiple-repo sections.

### 113.3 Diff & Inline Diff
Side-by-side and inline diff editors; gutter change indicators (added/modified/deleted) with inline "revert/stage this change" and hunk navigation; diff against index/HEAD/branch.

### 113.4 Branch & History Operations
Create/checkout/rename/delete branches; merge, rebase (incl. interactive via terminal), cherry-pick, revert, reset (guarded), tag, and **stash** (create/apply/pop/list). Publish/track branches. A visual **commit graph/history** view (per file and repo), with blame annotations (inline + gutter).

### 113.5 Conflict Resolution
A **3-way merge editor** (incoming/current/result) with accept-incoming/current/both, per-conflict navigation, and AI-assisted resolution suggestions (Part VIII). Falls back to inline conflict markers for power users.

### 113.6 Remotes & Auth
Fetch/pull/push/sync; manage remotes; credential handling via the OS Git credential manager / helpers (no credential storage in Axiom beyond delegating to Git). Handles auth prompts, SSH, and HTTPS tokens through Git's own mechanisms.

### 113.7 Hosting Providers (Scope)
1.0 focuses on core Git. Lightweight GitHub/GitLab integration (view/create PRs/MRs, issues) is delivered via **extensions/providers** on the extension rails (curated), not hard-coded — keeping the core VCS-agnostic. Deeper PR review flows are Post-1.0.

### 113.8 AI Git Features (pointer)
AI-generated commit messages (from staged diff), PR descriptions, changelog, review of staged changes, and conflict-resolution assistance are specified in Part VIII. All AI Git actions surface a diff for approval.

### 113.9 Scale & Edge Cases
Large repos (sparse checkout awareness, partial clone), submodules, worktrees, Git LFS, detached HEAD, mid-rebase/merge states (clearly indicated with next-step guidance), and huge diffs (virtualized) are all handled gracefully.

---

## 114. DEBUGGER (DAP)

### 114.1 Architecture
Debug Adapter Protocol clients talk to per-language debug adapters (child processes) via a `DebugService`. Adapters install on demand (bundled for JS/TS/Node; others via extensions). Multiple concurrent debug sessions supported.

### 114.2 Debug UI
Breakpoints (line/column, conditional, hit-count, **logpoints**), the **Variables** view (with edit-value), **Watch** expressions, **Call Stack** (multi-thread, multi-session), **Loaded Scripts/Modules**, and a **Debug Console/REPL** for expression evaluation in the paused context.

### 114.3 Launch Configurations
`launch.json`-style configs (compatible shape), auto-generated for detected project types, with compound configurations, pre-launch tasks, environment/args, and variable substitution. A quick "Run/Debug" from code lens or the Run view.

### 114.4 Control & Evaluation
Continue, step over/into/out, restart, stop, pause; run-to-cursor; set-next-statement (where supported); inline variable values during stepping; hover-evaluate; data/function breakpoints where the adapter supports them.

### 114.5 Remote & Multi-Target
Attach to running processes; remote/container/WSL debugging via adapters; multi-session orchestration (e.g., client + server) with a session picker.

### 114.6 Language Coverage
Bundled/first-class: Node/JS/TS. Via adapters/extensions: Python, Go, Rust, C/C++, Java, .NET, PHP, etc. Coverage grows via the extension ecosystem on the same DAP rails.

### 114.7 AI Debugging (pointer)
AI can analyze a stopped state (stack, variables, exception), hypothesize root cause, set strategic breakpoints/logpoints, and propose fixes as reviewable diffs (Part VIII), using the debugger as a tool.

---

## 115. TASKS & BUILD

- **Task definitions** (`tasks.json`-compatible): shell/process tasks, build/test/custom groups, dependencies (sequential/parallel), and background/watch tasks.
- **Auto-detection** of npm/scripts, Make, Cargo, etc., offering ready-to-run tasks.
- **Problem matchers** parse task output into the Problems panel (file/line/severity), turning build/lint output into navigable diagnostics.
- **Run UX:** run from palette/Run view/status bar; output in the terminal; task status decorations; rerun last task.
- **AI integration:** agents can run tasks as tools (tests/builds) under approval and use results to iterate (Part V §72/Part VIII).

---

## 116. DIAGNOSTICS & PROBLEMS

- A **Problems panel** aggregates diagnostics from LSP servers, linters, task problem-matchers, and AI checks, grouped by file with severity filters, quick-fix affordances, and click-to-navigate.
- Inline squiggles + gutter markers + status-bar counts; hover shows message + quick fixes (code actions).
- Diagnostics are debounced and cancellable; large diagnostic sets are virtualized.
- "Explain this error" and "Fix with AI" actions bridge to Part VIII.

---

## 117. EXTENSIONS

### 117.1 Model
Extensions run in the sandboxed extension host (Part II §19) using the curated Axiom API. They contribute commands, views, languages, debuggers, themes, tasks, and — uniquely — AI tools/agents/prompts.

### 117.2 API Surface (1.0)
A pragmatic, stable subset covering the most-used capabilities (commands, configuration, workspace/text-document, languages/diagnostics/completions, UI views/tree/webview, tasks, debug, SCM provider, and AI contribution points). Shaped to feel familiar to VS Code extension authors while remaining small enough to secure and support (N4: not full parity).

### 117.3 Distribution & Marketplace
A curated Axiom extension registry (signed extensions, review for the initial catalog) plus support for installing from VSIX-like packages. (The proprietary VS Code Marketplace is not redistributable; Axiom uses its own registry, e.g., an OpenVSX-style source, plus first-party extensions.) Extension signing + permission manifest (Part II §19.3) mitigate supply-chain risk (Part X).

### 117.4 VS Code Compatibility
A **compatibility layer** targets a high-value subset of the VS Code API so many popular extensions (themes, linters, language packs, formatters) can run with little/no change. Compatibility is best-effort and clearly labeled per extension; deep/host-specific extensions may not port. First-party equivalents cover the most critical gaps.

### 117.5 Management UI
Browse/search/install/enable/disable/uninstall/update; per-workspace enablement; recommended extensions (from `.axiom` or project detection); view permissions before install; extension logs; bulk update. Extensions honor workspace trust (§111.6).

### 117.6 Security
Manifest-declared permissions enforced by the capability broker; resource limits; no secret access; network access brokered/allow-listed; crash isolation. Users see and approve what an extension can do.

---

## 118. THEMES & CUSTOMIZATION

- **Color themes:** full workbench + editor token theming via a token system; ship polished dark, light, and high-contrast defaults (Part IX design tokens). Import VS Code color themes (compatible format).
- **Syntax token colors:** TextMate scopes + semantic token colors, customizable per-scope by users.
- **File icon themes** and **product icon themes** (customize UI iconography).
- **Customization:** per-setting color overrides (`workbench.colorCustomizations`, `editor.tokenColorCustomizations`-style), UI density, font, and layout preferences.
- **Live preview** when selecting/editing themes; theme auto-switch with OS light/dark.

---

## 119. KEYBOARD SHORTCUTS & KEYMAPS

- **Keybinding system:** commands ↔ keys with chords (multi-key), `when` context clauses, and platform-aware defaults. Everything is rebindable.
- **Keymaps:** ship **Axiom default, VS Code, JetBrains, Sublime, Emacs**, and a **Vim mode** (modal editing) as selectable keymaps; import happens in onboarding (Part VI §85). Reduces switching friction (Goal IDE-G5).
- **Keybinding editor:** searchable GUI (by command/key/when) + raw JSON; record-a-key to bind; shows conflicts and lets users resolve them.
- **Conflict handling:** duplicate/overlapping bindings are surfaced with resolution; context keys disambiguate where possible.
- **Discoverability:** palette shows bindings; hover tooltips show shortcuts; a printable/searchable cheat-sheet.

---

## 120. SETTINGS & SETTINGS SYNC

### 120.1 Settings UI
Dual interface: a **searchable GUI** (grouped, with descriptions, defaults, per-scope tabs, "modified" filter, and reset) and **raw JSON** (`settings.json`) for power users — always in sync. Settings search is instant and fuzzy.

### 120.2 Scopes & Precedence
`default < managed policy < user < workspace < folder(multi-root) < machine-local` (Part VI §96). Each setting shows where its effective value comes from; machine-scoped settings never sync.

### 120.3 Settings Sync
Opt-in sync (Part IV §55) of user settings, keybindings, snippets, themes selection, and (user-authored) prompts/rules across signed-in devices, with conflict resolution and history. Machine-local and secret values are excluded by construction.

### 120.4 Settings Profiles
**Profiles** bundle settings + keybindings + enabled extensions + UI state for different contexts (e.g., "Web dev," "Rust," "Demo"). Switch profiles per window/workspace; profiles can sync. Great for developers who juggle stacks.

---

## 121. SNIPPETS

- **Built-in, user, and extension snippets** per language + global; tab-stops, placeholders, choices, variables (file name, date, clipboard, selection), and transforms.
- **Management UI** to create/edit/organize; scope to language/project; share via workspace or sync.
- Snippet suggestions appear inline in completion (§109.4) and via a dedicated "Insert Snippet" command.
- AI can generate snippets from a natural-language description (Part VIII) and save them to the library (Part IV §43.5).

---

## 122. IDE PERFORMANCE (POINTER)

All IDE-core surfaces are bound by Part XI budgets: keystroke-to-render latency, scroll smoothness, open-file time, search/index throughput, and memory. Key mechanisms already noted: virtualization (tree/list/results/scrollback), off-thread work (Rust Core + workers), streaming results, lazy activation, and large-file/large-repo modes. Performance regressions in the editor hot path are release-blocking (INV-1, Part XII).

---

## 123. IDE CORE RISKS, TRADE-OFFS & MITIGATIONS

- **Editor breadth vs. VS Code (clean build)** → reuse Monaco/LSP/DAP/Tree-sitter/ripgrep; prioritize top-90% tasks; compatibility layer + first-party equivalents; phased delivery (Part XIV).
- **Extension ecosystem gap** → curated registry + VS Code API compatibility subset + recommended first-party extensions; be transparent about compatibility.
- **Multi-server LSP/DAP complexity** → supervised out-of-process servers, lazy start, cancellation, graceful degradation to Tree-sitter/basic features.
- **Large-repo/large-file performance** → virtualization, ripgrep + index, performance modes, budgets as gates (Part XI).
- **Git edge-state confusion** → explicit in-progress-operation indicators with guided next steps; guard destructive ops.
- **Workspace-trust friction vs. safety** → sensible defaults, clear one-click trust, remembered per workspace (Part X).
- **Keymap/behavior mismatch for switchers** → multiple keymaps + import + Vim mode reduce friction; document differences.

---

*End of Part VII — IDE Core.*


---

# PART VIII — AI FEATURES

> **Purpose of this Part.** Part VIII specifies the **user-facing AI product** — every capability a developer touches — built on the engine of Part V and woven into the IDE of Part VII. It spans the full *Think · Build · Ship* loop: understanding a codebase, chatting, inline assistance, multi-file and autonomous editing, planning/thinking modes, a library of specialized agents (research, review, testing, bug-fix, refactor, docs, architecture, deployment, dependency/security, migration), visual diff review, snapshots/rollback, approval workflows, workspace rules/standards, prompt library/history, custom agents, and workflow automation. It also invents systems that push **beyond** current tools. Every feature obeys the invariants: on-device retrieval, single egress to the user's chosen provider (INV-2/4), reversible and inspectable actions, and UI that never blocks (INV-1).

---

## 124. OVERVIEW & FEATURE MAP

### 124.1 Relationship to Part V
Part V is the engine (providers, protocol, routing, context, memory, orchestration, cost, safety). Part VIII composes those primitives into products. A feature is typically: *a context recipe + a prompt/agent definition + a UX surface + an approval policy*. New features are cheap because the engine does the heavy lifting.

### 124.2 Organization by the Think·Build·Ship Loop
- **Think:** repo understanding, semantic search, knowledge graph, chat, code explanation, planning, thinking mode, research agent, architecture generation.
- **Build:** inline AI, multi-file editing, autonomous coding, refactoring, test generation, docs generation, custom agents, workflow automation.
- **Ship:** code review, bug fixing, testing/QA, dependency/security analysis, deployment agent, diff review, snapshots, Git AI actions.

### 124.3 Feature ↔ Persona Traceability (selected)
- **Maya (senior full-stack):** multi-file editing, review, snapshots, workspace rules.
- **Diego (AI engineer):** model switching, provider A/B compare, local-first agents, cost-aware autopilot.
- **Priya (indie):** autonomous coding, planning mode, background agents, cost budgets.
- **Enterprise lead:** approval workflows, audit, workspace rules/standards, on-device retrieval.
- **Learner:** code explanation, thinking mode, safe reversible edits.

### 124.4 Cross-Cutting Concepts
- **Interaction modes:** **Ask** (read-only Q&A, no edits) and **Agent** (can use tools/edit under approval). A visible toggle; Agent mode always shows what it will do.
- **Transparency:** every AI response exposes model, tokens, cost, latency, and a **context manifest** (what was sent). Optional reasoning display.
- **Reversibility:** any edit-producing feature creates a snapshot and presents a reviewable diff (§142–143).
- **Groundedness:** answers/edits cite real files/lines from the on-device index; "not found in repo" over fabrication (Part V §78.6).

---

## 125. REPOSITORY INDEXING & PROJECT UNDERSTANDING

### 125.1 The Indexer
Runs in the Rust Core (Part II §12.9): walks the workspace (respecting `.gitignore`/excludes), parses with Tree-sitter, extracts symbols, chunks code semantically (by function/class/logical block), and generates embeddings (local model or user-chosen provider — user's choice) stored in an on-device HNSW index + SQLite catalog. **All index data stays on-device (INV-4).**

### 125.2 What Is Indexed
File tree + metadata; symbols (functions, classes, types, exports); symbol relationships (defs/refs/calls/imports); semantic embeddings of code chunks + docs/comments; config/manifests (package.json, etc.); and a derived **repo map** (structure, entry points, frameworks). Secrets/binaries/huge files are skipped or summarized.

### 125.3 Incremental Indexing
File-watcher-driven incremental updates: only changed files re-parse/re-embed (content-hash cache avoids redundant embeddings, Part V §76). Initial index runs in the background with progress; the app is fully usable during indexing (AI degrades to available context with a "still indexing" note).

### 125.4 Automatic Project Understanding
On open, Axiom builds a project profile: languages, frameworks (React/Next/Django/etc.), package managers, entry points, test setup, build/run commands, and architecture shape. This powers grounded first answers ("this is a Next.js + Prisma app…"), sensible defaults (tasks/run configs), and better agent planning. Presented as an optional "Project Overview" the user can view/edit.

### 125.5 Privacy
Indexing is local; embeddings never leave the device except (if the user chose a cloud embedding provider) the *content being embedded* goes only to that user-chosen provider — and even then, embedding storage/search is local. Users can exclude paths from indexing and clear the index anytime.

### 125.6 Status & Control
A status-bar indicator shows index state (building/ready/paused/errors) with controls to pause/resume/rebuild, view coverage, and configure includes/excludes and the embedding model.

---

## 126. SEMANTIC (NATURAL-LANGUAGE) SEARCH

Natural-language code search ("where do we validate JWTs?", "the retry logic for uploads") over the on-device index using **hybrid retrieval** (vector + lexical/ripgrep + symbol graph), ranked and de-duped. Results show file/line, a snippet, and a relevance score; click to open; "add to chat context." Complements lexical search (Part VII §110) and grounds every other AI feature. Works offline if a local embedding model is configured. Serves Diego/Maya heavily; invaluable on unfamiliar large repos.

---

## 127. KNOWLEDGE GRAPH & DEPENDENCY ANALYSIS

### 127.1 The Graph
A code knowledge graph built from the symbol graph + import/dependency edges: nodes (files, symbols, modules, packages) and edges (imports, calls, extends/implements, references). Persisted on-device, updated incrementally.

### 127.2 Capabilities
- **Dependency analysis:** what depends on X; what X depends on; import cycles; dead code candidates.
- **Impact analysis:** "if I change this function, what's affected?" — powers safer refactors and review.
- **Architecture insight:** module boundaries, coupling hotspots, layering violations.
- **Third-party/dependency inventory:** packages, versions, and (with the security agent) known-vulnerability flags.

### 127.3 Visualization & Q&A
Interactive graph/diagram views (module map, dependency graph, call graph) with zoom/filter, plus natural-language Q&A over the graph ("show the request path from route to DB"). Feeds context to agents (planning, refactor, review) for grounded, whole-repo reasoning — a differentiator over file-local tools.

---

## 128. AI CHAT

### 128.1 Surface
A dockable chat (secondary side bar/panel/float, Part VII §102) with multiple **threads** per workspace, thread titles (auto-named), pinning, and search across history. Each message shows model/cost/tokens and (optional) reasoning.

### 128.2 Context Attachment
Rich context via `@` mentions and drag-drop: `@file`, `@folder`, `@symbol`, `@selection`, `@repo` (whole-repo via index), `@git` (diff/commit/branch), `@terminal` (recent output), `@problems`, `@docs` (indexed docs / attached), `@url` (fetched, permissioned), and **images** (for vision-capable models — screenshots, diagrams, error shots). The context manifest shows exactly what was included and its token cost before sending.

### 128.3 Modes
Toggle **Ask** (no edits) vs **Agent** (tools + edits under approval). Agent mode streams its plan/tool calls live and routes edits into diff review (§142).

### 128.4 Slash Commands
`/explain`, `/fix`, `/tests`, `/refactor`, `/review`, `/doc`, `/plan`, `/search`, `/commit`, `/agent <name>`, and user prompt-library entries. Slash commands are contributed (extensible) and discoverable via autocomplete.

### 128.5 Streaming & Reasoning
Responses stream token-by-token; reasoning displays per the visibility setting (hidden/summary/full, Part V §68) in a collapsible "thinking" section. Stop is always available.

### 128.6 Code Blocks & Actions
Code blocks offer: copy, insert-at-cursor, **apply as diff** (opens diff review), create-file, and run-in-terminal (for commands, under approval). Diffs are the default for anything touching real files (safe edits).

### 128.7 Citations & Grounding
Answers cite the real files/lines they used (clickable), so the developer can verify. Ungrounded claims are discouraged; "I couldn't find that in the repo" is a valid, encouraged answer.

### 128.8 History & Search
Threads persist locally (optionally sync as C2 metadata — but not code); full-text search across threads; export a thread; resume any thread with its context.

### 128.9 Model/Provider Switching
Switch model/provider per thread or per message (Part V §73.4), including "draft cheap → finalize strong." A **provider A/B compare** view can run the same prompt on two models side-by-side (§151).

### 128.10 Voice (Optional/Future)
Speech-to-text input and TTS read-back as a Post-1.0 accessibility/convenience option (infra-ready via modality abstraction).

---

## 129. INLINE AI

### 129.1 Inline Completion (Ghost Text)
Context-aware, multi-line completions as gray ghost text as you type — from single-token to whole-function, grounded in surrounding code + index context. Tab to accept, Esc to dismiss, word-by-word accept. Debounced, cached (Part V §76), and routed to a fast/cheap model by default (task profile, Part V §65.4). Never blocks typing (INV-1).

### 129.2 Next-Edit Prediction
Beyond the cursor: predict the developer's **next edit location and change** (e.g., "you renamed here; update these 3 call sites") and offer to jump+apply — a Cursor-class "tab to jump" experience that accelerates repetitive edits.

### 129.3 Inline Edit (natural-language, "Cmd-K"-style)
Select code (or place cursor) → invoke inline edit → describe the change ("make this async and add error handling") → see an inline diff → accept/reject. Great for surgical edits without leaving the editor. Multi-line and selection-scoped; snapshot-protected.

### 129.4 Inline Chat
A lightweight chat bubble anchored at the cursor for quick Q&A about the local code without opening the full panel; can escalate to an edit.

### 129.5 Quick Actions
Context-menu / code-lens / lightbulb actions on a selection or symbol: **Explain, Fix, Optimize, Add types, Add error handling, Add docs, Generate tests, Simplify, Translate (language), Find bugs**. One-click, diff-reviewed.

### 129.6 Hover Explain
Hovering a symbol offers an AI "explain" alongside LSP hover — plain-language explanation grounded in the definition and usages.

### 129.7 Comment-to-Code & Code-to-Comment
Write a comment describing intent → generate the implementation; or select code → generate an explanatory comment/docstring.

### 129.8 Accept/Reject UX
All inline edits present a clear diff affordance with accept/reject (whole or partial), keyboard-driven, and a snapshot so undo is trivial. Accepted edits count toward WAEA (Part I §2.3) only if kept.

---

## 130. MULTI-FILE EDITING (COMPOSER)

Describe a change that spans files ("add a `role` field to User across model, API, and UI") → the engine gathers cross-file context (index + knowledge graph), plans the edits, and produces a **coordinated multi-file diff**. The user reviews per-file/per-hunk (§142), applies all-or-selected, with a single snapshot for the batch (§143). Dependency-aware (updates call sites/imports/types), and iterative (the model can refine after review feedback). This is the core "Build" experience for non-trivial changes and a primary differentiator; it always runs through diff review + snapshot (safe by construction).

---

## 131. AUTONOMOUS CODING AGENT

### 131.1 What It Is
The full agent loop (Part V §72) exposed as a product: give a goal ("implement dark mode across the app," "fix all failing tests"), and the agent **plans → edits (multi-file) → runs tools (tests/build/lint) → observes → iterates → verifies → summarizes**, with human checkpoints per the approval policy.

### 131.2 Task Input
Natural-language goal + optional constraints (files in scope, acceptance criteria, "don't touch X"), attachments, and a chosen agent profile/model. Can start from a chat message, a TODO, a failing test, or an issue.

### 131.3 Plan → Execute → Verify
The agent drafts a plan (editable; see Planning Mode §132), executes steps using tools (edit, search, terminal, tests, git-read), and **self-verifies** by running tests/typecheck/lint and reading results. On failure it diagnoses and iterates (with a loop-guard that stops and explains rather than thrashing — Part V §72.3).

### 131.4 Verification-First
The agent prefers to *prove* success (green tests, clean build, matching acceptance criteria) before claiming done. If it can't verify, it says so explicitly (mirrors Axiom's own verification discipline).

### 131.5 Human-in-the-Loop
Checkpoints for consequential actions (writes/exec/network) per approval policy (§144). The user can watch the live timeline, pause, redirect, or stop at any time; everything is snapshot-protected and resumable.

### 131.6 Concurrency
Runs foreground or **background** (§149); multiple agents run in **parallel** on independent subtasks with bounded resources (Part V §72.4). Completion notifies via toast (Part VI §91).

---

## 132. PLANNING MODE

Before editing, generate an explicit, **editable plan**: ordered steps, files to touch, risks, and acceptance criteria. The user reviews/edits/approves the plan; the agent then executes against it, checking off steps live and re-planning if observations invalidate assumptions. This "spec-then-build" flow (echoing structured spec workflows) gives control and predictability for larger tasks, reduces wasted tokens, and produces a shareable record of intent. Plans can be saved as artifacts and reused.

---

## 133. THINKING MODE

Surfaces the model's reasoning (for reasoning-capable models, Part V §68) as a live, collapsible stream — step-by-step problem decomposition before the answer/edits. Visibility is user-controlled (hidden/summary/full). Value: trust, learning (great for the Learner persona), and debuggability of AI decisions. Reasoning tokens are counted in cost (transparency). For non-reasoning models, an optional lightweight "plan-then-answer" scaffold approximates it (clearly labeled as emulated).

---

## 134. AGENT LIBRARY (SPECIALIZED AGENTS)

Each is a pre-built custom agent (persona + tool scope + model routing + guardrails + rules), runnable from chat (`/agent`), the command palette, context menus, or automation (§148). All produce reviewable, snapshot-protected output.

### 134.1 Research Agent
Explores the codebase (and, if permitted, the web/docs) to answer deep questions, compare approaches, and produce a grounded report with citations — without editing. For understanding unfamiliar systems and evaluating options.

### 134.2 Review Agent — see §135.
### 134.3 Testing Agent — see §137.
### 134.4 Bug-Fix / Debugging Agent — see §136.
### 134.5 Refactoring Agent — see §138.
### 134.6 Documentation Agent — see §139.
### 134.7 Architecture Agent — see §140.

### 134.8 Deployment Agent
Assists with shipping: generates/updates CI/CD configs, Dockerfiles, IaC snippets, env/config checks, release notes, and pre-deploy checklists; runs build/test/lint locally; **flags anything that touches production or infrastructure as high-risk and requires explicit confirmation** (Part X). It never deploys to production autonomously in 1.0 — it prepares and proposes; the human ships. (Directional: gated auto-deploy Post-1.0.)

### 134.9 Dependency / Security Agent
Analyzes dependencies (via the knowledge graph + manifests): outdated/vulnerable packages, license issues, unused deps, and safe upgrade paths (with codemods where needed); scans for risky patterns (secrets in code, injection-prone code) and proposes fixes as diffs. Complements (not replaces) dedicated security tooling; findings feed the Problems panel and review.

### 134.10 Migration Agent
Executes large mechanical migrations (framework/version upgrades, API changes, language idiom updates) across the repo using the knowledge graph for completeness, applying codemods + AI edits, verifying with tests, and reporting coverage ("142/145 sites migrated; 3 need human decisions").

*(The library is extensible — teams add their own via Custom Agents §147.)*

---

## 135. CODE REVIEW (AI)

Reviews a scope (staged changes, a commit, a branch diff, or a range) and produces structured feedback: inline comments anchored to lines, each with **severity** (blocker/major/minor/nit), category (bug, security, performance, style, test-gap), rationale, and — where possible — a **suggested fix as an applicable diff**. Enforces **workspace rules/coding standards** (§145). Summarizes risk, missing tests, and edge cases. Runs on-demand, as a pre-commit/pre-PR step, or via automation (§148). The developer accepts/dismisses each comment; accepted suggestions apply through diff review. A key "Ship" feature and a strong enterprise/standards story.

---

## 136. BUG FIXING & DEBUGGING ASSISTANCE

Starts from a symptom: an error message, a stack trace, a failing test, or a bug description. The agent reproduces context (reads the trace, semantic-searches the repo, inspects the knowledge graph), forms a **root-cause hypothesis**, and proposes a **fix as a reviewable diff**. It can drive the **debugger** (Part VII §114) as a tool — set strategic breakpoints/logpoints, inspect a stopped state, evaluate expressions — and **run the failing test to confirm the fix** before claiming success. Iterates on failure with a loop-guard. Explains the bug in plain language (learning value).

---

## 137. TESTING (UNIT + INTEGRATION)

- **Generation:** produce unit and integration tests for a selection/file/module, matching the project's framework and conventions (detected via project understanding §125.4), including edge cases and error paths.
- **Execution & repair:** run tests via tasks (Part VII §115), read failures, and fix either the code or the tests (with clear labeling of which) — iterating until green or reporting blockers.
- **Coverage-aware:** identify untested paths (using coverage output + knowledge graph) and target them; avoid over-mocking; prefer meaningful assertions.
- **Test maintenance:** update tests when code changes; flag brittle tests.
- Distinct **Testing Agent** runs this end-to-end in the background for whole modules. All test edits are diff-reviewed and snapshot-protected.

---

## 138. REFACTORING

Semantic, cross-file refactors grounded in the knowledge graph (impact analysis ensures completeness): rename a concept repo-wide, extract function/module/component, inline, change signatures with call-site updates, split/merge modules, dedupe, modernize idioms, and apply design patterns. Distinguished from LSP rename by *semantic scope* and *natural-language intent* ("extract the payment logic into its own service"). Always presented as a multi-file diff (§142) with a snapshot (§143), and ideally verified by tests. The **Refactoring Agent** automates larger campaigns.

---

## 139. DOCUMENTATION GENERATION

- **In-code:** docstrings/JSDoc/type annotations for symbols, respecting the language's convention and existing style.
- **Project docs:** README, CONTRIBUTING, API references (from code + comments), module overviews, and onboarding guides — grounded in the actual repo.
- **Diagrams:** generate architecture/flow/sequence diagrams (e.g., Mermaid) from the knowledge graph, kept in Markdown.
- **Explain-to-doc:** turn a code explanation into durable documentation.
- **Freshness:** detect docs drifted from code and propose updates. All output is diff-reviewed; docs files are created only where appropriate (never spammy).

---

## 140. ARCHITECTURE GENERATION

From requirements or a description, the **Architecture Agent** proposes a design: component breakdown, data model, API surface, technology choices (with trade-offs and alternatives), and diagrams — then can scaffold the skeleton (folders, interfaces, stubs) and, on approval, flesh it into working code (multi-file editing). Grounded in the existing repo when extending a codebase (respects current architecture/patterns). Mirrors the "structure overview → skeleton → complete implementation" approach for greenfield features. Outputs are reviewable artifacts + diffs.

---

## 141. CODE EXPLANATION

Explain at any granularity — a selection, symbol, file, module, or the whole repo — at a chosen depth (one-line summary → deep walkthrough). Grounded with citations and cross-references (knowledge graph). Modes: "explain like I'm new to this codebase," "explain the tricky part," "explain this PR/diff." A cornerstone for onboarding, review, and the Learner persona. Available via hover, quick action, chat, or `/explain`.

---

## 142. VISUAL DIFF REVIEW & SAFE EDITS

### 142.1 The Review Surface
Every AI edit (inline, multi-file, agent) is presented in the **diff editor** (Part VII §105.3): per-file, side-by-side or inline, with syntax highlighting and clear add/remove/modify markers. Multi-file changes show a **change list** (files + hunks + summary) navigable as a review session.

### 142.2 Granular Accept/Reject
Accept/reject at the **hunk** and **line** level, per file, or all-at-once; edit the AI's proposed change before accepting; "apply and keep reviewing." Nothing touches disk until the user applies (or, in higher-autonomy modes, applies-then-lets-you-review with easy rollback).

### 142.3 Streaming Preview
For large edits, diffs stream in as the model produces them, so review can start immediately. Cancel leaves the workspace untouched (pre-apply) or snapshot-restorable (post-apply).

### 142.4 Safe-Edits Principles
Edits are **staged and atomic** (Part II §22): validated/parsed before apply, applied transactionally, always preceded by a snapshot (§143), and always reversible. Malformed patches are rejected with feedback to the model rather than corrupting files. This is what makes autonomy trustworthy.

---

## 143. SNAPSHOTS, CHECKPOINTS & ROLLBACK

- **Automatic checkpoints:** before any AI edit batch (inline/multi-file/agent step), Axiom snapshots the affected files (content + metadata), recorded in the event-sourced run log (Part II §16.5).
- **AI change timeline:** a per-workspace timeline of AI-induced changes (what/when/which agent/which model/cost), independent of Git, so users can review and **restore** to any prior checkpoint with one click — even across multiple agent steps ("undo the whole run" or "back to step 3").
- **Granularity:** restore a single file, a hunk, a batch, or an entire agent run.
- **Relationship to Git:** complements Git (snapshots are finer-grained, automatic, and cover pre-commit AI experimentation); users still commit via Git when ready. Snapshots are local, space-bounded (dedup + TTL), and never leave the device.
- **Crash-safe:** snapshots + run logs enable resuming/rolling back an interrupted agent run (Part VI §88).

This snapshot/rollback system is a core trust differentiator: **any AI action is undoable**, which is what allows Axiom to offer strong autonomy safely.

---

## 144. APPROVAL WORKFLOW & GUARDRAILS

- **Action classes & policies:** each tool/action is classed (read / mutate-file / exec-command / network / git-write) with a policy of **auto-approve / ask / deny**. Defaults: reads auto; file edits → diff-review (ask-to-apply); exec/network/git-write → explicit approval. Fully configurable **per workspace and per agent**.
- **Scoped allow-lists:** file-path scopes an agent may touch; command allow/deny lists; network host allow-lists; "never touch these files/globs."
- **Autonomy levels:** from **Manual** (approve every step) → **Guided** (approve consequential steps) → **Autopilot** (auto-apply within scope, review after, easy rollback). The user picks per task; higher autonomy still respects deny-lists and always snapshots.
- **High-risk gating:** destructive ops, production/infra changes, auth/security modifications, mass deletes → always explicit confirmation with impact explanation (Part X, mirrors Axiom's own safety guardrails).
- **Audit:** every AI action, approval, apply, and rollback is written to the local hash-chained audit log (Part IV §56, Part X).

---

## 145. WORKSPACE RULES & CODING STANDARDS

- **Rules files:** human-readable rules live in `.axiom/rules/*.md` (workspace, checked into the repo for teams) and in user-global rules. They encode conventions, style, architecture constraints, "always/never" directives, preferred libraries, and domain context. (Conceptually akin to `AGENTS.md`/`.cursorrules`, and Axiom can import those.)
- **Scoping & precedence:** global < workspace < path-scoped rules (glob-targeted), with priority ordering; conflicts resolved by specificity + priority.
- **Enforcement:** rules are injected into generation context (so AI writes conforming code), enforced by the **Review Agent** (flag violations), and used by refactor/test/doc features. Guardrail rules (security/safety) can't be silently overridden by prompts (Part V §71.6).
- **Team sharing:** because they're files in the repo, rules travel with the project; user-authored rules sync as C2 (Part IV). A rules editor + templates help authoring; AI can *propose* rules by observing the codebase's conventions (§151).

---

## 146. PROMPT LIBRARY & PROMPT HISTORY

- **Prompt library:** save reusable prompts (with variables, tags, scope), insert via `/slash`, palette, or context menu (Part IV §43.5). Ship a starter set (explain, review, test, refactor, doc). Team-shared prompts Post-1.0.
- **Prompt history:** every prompt/response is stored locally (searchable, re-runnable, resumable) with its context manifest and cost — so good prompts can be recovered and reused, and outcomes audited.
- **Versioning:** library entries are versioned; usage stats surface the most valuable prompts.

---

## 147. CUSTOM AGENTS

Users/teams define agents declaratively (Part V §72.9 / Part II §19.5): **name, persona/system instructions, allowed tools, model routing + fallback, guardrails (max steps, approval policy, file/command scopes), and rule bindings.** Custom agents appear alongside built-ins (`/agent <name>`), can be workspace- or user-scoped, shared via the repo (`.axiom/agents/*`), and optionally extended with code hooks. This turns Axiom into a platform: teams encode their own workflows (e.g., "our-service-scaffolder," "our-pr-reviewer") as first-class agents. A creation wizard + templates lower the barrier.

---

## 148. WORKFLOW AUTOMATION

- **Triggers (hooks):** run agents/commands automatically on events — file save/create/delete, pre-commit, post-checkout, task completion, on a schedule, or manual buttons. (Same hook model Axiom exposes generally.) Example: "on save of `*.ts`, run the review agent on the diff"; "pre-commit: generate/verify tests for changed files."
- **Chained workflows:** compose multi-agent pipelines (e.g., *plan → implement → test → review → doc*) with conditions and human gates between stages.
- **Scoping & safety:** automations respect approval policies and scopes; potentially expensive/destructive triggers require confirmation and show cost estimates; all runs are audited and snapshot-protected.
- **Management UI:** create/enable/disable/inspect automations; view run history and outcomes. Enables "set-and-forget" background quality (see the ambient health agent §151).

---

## 149. TASK QUEUE & AGENT MANAGEMENT UI

A dedicated **Agents/Tasks** view (persistent, SQLite-backed, Part V §72.5) shows: queued, running, paused, completed, and failed agent tasks; live progress and timelines; **parallel/background** runs with per-task cost, model, and step count; controls to pause/resume/cancel/retry/reprioritize; and links to each run's diff review, snapshot, and audit trail. Notifications on completion (Part VI §91). This is mission control for autonomous work — essential once multiple/background agents are in play.

---

## 150. AI OBSERVABILITY FOR USERS

Every turn/run is transparent to the user: model/provider, token breakdown (input/output/reasoning/cached), cost, latency, the **context manifest** (exactly what was sent, with the ability to inspect each included chunk), tool calls + results, and a full **trace/replay** of agent runs (step through what happened). Reasoning is viewable when available. Cost dashboards (Part IV §54, Part V §75) roll this up. This transparency is a deliberate contrast to opaque competitors and underpins trust, debugging, and cost control.

---

## 151. NOVEL / DIFFERENTIATING AI SYSTEMS (BEYOND CURSOR)

Systems invented to lead the category, not just match it:

1. **Time-Travel Agent Review.** Scrub an agent run's timeline like a video: see each decision, tool call, and diff at every step; branch from any point ("redo from step 4 with a different approach"). Turns opaque autonomy into an inspectable, editable process.
2. **Multi-Model Debate / Critic.** For high-stakes changes, one model proposes and another (or several) critiques; disagreements are surfaced to the user. Optional majority-vote/self-consistency for correctness-critical edits (Part V §80.4).
3. **Provider A/B Compare.** Run the same prompt on two providers/models side-by-side to compare quality, latency, and cost — perfect for the BYOK/AI-engineer persona choosing models.
4. **Ambient Codebase Health Agent.** A low-cost background agent (opt-in, budget-capped) that continuously watches for drift: failing tests, new lint/security issues, doc/code divergence, dead code, dependency risks — and surfaces a prioritized, one-click-fixable "health" list. Uses local/cheap models to stay affordable.
5. **Convention Learner.** Observes the repo (and accepted/rejected AI edits) to *infer* coding conventions and *propose* workspace rules (§145), so standards codify themselves over time.
6. **Cost-Aware Autopilot.** Routing that hits a quality bar at minimum spend — drafts with cheap/local models, escalates to frontier models only when needed, all within user budgets (Part V §73/§75).
7. **Local-First Autonomy.** Full agentic workflows that run entirely on local models (Ollama/LM Studio) for zero-egress, zero-cost, offline autonomy — a capability the reseller IDEs structurally can't offer.
8. **Repo Q&A Onboarding ("Explain this codebase to me").** A guided, interactive walkthrough for newcomers that tours architecture, entry points, and key flows using the knowledge graph — turning a cold repo into an understood one in minutes.
9. **Grounded Answer Guarantee.** A mode that refuses to answer about code it can't cite from the index, eliminating a whole class of hallucinations for teams that need reliability.
10. **Knowledge-Graph-Aware Refactor Safety.** Impact analysis that predicts blast radius *before* editing and verifies completeness *after* — safer large-scale change than text-only tools.

---

## 152. AI FEATURES RISKS, TRADE-OFFS & MITIGATIONS

- **Hallucination / wrong edits** → on-device grounding + citations, diff review, snapshots, verification-first agents, grounded-answer mode, multi-model critic (§135/§142/§151).
- **Over-autonomy / unwanted changes** → approval workflow, autonomy levels, deny-lists, always-snapshot, audit (§144).
- **Cost blowups from agents** → budgets, per-run caps, cost-aware routing, pre-flight estimates, cost dashboards (Part V §75).
- **Prompt injection via repo/web/tool content** → instruction/content separation, guardrails, approval gates, secret redaction (Part V §78).
- **Latency on big multi-file/agent tasks** → streaming diffs, background/parallel agents, prompt caching, off-thread work (INV-1).
- **Context quality on huge repos** → hybrid retrieval, knowledge graph, budgeting/compression, visible context manifest (Part V §69, §125–127).
- **Feature sprawl / complexity** → progressive disclosure (Ask by default, agents opt-in), consistent surfaces (diff review, approval) reused everywhere.
- **Privacy concerns** → on-device index/memory, no code to Axiom cloud, egress only to the user's chosen provider, local-first autonomy option (INV-4).

---

*End of Part VIII — AI Features.*


---

# PART IX — USER EXPERIENCE

> **Purpose of this Part.** Part IX is the complete UX specification: the design system and visual language, information architecture, every screen and panel, every onboarding step, every dialog/popup/menu/toolbar, and — critically — **every state** (loading, empty, error, success, offline, streaming, permission). It defines interaction patterns, motion, in-app messaging, forms, the settings experience, component-level accessibility, and UX writing. It is the connective tissue that makes Parts VI–VIII feel like one coherent, calm, professional product. It cross-references Part VI (platform a11y/native surfaces) and Part VII (workbench regions) rather than repeating them.

---

## 153. UX OVERVIEW, PRINCIPLES & GOALS

### 153.1 Scope
Everything the user sees, touches, and reads: pixels, states, motion, copy, and the rules that keep them consistent. The goal is an interface that is **calm at rest, powerful on demand, and never surprising**.

### 153.2 UX Principles
1. **Progressive disclosure.** Simple defaults; depth revealed as needed. A new user sees an editor and a chat box; a power user finds every knob.
2. **Keyboard-first, mouse-friendly.** Everything is reachable by keyboard; the mouse is an accelerator, not a requirement.
3. **The editor is the hero.** UI chrome recedes; content (code) dominates. AI augments, never crowds.
4. **Trust through transparency.** Show what AI will do, what it costs, and how to undo it. No hidden magic.
5. **Calm, not noisy.** Minimal notifications, gentle motion, quiet color; attention is spent deliberately.
6. **Consistency over novelty.** One way to review diffs, one way to approve actions, one component per job — reused everywhere.
7. **Fast is a feeling.** Optimistic UI, skeletons, streaming, instant feedback — perceived performance engineered (Part XI).
8. **Recoverable by default.** Every action has an obvious undo/back/cancel; destructive actions confirm.

### 153.3 Design Goals
- Feel instantly familiar to VS Code users (lower switching cost) while establishing a distinct, refined Axiom identity.
- Make AI feel **native and safe**, not bolted-on or scary.
- Hold **WCAG 2.1 AA** as the bar for UI surfaces (with the manual-testing caveat, Part VI §94).
- Support dark/light/high-contrast and full theming with zero layout breakage.

### 153.4 Relationship to Other Parts
Visual/interaction detail lives here; behavior/logic lives in Parts VI–VIII; performance budgets for UI live in Part XI; a11y platform infra in Part VI §94; a11y component patterns here (§171).

---

## 154. DESIGN SYSTEM & VISUAL LANGUAGE

### 154.1 Design Tokens (single source of truth)
All visual values are **tokens** (JSON, themable, synced): `color.*`, `space.* (4pt grid: 2/4/8/12/16/24/32…)`, `radius.* (0/2/4/8/pill)`, `font.*`, `size.*`, `elevation.* (shadow layers)`, `motion.duration.*`, `motion.easing.*`, `border.*`, `opacity.*`, `z-index.*`. Components consume tokens only (no hard-coded values), so themes and density changes propagate globally. Tokens are versioned and documented in a living style reference.

### 154.2 Color System
Semantic color tokens (not raw hex in components): `bg.{canvas,surface,raised,overlay}`, `fg.{default,muted,subtle,onAccent}`, `accent.{default,hover,active}`, `border.{default,strong,focus}`, and status colors `{info,success,warning,danger}` each with `bg/fg/border` variants. Editor/syntax colors are a separate token group (TextMate scopes + semantic tokens, Part VII §118). All pairings meet contrast targets; a contrast linter validates token combinations.

### 154.3 Typography
- **UI font:** a clean system-forward sans (e.g., Segoe UI Variable on Windows) with a bundled fallback for cross-platform consistency.
- **Code font:** a bundled monospace with ligatures (toggleable) and broad glyph coverage (CJK/Cyrillic), user-overridable.
- **Type scale:** tokenized sizes/line-heights/weights (`text.{xs,sm,md,lg,xl,2xl}`) for consistent hierarchy. Code uses its own scale independent of UI zoom.

### 154.4 Iconography
A cohesive, single-weight icon set (line style) with filled variants for active states; file/product icon themes (Part VII §118); crisp at all DPIs (SVG). AI features get a consistent, recognizable icon language (e.g., a spark/atom motif tied to the Axiom brand).

### 154.5 Grid, Spacing & Density
4pt base grid; consistent paddings/gaps from space tokens. Two density modes: **Comfortable** (default) and **Compact** (more content per screen) — both tokenized so no bespoke spacing.

### 154.6 Component Library (Catalog)
A first-party component set (Part II §12.4) covering: Button (primary/secondary/ghost/danger/icon), Input/Textarea, Select/Combobox, Checkbox/Radio/Toggle, Slider, Tabs, Tree, List (virtualized), Table (virtualized), Menu/ContextMenu, Dropdown, Tooltip, Popover/HoverCard, Dialog/Modal, Drawer/Panel, Toast/Notification, Banner, Badge/Tag, Avatar, ProgressBar/Spinner/Skeleton, Breadcrumbs, StatusBarItem, Command/QuickPick, Diff viewer, Code block, Chat message, Empty state, Split/Resizable panes, Accordion, Chips/Token input, Segmented control, Stepper/Wizard, Callout. Each ships with all states (default/hover/active/focus/disabled/loading/error), full a11y, and theming. Components are documented with usage do/don't.

### 154.7 Theming
Dark (default), Light, and High-Contrast built-ins; custom + imported VS Code themes (Part VII §118); OS auto-switch; live preview. Every component is verified across all built-in themes for contrast and legibility.

### 154.8 Brand Expression
Axiom's identity ("Think. Build. Ship.") shows in the logo/wordmark, the accent color, the AI motif, onboarding illustrations, and the empty-state art — restrained and professional, never toy-like. Splash/loading uses the wordmark subtly.

---

## 155. INFORMATION ARCHITECTURE & NAVIGATION

### 155.1 Global IA
The workbench regions (Part VII §102): Title Bar · Activity Bar · Primary Side Bar · Editor Area · Secondary Side Bar · Panel · Status Bar. Primary destinations on the Activity Bar: **Explorer, Search, Source Control, Run & Debug, Extensions, AI (Chat/Agents), Accounts/Settings (bottom)**.

### 155.2 Navigation Model
Spatial (regions/tabs) + command-driven (palette/quick-open) + contextual (right-click, code lens, lightbulb). Users can navigate entirely by keyboard. Deep links (`axiom://`) and CLI open specific files/folders (Part VI §89.5).

### 155.3 Command-First
The Command Palette (`Ctrl+Shift+P`) and Quick Open (`Ctrl+P`) are the universal fast path; every feature is discoverable there with its keybinding shown. This is the primary "search the app" affordance.

### 155.4 Wayfinding
Breadcrumbs (editor), active-view highlighting (activity bar), status-bar context (branch/lang/position/index/cost), and consistent titles/back affordances keep users oriented. Nothing traps focus or hides an exit.

---

## 156. ONBOARDING & FIRST-RUN EXPERIENCE

A resumable, skippable wizard (logic in Part VI §85). Each step below specifies **screen · states · copy tone**.

| Step | Screen | Key states |
|---|---|---|
| 0 Splash | Wordmark + subtle loader while shell boots | loading; error→safe mode (Part VI §88.3) |
| 1 Welcome + Theme | Live theme preview (dark/light/system/high-contrast) | default; high-contrast detected banner |
| 2 Keymap | Cards: Axiom / VS Code / JetBrains / Vim (+ preview of key differences) | default; "you can change later" hint |
| 3 Import | Detected VS Code/Cursor configs → checklist to import | none-detected (empty state + skip); importing (progress); partial-success (summary) |
| 4 Sign-in | Optional Google sign-in; clearly "optional — unlocks sync" | signed-out default; browser-waiting; success; canceled; offline-disabled |
| 5 Privacy/Consent | Granular toggles (crash/analytics/perf), privacy-first defaults OFF | default; "learn what we collect" expander |
| 6 AI Provider | Add key or connect local Ollama/LM Studio; health check | empty (no providers); validating; success (green); failure (actionable error); local-detected shortcut |
| 7 Open Folder | Recent / browse / try a sample project | no-recents empty state; opening; indexing-started toast |
| 8 First Action | Nudge: "Ask Axiom about this repo" with a prefilled prompt | ready; index-still-building note |
| 9 Finish | Tips + link to walkthroughs; confetti-free, calm success | done |

Onboarding never blocks: every step has **Skip / Do later**; progress is shown (stepper); state is saved; re-run available from Help. Fully keyboard/screen-reader navigable and localized.

---

## 157. WELCOME / HOME / GET STARTED

A **Welcome tab** (shown on launch when no folder is open; toggleable): sections for **Start** (New File/Folder/Clone/Connect provider), **Recent** (workspaces, pinned), **Walkthroughs** (interactive, checkmarked guided tours: "Set up AI," "Multi-file editing," "Review with AI"), **Tips** (rotating, dismissible), and **What's New** (release notes). Empty states here are inviting, not blank (illustration + primary CTA).

---

## 158. CORE SCREENS (CATALOG)

For each primary view: **purpose · layout · notable states**.

- **Editor** — code editing (Part VII §106). States: normal, diff, merge, dirty, read-only, large-file mode, no-editor (welcome), loading buffer, external-change prompt.
- **Explorer** — file tree + Open Editors/Outline/Timeline. States: populated, empty folder, no-folder-open (CTA to open), loading large dir, filtered, restricted (untrusted workspace).
- **Search** — query + filters + results tree. States: idle (prompt), searching (streaming + count), results, no-results (empty), too-many (load-more), error.
- **Source Control** — changes/staging/commit + graph. States: clean repo, changes present, no-repo (init CTA), mid-merge/rebase (guided), remote-auth-needed, conflict.
- **Run & Debug** — configs, controls, variables/watch/call-stack/console. States: no-config (create CTA), ready, running, paused (stopped frame), exception, no-adapter (install CTA).
- **Extensions** — browse/installed/recommended. States: browsing, installing (progress), installed, update-available, disabled, incompatible (labeled), offline (cached).
- **AI (Chat/Agents)** — chat threads + agent/task view. States: empty (starter prompts), streaming, agent-running (timeline), awaiting-approval, error/failover, offline (local-only), no-provider (setup CTA).
- **Settings** — GUI + JSON (§167). States: browsing, searching, modified-only filter, managed (locked) settings, reset-confirm.
- **Accounts** — profile, devices, sync status (Part III). States: signed-out, signed-in, syncing, sync-conflict, offline.
- **Diff Review** — AI change review (§159.3). States: streaming diff, per-hunk pending, applied, rejected, conflict.

---

## 159. AI EXPERIENCE UX (DEEP)

### 159.1 Chat UI
Message list (user/assistant/agent), composer with `@`-mention autocomplete, mode toggle (Ask/Agent), model picker (with cost/latency badges), attach button (files/images), and send/stop. Assistant messages: streamed text, collapsible **reasoning** section, code blocks with action bar (Apply as diff / Insert / Copy / Create file / Run), inline **citations** (clickable file:line), and a footer chip showing model · tokens · cost · latency. Threads sidebar with search/pin/rename/new. Context manifest is one click away ("what was sent").

### 159.2 Inline UI
- **Ghost text:** dimmed inline prediction; `Tab` accept (word-accept via modifier); subtle "AI" hint; never shifts layout jarringly.
- **Inline-edit bar (Cmd-K):** a compact input anchored to the selection ("describe the change"); on submit, shows inline diff with Accept/Reject/Refine; Esc cancels.
- **Lightbulb / code actions:** quick AI actions surfaced with LSP actions, clearly grouped ("AI" section).
- **Hover explain:** AI explanation appended to the hover card with "ask more."

### 159.3 Diff Review UI
A dedicated review surface (Part VIII §142): file list with change summaries + accept/reject counts; per-file diff (side-by-side/inline toggle); per-hunk and per-line accept/reject; "edit before accept"; streaming-in diffs with a progress affordance; sticky action bar (Apply selected / Apply all / Discard). Multi-file review reads like a checklist. Clear pre-apply vs post-apply (snapshot) indication.

### 159.4 Agent Timeline UI
A live, scrubbable timeline of an agent run: steps (plan, tool calls, edits, test runs) with status icons, expandable details (inputs/outputs/diffs), running cost/step counter, and controls (Pause/Stop/Resume/Redo-from-step — the time-travel feature §151.1). Completion shows a summary + links to diffs/snapshots.

### 159.5 Approval Prompts
When an action needs approval: a focused, non-modal-if-possible prompt describing the action (e.g., "Run `npm test`?", "Edit 3 files?", "Access host api.example.com?"), its class/risk, scope, and **Approve / Approve-and-remember / Deny / Always-allow-in-this-workspace**. High-risk actions use a stronger confirm with impact text (Part VIII §144, Part X).

### 159.6 Task Queue UI
The Agents/Tasks view (Part VIII §149): cards/rows for queued/running/paused/done/failed with progress, cost, model, and quick actions; filter/sort; click into a run's timeline. Background-run completions toast (Part VI §91).

### 159.7 Cost & Context Surfaces
A status-bar **cost meter** (session spend, click → dashboard); pre-action **cost estimate** chips ("~$0.03, ~4k tokens") on expensive actions with a confirm past threshold; a **context manifest** viewer (included sources, tokens each, total vs budget) available on any turn.

---

## 160. TOOLBARS & ACTION SURFACES

- **Title bar actions:** command palette entry, layout controls, AI quick-open, account menu, window controls.
- **Editor toolbar (per group):** split, more-actions (⋯), run/debug (contextual), diff toggle, and AI actions (explain/edit/tests) on the active file/selection.
- **View toolbars:** Explorer (new file/folder, refresh, collapse-all, filter); Search (replace toggle, regex/case/word, include/exclude); SCM (commit, refresh, more); Extensions (filter, sort, views); AI (new thread, model, history, settings).
- **Panel toolbar:** terminal (new/split/kill/profile), problems (filter), output (channel select).
- **Status bar items (left→right):** remote/workspace-trust, branch + sync, errors/warnings counts, editor position (Ln/Col), indentation, encoding, EOL, language mode, index status, AI model, cost meter, notifications bell. Each is clickable with a relevant action/menu; items are contributable and can be hidden.

---

## 161. CONTEXT MENUS (RIGHT-CLICK) — CATALOG

Context menus are consistent, grouped (navigation / edit / git / AI / view / advanced), keyboard-accessible, and contributable. Representative menus:

- **Editor content:** Cut/Copy/Paste, Go to Definition/References/Peek, Rename Symbol, Format Document/Selection, Change All Occurrences, Refactor…, **AI: Explain / Edit / Fix / Optimize / Generate Tests / Add Docs / Add to Chat**, Command Palette.
- **Editor tab:** Close / Close Others / Close to the Right / Close Saved / Close All, Pin, Split (Up/Down/Left/Right), Keep Open, Copy Path / Relative Path, Reveal in Explorer, Compare with…
- **Explorer item (file):** Open / Open to Side / Open With…, Cut/Copy/Paste, Copy Path/Relative Path, Rename, Delete, Duplicate, Reveal in OS, Open in Integrated Terminal, Compare Selected, **AI: Explain File / Generate Tests / Refactor / Add to Chat Context**, Git (Stage/Discard/History).
- **Explorer item (folder):** New File/Folder, Find in Folder, Open in Terminal, **AI: Explain Module / Document / Review**, Git actions, Reveal in OS.
- **Explorer background:** New File/Folder, Open Folder, Refresh, Collapse All, Toggle Hidden/Ignored.
- **Terminal:** Copy/Paste, Clear, Select All, Split, Kill, Rename, Change Color/Icon, Copy Output (shell integration), Run Recent Command, **AI: Explain Output / Fix Error**.
- **SCM change:** Open Changes (diff), Stage/Unstage, Discard, Stage Selected Ranges, **AI: Explain Change / Review**.
- **Chat message:** Copy, Edit & Resend, Retry with other model, Delete, Add to Prompt Library, Report issue.
- **Problems item:** Go to, Copy, Quick Fix, **AI: Explain / Fix**.

---

## 162. DIALOGS & MODALS

### 162.1 Types & Policy
- **Native OS dialogs** for open/save/folder-pick and critical OS confirmations (Part VI §90).
- **In-app dialogs** for product flows. Types: **Confirm** (yes/no + optional "don't ask again"), **Input** (single/multi-field with validation), **Choice/QuickPick** (list, filterable), **Progress** (determinate/indeterminate, cancelable), **Error** (message + details expander + actions), **Consent** (permissions/telemetry).
- **Modal discipline:** modals only when the flow truly requires focus; prefer non-modal panels/inline. Every modal: Esc to dismiss, focus-trapped correctly, restores focus on close, keyboard-complete, first sensible control auto-focused, primary/secondary buttons consistently placed.

### 162.2 Key Dialog Catalog (representative)
Save-changes-before-close; Delete-file confirm; Discard-git-changes confirm; Overwrite-file; Workspace-trust prompt; Add/Edit provider (with masked key); Rename-symbol preview; Reset-settings confirm; Account-deletion (multi-step, re-auth); Sign-out confirm (if unsynced); Update-ready ("Restart now/Later"); High-risk AI action confirm; Rebuild-index confirm; Clear-caches confirm; Extension-install permissions; Rate-limit/quota notice with retry/switch; Crash-recovery "Restore session?".

---

## 163. POPOVERS, TOOLTIPS, HOVERS & MENUS

- **Tooltips:** concise, delayed, show keybindings for actions; never contain essential-only info; dismiss on move/Esc.
- **Hover cards:** editor hovers (LSP + AI explain), symbol info, Git blame hover, link previews.
- **Dropdowns / Quick Picks:** filterable lists (model picker, profiles, branch picker) with keyboard nav, sections, and icons.
- **Inline widgets:** peek views, inline diff, inline-edit bar, code lens — anchored, dismissible, non-layout-breaking.
- **Menus:** app menu bar + context menus share styling, grouping, submenus, checkable items, and keyboard mnemonics.

---

## 164. NOTIFICATIONS & MESSAGING (IN-APP)

- **Toasts** (bottom-right): transient, stacked (max N, then collapse), with optional actions; auto-dismiss for info, sticky for actionable/errors; respect Focus Assist (Part VI §91).
- **Notification Center:** bell in status bar → history of notifications with actions and clear-all.
- **Banners:** view-scoped, dismissible (e.g., "Workspace is in Restricted Mode — Trust?", "Indexing…", "Offline — cloud sync paused").
- **Status-bar messages:** ephemeral progress/status ("Formatting…", "Indexed 12,340 files").
- **Badges:** counts on activity bar (Problems, SCM changes, Extension updates), gentle attention.
- **Severity & tone:** info/success (quiet), warning (amber, non-blocking), error (red, actionable, with details). Never spam; batch related notifications; user-configurable per category.

---

## 165. STATE DESIGN

The most detailed UX area — **every view designs all its states**. Global patterns below; per-view specifics captured in each view's spec (§158).

### 165.1 Loading States
- **Skeletons** for structured content (lists, trees, chat, diffs) — preferred over spinners.
- **Inline spinners** for small async actions (buttons show a spinner + disabled).
- **Progress bars** (determinate) for known-length ops (indexing, downloads, updates, multi-file apply); **indeterminate** for unknown.
- **Streaming** for AI (tokens appear live) and search (results stream); a subtle "generating…" indicator with Stop.
- **Optimistic UI** for instant actions (rename, toggle) with reconcile/rollback on failure.
- **Staged loading** on startup (shell → workspace → content) so something useful shows fast (Part VI §87.1).

### 165.2 Empty States
Every view defines a purposeful empty state (illustration/icon + one-line explanation + primary CTA + optional secondary/learn-more), never a blank void. Examples: no folder open (Open Folder / Clone / Recent), no search yet (type to search), clean repo ("No changes"), no chat yet (starter prompt chips), no providers (Add provider), no extensions installed (Browse), no debug config (Create configuration), no test results, no notifications. Distinguish **first-use** (guiding) vs **cleared/zero-data** (neutral) vs **filtered-to-empty** ("no matches — clear filters").

### 165.3 Error States
- **Inline** (form field, editor squiggle) for local/validation errors.
- **Panel/banner** for view-scoped errors (search failed, index error, sync error) with retry.
- **Dialog** for blocking/critical errors with details expander + actions.
- **AI errors** map to the taxonomy (Part V §63.7): auth (fix key), rate-limit (retry/switch/failover shown), quota, timeout, content-filter (explain), context-overflow (auto-trim offered), offline (local-only). Every error states **what happened, why, and the next action** — never a raw stack to the user (details available on demand). Nothing dead-ends.

### 165.4 Success / Confirmation States
Quiet confirmation (checkmark, brief toast, state change) — not celebratory. Applied diffs show "Applied · Undo"; saved shows the dirty dot clearing; commit shows the change list clearing; provider added shows a green health check. Undo affordances accompany consequential successes.

### 165.5 Offline / Degraded States
Clear, non-alarming indicators: status-bar "Offline" chip, banners on cloud-dependent views ("Sign-in unavailable offline," "Sync paused — will resume"), AI shows local-only availability. Editing/local features remain fully usable (Principle 4.11). Auto-recovers on reconnect with a subtle "Back online — syncing."

### 165.6 Partial / Streaming States
Diffs/answers/search stream in with clear "in progress" vs "complete" distinction; canceling mid-stream leaves a clearly-marked partial result (retained, labeled incomplete). Applied-partially states (some hunks accepted) are visible.

### 165.7 Permission / Consent States
Approval prompts (§159.5), telemetry consent (granular, revisitable), workspace trust, extension permissions, and provider/network access — all explicit, understandable, and revocable; defaults privacy-first.

### 165.8 Restricted / Managed States
Untrusted workspace (Restricted Mode banner + what's disabled + Trust CTA); enterprise-managed settings (locked, "managed by your organization"); read-only files (indicator + why).

---

## 166. FORMS & INPUT

- **Text inputs:** clear labels, placeholder ≠ label, helper text, inline validation (on blur/submit, not keystroke-nagging), error + success affordances, character limits where relevant.
- **Provider key input:** masked by default with show/hide toggle, paste-friendly, never logged/echoed, "test connection" inline, stored to SecretVault (INV-3) — the UI never displays a stored key again (shows "•••• last4" or "configured").
- **Search inputs:** instant/debounced, clear button, recent queries, regex/case toggles with tooltips.
- **Settings controls:** typed controls per setting (toggle/select/number/text/list/keybinding), with default indicator, scope tabs, and reset-to-default.
- **Validation UX:** prevent invalid submit; explain how to fix; preserve user input on error; keyboard-subm*itable.

---

## 167. SETTINGS EXPERIENCE

- **Dual view:** searchable GUI + `settings.json` (Part VII §120), always in sync; "edit in JSON" link on any setting.
- **Structure (category pages):** **General/Appearance** (theme, density, font, icons, motion), **Editor** (formatting, tabs, wrap, minimap, suggestions), **Terminal**, **Git/SCM**, **AI** (providers, models, task profiles, routing, reasoning visibility, budgets, context, memory), **Privacy & Telemetry** (granular consent), **Keybindings** (link to editor), **Extensions**, **Sync & Account**, **Advanced/Experimental** (feature flags where user-exposable). Each page: grouped settings, descriptions, defaults, per-scope tabs (User/Workspace/Folder), modified-only filter, and reset.
- **Search:** fuzzy across titles/descriptions/keys; deep-link to a setting from anywhere ("Configure…").
- **Managed settings:** locked with an org note (Part VI §96).
- **Profiles:** switch/create settings profiles (Part VII §120.4).

---

## 168. MOTION & ANIMATION

- **Principles:** motion is functional (explains change, guides attention, provides feedback), fast, and subtle. No gratuitous animation.
- **Durations/easing (tokens):** micro (~100ms) for hovers/toggles, short (~150–200ms) for panels/menus, medium (~250–300ms) for view transitions; standard easing (ease-out for enters, ease-in for exits). Motion tokens keep it consistent.
- **Where used:** panel/side-bar open-close, tab switches, menu/popover enter, toast in/out, skeleton shimmer, streaming text, progress, focus transitions, diff apply (gentle highlight), notification badge. Layout never "janks."
- **Reduced motion:** honor OS/setting → replace movement with instant/opacity-only changes; never disable essential feedback (Part VI §94).
- **Performance:** animations are GPU-friendly (transform/opacity), 60fps target, and never block input (INV-1); heavy views disable decorative motion under load.

---

## 169. INTERACTION PATTERNS

- **Drag & drop:** tabs (reorder, across groups/windows), files (move/open, from OS), panels (relocate), chat attachments; clear drop targets + insertion indicators + drag ghosts; keyboard alternatives for all DnD.
- **Resize:** all splits/panels draggable with keyboard resize too; sizes persist; sensible min/max.
- **Multi-select:** Ctrl/Shift in trees/lists; bulk actions (delete, stage, close); clear selection affordance.
- **Focus management:** logical tab order, visible focus rings (token), focus restoration after dialogs, no focus traps, "focus next region" shortcut, clear active-region indication.
- **Undo/redo:** editor undo stack + app-level undo for structural actions (with toast "Undo" affordances); AI edits undo via snapshots (Part VIII §143).
- **Selection & commands:** selection-aware toolbars/menus; consistent primary action placement.

---

## 170. KEYBOARD SHORTCUTS (UX CATALOG)

Discoverability first (palette shows all bindings; tooltips show shortcuts; a searchable cheat-sheet + printable reference). Representative **Axiom default** map (rebindable, keymaps in Part VII §119):

| Category | Action | Default |
|---|---|---|
| Core | Command Palette | Ctrl+Shift+P |
| Core | Quick Open file | Ctrl+P |
| Core | Settings | Ctrl+, |
| Core | Toggle Side Bar / Panel / Terminal | Ctrl+B / Ctrl+J / Ctrl+` |
| Edit | Save / Save All | Ctrl+S / Ctrl+K S |
| Edit | Multi-cursor add | Ctrl+Alt+↑/↓ |
| Edit | Rename Symbol | F2 |
| Edit | Format Document | Shift+Alt+F |
| Nav | Go to Definition / References | F12 / Shift+F12 |
| Nav | Go to Symbol / Line | Ctrl+Shift+O / Ctrl+G |
| Nav | Back / Forward | Alt+←/→ |
| Search | Find / Replace | Ctrl+F / Ctrl+H |
| Search | Search across files | Ctrl+Shift+F |
| Git | Commit / SCM view | (view) Ctrl+Shift+G |
| Debug | Start/Continue / Step | F5 / F10/F11 |
| Terminal | New / Split | Ctrl+Shift+` / (cmd) |
| **AI** | Open Chat | Ctrl+I (or Ctrl+L) |
| **AI** | Inline Edit (Cmd-K) | Ctrl+K |
| **AI** | Accept ghost text / next-edit | Tab |
| **AI** | Add selection to chat | Ctrl+Shift+I |
| **AI** | Run last agent / stop | (bindable) / Esc |

All AI shortcuts avoid clobbering critical editor bindings and are chosen to feel natural to VS Code/Cursor users; conflicts are surfaced (Part VII §119).

---

## 171. ACCESSIBILITY (COMPONENT-LEVEL)

*(Platform infra in Part VI §94; testing in Part XII.)*
- **Roles/names/states:** every component exposes correct ARIA (role, name, value, state, description); custom widgets follow WAI-ARIA authoring patterns (tree, listbox, combobox, tablist, dialog, menu).
- **Keyboard patterns:** standard interaction per pattern (arrow keys in trees/menus, type-ahead in lists, Esc to close, Home/End, PageUp/Down); no keyboard traps; documented shortcuts.
- **Focus:** visible, high-contrast focus indicators (token); managed focus on open/close; skip-to-region.
- **Live regions/announcements:** async events announced politely (AI streaming start/finish, task done, errors, "3 results"); nothing important conveyed by color alone.
- **Editor a11y:** Monaco screen-reader mode, audio cues (optional) for errors/breakpoints, accessible diff/merge navigation.
- **Contrast & sizing:** meet AA contrast; support UI zoom and editor font scaling without clipping; hit-target minimums.
- **Testing:** automated a11y linting + AT-based manual passes (NVDA/Narrator) in QA; the honest caveat (Part VI §94) applies — full conformance needs expert review.

---

## 172. CONTENT, VOICE & TONE (UX WRITING)

- **Voice:** knowledgeable, supportive, calm, concise — an expert peer, never condescending or hype-y (mirrors Axiom's product voice).
- **Microcopy:** buttons are verbs ("Add provider," "Apply changes"); labels are plain; avoid jargon where a simpler word works; no dark patterns.
- **Errors:** state what happened, why, and the next step; offer an action; keep the raw details behind "Show details"; never blame the user.
- **Empty states:** explain the value + one clear CTA.
- **AI output formatting:** markdown with code blocks, clear headings only when useful, citations as links, cost/model as quiet metadata; concise by default, expandable for depth.
- **Consent/permission copy:** transparent about what/why; privacy-first framing.
- **Localization:** all strings externalized (Part VI §95), ICU pluralization, no concatenation, allow for text expansion (~30%) in layouts, RTL-ready.

---

## 173. RESPONSIVE, MULTI-MONITOR & DENSITY

- **Window sizes:** graceful from small (~800px: bars collapse to icons, overflow menus, chat as overlay) to ultrawide (multi-column, side-by-side chat + editor + terminal).
- **Zoom:** UI zoom (Ctrl+=/-) and independent editor font zoom; layouts reflow without clipping (a11y).
- **Multi-monitor:** windows remember monitor/DPI; per-monitor DPI correctness; drag between monitors without blur; detached panels (e.g., floating chat/terminal) Post-1.0-ready.
- **Density modes:** Comfortable/Compact (§154.5) tokenized; touch-friendliness improvements are Post-1.0 (desktop-first).

---

## 174. UX RISKS, TRADE-OFFS & MITIGATIONS

- **AI crowding the editor** → progressive disclosure, quiet defaults, dockable/hideable AI, "editor is hero" principle.
- **State explosion (many views × many states)** → shared state components (skeleton/empty/error) + a states checklist enforced in design review and component tests (Part XII).
- **Notification fatigue** → strict severity policy, batching, per-category controls, quiet successes.
- **Familiarity vs. distinct identity** → VS Code-like ergonomics + keymap import, with a refined Axiom visual layer on top.
- **Accessibility regressions** → tokenized contrast, ARIA-by-default components, automated + manual AT testing, WCAG AA target.
- **Motion causing distraction/perf issues** → subtle, tokenized, GPU-friendly motion; reduced-motion support; disable under load.
- **Consent/approval friction vs. safety** → smart defaults, "remember" options within scope, high-risk-only hard confirms.
- **Localization layout breakage** → text-expansion-tolerant layouts, no hard-coded widths for text, RTL-ready from 1.0.

---

*End of Part IX — User Experience.*


---

# PART X — SECURITY

> **Purpose of this Part.** Part X is the enterprise security specification: the threat model, secrets/API-key management, credential and process isolation, encryption, secure local storage, the permission/capability model, file-access controls, network/egress security, supply-chain security, AI-specific security, authentication/session hardening, security logging/audit/monitoring, privacy and data protection, compliance readiness, the secure SDLC, and incident response/recovery. Security is not a feature bolted on; it is enforced **structurally** through the Part II invariants — single egress (INV-2), secrets in Main only (INV-3), no user code to Axiom cloud (INV-4) — and through defense-in-depth at every layer. Where a limitation exists (e.g., desktop attestation), it is stated honestly rather than glossed.

---

## 175. SECURITY OVERVIEW, PRINCIPLES & GOALS

### 175.1 Scope
Protecting the user's **code, credentials, and privacy**, and the **integrity** of the application and its updates, against local malware, malicious repositories/extensions/MCP servers, network adversaries, prompt-injection, and supply-chain compromise — while preserving Axiom's sovereignty promise.

### 175.2 Security Principles
1. **Sovereignty as security.** Because code and keys stay on-device and flow only to user-chosen endpoints, the highest-value assets never enter Axiom's control plane — shrinking the attack surface by design (INV-2/3/4).
2. **Defense in depth.** Multiple independent controls (process isolation, rules, validation, encryption, allow-lists, audit) so one failure isn't catastrophic.
3. **Least privilege.** Every process, extension, agent, and function gets the minimum access needed.
4. **Secure by default.** Safe defaults (privacy-first telemetry, restricted workspace trust, approval-gated agent actions); users opt into risk, not out of safety.
5. **Zero-trust of external content.** Files, repos, web results, tool output, extensions, and MCP servers are untrusted input; instructions within them are data, not commands (mirrors Axiom's own operating stance).
6. **Transparency & auditability.** Security-relevant actions are logged locally, tamper-evident, and user-inspectable.
7. **Fail safe, never fail open.** On uncertainty, deny/degrade rather than expose.

### 175.3 Security Goals
- **S1.** No API key or token ever leaves the device except to the provider it belongs to.
- **S2.** No user source code reaches Axiom's cloud (INV-4), and no code reaches any endpoint the user didn't choose.
- **S3.** A compromised renderer/extension cannot read secrets or open arbitrary egress.
- **S4.** Updates are authenticated and tamper-proof; supply chain is verified.
- **S5.** Agents cannot take destructive/high-risk actions without explicit approval and are fully audited/reversible.
- **S6.** The product is GDPR/CCPA-ready at launch and SOC 2 / ISO 27001-ready in architecture.

### 175.4 Security Invariants (recap, binding)
INV-2 (single egress gateway), INV-3 (secrets only in Main + OS store), INV-4 (no code to Axiom cloud), plus INV-6 (interface-first) and INV-7 (platform quarantine) which localize security-sensitive code. Any change touching these requires ARB + security sign-off.

---

## 176. THREAT MODEL

### 176.1 Methodology
STRIDE (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege) applied per trust boundary, complemented by attack trees for the highest-value scenarios. Maintained as a living document; revisited each release and on new features.

### 176.2 Assets (ranked)
1. **API keys / OAuth tokens** (C0) — highest value.
2. **User source code & prompts** (C1) — confidentiality-critical.
3. **On-device index/embeddings/memory** (derived from code) — sensitive.
4. **App & update integrity** — supply-chain target.
5. **Identity/session** — account takeover target.
6. **Settings/preferences & audit log** — integrity/privacy.

### 176.3 Trust Boundaries
- OS ⇄ Axiom (local malware, other apps, DPAPI).
- Main (trusted) ⇄ Renderer (untrusted) ⇄ Extension Host (untrusted) ⇄ Sidecars.
- Axiom ⇄ AI providers (user-chosen; TLS).
- Axiom ⇄ Supabase (identity/prefs/telemetry only).
- Axiom ⇄ untrusted content (repos, web, MCP servers, extensions).

### 176.4 Adversaries
Local malware/other user-context processes; malicious/compromised repositories; malicious extensions or MCP servers; network MITM/hostile Wi-Fi/proxy; prompt-injection payloads embedded in content; a compromised provider endpoint the user configured; supply-chain attackers (deps/build); and a curious/hostile insider (for enterprise deployments).

### 176.5 Attack Surface Enumeration
Installer/updater; protocol handler (`axiom://`); IPC channels; preload bridge; extension API; MCP transport; file parsers/watchers; the loopback auth server; HTTP egress; local DBs/caches; log/diagnostic files; deep links; and clipboard/drag-drop ingress.

### 176.6 STRIDE Summary (representative)

| Threat | Example | Primary controls |
|---|---|---|
| **Spoofing** | Fake auth callback; spoofed provider host | PKCE+state+nonce, loopback, egress allow-list, TLS, deep-link validation (Part III §37) |
| **Tampering** | Malicious update; altered local DB | EV-signed + hash-verified updates, downgrade protection, DB integrity checks (Part VI §86.9) |
| **Repudiation** | "I didn't approve that agent action" | Hash-chained local audit log of approvals/edits/rollbacks (§187) |
| **Info disclosure** | Key/code exfiltration via renderer/extension/AI | INV-3 (no secrets in renderer), INV-2 egress choke, secret redaction, on-device retrieval (§177/§185) |
| **DoS** | Runaway agent/extension; huge file crash | Budgets, resource ceilings, breakers, large-file mode, crash isolation (Part II §13, V §72) |
| **Elevation** | Extension escaping sandbox to Main | Sandboxed hosts, capability broker, IPC allow-list + validation (§178) |

### 176.7 Attack Trees (key scenarios)
- **"Steal the user's OpenAI key."** Paths: read from disk (mitigated: DPAPI-encrypted, not plaintext) · read from renderer (mitigated: never there, INV-3) · intercept in transit (mitigated: TLS + host allow-list) · trick AI into echoing it (mitigated: redaction + guardrails) · malicious extension reads it (mitigated: no secret API, brokered access denied). All leaf nodes have a control.
- **"Exfiltrate proprietary code."** Paths: to Axiom cloud (mitigated: INV-4 schema allow-list) · to attacker endpoint via AI (mitigated: egress allow-list to user's providers only) · via telemetry (mitigated: no code in telemetry, scrubbing) · via a malicious extension's network (mitigated: brokered/allow-listed egress) · via prompt injection instructing the agent to POST code somewhere (mitigated: egress allow-list + approval + content-as-data). 
- **"Push a malicious update."** Mitigated by signing + hash verification + protected CI signing keys + downgrade protection.

### 176.8 Residual Risks (honest)
- **Local malware with the user's privileges** can, in principle, read DPAPI-protected data *as that user* — an OS-level limitation no app fully solves; mitigated by OS protections, not eliminated. Documented, not hidden.
- **User-chosen malicious provider endpoint** — if a user configures a hostile base URL, their code goes there by their choice; Axiom warns on non-standard endpoints and shows egress transparency but cannot override user intent.
- **Desktop attestation is inherently weak** (Supabase has no App Check equivalent, and no platform fully solves desktop attestation; Part IV §61) — compensated with RLS + Edge-Function rate limiting + anomaly detection.

---

## 177. SECRETS MANAGEMENT & API KEY STORAGE

### 177.1 Secrets Inventory
Provider API keys, OAuth refresh/access tokens, custom-endpoint auth headers/tokens, and any user-entered credentials. All are **C0** (Part IV §41.3).

### 177.2 Storage
Secrets live only in the **OS secure store** via `SecretVault` (Windows Credential Manager / DPAPI; Electron `safeStorage` where appropriate) — never plaintext files, never Postgres, never logs. DPAPI encrypts per-user at rest. The vault is the sole reader/writer (INV-3, Part II §15.4).

### 177.3 `keyRef` Alias Model
Everything outside the vault references a secret by an opaque **alias** (`keyRef`), never the value (Part IV §43.8, V §66.1). Settings, sync, provider configs, UI, and logs carry aliases only.

### 177.4 Injection at Egress
The **only** place a raw key exists in memory transiently is inside the Main-process **egress gateway** at request-send time, where it's injected into the outbound request headers and immediately dropped (INV-2/3). The renderer/orchestrator send *intent + alias*, not keys.

### 177.5 Non-Exposure Guarantees
Keys/tokens are excluded by construction from: renderer memory, IPC to renderer, Postgres/Storage, analytics, crash reports, diagnostics bundles (scrubbed), and logs (redaction at sink). These exclusions are covered by automated tests (Part XII) and monitored as invariants.

### 177.6 Lifecycle & Rotation
Add (with health check) → use (inject at egress) → rotate (atomic replace; in-flight requests finish on old) → revoke/remove (on user action or account deletion). Multiple keys per provider supported (Part V §66.3).

### 177.7 Memory Hygiene
Minimize secret lifetime in memory; avoid copying; where the platform allows, use protected/zeroized buffers and avoid writing secrets to swap. Never interpolate secrets into log/format strings. Redaction utilities are centralized and mandatory.

---

## 178. CREDENTIAL ISOLATION & PROCESS SECURITY

### 178.1 Trust Tiers
Main (trusted, holds secrets/egress) · Renderer (untrusted UI) · Extension Host (untrusted third-party) · Sidecars (Core Engine, AI Orchestrator, PTY — semi-trusted, no secrets). Secrets and egress are confined to Main (Part II §13).

### 178.2 Electron Hardening (mandatory config)
`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `nodeIntegrationInWorker/SubFrames: false`, `enableRemoteModule: false`; a strict **Content-Security-Policy** (no remote script, no `eval`); disable/whitelist `will-navigate` and `window.open`; block untrusted `webContents` navigation; disable `webview` unless sandboxed; validate `sender` on every IPC message. These close the common Electron RCE/exfiltration vectors.

### 178.3 IPC Allow-Listing & Validation
Renderer↔Main channels are **allow-listed by name**; every message is **schema-validated** before handling; unknown/malformed messages are dropped and logged (Part II §14.3). This treats the renderer as potentially compromised.

### 178.4 Preload Minimalism
The preload bridge (`contextBridge`) exposes only a small, explicit, audited API surface — no raw `ipcRenderer`, no Node primitives, no secret access. The bridge is security-reviewed on every change.

### 178.5 Renderer/Extension as Untrusted
Neither can read secrets, open arbitrary sockets, or access the filesystem beyond brokered, permissioned APIs (capability broker, §181.6). Extension crashes/abuse are contained (Part II §13.4/§19.3).

---

## 179. ENCRYPTION

### 179.1 At Rest
- **Secrets:** OS-encrypted (DPAPI) via the secure store.
- **Sensitive local app data** (auth cache, memory that may contain code snippets, sensitive settings): encrypted at the app level using a key derived/wrapped by the OS secure store (so it's bound to the user/machine).
- **Index/embeddings/general caches:** integrity-checked; encryption optional/configurable (they're derived from local code the user already has on disk; encryption adds cost — offered for high-sensitivity users/enterprise policy).
- Full-disk encryption (BitLocker) is recommended to users/enterprises as the OS-level baseline.

### 179.2 In Transit
TLS for all network calls (providers, Supabase, updates); modern cipher suites; certificate validation; **certificate/host pinning** where feasible (update feed, Supabase) balanced against enterprise MITM proxies (which require configurable custom CAs, Part II §20.3). No sensitive data over non-TLS.

### 179.3 App-Level Key Management
App encryption keys are generated per-install, wrapped by the OS secure store, never hard-coded, never synced, and rotated on major security events. No secrets in source or build artifacts (scanned in CI).

### 179.4 What Is / Isn't Encrypted (transparency)
Documented matrix so users/IT know exactly what protection applies to each data class — avoiding false assurances.

---

## 180. SECURE LOCAL STORAGE

- **Stores:** SQLite (metadata, settings cache, audit, history, task queue), on-device HNSW/index, response/embedding caches, logs, snapshots.
- **Protection:** secrets never here (vault only); sensitive stores app-encrypted (§179.1); all stores integrity-checked on startup with safe rebuild/restore on corruption (Part VI §88.6).
- **Access control:** stored under the user's app-data directory with OS file permissions; the app validates paths and never follows untrusted symlinks into these stores.
- **Cleanup:** logout clears cloud-derived caches; uninstall offers full data + secret removal; snapshots/caches TTL-bounded; "clear data" controls exposed (Part VI §99).

---

## 181. PERMISSIONS & CAPABILITY MODEL

### 181.1 Workspace Trust
Opening an unfamiliar folder starts in **Restricted Mode** (Part VII §111.6): no auto-run tasks, no auto-start of workspace-provided tooling/servers, limited extension activation, agent actions extra-gated. User grants trust explicitly; remembered per workspace. Protects against malicious repos that try to execute on open.

### 181.2 Extension Permissions
Manifest-declared permissions (filesystem scopes, network hosts, AI access; secret access effectively denied). Enforced at every API call by the capability broker; undeclared access denied and surfaced. Users review permissions before install; resource ceilings apply (Part II §19.3).

### 181.3 AI / Agent Permissions
The approval workflow (Part VIII §144): action classes (read/mutate/exec/network/git-write) with auto/ask/deny policies, autonomy levels, file/command/host scopes, and mandatory hard-confirm for high-risk/destructive actions. Everything audited and snapshot-reversible.

### 181.4 Network / Host Allow-Lists
Egress destinations are constrained to configured provider endpoints (Part V), Supabase, and the update feed. Extensions/MCP/tools requesting network access are brokered against allow-lists. Unexpected destinations are blocked/flagged.

### 181.5 MCP Server Permissions
MCP servers (Part V §80.3) are configured explicitly, permission-brokered (which tools/resources, which scopes), sandboxed, and audited. Untrusted MCP tool output is treated as data (prompt-injection defense, §185). Users approve MCP connections and see what they expose.

### 181.6 Capability Broker
A central broker in Main mediates every privileged capability request (file, network, secret, exec) from renderer/extensions/agents/MCP against declared permissions + user policy — a single, testable enforcement point.

---

## 182. FILE ACCESS CONTROLS

- **Scoped access:** file operations are scoped to open workspace roots by default; access outside requires explicit user action (native picker) — no silent reads of arbitrary disk locations by extensions/agents.
- **Agent file scopes:** agents operate within configured path allow-lists; "never touch" globs are enforced (Part VIII §144).
- **Path-traversal prevention:** all paths canonicalized and validated; `..`/absolute-escape attempts rejected; long-path and reserved-name handling (Part II §18).
- **Symlink safety:** symlinks are resolved with loop detection and not blindly followed outside allowed scopes.
- **Sensitive file handling:** `.env`, key files, credential stores are flagged; the AI redacts detected secrets before egress (Part V §78.2); the app warns before committing likely-secret files (Part git safety) and before sending them as context.
- **Deletes:** prefer OS recycle bin (recoverable); permanent deletes confirm.

---

## 183. NETWORK & EGRESS SECURITY

- **Single egress gateway** (INV-2): all provider/network calls exit one hardened Main-process client; renderer/extensions cannot open arbitrary sockets.
- **Host allow-list:** egress limited to user-configured provider endpoints + Supabase + update feed; anything else blocked/flagged (anti-exfiltration).
- **TLS + proxy/CA:** enforced TLS; system/explicit proxy support; configurable custom CAs for enterprise inspection (Part II §20.3).
- **No code in telemetry/egress-to-Axiom:** telemetry/crash/diagnostics carry no code/secrets (scrubbed); Axiom's cloud gets only C2–C5 (INV-4).
- **SSRF/deep-link validation:** `axiom://` deep links and any fetch-URL tool are validated, permission-gated, and never auto-execute (Part III §37, VI §89.5).

---

## 184. SUPPLY-CHAIN SECURITY

- **Dependencies:** pinned exact versions + lockfiles; automated vulnerability scanning (deps + transitive) in CI; typosquat/name-anomaly checks; minimal, well-maintained deps preferred.
- **SBOM:** generated per release for transparency and audit.
- **Signing:** all binaries/installers/updates EV-signed; signing keys in HSM/KMS on protected CI runners, never on dev machines (Part VI §84).
- **Native binaries** (Rust sidecar, node-pty, SQLite): built reproducibly per target, pinned, verified.
- **Extensions:** signed; initial catalog reviewed; permission manifests; runtime sandbox — mitigating a major attack vector (Part VII §117.6).
- **Build integrity:** reproducible builds, protected pipelines, least-privilege service accounts, secrets in CI vaults, provenance attestation (SLSA-style direction).

---

## 185. AI-SPECIFIC SECURITY

*(Engine controls in Part V §78; here: the security framing.)*
- **Prompt injection** (top AI risk): untrusted content (repo files, web, tool/MCP output) is placed in delimited **content** regions, never instruction slots; standing guardrails treat such content as data; consequential actions require approval; suspicious "ignore previous instructions" patterns are flagged. An agent cannot be talked into exfiltrating code because egress is allow-listed and writes/commands need approval.
- **Data exfiltration via AI:** egress allow-list + secret redaction + no-code-to-Axiom + approval gates prevent an agent (or injected instruction) from sending code/keys to an unauthorized destination.
- **Tool execution safety:** exec/network/mutating tools gated, scoped, previewed, and audited; destructive ops hard-confirmed.
- **Malicious repository content:** workspace trust + content-as-data + sandboxing prevent a hostile repo from executing on open or hijacking the agent.
- **Output safety:** generated code is parsed/validated before apply; the security agent (Part VIII §134.9) can review AI output for introduced vulnerabilities.
- **Model/provider trust:** the user chooses providers; Axiom is transparent about where data goes (egress transparency, context manifest) so users make informed choices.

---

## 186. AUTHENTICATION & SESSION SECURITY

Recap of Part III §37 as security controls: PKCE + state + nonce; system-browser-only OAuth; loopback-preferred redirect; refresh/access tokens in the secure store (never renderer/cloud/logs); single-use PKCE authorization code exchanged for a session (`exchangeCodeForSession`), worthless without the locally held code verifier; constant-time comparisons; server-authoritative PostgreSQL Row Level Security independent of client tokens; revocation propagation ("sign out everywhere"); rate-limited auth/session Edge Functions; no password handling (delegated). Known limitation: desktop attestation is inherently weak (Supabase has no App Check equivalent), compensated by RLS + rate-limits + anomaly detection.

---

## 187. SECURITY LOGGING, AUDIT & MONITORING

### 187.1 Local Audit Log (authoritative)
An append-only, **hash-chained** (tamper-evident) local log of security-/trust-relevant events, stored in SQLite, user-viewable/exportable (Part IV §56).

### 187.2 What's Audited
Sign-in/out, device registration/revocation, secret add/rotate/remove/access (by alias, never value), provider-config changes, AI edits applied, agent actions + approvals + denials, snapshots created/restored, high-risk confirmations, settings resets, network egress metadata (destination/model/bytes — not payload), and account deletion.

### 187.3 Tamper-Evidence
Each entry chains a hash of the previous (Merkle-style), so deletion/alteration is detectable. The user (and enterprise policy) can rely on it for after-the-fact review; optional cloud mirror for cross-device transparency (C5, Part IV §56.2).

### 187.4 Redaction
Logs and audit entries **never** contain secrets or full code (edits referenced by file + snapshot id). Redaction is applied at the sink and tested (Part XII). Diagnostics bundles are scrubbed by construction.

### 187.5 Anomaly Detection (opt-in, cloud side)
On the backend, anomaly detection watches for suspicious patterns (many new devices, token-mint abuse, impossible-travel-style signals) and can prompt the user to review devices or trigger protective measures (Part IV §31.4/§60).

### 187.6 Incident Signals
Repeated auth failures, egress to unexpected hosts (blocked + logged), extension permission violations, and integrity-check failures are surfaced to the user and (opt-in) telemetry for detection.

---

## 188. PRIVACY & DATA PROTECTION

### 188.1 Data-Flow Map (authoritative)

| Data | Where it goes | Notes |
|---|---|---|
| Source code / prompts | User's chosen AI provider only (or local = nowhere) | Never to Axiom cloud (INV-4) |
| API keys / tokens | OS secure store (local); provider (in request) | Never to Axiom cloud/logs/renderer |
| Index/embeddings/memory | On-device only | Content embedded goes only to user-chosen embed provider if cloud embeddings selected |
| Identity (uid/email/name/avatar) | Supabase Auth | For auth/profile |
| Settings / prompts / rules (C2/C3) | Supabase (Postgres, if sync on) | User-authored, small; opt-in |
| Telemetry / analytics / crash | Telemetry sink (Edge→Postgres; opt-in) | Anonymized, bucketed, no code/secrets |
| Audit log | Local (opt-in cloud summary) | Hash-chained; no code/secrets |

### 188.2 Data Minimization
Collect the least, for the shortest time; opt-in for anything beyond core function; TTL/retention on cloud data (Part IV §59); no code ever leaves to Axiom.

### 188.3 Consent
Granular, revisitable consent for crash/analytics/performance telemetry and cloud sync; privacy-first defaults (off); turning off disables the network calls (not just UI).

### 188.4 On-Device by Default
Retrieval, index, memory, history, snapshots, audit — all local. This is the core privacy stance and a key differentiator for regulated/enterprise users.

### 188.5 User Rights
Data export (portability) and account deletion (erasure) flows (Part III §32); local data fully user-controlled (clear/exclude/forget); transparency via the data-flow map and in-app privacy page.

### 188.6 Third-Party Providers
Egress to AI providers is governed by the **provider's** terms/privacy — Axiom is transparent that the user's chosen provider receives the code/prompts the user sends, surfaces this clearly (egress transparency, context manifest), and recommends local models for maximum privacy. Axiom does not add itself as an intermediary (no proxying).

### 188.7 Policy Alignment
The product's behavior matches a clear, plain-language privacy policy; the data-flow map is the source of truth engineers implement against and legal reviews.

---

## 189. COMPLIANCE READINESS

- **GDPR / CCPA (launch-ready):** lawful-basis-friendly (consent + minimization), data-subject rights (access/export/erasure/rectification via profile + deletion flows), records of processing (data-flow map), and DPA-ready backend (Supabase). Because no code is stored, the sensitive-data footprint is minimal.
- **SOC 2 / ISO 27001 (architecture-ready, certification Post-1.0):** the controls here (access control, encryption, audit, change management, incident response, vendor management) map to common criteria; formal audit is a Post-1.0 program with the groundwork laid now.
- **Data residency:** minimal cloud data reduces residency risk; region-pinning/self-hosted backend is a Post-1.0 enterprise option behind `IBackendService` (Part IV §41.4).
- **Enterprise controls:** managed policy (ADMX/MSI), telemetry-off, provider allow-lists, controlled updates, audit export (Part VI §96).
- **Responsible disclosure:** a published security contact + vulnerability disclosure policy; coordinated disclosure; a security.txt.
- **Assurance:** third-party **penetration test as a GA gate** (§190); periodic re-testing; (Post-1.0) bug bounty.

---

## 190. VULNERABILITY MANAGEMENT & SECURE SDLC

- **Secure coding standards** + security-focused code review for sensitive areas (auth, egress, secrets, IPC, extension host).
- **Automated scanning in CI:** SAST (static analysis), dependency/SCA scanning, secret scanning (block secrets in commits), IaC/config scanning, and DAST-style checks where applicable — as **release gates** (Part XII).
- **Fitness functions** enforce security invariants (no secret access from renderer packages, egress only from Main, no code columns in Postgres tables/schemas).
- **Pen-test gate:** an independent penetration test must pass (criticals/highs remediated) before GA; re-test on major releases.
- **Patch & response:** a defined SLA for vulnerability triage/patch by severity; security updates ship via fast-tracked auto-update with kill-switch/rollback (Part VI §86).
- **Bug bounty:** Post-1.0, once the disclosure program matures.

---

## 191. INCIDENT RESPONSE & RECOVERY

- **IR plan:** defined roles, severity classification, detection sources (telemetry/anomaly/user reports/scanners), containment, eradication, recovery, and post-mortem with corrective actions.
- **Kill switches & remote controls:** feature flags (Part IV §57) can disable a compromised feature, force clients off a bad/insecure version, and disable telemetry fleet-wide (VI §86.4).
- **Credential compromise response:** "sign out everywhere" (token revocation), guidance to rotate provider keys (which never left the device), and forced re-auth; because keys are local, an Axiom-side breach cannot leak them.
- **Update-based remediation:** signed emergency updates with staged rollout + rollback; downgrade protection preserved.
- **Data recovery:** local WAL journals + snapshots + rebuildable indexes + managed Supabase backups (point-in-time recovery) ensure recoverability (Parts VI §88, IV §59); documented runbooks.
- **Communication:** status page, in-app announcements (Part IV §43.14), and coordinated disclosure for security issues; clear user guidance on any required actions.

---

## 192. SECURITY RISKS, TRADE-OFFS & RESIDUAL

- **Local malware at user privilege** → OS/DPAPI protections + full-disk-encryption guidance; residual (OS-level limitation, documented §176.8).
- **User configures a hostile provider endpoint** → egress transparency + non-standard-endpoint warnings; cannot override informed user choice (residual by design).
- **Weak desktop attestation (no App Check equivalent)** → RLS + rate-limits + anomaly detection compensate (Part IV §61); residual reduced, not zero.
- **Prompt injection sophistication** → layered controls (content-as-data, allow-listed egress, approval, redaction); an evolving threat monitored continuously.
- **Extension/MCP supply chain** → signing, review, permissions, sandbox, allow-lists; residual mitigated by least privilege + audit.
- **Enterprise MITM vs. pinning** → configurable custom CAs (trade-off: honor corporate inspection while validating TLS).
- **Convenience vs. safety friction** → secure defaults + scoped "remember" approvals + high-risk-only hard confirms balance usability and protection.

Overall posture: because Axiom's architecture keeps the crown-jewel assets (keys, code) **on the device and out of its own cloud**, the most damaging breach classes are structurally constrained — the strongest possible foundation for an AI IDE's security story.

---

*End of Part X — Security.*


---

# PART XI — PERFORMANCE

> **Purpose of this Part.** Part XI turns "Performance is a feature" (Principle 4.6, Tenet 7) into **measurable, release-blocking contracts**. It defines explicit budgets and SLOs (cold/warm start, input latency, file open, search, indexing, memory), the strategy for **extremely large repositories** and **very large files**, cold-start optimization, memory management, caching, worker-thread concurrency and parallelism, GPU utilization, AI/network performance, disk/I-O, measurement/profiling, orchestration scalability, and power/thermal efficiency. It obeys INV-1 (UI never blocks) above all: no feature — AI, indexing, sync, telemetry — may degrade the editor hot path. Budgets here are enforced as CI gates (Part XII); regressions are blockers.

---

## 193. PERFORMANCE OVERVIEW, PHILOSOPHY & GOALS

### 193.1 Scope
End-to-end performance of the desktop app: how fast it starts, how responsive it feels while editing, and how gracefully it scales to huge codebases and files under heavy AI/indexing load — on realistic developer hardware, not just high-end machines.

### 193.2 Philosophy
1. **Perceived performance is engineered.** Optimistic UI, skeletons, streaming, and staged loading make the app *feel* instant even when work is ongoing.
2. **The hot path is sacred.** Keystroke→render is the most protected budget in the product (INV-1). Everything heavy is off-thread (workers/Rust sidecars).
3. **Budgets are contracts.** Every SLO has a number, a measurement method, and a CI gate. "It feels fine" is not acceptance.
4. **Scale by design, not by hardware.** Virtualization, laziness, incrementality, and bounded resources — not "buy more RAM" — deliver large-repo performance.
5. **Bounded everything.** Caches, queues, pools, memory, and agent runs all have explicit ceilings with eviction/back-pressure.

### 193.3 Goals
- **P1.** Fast cold start to an interactive shell; near-instant warm start.
- **P2.** Frame-perfect editor input latency and 60fps scrolling, even during indexing/AI.
- **P3.** Usable on 1M+ file repos and multi-GB working trees.
- **P4.** Open and edit very large/minified files without freezing.
- **P5.** Bounded, predictable memory; no unbounded growth or leaks.
- **P6.** Background indexing that never blocks interaction and resumes after restart.
- **P7.** Efficient CPU/GPU/battery use, especially when idle/backgrounded.

---

## 194. PERFORMANCE BUDGETS & SLOs

Targets are measured on a **reference machine** (mid-range dev laptop: 4-core/8-thread CPU, 16 GB RAM, SSD, integrated GPU) unless noted, and validated across a low-end tier (4 GB–8 GB) with graceful degradation. `p50/p95` are medians/95th percentiles from telemetry + benchmark harness.

| # | Metric (SLI) | Target (SLO) | Gate |
|---|---|---|---|
| B1 | Cold start → interactive shell (window + input) | p50 ≤ 1.5 s, p95 ≤ 3.0 s | Blocking |
| B2 | Cold start → last workspace restored (tabs interactive) | p95 ≤ 5.0 s | Blocking |
| B3 | Warm start (recent launch) | p50 ≤ 0.8 s | Blocking |
| B4 | Keystroke → on-screen render (editor hot path) | p95 ≤ 1 frame (~16 ms); hard ceiling 33 ms | **Hard blocking** |
| B5 | Scroll / minimap / large-doc navigation | sustained 60 fps (no frame > 33 ms) | Blocking |
| B6 | Open typical file (< 1 MB) → editable | p95 ≤ 150 ms | Blocking |
| B7 | Open large file (see §198) → editable (perf mode) | p95 ≤ 1.5 s (50 MB) | Blocking |
| B8 | Command Palette / Quick Open first results | p95 ≤ 100 ms | Blocking |
| B9 | Workspace search first results (large repo, ripgrep) | p95 ≤ 300 ms | Blocking |
| B10 | Inline completion first token (fast/local profile) | p50 ≤ 300 ms, p95 ≤ 800 ms | Target |
| B11 | Chat first token (cloud, streaming) | p50 ≤ 1.0 s (provider-dependent) | Target |
| B12 | Incremental index update (single file save) | p95 ≤ 500 ms to searchable | Blocking |
| B13 | Full index throughput (parse+symbol) | ≥ ~10k files/min on reference HW | Target |
| B14 | Memory at rest (small workspace, idle) | ≤ ~600 MB working set | Blocking |
| B15 | Memory (large repo, indexed, idle) | bounded & documented; no unbounded growth | Blocking |
| B16 | Idle CPU (focused, no work) | ≤ ~1% average | Blocking |
| B17 | Idle CPU (backgrounded) | ≈ 0% (throttled) | Blocking |
| B18 | Crash-free sessions | ≥ 99.5% | Blocking |
| B19 | UI action → visible feedback (any click) | ≤ 100 ms (optimistic/skeleton) | Blocking |

"Blocking" = a regression past the threshold fails CI / blocks release. Targets marked "Target" depend on external factors (provider latency, model, HW) and are tracked but not hard-gated.

---

## 195. COLD & WARM START OPTIMIZATION

- **Staged startup** (Part VI §87.1): paint window frame → shell skeleton → restore workspace metadata + tab list (lazy content) → activate essential services → lazily spin up sidecars + resume background indexing. The first paint never waits on heavy work.
- **Lazy service activation** (Part II §17.2): debugger, extension host, embeddings host, and non-essential services start on first use, not at boot.
- **Code splitting & lazy modules:** the renderer bundle is split so the editor + shell load first; heavy views (settings, extensions, graph viz) load on demand.
- **Startup snapshots/caching:** V8 code-cache / snapshotting for hot JS, precompiled/persisted where the framework allows, to cut parse/compile time.
- **Preload minimalism:** the preload bridge is tiny (Part X §178.4), reducing startup cost and attack surface.
- **Warm start:** process/service reuse and cached workspace state make relaunch near-instant.
- **Measurement:** a startup timeline (phase markers) is captured in dev/CI and (bucketed) in telemetry; regressions are gated (B1–B3).

---

## 196. EDITOR & UI RESPONSIVENESS

- **Input-latency budget (B4)** is the top priority: keystroke handling, tokenization, and rendering for the visible viewport complete within a frame. Anything that can't (full-file re-tokenize, diagnostics, AI) is deferred/off-thread.
- **Main-thread protection (INV-1):** no sync CPU/I-O > 16 ms on the UI thread; work is chunked with time-slicing/`requestIdleCallback`-style scheduling and moved to workers/sidecars.
- **Rendering pipeline:** GPU-accelerated compositing; only dirty regions repaint; animations use transform/opacity (§203).
- **Virtualization everywhere:** editor viewport, file tree, search results, Problems, terminal scrollback, chat history, diff lists, task queue — render only what's visible.
- **Debounce/throttle:** diagnostics, highlighting, autocomplete, search-as-you-type, and index triggers are debounced; streams coalesce to ≤ 60 fps (Part II §14.4).
- **Optimistic UI:** instant feedback for rename/toggle/apply with reconcile/rollback (Part IX §165.1).
- **Concurrency isolation:** interactive work is prioritized over background agents/indexing (fair scheduling, §202) so typing never stalls.

---

## 197. LARGE REPOSITORY STRATEGY

**Scale target:** repositories with **1M+ files** and multi-GB working trees remain usable.

- **File tree:** lazy directory expansion + virtualization (Part VII §104.1); incremental load with "showing N of M"; never eagerly enumerate the whole tree.
- **Search:** ripgrep via the Rust Core (Part II) streams results, respects ignores, and bounds output (max results + "load more"); regex/glob filters narrow scope; cancellable.
- **Indexing at scale:** incremental, prioritized, resumable, content-hash-cached, memory-mapped storage (§199); partial/scoped indexing options; per-workspace budgets so a giant monorepo can index the relevant subset first.
- **Git at scale:** sparse-checkout/partial-clone awareness, virtualized diffs/history, and background status computation so SCM never blocks (Part VII §113.9).
- **Memory at scale:** heavy structures live in the Rust Core (out of Node/Chromium heaps), memory-mapped; the file model stores lightweight nodes; caches capped (§200).
- **Watchers at scale:** efficient recursive OS watch APIs with debouncing/coalescing and ignore-aware filtering to avoid event storms (Part II §18); fall back to polling only where necessary, scoped.
- **Graceful degradation:** on extreme repos, embeddings/semantic features may index incrementally while lexical search + structure work immediately (clear "indexing" status, Part VIII §125.6).

---

## 198. LARGE FILE SUPPORT

- **Thresholds (configurable):** e.g., > 5 MB or > ~50k lines → **performance mode**; > ~256 MB → restricted viewer.
- **Performance mode:** disable minimap, heavy tokenization, word-wrap, and some decorations; use coarse/streamed highlighting; warn before expensive ops (format/replace-all).
- **Virtualized/streamed rendering:** load and render in chunks; never hold/format the entire file synchronously; memory-mapped/chunked reads for huge files.
- **Tokenization limits:** cap per-line and per-file tokenization work; long-line handling to avoid pathological regex/tokenizer blowups.
- **Binary/minified detection:** detect binaries (open appropriate viewer or hex) and minified/generated files (offer to skip formatting/indexing, collapse).
- **Editing safety:** atomic writes regardless of size; large-file edits stay responsive; AI features on huge files operate on windows/ranges, not the whole blob.

---

## 199. PROJECT INDEXING PERFORMANCE

- **Incremental & event-driven:** only changed files re-parse/re-embed (watcher-driven); **content-hash cache** skips unchanged content (avoids re-embedding — a major saving, Part V §76).
- **Prioritization:** open/active files and their dependencies index first; the rest fills in background (so AI is grounded on what you're looking at immediately).
- **Throughput:** parsing/symbol extraction in the Rust Core (parallel, work-stealing pool); embeddings batched (and, for local models, GPU-accelerated via the runtime).
- **Back-pressure & limits:** bounded concurrency + CPU/memory ceilings so indexing never starves interactive work; auto-throttle under load/on battery (§208).
- **Persistence:** the index (SQLite catalog + memory-mapped HNSW) persists across restarts and **resumes** where it left off; rebuildable from source if corrupted (never authoritative over code).
- **Progress & control:** visible status, pause/resume/rebuild, include/exclude config, and embedding-model choice (Part VIII §125.6).

---

## 200. MEMORY MANAGEMENT & OPTIMIZATION

- **Multi-process budgets:** per-process working-set targets (Main, each renderer, sidecars) monitored against B14/B15; the Rust Core owns heavy data to keep Node/Chromium heaps small.
- **Bounded caches:** every cache (index, embeddings, response, search, LSP, thumbnails) has a size cap + **LRU eviction** + TTL; total on-disk cache footprint is capped with a "clear caches" action (Part VI §92.5).
- **Leak prevention:** listener/subscription lifecycle discipline (Part IV §48.3), pooled+recycled workers, and leak-detection tests in CI (heap snapshots over long sessions).
- **Memory watchdog:** monitors pressure; under low memory it sheds caches, pauses background agents/indexing, and warns — degrading gracefully instead of OOM-crashing.
- **GC tuning:** appropriate V8 heap limits per process; avoid large transient allocations on the hot path; stream/iterate rather than materialize large arrays.
- **Large structures off-heap:** memory-mapped index/vectors; strings/buffers reused; diff/tokenization results bounded.

---

## 201. CACHING (PERFORMANCE-WIDE)

Consolidated view (mechanics across Parts IV/V):
- **Startup cache** (V8 code cache, workspace state) → faster boot.
- **Index/symbol/vector cache** (on-device, persisted) → instant semantic features after first index.
- **Embedding cache** (content-hash keyed) → skip re-embedding unchanged code.
- **AI response/prompt cache** (exact + provider prompt caching) → cut cost & latency (Part V §76).
- **Search cache** (recent queries/results) and **LSP result cache** → snappy repeat operations.
- **Invalidation:** content-hash + file-watcher driven; never serve stale results across edits; version-stamped for schema changes.
- **Footprint:** all caches capped + evictable; caches are always rebuildable and never the source of truth.

---

## 202. CONCURRENCY: WORKER THREADS & PARALLELISM

- **Renderer web workers:** diffing, tokenization/highlighting assist, fuzzy matching, JSON parsing, and other CPU tasks run off the UI thread; results posted back in frame-friendly chunks.
- **Node worker threads / child processes:** heavier Node work and the sidecars (Core Engine, AI Orchestrator, PTY) run out of Main.
- **Rust async (Tokio):** the Core Engine uses a bounded work-stealing pool for parallel parsing/indexing/search; chunked and cancellable.
- **Bounded pools + fairness:** all pools are size-bounded with priority scheduling (interactive > background) and back-pressure so no subsystem monopolizes CPU.
- **Cancellation-first:** every long task takes a cancellation token propagated across IPC (Part II §13.2); "Stop" is instant end-to-end.
- **Parallel agents:** multiple/background agents run concurrently within a bounded pool and per-run resource/cost ceilings (Part V §72.4, §207).

---

## 203. GPU UTILIZATION

- **UI rendering:** Chromium GPU-accelerates compositing, scrolling, and animations, keeping the editor smooth at high refresh/DPI (B5). Animations are transform/opacity-based (GPU-friendly).
- **Canvas/WebGL viz:** large visualizations (dependency/knowledge graph, big diffs, minimap) use GPU canvas where beneficial, with level-of-detail and virtualization for huge graphs.
- **Fallback & robustness:** automatic software-rendering fallback if GPU is unavailable/blocklisted or the GPU process crashes (isolated + auto-restart); a setting to force software rendering; GPU status in diagnostics (Part VI §93).
- **Local model GPU:** inference GPU use is delegated to Ollama/LM Studio (the user's runtime); Axiom surfaces status but doesn't manage GPU inference itself.

---

## 204. AI & NETWORK PERFORMANCE

- **Streaming-first:** tokens render as they arrive; first-token latency (B10/B11) is what users feel — optimized via fast/local model routing for interactive tasks and provider prompt caching for multi-turn/agent loops (Part V §69.6/§76).
- **Off-thread token counting/context building:** tokenization and RAG assembly run in workers/Core so they never stall typing (INV-1).
- **Concurrency limits & queueing:** per-provider concurrency caps + fair queue avoid 429s and keep interactive requests ahead of background ones (Part V §77).
- **Perceived-latency techniques:** show "thinking"/skeleton instantly, stream reasoning, prefetch likely context, cache autocomplete, and use cheap-draft→strong-final routing.
- **Local = fastest & free:** local models (Ollama/LM Studio) give low, network-independent latency and zero cost — preferred for autocomplete/interactive under latency-optimized/privacy-first routing (Part V §73).

---

## 205. DISK & I/O PERFORMANCE

- **Async, non-blocking I/O** for all file ops; never block the UI thread on disk.
- **Batching & coalescing:** group small writes (journal, telemetry queue, index updates); debounce watcher-driven work.
- **SQLite tuning:** WAL mode, appropriate `synchronous`/`cache_size`/`mmap` pragmas, prepared statements, and transactions for bulk writes; periodic checkpointing.
- **Atomic writes:** temp + fsync + rename for durability without corruption (Part II §22).
- **Watcher efficiency:** OS-native recursive watchers with ignore-aware filtering + debouncing to avoid event storms on large trees (§197).
- **Disk-full handling:** detect low disk, pause non-essential writes, warn, degrade — never crash (Part II §22).

---

## 206. STARTUP/RUNTIME MEASUREMENT & PROFILING

- **Built-in performance tooling:** a startup timeline view, a "record performance profile" command (CPU/memory), and per-operation timers surfaced in a developer/diagnostics panel.
- **Telemetry (opt-in, bucketed):** cold/warm start, TTI, input-latency histograms (aggregated locally, summaries uploaded — never raw keystrokes), index throughput, memory gauges, crash-free rate (Part IV §53). Feeds SLO dashboards (B1–B19).
- **Benchmark harness & fixtures:** reproducible benchmarks against **reference corpora** — a huge synthetic monorepo (1M+ files), very large files (50–256 MB), deep dependency graphs — run in CI on fixed hardware.
- **Regression gates:** performance CI gates compare against baselines with tolerances; blocking regressions fail the build (Part XII). Flame graphs/traces attached to regressions for triage.

---

## 207. SCALABILITY OF AI ORCHESTRATION

- **Many concurrent/background agents** run within a **bounded worker pool** with fair scheduling and **back-pressure**; new tasks queue (persistent, SQLite-backed) rather than overwhelming the system (Part V §72.4/§72.5).
- **Per-run ceilings:** step budget, wall-clock timeout, cost cap, and concurrency limits prevent any single run (or a swarm) from exhausting CPU/memory/spend; on breach → pause for user decision.
- **Resource isolation:** the orchestrator runs out-of-process so long/heavy runs never affect editor latency (INV-1); interactive AI (chat/inline) is prioritized over background agents.
- **Graceful saturation:** when saturated, the queue holds tasks with clear status; the UI stays responsive; the user can reprioritize/cancel (Part VIII §149).

---

## 208. BATTERY, THERMAL & RESOURCE EFFICIENCY

- **Idle reduction (B16/B17):** on idle/blur, throttle timers, pause/slow indexing + background agents, reduce frame rate, and release non-essential caches (Part VI §92.3); resume on focus.
- **Power awareness:** detect on-battery/low-power and reduce background intensity (lighter indexing concurrency, defer non-urgent work), configurable.
- **Thermal friendliness:** bounded parallelism and back-pressure avoid pegging all cores; heavy work is schedulable/deferrable.
- **Efficient defaults:** local model routing for cheap/fast interactive tasks reduces network and battery cost; telemetry batched and sparse.

---

## 209. PERFORMANCE TESTING & GATES (POINTER)

Full methodology in Part XII. Summary: automated **performance suite** (startup, input latency, scroll, open-file, search, index) on fixed hardware; **load/stress tests** (huge repo, huge file, many agents, high terminal throughput); **soak tests** (long sessions for leaks); baseline comparison with **release-blocking gates** for the "Blocking" SLOs (B1–B9, B12, B14–B19). Results tracked over time to catch slow drift.

---

## 210. PERFORMANCE RISKS, TRADE-OFFS & MITIGATIONS

- **Electron baseline weight** → Rust sidecars for heavy work, staged/lazy startup, strict budgets, multi-process sharing; Tauri path kept open (Part II §12.2).
- **Indexing/embeddings cost on huge repos** → incremental + content-hash cache + prioritization + budgets + partial indexing + graceful lexical-first degradation.
- **Memory growth with large repos/long sessions** → off-heap Rust structures, capped/evicted caches, watchdog, leak tests, soak testing.
- **AI latency variability (external providers)** → streaming, prompt caching, fast/local routing, cheap-draft→strong-final, perceived-latency UX; some latency is provider-bound (tracked, not hard-gated).
- **Background work vs. interactivity** → priority scheduling, back-pressure, idle/on-battery throttling; interactive always wins (INV-1).
- **Huge/minified files** → performance mode, virtualization, windowed AI, binary detection.
- **GPU driver instability** → software fallback + isolation + force-software setting + diagnostics.
- **Perf regressions creeping in** → CI perf gates on fixed hardware, baselines with tolerances, telemetry SLO dashboards, blocking thresholds.

---

*End of Part XI — Performance.*


---

# PART XII — QUALITY & TESTING

> **Purpose of this Part.** Part XII defines how Axiom achieves and *proves* production quality: the testing strategy and pyramid, the Definition of Done, and every test discipline the brief requires — unit, integration, end-to-end, AI-evaluation, regression, accessibility, security, performance, stress, load, compatibility, recovery, and soak — plus manual/exploratory QA, test automation, CI/CD quality gates, release management/sign-off, bug management, and quality KPIs. Quality is **shift-left** (built in, not inspected in) and **gated** (release-blocking checks in CI). It operationalizes the standards asserted throughout Parts I–XI (e.g., the performance SLOs in Part XI, the security invariants in Part X, the a11y target in Parts VI/IX).

---

## 211. QUALITY OVERVIEW, PHILOSOPHY & GOALS

### 211.1 Scope
All verification activities and infrastructure that gate a change from a developer's machine to a user's install, across the desktop app, Rust Core, AI engine, and Supabase backend.

### 211.2 Philosophy
1. **Shift-left.** Bugs are cheapest to catch early — strong typing, linting, unit tests, and fitness functions run on every commit.
2. **Quality gates, not quality theater.** Every critical property (perf SLO, security invariant, a11y, rules) has an automated gate; "looks fine" is not sign-off.
3. **Test behavior, not implementation.** Tests target contracts/user outcomes so refactors don't break the suite.
4. **Determinism first.** Flaky tests are treated as bugs; external nondeterminism (AI, network) is isolated behind fakes/fixtures.
5. **Every bug becomes a test.** A fixed bug ships with a regression test that would have caught it.
6. **Dogfood relentlessly.** The team builds Axiom in Axiom (self-hosting) — the highest-signal continuous test.

### 211.3 Goals
- **Q1.** High-confidence releases with a low escaped-defect rate and ≥ 99.5% crash-free sessions (Part XI B18).
- **Q2.** Fast CI (< ~15 min for the standard gate) so quality doesn't slow delivery.
- **Q3.** Automated coverage of all critical journeys + release-blocking gates for perf/security/a11y/rules.
- **Q4.** A repeatable, low-risk release process with staged rollout and one-click rollback.

---

## 212. QUALITY STRATEGY & THE TEST PYRAMID

A pragmatic pyramid plus specialized layers:

```
          ▲  Manual / Exploratory / Dogfooding (high value, low volume)
         ███ E2E (Playwright→Electron): critical journeys
        █████ Integration (IPC, services, Supabase local stack, adapters, DB)
       ███████ Unit (TS: Vitest; Rust: cargo test) — the broad base
   ── cross-cutting specialized layers run continuously ──
   AI-eval · Accessibility · Security · Performance · Visual-regression ·
   Stress · Load · Compatibility · Recovery · Soak
```

- **Volume:** mostly fast unit tests; fewer integration; a focused set of E2E for the journeys that matter.
- **Coverage philosophy:** meaningful coverage over a vanity percentage — but with **floors** (§214) and mandatory coverage for security/critical modules.

---

## 213. DEFINITION OF DONE (DoD) & READY (DoR)

### 213.1 Definition of Ready (per phase/feature)
Clear scope + acceptance criteria; dependencies identified; risks noted; test approach outlined; UX states enumerated (Part IX); security/privacy impact considered.

### 213.2 Definition of Done (enforced in CD)
A change is **Done** only when: it meets acceptance criteria; has unit + integration tests (and E2E if it touches a critical journey); passes typecheck/lint/format/boundary/cycle checks; meets coverage floors; passes a11y checks for new UI; passes security scans + relevant fitness functions; introduces no perf regression past budget (Part XI); updates docs (Part XIII) + ADRs if architectural; is behind a feature flag if risky; and is verified by the author (built + run + tested), with observability (logs/metrics) added. No "happy-path-only" merges (Principle 4.1).

---

## 214. UNIT TESTING

- **Frameworks:** TypeScript → **Vitest** (fast, ESM-native); Rust → **cargo test** + **proptest** (property-based) for the Core Engine; both run in CI and locally.
- **Targets:** pure logic, reducers/selectors (state), context assembly, routing/failover logic, cost/token math, prompt composition, validators/migrations, parsers/tokenizers, path/PAL utilities, redaction/scrubbing, and error mapping.
- **Coverage floors:** overall ≥ 70% lines/branches as a floor; **≥ 90%** for security-critical modules (secrets, egress, auth, IPC validation, redaction, rules-adjacent logic) and for cost/routing math. Coverage is a gate but paired with mutation-testing spot checks to ensure tests actually assert.
- **Isolation & determinism:** dependencies injected (Part II §17) and faked; time, randomness, network, and AI are stubbed; no test hits real providers or the network. Tests are parallel-safe and deterministic.

---

## 215. INTEGRATION TESTING

- **Cross-module & IPC:** verify service interactions and the typed IPC contract across process boundaries (with a test harness that spins up real Main↔sidecar channels), including schema validation and version negotiation (Part II §14).
- **Supabase (local stack):** run the Supabase CLI local stack (Postgres, Auth, Storage, Edge Functions) to test **RLS policies** via pgTAP (positive + negative: cross-user denied, oversize rejected, secret-shaped columns rejected, config-write denied — §220), Edge/DB functions (idempotency, validation, deletion CASCADE), and offline/sync behavior — **no production project touched**.
- **Provider adapters (contract tests):** each adapter is tested against **recorded fixtures** of real provider responses (streaming, tool calls, reasoning, errors) so protocol normalization, error mapping, and capability handling are verified without live calls or churn risk (Part V §64). Fixtures are refreshed periodically against live sandboxes in a separate, non-gating job.
- **LSP/DAP:** integration tests against real language/debug servers for the bundled languages (start/stop, completion, diagnostics, breakpoints).
- **DB & migrations:** every schema migration is tested (up-migration correctness, corrupt/newer-version fail-safe, backup) on representative data (Part II §24, Part IV §47).

---

## 216. END-TO-END (E2E) TESTING

- **Tooling:** **Playwright** driving the real **Electron** app (renderer + Main), on the target OS in CI.
- **Critical journeys covered:** first-run onboarding; sign-in (mocked IdP) + sign-out; add provider (mock endpoint) + first chat; inline completion accept; multi-file edit → diff review → apply → undo/rollback; agent run (mocked model) with approval; open large repo + search + navigate; Git stage/commit; terminal run; settings change + sync (local stack); crash-recovery restore; update flow (mocked feed).
- **Determinism:** AI/providers/network are mocked with deterministic fixtures; a small non-gating "live smoke" suite exercises a real provider in a sandbox nightly.
- **Flakiness management:** auto-retry with quarantine; a flaky test is triaged as a bug (root-caused, not just retried); flake rate tracked as a KPI (§232).

---

## 217. AI QUALITY & EVALUATION TESTING

*(Harness introduced in Part V §79.)*
- **Golden-task eval suite:** a curated corpus of coding tasks (bug fixes, refactors, test-gen, explanations, multi-file edits) with **automated correctness checks** (does the edit apply? do generated tests pass? does the code compile/typecheck/lint? does the answer cite the right file?).
- **Prompt/model regression:** any change to system/feature prompts or default models runs the eval suite; results are compared to a baseline; a **quality regression blocks** the change. Production accept/revert-rate shifts trigger investigation + Remote-Config rollback (Part IV §57, V §79).
- **Non-determinism handling:** evals run at low temperature where possible, use multiple samples + thresholds (pass@k), and assert on *verifiable* properties (compiles/tests-pass/valid-diff) rather than exact text.
- **Grounding/hallucination checks:** tests assert grounded features cite real repo content and that "grounded-answer mode" refuses uncited claims (Part VIII §151.9).
- **Agent success metrics:** task-success rate, average steps, revert rate, and cost per task tracked across releases; guardrail tests verify approval gates, scope enforcement, and secret redaction fire correctly (Part V §78, VIII §144).
- **Provider matrix evals:** the suite runs across representative providers (incl. a local model) to catch provider-specific breakage.

---

## 218. REGRESSION TESTING

- **Automated regression suite:** the full unit+integration+E2E set runs on every PR and nightly; the AI-eval suite runs on AI-affecting changes.
- **Visual regression:** Playwright screenshot comparisons across themes (dark/light/high-contrast) and key screens/components; diffs flagged for review (guards UI/Part IX consistency).
- **Snapshot testing:** for stable serialized outputs (settings schema, IPC message shapes, generated diagrams) with intentional-update review.
- **Bug→test policy:** every fixed defect adds a failing-first regression test (§211.2). Regression suite growth is monitored to keep CI fast (parallelization + selective runs).

---

## 219. ACCESSIBILITY TESTING

- **Automated:** **axe-core**-style checks integrated into component tests + E2E for ARIA roles/names/states, contrast, and common violations; a11y lint (e.g., no un-labeled controls) in CI.
- **Keyboard-only passes:** automated + manual verification that every journey is completable without a mouse; no focus traps; visible focus.
- **Assistive-technology manual testing:** scheduled manual passes with **NVDA and Windows Narrator** (and JAWS spot-checks) on core journeys each release.
- **Contrast/zoom/reduced-motion:** verify AA contrast across themes, UI zoom + editor font scaling without clipping, and reduced-motion behavior.
- **WCAG 2.1 AA checklist** tracked per surface. **Honest caveat (Parts VI §94/IX §171):** automated tooling catches only a subset; full conformance requires manual AT testing and expert review, which are part of the release process — we do not claim conformance from automated checks alone.

---

## 220. SECURITY TESTING

- **SAST:** static analysis (CodeQL/Semgrep-style) on TS + Rust in CI, gating on new criticals/highs.
- **SCA / dependency scanning:** vulnerable + typosquat dependency detection; SBOM generated; gating on high-severity known vulns (Part X §184).
- **Secret scanning:** pre-commit + CI (gitleaks-style) to block secrets in the repo; tests assert secrets never appear in logs/telemetry/diagnostics (redaction tests).
- **Fitness functions (invariant tests):** automated architectural checks enforce the security invariants — e.g., renderer packages cannot import the secrets module; only the egress package makes network calls; Postgres tables contain no code columns; no import cycles (Part II §15.3, Part X §190).
- **RLS / pgTAP policy tests:** exhaustive positive/negative RLS policy tests in the local stack (a **deploy gate**, §215).
- **Fuzzing:** fuzz parsers (Tree-sitter integration, file/encoding detection), the IPC message decoder, and deep-link/URL handling (`cargo-fuzz` for Rust) to harden against malformed/malicious input.
- **DAST / dynamic checks:** where applicable (backend endpoints, protocol handler).
- **Penetration test (GA gate):** an independent pen test before GA with criticals/highs remediated; periodic re-test (Part X §189/§190).
- **Threat-model verification:** each release re-checks that mitigations for the STRIDE table/attack trees remain in place (Part X §176).

---

## 221. PERFORMANCE TESTING

*(SLOs/harness in Part XI §194/§206/§209.)*
- **Perf suite on fixed hardware:** startup (cold/warm), keystroke→render latency, scroll fps, open-file, palette/quick-open, workspace search, incremental index — measured against baselines with tolerances.
- **Blocking gates:** regressions past the "Blocking" SLOs (B1–B9, B12, B14–B19) fail CI. Flame graphs/traces attach to regressions for triage.
- **Trend tracking:** dashboards track SLIs over releases to catch slow drift, not just single-release spikes. Telemetry (opt-in, bucketed) validates lab numbers against the field.

---

## 222. STRESS TESTING

- **Scale extremes:** open a **1M+ file** synthetic monorepo and **50–256 MB** files; verify tree/search/index/editor stay within budget or degrade gracefully (Part XI §197/§198).
- **Concurrency extremes:** many parallel/background agents; verify bounded pools, queueing, per-run ceilings, and interactive priority hold (Part XI §207).
- **Throughput extremes:** high-volume terminal output; rapid file changes (watcher storms); large multi-file diffs.
- **Memory pressure:** run under constrained RAM; verify the memory watchdog sheds caches/pauses background work and doesn't OOM-crash (Part XI §200).
- **Chaos testing:** randomly kill sidecars (Core Engine, AI Orchestrator, PTY, extension host) mid-operation and assert supervised restart + state recovery + no data loss (Part II §13.3/§13.4).

---

## 223. LOAD TESTING (BACKEND)

- **Edge Functions:** load-test the auth/session code exchange (the auth hot path), `delete_account`, and aggregation/scheduled (`pg_cron`) jobs for latency/throughput, cold-start behavior, and rate-limit correctness (Part IV §51).
- **Postgres:** simulate many concurrent clients (Realtime subscriptions, aggregate writes) to validate index performance, hotspot avoidance (date-partitioning), and connection-pool/cost behavior (Part IV §60).
- **Auth flow:** simulate concurrent sign-ins/refreshes; verify rate limits and abuse controls hold.
- **Scale simulation:** model target MAU growth to size quotas/budgets and validate alerting; confirm graceful behavior at quota limits (never a client hang — local-first).

---

## 224. COMPATIBILITY TESTING

- **OS matrix:** Windows 10 (2004+) and Windows 11, **x64 and ARM64** (Part VI §82.3); installer types (NSIS/MSI/MSIX/winget/portable); per-user vs per-machine.
- **Hardware tiers:** low-end (4–8 GB), typical (16 GB), high-DPI, multi-monitor with mixed DPI; integrated + discrete GPUs; software-rendering fallback path.
- **GPU/driver variance:** test across common GPU vendors/drivers incl. blocklisted-driver fallback (Part VI §93).
- **Provider matrix:** validate all listed providers (OpenAI, Anthropic, Google, OpenRouter, Groq, DeepSeek, Qwen, Mistral, Ollama, LM Studio, and a custom OpenAI-compatible endpoint) via contract tests + periodic live sandbox smoke (Part V §64).
- **Language/file matrix:** encodings (UTF-8/16, BOM), EOL (LF/CRLF), top languages (LSP/Tree-sitter), huge/minified/binary files.
- **Shells & environments:** cmd, PowerShell, Git Bash, WSL for the terminal (Part VII §112.4); behind corporate proxy + custom CA (Part X §183).
- **Locale/RTL:** pseudo-localization + RTL layout smoke tests to catch truncation/mirroring issues (Part VI §95).

---

## 225. RECOVERY & RESILIENCE TESTING

- **Crash recovery:** force-kill the app (and each process tier) mid-edit/mid-agent-run/mid-index; on relaunch verify session/tabs/dirty-buffers/terminal-layout/agent-run restore from the journal (Part VI §88, INV-5).
- **Power-loss simulation:** interrupt during file writes; verify atomic-write integrity (no truncated/corrupt files) and DB WAL recovery.
- **Interrupted agent runs:** kill mid-run; verify the run is marked `interrupted`, snapshot preserved, and resumable (Part V §72.7, VIII §143).
- **Corruption recovery:** corrupt SQLite/index/settings; verify integrity check → repair/safe-rebuild/restore-from-backup → no crash (Part VI §88.6).
- **Network loss & failover:** drop network mid-request; verify retry/failover/local-degradation and clean offline states (Part V §74, IX §165.5).
- **Update/rollback:** simulate a bad update; verify health-gated halt, kill-switch, and one-generation rollback (Part VI §86).
- **Safe mode:** simulate startup crash loop; verify Safe Mode triggers (extensions/GPU disabled) and enables recovery (Part VI §88.3).

---

## 226. RELIABILITY & SOAK TESTING

- **Long-running sessions:** run the app for many hours/days with scripted activity; monitor for **memory leaks** (heap growth), handle leaks, degrading latency, and stability.
- **Repeated operations:** thousands of open/close/search/AI cycles to surface slow leaks and state corruption.
- **Stability KPIs:** crash-free sessions/users tracked toward ≥ 99.5% (Part XI B18); soak results gate major releases.

---

## 227. MANUAL QA & EXPLORATORY TESTING

- **Test plans:** structured plans for each release covering critical journeys, new features, and high-risk areas; traceable to acceptance criteria.
- **Exploratory charters:** time-boxed, mission-driven exploration ("try to break multi-file editing on a monorepo," "abuse the approval workflow") to find what scripted tests miss.
- **Dogfooding / self-hosting:** the team uses Axiom to build Axiom daily — continuous real-world QA; internal "eat-your-own-dogfood" feedback channel.
- **Beta program:** `dev`/`beta` channels (Part VI §82.4) with real users; structured feedback + telemetry + crash data feed triage before `stable`.
- **Release sign-off:** a human QA sign-off checklist (in addition to automated gates) for major releases, incl. the manual a11y AT pass (§219) and security review (§220).
- **Bug bashes:** cross-functional bug bashes before major milestones.

---

## 228. TEST AUTOMATION & INFRASTRUCTURE

- **CI/CD:** runs on every PR + merge + nightly; matrixed across OS/arch where relevant; caches builds (Turborepo/Cargo) for speed (Q2 target < ~15 min standard gate).
- **Environments:** hermetic test envs with the Supabase CLI local stack, mock provider servers (deterministic fixtures), and reference repo/file corpora as versioned fixtures.
- **Test data/fixtures:** synthetic repos (small→1M files), large/minified/binary files, recorded provider responses, and seeded databases — all versioned and reproducible.
- **Parallelization & sharding:** tests sharded across runners; selective test runs based on changed packages to keep feedback fast; full suite nightly.
- **Flaky-test management:** auto-detect flakes, quarantine, and track a **flake-rate KPI**; quarantined tests must be fixed within an SLA, not ignored indefinitely.
- **Reporting/dashboards:** per-run results, coverage, perf trends, eval scores, flake rates, and crash-free rates on a quality dashboard visible to all.

---

## 229. CI/CD QUALITY GATES

The **standard gate** (must pass to merge):
1. Typecheck (TS strict) + Rust build.
2. Lint + format + **architecture fitness functions** (boundaries, no cycles, invariant checks).
3. Unit tests (TS + Rust) + coverage floors.
4. Integration tests (IPC, adapters-vs-fixtures, **RLS policies + Edge/DB functions in the local stack**, migrations).
5. Security: SAST + SCA + secret scanning (+ rules tests) — gate on new criticals/highs.
6. Accessibility automated checks on changed UI.
7. Build the app + native modules/sidecars (all target triples).
8. **E2E** critical-journey subset (full E2E nightly).
9. **Performance** budget checks (blocking SLOs) on changed hot paths.
10. AI-eval suite (if AI-affecting change) — gate on quality regression.
11. Docs/ADR updates present when required.

**Release gates (additional, before promoting to `stable`):** full E2E + full perf + full compatibility matrix + soak/stress results + manual QA sign-off + manual a11y AT pass + security review; **pen-test remediation for GA**. Bad results block promotion.

---

## 230. RELEASE MANAGEMENT & QUALITY SIGN-OFF

- **Channels:** `dev` (nightly/continuous) → `beta` (stabilizing) → `stable` (GA), each side-by-side installable (Part VI §82.4).
- **Staged rollout:** `stable` rolls out by percentage via feature flags, gated on live **crash-free-rate** and error SLOs; progression halts/rolls back automatically on regression (Part VI §86.4, Part IV §57).
- **Sign-off criteria:** all release gates green; no open blockers/criticals; perf within budget; crash-free rate healthy on `beta`; security review complete.
- **Rollback criteria:** crash-rate spike, critical regression, or security issue → kill-switch/rollback to last-known-good (one-generation retained), with post-mortem (Part X §191).
- **Post-release monitoring:** watch crash-free rate, error categories, perf SLIs, AI accept/revert, and update-success for a defined window; hotfix path is fast-tracked through the same gates.

---

## 231. BUG MANAGEMENT & TELEMETRY-DRIVEN QUALITY

- **Lifecycle:** report → triage (severity S1–S4 × priority) → assign → fix + regression test → verify → release. SLAs by severity (S1 immediate/hotfix; lower on scheduled releases).
- **Crash triage:** the crash pipeline groups by signature; top crashers prioritized; symbolicated stacks; correlation to release/rollout (Part IV §58).
- **Telemetry→quality loop:** field SLIs (crash-free, perf, AI accept/revert, error rates) surface regressions the lab missed; feed back into new tests + fixes; anomaly alerts trigger investigation.
- **Escaped-defect analysis:** each escaped bug gets a root-cause + "why didn't a test catch it?" → new test/gate (continuous improvement).

---

## 232. QUALITY METRICS & KPIs

- **Coverage** (overall + critical-module floors) and mutation-test spot scores.
- **Escaped-defect rate** (bugs found in prod per release) — trend down.
- **Crash-free sessions/users** (≥ 99.5% target).
- **Flake rate** (quarantine count, time-to-fix).
- **CI duration** (keep fast) and **gate pass rate**.
- **Perf SLI trends** (Part XI budgets) and **AI eval scores + accept/revert rates**.
- **MTTR** for S1/S2 and **time-to-detect** (telemetry) for regressions.
- **A11y**: open violations, WCAG checklist completion.
- **Security**: open vuln count by severity, time-to-remediate, pen-test findings closed.

---

## 233. QUALITY RISKS, TRADE-OFFS & MITIGATIONS

- **AI nondeterminism makes testing hard** → verifiable-property assertions (compiles/tests-pass/valid-diff), pass@k thresholds, mocked-provider E2E, separate live-smoke jobs.
- **E2E flakiness/slowness** → deterministic mocks, retry+quarantine, sharding, critical-subset-on-PR + full-nightly.
- **Provider API churn breaking tests** → fixture-based contract tests (stable) + periodic non-gating live refresh.
- **Perf gate false positives (hardware variance)** → fixed reference runners, tolerances, trend analysis over single runs.
- **Coverage gaming** → floors + mutation spot checks + behavior-focused tests + bug→test policy.
- **Manual QA/a11y not scaling** → automate the repetitive, reserve humans for exploratory + AT + judgment; dogfooding as continuous coverage.
- **Backend load surprises** → local stack + load tests + quota alerts + local-first design so backend issues never block the editor.
- **Gate fatigue slowing delivery** → parallelization, caching, selective runs, and keeping gates meaningful (no flaky/low-value gates).

---

*End of Part XII — Quality & Testing.*


---

# PART XIII — SUBSYSTEM DOCUMENTATION

> **Purpose of this Part.** Part XIII is the canonical **per-subsystem dossier**. Where Parts II–XII specify behavior across concerns, this part indexes the system **by subsystem** and gives each one a uniform 11-facet treatment — purpose, why it exists, how it works, future scalability, implementation considerations, edge cases, UX decisions, technical decisions, risks, alternatives, and assumptions — so any engineer can open a single dossier and understand a subsystem end to end. It also defines the documentation *system* (ADRs, API references, runbooks, developer/user docs) and the freshness/ownership policy that keeps docs trustworthy. Dossiers cross-reference the deep sections rather than duplicating them.

---

## 234. DOCUMENTATION OVERVIEW & SYSTEM

### 234.1 Purpose & Audience
Documentation is a first-class deliverable (Principle 4.15). Audiences: subsystem DRIs and ICs (implementation), reviewers (design/security), QA (test design), support/DevOps (runbooks), and users (product docs). Every subsystem must be understandable without reading its source.

### 234.2 Documentation Types
- **ADRs** (`/docs/adr`): one decision each — context, options, decision, consequences, status (Part II §11.4).
- **Subsystem dossiers** (`/docs/subsystems`): the 11-facet docs in this Part, kept in sync with code.
- **API references**: generated from typed source (TSDoc/rustdoc) for the extension API, provider SDK, IPC schema, and public interfaces.
- **Runbooks** (`/docs/runbooks`): operational procedures (release, rollback, incident, backup/restore, key rotation, on-call).
- **Developer onboarding** (`/docs/dev`): setup, architecture tour, contribution guide, testing guide.
- **User docs**: in-product help, walkthroughs, and an external docs site (getting started, providers, agents, privacy, troubleshooting).

### 234.3 Location, Ownership & Freshness
Docs live in-repo (docs-as-code) beside the code they describe; each subsystem doc names its DRI (Part II §0.1). **Freshness policy:** doc updates are part of the Definition of Done (Part XII §213.2) — a change that alters a subsystem's contract must update its dossier/ADR or CI flags it. A quarterly doc audit prunes drift.

### 234.4 Docs-as-Code & Review
Docs are versioned, PR-reviewed, and (for API refs/diagrams) generated in CI. Diagrams use text formats (Mermaid) so they diff and review cleanly. Broken internal links fail CI.

### 234.5 The Subsystem Dossier Template (11 facets)
Each dossier below follows: **(1) Purpose · (2) Why it exists · (3) How it works · (4) Future scalability · (5) Implementation considerations · (6) Edge cases · (7) UX decisions · (8) Technical decisions · (9) Risks · (10) Alternatives considered · (11) Assumptions.**

---

## 235. SUBSYSTEM CATALOG & DEPENDENCY MAP

```
Desktop Shell ─┬─ IPC ─┬─ Renderer(Workbench, Editor Host, Command System, Design System)
               │       ├─ AI Orchestrator ─ Provider Registry ─ Egress Gateway ─ Secret Vault
               │       ├─ Core Engine(Indexer, Search, Knowledge Graph, Embeddings)
               │       ├─ Extension Host ── Public API
               │       └─ PTY(Terminal)
               ├─ PAL (secrets, fs, watch, pty, notify, shell)
               ├─ Services(Workspace, FileSystem, Settings/Sync, Auth, Telemetry, Update, Git, Feature Flags)
               └─ Backend(Supabase: Auth, Postgres+RLS, Storage, Edge Functions, feature_flags, telemetry/crash sink)

Cross-cutting: Context Engine, Memory, Diff/Snapshots, Approval/Guardrails, Cost Accounting, Observability.
```
Dependency direction is enforced (Part II §15.3): higher layers depend on lower via interfaces; no cycles.

---

## 236. DOSSIER — DESKTOP SHELL & PROCESS MODEL
1. **Purpose:** Host the app; own lifecycle, windows, processes, and the trusted core.
2. **Why:** A desktop IDE needs a native chassis with crash isolation and a trusted tier for secrets/egress.
3. **How:** Electron Main (trusted) + sandboxed renderers + Rust/Node sidecars, supervised by `ProcessSupervisor` (Part II §13, VI §87).
4. **Scalability:** Multi-window/multi-workspace; sidecars scale heavy work horizontally; Tauri migration path preserved.
5. **Implementation:** Staged startup, lazy activation, single-instance lock, graceful shutdown, health pings + backoff restarts.
6. **Edge cases:** Sidecar crash-loops (circuit breaker), forced kill (recovery journal), sleep/resume, multi-monitor DPI.
7. **UX:** Fast first paint; "Recovered your session"; Safe Mode on crash loop.
8. **Technical:** Electron chosen for uniform Chromium + Node ecosystem (ADR-0002); hardening mandatory (Part X §178.2).
9. **Risks:** Memory/footprint weight → Rust sidecars + budgets; complexity of multi-process → supervision + typed IPC.
10. **Alternatives:** Tauri (lighter, less mature — kept open), fully native (no cross-platform/editor reuse — rejected).
11. **Assumptions:** Windows 10 2004+/11; ≥ 8 GB RAM; user-privilege execution.

---

## 237. DOSSIER — IPC LAYER
1. **Purpose:** Typed, versioned, secure messaging across processes.
2. **Why:** Multi-process design requires a safe, evolvable contract; the renderer is untrusted.
3. **How:** `contextBridge`/ipc allow-list (renderer↔Main) + JSON-RPC over stdio/socket (Main↔sidecars); one codegen'd schema; streaming channel with back-pressure (Part II §14).
4. **Scalability:** New channels/messages additive; protocol version negotiation; streaming scales to token/PTY firehoses.
5. **Implementation:** Schema is source of truth (TS→Rust codegen); sender validation; correlation IDs.
6. **Edge cases:** Version mismatch (controlled upgrade), malformed message (drop+log), slow consumer (windowed flow control).
7. **UX:** Invisible when healthy; instant "Stop" via cancellation tokens across IPC.
8. **Technical:** Allow-list + schema validation for security (Part X §178.3); coalesce streams to ≤ 60fps.
9. **Risks:** Serialization overhead (batching, WASM for hot logic); protocol drift (codegen + version gate).
10. **Alternatives:** Direct FFI (rejected — no crash isolation); shared memory (complexity; used selectively for large streams).
11. **Assumptions:** Sidecars ship with the app (matched versions, Part VI §86.8).

---

## 238. DOSSIER — PLATFORM ABSTRACTION LAYER (PAL)
1. **Purpose:** Quarantine OS-specific behavior behind interfaces (INV-7).
2. **Why:** Enable macOS/Linux ports without rewrites; keep business logic platform-agnostic.
3. **How:** Interfaces (`ISecretStore`, `IFileWatcher`, `IPtyHost`, `IDialogService`, notifications, shell integration) with Windows impls in 1.0 (Part II §18).
4. **Scalability:** Add a platform = implement interfaces; no caller changes.
5. **Implementation:** Only place with `process.platform` branches; contract tests per interface.
6. **Edge cases:** Long paths (`\\?\`), case-insensitive FS, reserved names, watcher storms, ConPTY quirks.
7. **UX:** Native dialogs/notifications/associations feel OS-correct.
8. **Technical:** DPAPI/Credential Manager for secrets; ReadDirectoryChangesW for watching; ConPTY for terminal.
9. **Risks:** Subtle cross-platform semantic gaps → contract tests + documented behavior.
10. **Alternatives:** Scattered platform conditionals (rejected — unmaintainable/unportable).
11. **Assumptions:** Target OSes expose the needed native capabilities.

---

## 239. DOSSIER — AUTHENTICATION & IDENTITY
1. **Purpose:** Prove identity; manage sessions/tokens/devices (Part III).
2. **Why:** Gate cloud features (sync/profile) while keeping core work sign-in-optional.
3. **How:** Google via Supabase Auth; system-browser OAuth + loopback + PKCE/state/nonce + authorization-code exchange (`exchangeCodeForSession`); refresh/access token in SecretVault; silent refresh (Part III §27–30).
4. **Scalability:** Provider-agnostic `IAuthService` for GitHub/MS/Apple/SSO; multi-device registry; enterprise SSO later.
5. **Implementation:** Loopback receiver, token manager (de-duped refresh), device registry (`device_sessions`), PKCE code-exchange handling.
6. **Edge cases:** 20-row matrix (Part III §38): canceled flow, port unavailable, revoked token, clock skew, offline.
7. **UX:** "Optional — unlocks sync"; browser-waiting; device management; never blocks local work.
8. **Technical:** No embedded webview; secrets only in Main (INV-3); server-authoritative rules.
9. **Risks:** Weak desktop attestation (no App Check equivalent) → RLS + rate limits + anomaly detection; deep-link hijack → loopback + state + PKCE verifier.
10. **Alternatives:** Embedded webview (rejected — policy/security); custom auth server (rejected for 1.0 — Supabase Auth suffices).
11. **Assumptions:** Users can complete browser OAuth; Supabase acceptable for 1.0.

---

## 240. DOSSIER — BACKEND & DATA (SUPABASE)
1. **Purpose:** Thin identity/preferences/telemetry plane (Part IV).
2. **Why:** Sync + identity + config without a code host or AI proxy.
3. **How:** Postgres tables (profiles/device_sessions/settings/prompts/rules/agents/provider_configs/workspaces/usage_daily/audit_events) + Storage + Edge/DB Functions + feature_flags; RLS policies authoritative (Part IV §43–46).
4. **Scalability:** Date-partitioned aggregates, normalized rows, TTL/`pg_cron` retention, no code = tiny volume; backend swappable via `IBackendService`.
5. **Implementation:** Schema versioning + SQL migrations; four-layer validation (client/`CHECK` constraints/triggers/RLS); local SQLite mirror + sync engine.
6. **Edge cases:** Offline writes, multi-device conflicts (LWW + history), oversize/secret-shaped writes (rejected).
7. **UX:** Transparent sync status; conflict "newer version exists — view diff?".
8. **Technical:** Postgres + RLS (relational integrity/policies/migrations over a document store); C0/C1 structurally excluded (INV-4).
9. **Risks:** Backend lock-in/cost → minimal cloud + abstraction + self-hostable Supabase + budgets/alerts.
10. **Alternatives:** Firebase (rejected — proprietary document store, ADR-0011), fully self-hosted Supabase (enterprise option), no-cloud (loses sync).
11. **Assumptions:** Small per-user cloud data; providers/keys/code stay local.

---

## 241. DOSSIER — SECRET VAULT & CREDENTIAL MANAGEMENT
1. **Purpose:** Sole store/reader of secrets (keys/tokens) — INV-3.
2. **Why:** Prevent key exposure; centralize a security-critical concern.
3. **How:** OS secure store (DPAPI/Credential Manager/`safeStorage`); `keyRef` aliases everywhere else; injection only at egress (Part V §66, X §177).
4. **Scalability:** Multiple keys/provider; rotation; org/shared keys via gateway later.
5. **Implementation:** Only Main accesses it; redaction utilities; health checks; memory hygiene.
6. **Edge cases:** Secure store unavailable (treat signed-out, never insecure fallback); corrupt token (clean reset).
7. **UX:** Masked input; "configured / •••• last4"; never re-displays stored keys.
8. **Technical:** No plaintext files/cloud/logs; excluded from diagnostics by construction.
9. **Risks:** Local malware at user privilege (OS-level residual, documented Part X §176.8).
10. **Alternatives:** App-managed encrypted file (weaker than OS store — rejected as primary).
11. **Assumptions:** OS secure store available and trustworthy.

---

## 242. DOSSIER — EGRESS GATEWAY & NETWORKING
1. **Purpose:** The single network exit for provider/cloud calls (INV-2).
2. **Why:** Enforce sovereignty (no unauthorized egress), centralize retry/cost/audit.
3. **How:** One hardened Main-side HTTP/stream client; credential injection; host allow-list; SSE normalization; retry/backoff/circuit-breaking (Part II §20, V §67).
4. **Scalability:** Connection pooling/HTTP2; per-provider concurrency; handles many streams.
5. **Implementation:** Proxy/custom-CA support; cancellation; per-request audit metadata (no payload).
6. **Edge cases:** 429/`Retry-After`, timeouts, provider down (failover), offline (local/degrade).
7. **UX:** Transparent failover ("continued on Anthropic"); offline chips.
8. **Technical:** Only egress package makes network calls (fitness function, Part X §190).
9. **Risks:** Misconfig leaking egress → allow-list + tests + audit; MITM → TLS + optional pinning.
10. **Alternatives:** Per-feature network calls (rejected — breaks sovereignty/audit).
11. **Assumptions:** Providers reachable over HTTPS; user configures endpoints.

---

## 243. DOSSIER — AI PROVIDER REGISTRY & ADAPTERS
1. **Purpose:** Normalize all providers behind one contract (Part V §63–65).
2. **Why:** Provider-agnostic features; broad BYOK coverage; future providers.
3. **How:** `IProviderAdapter` (chat/embed/listModels/capabilities/health); internal protocol; capability descriptors; dynamic model discovery.
4. **Scalability:** OpenAI-compatible adapter covers many; SDK for third-party/enterprise; local providers first-class.
5. **Implementation:** Adapters are pure translation; recorded-fixture contract tests; capability probing.
6. **Edge cases:** Provider quirks (reasoning/tools/cache), unknown models (conservative defaults), API churn.
7. **UX:** Add-provider wizard + health check; capability labels; model picker with cost/latency.
8. **Technical:** Capability-gating (INV-8); no per-model conditionals in call sites.
9. **Risks:** API churn → versioned adapters + fixtures + probing.
10. **Alternatives:** Hard-coding per provider (rejected — unmaintainable).
11. **Assumptions:** Providers are OpenAI-compatible or documented.

---

## 244. DOSSIER — AI ORCHESTRATOR & AGENT RUNTIME
1. **Purpose:** Run turns and multi-step agents safely and resumably (Part V §72, VIII §131).
2. **Why:** Agentic coding needs planning, tools, budgets, approval, and recovery.
3. **How:** Plan→act→observe loop; tool executor; event-sourced run log; bounded pool; parallel/background agents; persistent queue.
4. **Scalability:** Many concurrent agents within ceilings; queue survives restart; sub-agents compose.
5. **Implementation:** Out-of-process (protects UI); cancellation tokens; step/cost/time budgets; loop-guard.
6. **Edge cases:** Runaway loops (guard+stop), crash mid-run (interrupted+resumable), budget breach (pause).
7. **UX:** Live scrubbable timeline; approval prompts; task queue; time-travel redo.
8. **Technical:** Event sourcing enables replay/audit/rollback; interactive > background priority.
9. **Risks:** Cost/CPU runaway → budgets/breakers; unwanted edits → approval + snapshots.
10. **Alternatives:** In-renderer agents (rejected — blocks UI); stateless agents (rejected — no resume/audit).
11. **Assumptions:** Tools are well-scoped; snapshots protect all edits.

---

## 245. DOSSIER — CONTEXT ENGINE (RAG)
1. **Purpose:** Assemble token-budgeted, grounded context per turn (Part V §69).
2. **Why:** Model quality depends on the right context within the window; grounding fights hallucination.
3. **How:** gather→score→dedupe→compress→order→budget-fit→freeze; on-device hybrid retrieval; prompt-cache segmentation.
4. **Scalability:** Works on huge repos via retrieval + summarization; caching cuts cost/latency.
5. **Implementation:** Per-source budget shares; context manifest; off-thread token counting.
6. **Edge cases:** Over-budget (drop/summarize/window), stale cache (hash/watcher invalidation), no index yet (degrade).
7. **UX:** Context manifest viewer ("what was sent" + tokens); `@`-attachments.
8. **Technical:** Retrieval on-device (INV-4); stable-prefix caching for hits.
9. **Risks:** Truncation quality loss → hierarchical summarization + visible manifest.
10. **Alternatives:** Whole-file dump (rejected — cost/overflow); no RAG (rejected — ungrounded).
11. **Assumptions:** Index available or degrades gracefully.

---

## 246. DOSSIER — MEMORY SYSTEM
1. **Purpose:** Continuity across turns/sessions/workspaces (Part V §70).
2. **Why:** Better assistance without unbounded prompts; learned conventions.
3. **How:** Tiers (turn/session/workspace/agent/long-term); local storage; retrieval + budgeted injection; edit/forget.
4. **Scalability:** TTL + caps + pruning; hybrid retrieval; per-workspace scoping.
5. **Implementation:** SQLite + on-device vectors; provenance on injected memories.
6. **Edge cases:** Stale/wrong memory (edit/forget), sensitive content (local + erasable), growth (prune).
7. **UX:** View/pin/edit/delete; "forget this"; provenance shown.
8. **Technical:** Local-first (privacy); small user memory may sync as C2 (never code).
9. **Risks:** Memory pollution → curation + TTL + user control.
10. **Alternatives:** No memory (rejected — no continuity); cloud memory of code (rejected — INV-4).
11. **Assumptions:** Users want continuity; privacy defaults local.

---

## 247. DOSSIER — REPOSITORY INDEXER & RUST CORE ENGINE
1. **Purpose:** Fast on-device parsing/symbols/search/embeddings (Part II §12.9, VIII §125, XI §199).
2. **Why:** Heavy compute off the UI thread; grounding + navigation at scale.
3. **How:** Rust sidecar; Tree-sitter parse; symbol extraction; ripgrep search; HNSW vectors; incremental + content-hash cache.
4. **Scalability:** 1M+ files via incremental/prioritized/memory-mapped index; parallel work-stealing pool.
5. **Implementation:** Cancellable/chunked; persisted + resumable; rebuildable (never authoritative over code).
6. **Edge cases:** Watcher storms, huge/binary files (skip/summarize), corruption (rebuild).
7. **UX:** Index status + pause/resume/rebuild; "still indexing" note.
8. **Technical:** Rust for predictable perf/memory; JSON-RPC boundary for crash isolation.
9. **Risks:** Memory on giant repos → mmap + budgets + partial index.
10. **Alternatives:** In-Node indexing (rejected — perf/memory); cloud index (rejected — INV-4).
11. **Assumptions:** Local disk/CPU sufficient; embeddings model available (local or chosen).

---

## 248. DOSSIER — KNOWLEDGE GRAPH & DEPENDENCY ANALYSIS
1. **Purpose:** Repo-wide relationships for reasoning/refactor/review (Part VIII §127).
2. **Why:** Whole-repo correctness (impact analysis) beats file-local guessing.
3. **How:** Symbol + import/dependency edges; persisted on-device; incremental updates; graph Q&A + viz.
4. **Scalability:** Incremental; level-of-detail viz; query bounds.
5. **Implementation:** Built atop indexer/symbols; used by context, refactor, review, security agents.
6. **Edge cases:** Dynamic/reflective code (best-effort), multi-language edges, cycles.
7. **UX:** Interactive graph, "show request path…", impact preview before refactor.
8. **Technical:** Local; feeds refactor-safety (predict blast radius + verify completeness).
9. **Risks:** Incompleteness for dynamic languages → combine with tests + human review.
10. **Alternatives:** Text-only refactor (rejected — unsafe at scale).
11. **Assumptions:** Static analysis captures most edges.

---

## 249. DOSSIER — EDITOR HOST (MONACO)
1. **Purpose:** World-class code editing (Part VII §106).
2. **Why:** Editor is the hero; Monaco is mature and reusable (diff editor too).
3. **How:** Monaco behind `IEditorHost`; Tree-sitter + semantic highlighting; AI ghost-text/inline-edit overlays.
4. **Scalability:** Large-file perf mode; virtualized viewport; per-language config.
5. **Implementation:** Hot-path latency budget (B4); off-thread heavy work; encodings/EOL/format.
6. **Edge cases:** Huge/minified/long-line files, external changes, read-only, mixed EOL.
7. **UX:** Multi-cursor, folding, minimap, sticky scroll, breadcrumbs; AI coexists with IntelliSense.
8. **Technical:** Monaco (ADR-0003) wrapped behind an interface (swappable to CodeMirror later).
9. **Risks:** AI overlays hurting latency → strict budgets + async rendering.
10. **Alternatives:** CodeMirror 6 (lighter, less batteries — Post-1.0 candidate), custom editor (rejected).
11. **Assumptions:** Chromium-uniform rendering (Electron).

---

## 250. DOSSIER — LANGUAGE INTELLIGENCE (LSP) & DEBUGGING (DAP)
1. **Purpose:** Deep language features + debugging (Part VII §107/§114).
2. **Why:** Professional IDE parity requires semantic intelligence and real debugging.
3. **How:** Out-of-process LSP/DAP clients; bundled servers for top languages; on-demand install; Tree-sitter fallback.
4. **Scalability:** Multi-server, lazy start, cancellable; adapters via extensions.
5. **Implementation:** Supervised servers (restart on crash); debounced diagnostics; merged completions.
6. **Edge cases:** Server crash/slow start (degrade to Tree-sitter/basic), no adapter (install CTA), multi-session debug.
7. **UX:** Hover/complete/rename/peek; breakpoints/logpoints/watch; AI "explain error/fix".
8. **Technical:** Standard protocols (reuse ecosystem); out-of-process isolation.
9. **Risks:** Server quality/perf variance → supervision + lazy + graceful degradation.
10. **Alternatives:** Custom per-language engines (rejected — cost); no LSP (rejected — parity).
11. **Assumptions:** Language servers/adapters available for target languages.

---

## 251. DOSSIER — INTEGRATED TERMINAL
1. **Purpose:** Real shell inside the IDE + AI tool (Part VII §112).
2. **Why:** Developers live in the terminal; agents need to run commands.
3. **How:** xterm.js + native PTY (ConPTY) over flow-controlled IPC; profiles; shell integration.
4. **Scalability:** Many terminals/splits; high-throughput output (GPU + virtualized scrollback).
5. **Implementation:** cmd/PowerShell/Git Bash/WSL; command/cwd/exit-code detection; links.
6. **Edge cases:** Huge output (throttle), large paste (confirm), long-running process, shell quirks.
7. **UX:** Split/tabs, copy output, rerun command, "AI: explain output/fix error".
8. **Technical:** Real user shell (sovereignty); agent terminal use gated by approval.
9. **Risks:** Perf on firehose output → flow control + virtualization.
10. **Alternatives:** Emulated shell (rejected — must use real toolchains).
11. **Assumptions:** OS PTY available; user shells installed.

---

## 252. DOSSIER — SOURCE CONTROL (GIT)
1. **Purpose:** First-class Git using the user's real Git (Part VII §113).
2. **Why:** Version control is core; sovereignty = user's toolchain/credentials.
3. **How:** `IGitService` (libgit2/CLI hybrid); SCM view; diff/hunk staging; branches/stash/history/blame; 3-way merge; AI commit/PR.
4. **Scalability:** Sparse/partial clone awareness; virtualized diffs/history; multi-repo.
5. **Implementation:** Watch `.git`; OS credential manager for auth; guarded destructive ops.
6. **Edge cases:** Mid-rebase/merge (guided), conflicts, submodules/worktrees/LFS, huge diffs.
7. **UX:** Stage per line/hunk, graph view, AI-assisted conflict resolution/commit messages.
8. **Technical:** Use real Git (no reimplementation); hosting providers via extensions.
9. **Risks:** Git edge-state confusion → explicit state + guided next steps + guards.
10. **Alternatives:** Bundled Git reimplementation (rejected — fidelity/trust).
11. **Assumptions:** Git installed; user manages remotes/credentials.

---

## 253. DOSSIER — SEARCH SUBSYSTEM
1. **Purpose:** Fast lexical + semantic search (Part VII §110, VIII §126).
2. **Why:** Navigation/understanding at scale; grounding for AI.
3. **How:** ripgrep (lexical) + HNSW (semantic) + symbol graph, hybrid-ranked; streamed results.
4. **Scalability:** Huge repos (streaming, bounded results, ignore-aware); cancellable.
5. **Implementation:** In Rust Core; glob include/exclude; regex; result virtualization.
6. **Edge cases:** Binary/huge files (skip), too-many results (load-more), no index (lexical-only).
7. **UX:** Results tree, replace-across-files preview, semantic "add to context".
8. **Technical:** ripgrep for speed; semantic on-device (INV-4).
9. **Risks:** Semantic quality depends on embeddings → hybrid + citations.
10. **Alternatives:** JS search (rejected — perf); cloud search (rejected — INV-4).
11. **Assumptions:** Local compute adequate; index built for semantic.

---

## 254. DOSSIER — EXTENSION HOST & PUBLIC API
1. **Purpose:** Safe third-party extensibility (Part II §19, VII §117).
2. **Why:** Ecosystem breadth without forking; teams extend workflows/AI.
3. **How:** Sandboxed Node host; curated API + AI contribution points; permission manifest + capability broker; own signed registry; VS Code compat subset.
4. **Scalability:** Contribution model; provider/agent SDKs; marketplace growth.
5. **Implementation:** Resource limits; crash isolation; per-workspace enablement; trust-aware.
6. **Edge cases:** Bad/slow extension (kill), permission violation (deny+surface), incompatible API (label).
7. **UX:** Permissions shown pre-install; recommended extensions; management UI.
8. **Technical:** Never in renderer/Main; no secret access; brokered network.
9. **Risks:** Supply chain → signing + review + sandbox + least privilege.
10. **Alternatives:** Full VS Code API (rejected 1.0 — security/maintenance); no extensions (rejected — breadth).
11. **Assumptions:** Curated catalog initially; users accept compat caveats.

---

## 255. DOSSIER — DIFF REVIEW, SNAPSHOTS & ROLLBACK
1. **Purpose:** Make every AI edit reviewable and reversible (Part VIII §142/§143).
2. **Why:** Trust in autonomy requires safe, undoable edits.
3. **How:** Monaco diff editor per-file/hunk/line; auto-snapshot before edits; AI-change timeline; one-click restore; event-sourced runs.
4. **Scalability:** Multi-file batches; dedup + TTL snapshots; streaming diffs.
5. **Implementation:** Staged/atomic apply; validate before apply; local snapshots.
6. **Edge cases:** Partial accept, conflict on apply, interrupted run (resume/rollback), huge diff (virtualize).
7. **UX:** Change-list checklist, accept/reject granularity, edit-before-accept, "Applied · Undo".
8. **Technical:** Snapshots complement Git (finer/automatic); local + bounded.
9. **Risks:** Storage growth → dedup/TTL; false sense of safety → clear pre/post-apply states.
10. **Alternatives:** Direct writes without review (rejected — unsafe); Git-only undo (rejected — too coarse).
11. **Assumptions:** Local disk for snapshots; users review consequential edits.

---

## 256. DOSSIER — APPROVAL WORKFLOW & GUARDRAILS
1. **Purpose:** Gate consequential AI/agent actions (Part VIII §144, X §181).
2. **Why:** Prevent unwanted/destructive actions; enterprise control.
3. **How:** Action classes × auto/ask/deny; autonomy levels; scoped allow-lists; high-risk hard-confirm; audit.
4. **Scalability:** Per-agent/per-workspace policy; org policy later.
5. **Implementation:** Capability broker enforcement; secret redaction pre-egress; "remember" within scope.
6. **Edge cases:** Injection attempts (content-as-data), scope escape (deny), destructive op (impact confirm).
7. **UX:** Clear prompts (action/risk/scope), Approve/Deny/Always-in-workspace.
8. **Technical:** Single enforcement point; deny-lists can't be overridden by prompts.
9. **Risks:** Friction vs safety → smart defaults + scoped remember + high-risk-only hard confirms.
10. **Alternatives:** Full autonomy (rejected — unsafe); approve-everything (rejected — friction).
11. **Assumptions:** Users understand approval prompts; audit reviewed.

---

## 257. DOSSIER — SETTINGS, PROFILES & SYNC
1. **Purpose:** Configure the IDE; sync across devices (Part VII §120, IV §55, VI §96).
2. **Why:** Personalization + team standards + continuity.
3. **How:** Scoped precedence (default<policy<user<workspace<folder<machine); JSON+GUI; opt-in Postgres sync; profiles.
4. **Scalability:** Per-scope rows; Realtime subscriptions; profiles per context.
5. **Implementation:** Schema + migrations; machine/secret values excluded from sync; managed-policy lock.
6. **Edge cases:** Conflict (LWW+history), corrupt settings (restore), newer schema (read-only+prompt).
7. **UX:** Searchable settings, per-scope tabs, "managed by org", profiles.
8. **Technical:** Allow-list at write (no secrets/machine values sync).
9. **Risks:** Sync conflicts → LWW + history + diff prompt.
10. **Alternatives:** No sync (rejected — continuity); sync-all incl. machine (rejected — breakage).
11. **Assumptions:** Sign-in for sync; JSON familiarity for power users.

---

## 258. DOSSIER — TELEMETRY & OBSERVABILITY
1. **Purpose:** Understand quality/perf/usage without harming privacy (Part IV §52/53, II §23).
2. **Why:** Data-driven quality + SLO monitoring + crash triage.
3. **How:** Local-first buffer → batched opt-in upload; telemetry sink (Edge→Postgres; optional PostHog/Sentry); bucketed, no code/secrets; structured logs + correlation IDs; diagnostics bundle.
4. **Scalability:** Sampling, batching, event schema registry.
5. **Implementation:** Redaction at sink; consent gating; remote kill switch.
6. **Edge cases:** Offline (queue), consent off (no calls), incident (kill switch).
7. **UX:** Granular consent, persistent on/off indicator, preview-before-send diagnostics.
8. **Technical:** Privacy-by-design; local crash journal always on (recovery) even if telemetry off.
9. **Risks:** Privacy perception → opt-in defaults + transparency + scrubbing tests.
10. **Alternatives:** Always-on telemetry (rejected — privacy); none (rejected — blind to quality).
11. **Assumptions:** Users consent for cloud telemetry; local logs sufficient for recovery.

---

## 259. DOSSIER — UPDATE SYSTEM
1. **Purpose:** Keep clients current safely (Part VI §86).
2. **Why:** Fast-moving product; security patches; no data loss.
3. **How:** Signed feed per channel; delta downloads; background apply; staged rollout + kill switch; one-gen rollback; atomic sidecar/schema update.
4. **Scalability:** CDN feed; percentage rollout; enterprise mirror.
5. **Implementation:** Signature+hash verify; downgrade protection; migrate-forward/fail-safe.
6. **Edge cases:** Failed delta (full fallback), bad release (halt/rollback), mid-work update (protect journal).
7. **UX:** Non-nagging "Restart to update"; release notes; enterprise controls.
8. **Technical:** EV-signed; health-gated progression.
9. **Risks:** Bad update to fleet → staged + gates + kill switch + rollback.
10. **Alternatives:** Manual updates only (rejected — security/adoption).
11. **Assumptions:** Auto-update allowed (unless enterprise-disabled).

---

## 260. DOSSIER — FEATURE FLAGS (REMOTE CONFIG REPLACEMENT)
1. **Purpose:** Decouple release from exposure; incident control (Part IV §57).
2. **Why:** Dark-launch, staged rollout, A/B, kill switches.
3. **How:** `config.feature_flags` table over Supabase Realtime; targeting/percentage; client cache + subscription; compiled fail-safe defaults; single `IFeatureFlags`.
4. **Scalability:** Segment targeting; experiment exposure logging.
5. **Implementation:** Stable per-user variants; works offline via defaults.
6. **Edge cases:** Fetch fails (defaults), flag flip mid-session (stable variant), conflicting targeting.
7. **UX:** Invisible; enables gradual/ safe feature reveal; experimental settings where exposable.
8. **Technical:** No feature *requires* a successful fetch to keep the editor usable.
9. **Risks:** Flag sprawl → registry + cleanup; misconfig → defaults + review.
10. **Alternatives:** Compile-time flags only (rejected — no runtime control).
11. **Assumptions:** `feature_flags` reachable via Realtime periodically; defaults safe.

---

## 261. DOSSIER — COMMAND SYSTEM & WORKBENCH
1. **Purpose:** Uniform action + layout framework (Part VII §102/§103, IX).
2. **Why:** One way to invoke/bind/expose actions; consistent, extensible UI.
3. **How:** Command registry + `when` context keys; palette/quick-open; contributed views/menus/status; persisted layout.
4. **Scalability:** Contribution model (first-party + extensions share rails).
5. **Implementation:** Commands are the sole state-mutation path (undo/binding/telemetry uniform).
6. **Edge cases:** Keybinding conflicts (surface/resolve), context ambiguity (context keys), small windows (adaptive).
7. **UX:** Everything reachable via palette; shortcuts shown; layout customization/persistence.
8. **Technical:** Decouples features from wiring; dogfoods extensibility.
9. **Risks:** Command sprawl → categories + discoverability.
10. **Alternatives:** Ad-hoc handlers (rejected — inconsistent/unbindable).
11. **Assumptions:** Contribution model covers feature needs.

---

## 262. DOSSIER — COST & TOKEN ACCOUNTING
1. **Purpose:** Precise, local cost/token tracking (Part IV §54, V §75).
2. **Why:** BYOK users need transparency/control; a key differentiator.
3. **How:** Local ledger (tokens×catalog pricing); pre-flight estimates; live tracking; reconciliation; budgets/alerts; optional cloud aggregates.
4. **Scalability:** Date-bucketed aggregates; custom pricing for self-hosted.
5. **Implementation:** Reasoning/cached tokens counted separately; integer minor units; ±5% accuracy target.
6. **Edge cases:** Unknown model pricing (user override), custom endpoints, provider billing drift.
7. **UX:** Status-bar meter, estimate chips, budget warnings, dashboards.
8. **Technical:** Local-first + authoritative; raw records never leave device.
9. **Risks:** Pricing drift → catalog updates + user overrides + reconciliation.
10. **Alternatives:** No accounting (rejected — BYOK core value); cloud-only (rejected — INV-4/offline).
11. **Assumptions:** Catalog pricing reasonably current; providers report usage.

---

## 263. DOSSIER — DESIGN SYSTEM & COMPONENT LIBRARY
1. **Purpose:** Coherent, themable, accessible UI foundation (Part IX §154).
2. **Why:** Consistency, performance, a11y, and brand across all surfaces.
3. **How:** Design tokens (color/space/type/motion) + first-party component library; theming (dark/light/HC); density modes.
4. **Scalability:** Token-driven theming; components reused everywhere (incl. extensions webviews within CSP).
5. **Implementation:** Components consume tokens only; all states + a11y baked in; virtualized heavy components.
6. **Edge cases:** RTL/localization expansion, high-DPI, reduced motion, contrast across themes.
7. **UX:** One component per job; states checklist; calm motion.
8. **Technical:** In-house kit (perf/coherence) over heavy third-party; contrast linter.
9. **Risks:** Maintenance cost → strong docs + tests (visual regression).
10. **Alternatives:** Third-party UI kit (rejected — perf/coherence); CSS-in-JS on hot paths (rejected — perf).
11. **Assumptions:** Tokens cover theming needs; components meet a11y patterns.

---

## 264. DOCUMENTATION DELIVERABLES, RUNBOOKS & DEVELOPER ONBOARDING

- **Runbooks (must-exist before GA):** Release & staged rollout; Emergency hotfix; Rollback & kill switch; Incident response (Part X §191); Backup & restore (Supabase + local); Provider/key rotation; Secret/cert rotation; Data-deletion (GDPR) execution; Diagnostics triage; On-call guide.
- **Developer onboarding:** repo setup, architecture tour (this PRD + ADRs), build/run/debug, testing guide, contribution + code-review standards, "how to add a provider / extension / agent / setting."
- **API references (generated):** extension API, provider SDK, custom-agent SDK, IPC schema, public interfaces.
- **User documentation:** getting started, connecting providers (per provider), local models, agents & approval, privacy & sovereignty, keybindings/keymaps, troubleshooting/FAQ, security whitepaper (data-flow map, Part X §188.1).
- **In-product docs:** walkthroughs, tooltips, "learn more" links, changelog/what's-new.

## 265. DOCUMENTATION RISKS & MAINTENANCE
- **Drift** → DoD requires doc updates; CI link-check + quarterly audit; docs-as-code review.
- **Over/under-documentation** → dossiers standardized (11 facets), generated API refs, concise runbooks.
- **Diagram rot** → text-based (Mermaid) diagrams that diff/review.
- **Ownership gaps** → each dossier/runbook names a DRI; orphaned docs flagged in audit.
- **Onboarding friction** → measured via new-hire time-to-first-PR; onboarding docs iterated on feedback.

---

*End of Part XIII — Subsystem Documentation.*


---

# PART XIV — PHASED EXECUTION PLAN

> **Purpose of this Part.** Part XIV converts the entire PRD into an executable roadmap of **~290 sequenced implementation phases**, progressing from an empty repository to a production-ready GA release and into early Post-1.0 groundwork. Phases are grouped into **Epochs** (major milestones). Each phase is deliberately scoped to be independently buildable, testable, and reviewable, honoring the "everything is a phase" tenet and the invariants of Part II. Phases reference the PRD sections they implement. Delivered in installments per the Continue protocol.

## Phase Model & Template

Every phase uses this template:
- **Goal** — the single outcome the phase delivers.
- **Scope** — what's in (and notable out-of-scope).
- **Features** — user- or system-visible capabilities added.
- **Tech reqs** — key technical requirements/components.
- **Dependencies** — prerequisite phases.
- **Risks** — main risks for this phase.
- **Deliverables** — concrete artifacts produced.
- **Acceptance** — objective done-criteria (ties to Part XII DoD).
- **Testing** — suggested test focus.
- **Future expansion** — how it extends later.
- **Complexity** — S (small) / M / L / XL, in the header.

## Epoch Roadmap (overview)

| Epoch | Theme | Phases |
|---|---|---|
| **A** | Foundation & Tooling | 1–20 |
| **B** | Core Workbench & Editor | 21–48 |
| **C** | Rust Core Engine & Indexing | 49–72 |
| **D** | Developer Tooling (Terminal, Git, LSP, Debug) | 73–104 |
| **E** | Identity & Backend (Supabase) | 105–132 |
| **F** | AI Engine | 133–170 |
| **G** | Core AI Features | 171–200 |
| **H** | Agentic & Advanced AI | 201–238 |
| **I** | Extensions, Themes, i18n, A11y, Novel AI | 239–264 |
| **J** | Hardening, Performance, Security, Release | 265–286 |
| **K** | Post-1.0 Groundwork & Cross-Platform | 287–290+ |

Progression principle: **shell → editor → understanding → tooling → identity → AI engine → AI features → agents → ecosystem → hardening → GA → beyond.** Each epoch ends in a demonstrable, shippable increment (internal alpha at end of D, feature-complete beta around end of I, GA at end of J).

---

## EPOCH A — FOUNDATION & TOOLING (Phases 1–20)

*Objective: a signed, updatable, hardened Electron+Rust shell skeleton with CI, IPC, PAL, logging, config, and the design-system base — the chassis every later phase builds on.*

### Phase 1 — Monorepo & Tooling Bootstrap *(Complexity: M)*
- **Goal:** Establish the monorepo, languages, and build orchestration.
- **Scope:** pnpm workspaces + Cargo workspace; TypeScript strict; shared configs; Turborepo/Nx caching. Out: any app code.
- **Features:** Reproducible `install`/`build`/`test`/`lint` across packages/crates.
- **Tech reqs:** Node/TS toolchain, Rust toolchain, lockfiles, `packages/`+`crates/` skeleton (Part II §15.2).
- **Dependencies:** none.
- **Risks:** Toolchain version drift → pin versions.
- **Deliverables:** Repo skeleton, root scripts, editorconfig, base tsconfig/cargo config.
- **Acceptance:** `build`/`lint`/`test` run green on an empty skeleton on Windows.
- **Testing:** CI smoke (install+build).
- **Future expansion:** Add packages/crates as phases land.

### Phase 2 — CI/CD Pipeline Skeleton *(Complexity: M)*
- **Goal:** Continuous integration with the standard-gate scaffold.
- **Scope:** CI runners (Windows matrix), caching, artifact upload; gate stages stubbed (Part XII §229). Out: signing/release.
- **Features:** PR gate: typecheck+lint+unit; nightly hook.
- **Tech reqs:** CI config in `tooling/`, cache keys, matrix (x64/ARM64 later).
- **Dependencies:** 1.
- **Risks:** Slow CI → caching + sharding early.
- **Deliverables:** CI workflows, status checks.
- **Acceptance:** Failing lint/test blocks a PR; green on skeleton.
- **Testing:** Intentional-failure PR verifies gating.
- **Future expansion:** Add security/perf/e2e/eval gates in later phases.

### Phase 3 — Shared Kernel (Result, Errors, Logger, IDs, Cancellation) *(Complexity: M)*
- **Goal:** The `shared` package primitives used everywhere.
- **Scope:** `Result<T,E>`, structured error taxonomy, structured logger w/ redaction hooks, id/time utils, cancellation tokens (Part II §22/§23).
- **Features:** Consistent error/logging/cancellation model.
- **Tech reqs:** Zero heavy deps; redaction sink interface.
- **Dependencies:** 1.
- **Risks:** Over-abstraction → keep minimal.
- **Deliverables:** `packages/shared` with tests.
- **Acceptance:** 90%+ coverage; redaction unit-tested.
- **Testing:** Unit (error mapping, redaction, cancellation).
- **Future expansion:** Correlation-ID propagation across IPC (Phase 6).

### Phase 4 — Electron Shell Skeleton (Main + Renderer + Preload) *(Complexity: L)*
- **Goal:** Launchable hardened Electron window rendering a React shell.
- **Scope:** Main lifecycle, one sandboxed renderer, minimal preload; hardening config (Part X §178.2). Out: real UI.
- **Features:** App opens a window with a placeholder React app.
- **Tech reqs:** contextIsolation on, sandbox on, nodeIntegration off, strict CSP; React+TS renderer.
- **Dependencies:** 1,3.
- **Risks:** Misconfigured hardening → checklist + test.
- **Deliverables:** `apps/desktop` boots on Windows.
- **Acceptance:** Window launches; hardening flags verified by test; no Node in renderer.
- **Testing:** E2E launch smoke; security config assertion test.
- **Future expansion:** Multi-window, session restore (Epoch B/J).

### Phase 5 — Shell Abstraction Layer (keep Tauri path open) *(Complexity: M)*
- **Goal:** Isolate Electron APIs behind an interface.
- **Scope:** `IShell` wrapping window/app/dialog/lifecycle Electron calls (Part II §12.2).
- **Features:** Workbench code never imports Electron directly.
- **Tech reqs:** Interface + Electron impl; lint rule banning direct Electron imports outside the impl.
- **Dependencies:** 4.
- **Risks:** Leaky abstraction → fitness-function lint.
- **Deliverables:** `IShell` + impl + boundary lint.
- **Acceptance:** No direct Electron imports outside the shell package (CI-enforced).
- **Testing:** Fitness function; unit on shell wrapper.
- **Future expansion:** Tauri impl of `IShell` (Post-1.0).

### Phase 6 — IPC Layer & Schema Codegen *(Complexity: L)*
- **Goal:** Typed, versioned, validated IPC with codegen.
- **Scope:** Channel allow-list, schema (TS source→Rust codegen), validation, correlation IDs, streaming channel + back-pressure (Part II §14).
- **Features:** Safe renderer↔Main and Main↔sidecar messaging.
- **Tech reqs:** `core-ipc` package; JSON-RPC over stdio; version negotiation.
- **Dependencies:** 3,4.
- **Risks:** Protocol drift → codegen single source.
- **Deliverables:** `core-ipc`, sample round-trip + stream.
- **Acceptance:** Malformed message dropped+logged; version-mismatch handled; stream back-pressure works.
- **Testing:** Integration (round-trip, streaming, validation, version).
- **Future expansion:** Every subsystem's messages added here.

### Phase 7 — Platform Abstraction Layer (Windows) *(Complexity: L)*
- **Goal:** PAL interfaces + Windows implementations.
- **Scope:** `ISecretStore` (DPAPI/Credential Mgr), `IFileWatcher`, `IPtyHost` (stub), `IDialogService`, notifications, shell integration stubs (Part II §18).
- **Features:** OS-specific behavior behind interfaces.
- **Tech reqs:** `platform` package; only place with platform branches.
- **Dependencies:** 3,4.
- **Risks:** Cross-platform gaps → contract tests.
- **Deliverables:** `platform` with Windows impls + contracts.
- **Acceptance:** Contract tests pass; no platform branches outside PAL (CI).
- **Testing:** Contract tests per interface.
- **Future expansion:** mac/Linux impls (Epoch K).

### Phase 8 — Service Registry & Dependency Injection *(Complexity: M)*
- **Goal:** DI container + service lifecycle + cross-process proxies.
- **Scope:** Interface tokens, eager/lazy activation, topological deps, IPC proxy stubs (Part II §17).
- **Features:** Location-agnostic service resolution.
- **Tech reqs:** Container in `services`; cycle detection at build.
- **Dependencies:** 6.
- **Risks:** Hidden cycles → build-time check.
- **Deliverables:** Registry + sample service + proxy.
- **Acceptance:** Lazy service activates on first use; cycle fails build.
- **Testing:** Unit (resolution, lifecycle); integration (proxy over IPC).
- **Future expansion:** All services register here.

### Phase 9 — Logging, Diagnostics & Log Rotation *(Complexity: M)*
- **Goal:** Structured local logs + diagnostics bundle scaffold.
- **Scope:** Per-process JSON logs, rotation, redaction at sink, diagnostics packager (scrubbed) (Part II §23, VI §97).
- **Features:** Troubleshooting logs; export bundle.
- **Tech reqs:** Log sinks, rotation, scrub filters.
- **Dependencies:** 3,6.
- **Risks:** Secret/PII leakage → scrub tests.
- **Deliverables:** Logging service + diagnostics export.
- **Acceptance:** No secrets/code in logs (test); rotation caps size.
- **Testing:** Unit (scrub), integration (rotation, bundle).
- **Future expansion:** Add subsystem log tags; support upload (opt-in).

### Phase 10 — Configuration & Settings Store (local) *(Complexity: M)*
- **Goal:** Local settings storage with schema + precedence (no sync yet).
- **Scope:** JSON + SQLite cache; scopes default/user/workspace/machine; migration framework (Part VI §96, II §24).
- **Features:** Read/write typed settings; precedence resolution.
- **Tech reqs:** SQLite binding; schema+migrations; validators.
- **Dependencies:** 8.
- **Risks:** Corrupt settings → fail-safe defaults + backup.
- **Deliverables:** Settings service + migration runner.
- **Acceptance:** Precedence correct; corrupt/newer schema fails safe.
- **Testing:** Unit (precedence, migration), integration (persistence).
- **Future expansion:** GUI (Epoch B), sync (Epoch E), profiles (Epoch I).

### Phase 11 — SQLite Data Layer & Repository Pattern *(Complexity: M)*
- **Goal:** Embedded DB foundation + repository abstraction.
- **Scope:** SQLite (WAL, pragmas), migrations, repo layer, integrity check on startup (Part II §12.8, XI §205).
- **Features:** Durable local storage for later subsystems.
- **Tech reqs:** Native binding bundled; WAL; prepared statements.
- **Dependencies:** 3,7.
- **Risks:** Native build per-arch → CI matrix + prebuilds.
- **Deliverables:** DB module + migration tooling + repo interfaces.
- **Acceptance:** Migrations apply; integrity check + safe rebuild works.
- **Testing:** Integration (migrations, corruption recovery).
- **Future expansion:** Index catalog, audit, history, task queue tables.

### Phase 12 — Design Tokens & Theming Engine *(Complexity: M)*
- **Goal:** Token system + dark/light/high-contrast theming.
- **Scope:** Color/space/type/motion/elevation tokens; CSS variables; theme switch + OS auto (Part IX §154).
- **Features:** Themable foundation; contrast-linted tokens.
- **Tech reqs:** Token JSON; runtime theme application; contrast linter.
- **Dependencies:** 4.
- **Risks:** Contrast failures → linter gate.
- **Deliverables:** `ui-kit` tokens + 3 base themes.
- **Acceptance:** Themes switch live; contrast linter passes.
- **Testing:** Unit (token resolution), visual snapshot (themes).
- **Future expansion:** Custom/imported themes (Epoch I).

### Phase 13 — Component Library (Core Primitives) *(Complexity: L)*
- **Goal:** First-party accessible components (base set).
- **Scope:** Button, Input, Select/Combobox, Checkbox/Toggle, Menu/ContextMenu, Tooltip, Dialog, Tabs, List (virtualized), Spinner/Skeleton, Toast (Part IX §154.6).
- **Features:** Reusable, themed, a11y-complete primitives.
- **Tech reqs:** Token-driven; WAI-ARIA patterns; all states.
- **Dependencies:** 12.
- **Risks:** A11y gaps → axe tests + patterns.
- **Deliverables:** Components + stories + tests.
- **Acceptance:** axe clean; keyboard patterns pass; all states rendered.
- **Testing:** Unit + a11y + visual regression.
- **Future expansion:** Diff viewer, tree, table, chat message (later epochs).

### Phase 14 — App Bootstrap, Splash & Staged Startup *(Complexity: M)*
- **Goal:** Fast, staged startup to an interactive shell.
- **Scope:** Splash → shell skeleton → service activation ordering; startup timeline instrumentation (Part VI §87.1, XI §195).
- **Features:** Quick first paint; measured startup.
- **Tech reqs:** Staged init; lazy activation hooks; timeline markers.
- **Dependencies:** 4,8,9.
- **Risks:** Startup regressions → timeline + budget.
- **Deliverables:** Bootstrap sequence + startup profiler.
- **Acceptance:** Cold-start-to-shell within initial budget on reference HW.
- **Testing:** Startup benchmark; e2e launch.
- **Future expansion:** Session restore, workspace hydration (Epoch B).

### Phase 15 — Single-Instance, Window Manager & Lifecycle *(Complexity: M)*
- **Goal:** Correct window/app lifecycle.
- **Scope:** Single-instance lock + route-to-existing; window create/persist geometry; graceful quit (Part VI §87).
- **Features:** One instance; window state persistence; clean shutdown.
- **Tech reqs:** Lock, per-window state, shutdown flush hooks.
- **Dependencies:** 5,10.
- **Risks:** Multi-monitor DPI → test matrix.
- **Deliverables:** Window manager + lifecycle service.
- **Acceptance:** Second launch focuses existing; geometry restored.
- **Testing:** E2E (relaunch, geometry), manual multi-monitor.
- **Future expansion:** Multi-window, tray/background (Epoch B/J).

### Phase 16 — Crash Recovery Journal (foundation) *(Complexity: L)*
- **Goal:** Durable journal for crash recovery (INV-5).
- **Scope:** WAL journal for app/session state; clean-shutdown flag; restore scaffold (Part VI §88).
- **Features:** State survives forced kill (basic set).
- **Tech reqs:** Journal writer (off-thread), restore reader.
- **Dependencies:** 11,15.
- **Risks:** Journal overhead → batch/async.
- **Deliverables:** Journal service + restore path.
- **Acceptance:** After forced kill, app detects crash + restores journaled state.
- **Testing:** Recovery test (kill mid-write).
- **Future expansion:** Buffers/tabs/terminal/agent-run restore (later).

### Phase 17 — Auto-Update Client (dev feed) *(Complexity: L)*
- **Goal:** Background auto-update with verification (dev channel).
- **Scope:** Update check/download/apply; signature+hash verify; restart prompt (Part VI §86). Out: staged rollout/rollback (Epoch J).
- **Features:** Self-updating dev builds.
- **Tech reqs:** electron-updater-style client; signed test feed.
- **Dependencies:** 4,9.
- **Risks:** Update integrity → verify before apply.
- **Deliverables:** Update service + test feed.
- **Acceptance:** Signed update applies; tampered update rejected.
- **Testing:** Integration (mock feed, tamper).
- **Future expansion:** Delta, channels, rollout, rollback (Epoch J).

### Phase 18 — Telemetry Kernel (local, opt-in scaffold) *(Complexity: M)*
- **Goal:** Local-first telemetry buffer + consent gating (no upload yet).
- **Scope:** Event/metric API, local SQLite queue, consent flag, redaction; upload stub (Part IV §53).
- **Features:** Instrumentation surface used app-wide.
- **Tech reqs:** Queue, sampling hooks, consent gate.
- **Dependencies:** 10,11.
- **Risks:** Over-collection → schema registry + review.
- **Deliverables:** Telemetry service (local).
- **Acceptance:** Off = no collection; no code/secrets in events (test).
- **Testing:** Unit (consent gate, redaction).
- **Future expansion:** telemetry/crash sink upload (Epoch E).

### Phase 19 — Feature Flags Client (local defaults) *(Complexity: S)*
- **Goal:** `IFeatureFlags` with compiled defaults (no remote yet).
- **Scope:** Flag read API, built-in defaults, per-user stable bucketing scaffold (Part IV §57).
- **Features:** Gate features behind flags from day one.
- **Tech reqs:** Flag service; default map.
- **Dependencies:** 10.
- **Risks:** Flag sprawl → registry.
- **Deliverables:** Feature-flag service.
- **Acceptance:** Flags resolve from defaults; stable per user.
- **Testing:** Unit.
- **Future expansion:** feature-flags (Realtime) wiring (Epoch E).

### Phase 20 — Process Supervisor & Sidecar Harness *(Complexity: L)*
- **Goal:** Supervise child processes (health, restart, breakers).
- **Scope:** `ProcessSupervisor` (ping, backoff restart, crash-loop breaker, resource ceilings) + a no-op sidecar harness (Part II §13.3).
- **Features:** Foundation for Rust Core, AI Orchestrator, Extension Host, PTY.
- **Tech reqs:** Spawn/monitor over IPC; circuit breaker.
- **Dependencies:** 6.
- **Risks:** Crash loops → breaker + degrade.
- **Deliverables:** Supervisor + sample supervised sidecar.
- **Acceptance:** Killed sidecar auto-restarts; crash-loop trips breaker.
- **Testing:** Chaos test (kill sidecar), unit (breaker).
- **Future expansion:** Host each real sidecar in later epochs.

**Epoch A Exit Criteria:** a signed-capable, auto-updating, hardened Electron+React shell launches fast, survives crashes (basic state), has typed IPC, PAL, DI, logging, local settings/DB, telemetry/flags scaffolds, a themed component base, and a sidecar supervisor — all under a green CI standard gate. This is the chassis for everything that follows.

---

*Part XIV continues in the next installment (Epoch B — Core Workbench & Editor, Phases 21–48).*


## EPOCH B — CORE WORKBENCH & EDITOR (Phases 21–48)

*Objective: turn the chassis into a real, usable code editor — layout, commands, Monaco editing, explorer, tabs/splits, file I/O, workspaces, search, and settings UI. By the end, Axiom edits, navigates, and searches code like a lightweight VS Code (no AI, Git, terminal, or debug yet).*

### Phase 21 — Workbench Layout Shell *(Complexity: L)*
- **Goal:** Render the region layout (Part VII §102).
- **Scope:** Activity Bar, Primary/Secondary Side Bars, Editor Area, Panel, Status Bar, Title Bar shells.
- **Features:** Structural workbench with placeholder views.
- **Tech reqs:** `workbench` package; resizable split regions; region registry.
- **Dependencies:** 13,14.
- **Risks:** Layout perf/jank → GPU-friendly, virtualization-ready.
- **Deliverables:** Workbench component tree.
- **Acceptance:** All regions render, resize, and show/hide.
- **Testing:** Visual regression; unit (region toggle).
- **Future expansion:** Contributed views/panels attach here.

### Phase 22 — Layout Persistence, Zen & Customization *(Complexity: M)*
- **Goal:** Persist and customize layout.
- **Scope:** Save/restore sizes/visibility/active views per workspace; move panel; Zen/full-screen; reset layout (Part VII §102.2/§102.3).
- **Features:** Personalized, restored layouts.
- **Tech reqs:** Layout state in settings/journal.
- **Dependencies:** 10,16,21.
- **Risks:** Corrupt layout state → reset fallback.
- **Deliverables:** Layout persistence + Zen mode.
- **Acceptance:** Layout restores on reopen; reset works.
- **Testing:** E2E (persist/restore), unit.
- **Future expansion:** Detached/floating panels (Post-1.0).

### Phase 23 — Command System & Registry *(Complexity: M)*
- **Goal:** Central command registry (Part VII §103.1).
- **Scope:** Register commands (id/title/category/when/handler); the sole state-mutation path; telemetry hook.
- **Features:** Uniform action invocation.
- **Tech reqs:** Registry + dispatcher; args support.
- **Dependencies:** 8.
- **Risks:** Command sprawl → categories.
- **Deliverables:** Command service.
- **Acceptance:** Commands invocable programmatically + logged.
- **Testing:** Unit (register/dispatch/when).
- **Future expansion:** Every feature contributes commands.

### Phase 24 — Command Palette *(Complexity: M)*
- **Goal:** Fuzzy command palette (Ctrl+Shift+P).
- **Scope:** Searchable list, keybinding hints, recent-first, multi-step quick-pick (Part VII §103.2).
- **Features:** Universal action access.
- **Tech reqs:** Fuzzy matcher; quick-pick component.
- **Dependencies:** 13,23.
- **Risks:** Match perf → indexed/fuzzy in worker.
- **Deliverables:** Palette UI.
- **Acceptance:** Runs any command; <100ms first results (B8).
- **Testing:** Perf + e2e.
- **Future expansion:** `>`,`@`,`#`,`:` modes (Phase 25).

### Phase 25 — Quick Open (files/symbols/lines) *(Complexity: M)*
- **Goal:** Ctrl+P unified quick access (Part VII §103.3).
- **Scope:** File open by fuzzy path; `@` symbol, `:` line, `#` workspace symbol, `>` command.
- **Features:** Fast navigation.
- **Tech reqs:** Recency ranking; file list source.
- **Dependencies:** 24,30.
- **Risks:** Large repos → virtualized + streamed.
- **Deliverables:** Quick Open.
- **Acceptance:** Opens files quickly on large repos; modes work.
- **Testing:** Perf (large repo), e2e.
- **Future expansion:** Symbol modes wire to LSP/index (Epoch C/D).

### Phase 26 — Context Keys & When-Clauses *(Complexity: S)*
- **Goal:** Contextual enablement (Part VII §103.4).
- **Scope:** Context key store (editorFocus, terminalFocus, etc.); `when` evaluation.
- **Features:** Context-aware commands/keys/menus.
- **Tech reqs:** Reactive context store; expression parser.
- **Dependencies:** 23.
- **Risks:** Perf on frequent updates → memoize.
- **Deliverables:** Context-key service.
- **Acceptance:** `when` gates commands correctly.
- **Testing:** Unit (expression eval).
- **Future expansion:** More context keys per subsystem.

### Phase 27 — Keybinding System (core) *(Complexity: M)*
- **Goal:** Bind keys→commands with chords + when (Part VII §119).
- **Scope:** Default bindings, chord support, platform-aware; conflict detection.
- **Features:** Keyboard-driven app.
- **Tech reqs:** Keybinding resolver; when-integration.
- **Dependencies:** 23,26.
- **Risks:** Conflicts → detection + resolution.
- **Deliverables:** Keybinding service + defaults.
- **Acceptance:** Bindings fire per context; conflicts surfaced.
- **Testing:** Unit (resolution, chords, conflicts).
- **Future expansion:** Keymaps + editor UI (Phase 47).

### Phase 28 — Status Bar Framework & Items *(Complexity: S)*
- **Goal:** Contributed status-bar items (Part IX §160).
- **Scope:** Left/right item slots; clickable; priority ordering; hide/show.
- **Features:** Position, language, encoding, EOL indicators (initial).
- **Tech reqs:** Status-bar registry.
- **Dependencies:** 21,23.
- **Risks:** Overflow → priority + collapse.
- **Deliverables:** Status-bar service + base items.
- **Acceptance:** Items render, click actions work.
- **Testing:** Unit + visual.
- **Future expansion:** Git/index/cost/AI items later.

### Phase 29 — Notifications, Toasts & Notification Center *(Complexity: M)*
- **Goal:** In-app messaging (Part IX §164).
- **Scope:** Toasts (severity/actions/auto-dismiss), banners, notification center history, badges.
- **Features:** Consistent feedback/messaging.
- **Tech reqs:** Notification service + components.
- **Dependencies:** 13,28.
- **Risks:** Notification fatigue → severity policy + batching.
- **Deliverables:** Notification system.
- **Acceptance:** Toasts stack/dismiss; center stores history.
- **Testing:** Unit + visual + a11y (live regions).
- **Future expansion:** OS toasts (Epoch J), per-category controls.

### Phase 30 — File System Service (transactional) *(Complexity: L)*
- **Goal:** Safe file I/O + watching (Part VII §104.7, II §22).
- **Scope:** Read/write/rename/delete; atomic writes (temp+fsync+rename); PAL watcher wiring; encoding-aware.
- **Features:** Reliable file operations foundation.
- **Tech reqs:** `filesystem` service on PAL; recycle-bin delete.
- **Dependencies:** 7,11.
- **Risks:** Data loss/corruption → atomic + tests.
- **Deliverables:** FS service + watcher events.
- **Acceptance:** Atomic writes verified (power-loss sim); watch events fire.
- **Testing:** Integration (atomicity, watch), recovery test.
- **Future expansion:** Large-file streaming (Epoch J).

### Phase 31 — Workspace Model & Single-Folder Open *(Complexity: M)*
- **Goal:** Open a folder as a workspace (Part VII §111.1).
- **Scope:** Root model, recent workspaces, `.axiom/` detection; open/close flow.
- **Features:** Open folder → workspace context.
- **Tech reqs:** Workspace service; recents store.
- **Dependencies:** 30.
- **Risks:** Huge folders → lazy (Phase 33).
- **Deliverables:** Workspace service + open flow.
- **Acceptance:** Open/close folder; recents persist.
- **Testing:** E2E (open/close), unit.
- **Future expansion:** Multi-root (Phase 32), trust (Epoch D/I).

### Phase 32 — Multi-Root Workspaces & Workspace File *(Complexity: M)*
- **Goal:** Multiple roots + `.axiom-workspace` (Part VII §111.2/§111.3).
- **Scope:** Add/remove roots; workspace-file save/load; VS Code `.code-workspace` import.
- **Features:** Polyrepo/monorepo-slice workflows.
- **Tech reqs:** Workspace-file schema; per-root settings resolution.
- **Dependencies:** 31.
- **Risks:** Settings precedence complexity → tests.
- **Deliverables:** Multi-root support + workspace file.
- **Acceptance:** Multiple roots operate; workspace file round-trips.
- **Testing:** Integration (precedence, import).
- **Future expansion:** Team-shared workspace config.

### Phase 33 — File Explorer Tree (virtualized) *(Complexity: L)*
- **Goal:** Scalable file tree (Part VII §104.1).
- **Scope:** Virtualized tree; lazy expansion; ignore/hidden filtering; large-folder handling.
- **Features:** Browse huge repos smoothly.
- **Tech reqs:** Virtualized tree component; watcher-driven updates.
- **Dependencies:** 13,30,31.
- **Risks:** 1M-file perf → virtualization + lazy (B-scale).
- **Deliverables:** Explorer view.
- **Acceptance:** Smooth on 100k+ entry dirs; live updates.
- **Testing:** Perf (huge tree), integration (watch).
- **Future expansion:** Decorations (Phase 34), Git/AI badges (later).

### Phase 34 — Explorer Operations & Context Menu *(Complexity: M)*
- **Goal:** File ops + menus + decorations (Part VII §104.2/§104.3/§104.4).
- **Scope:** Create/rename/delete/duplicate/move; drag-drop (in-app + OS); cut/copy/paste; copy path; reveal in OS; decoration provider API.
- **Features:** Full explorer interactions.
- **Tech reqs:** Context-menu integration; decoration registry.
- **Dependencies:** 33.
- **Risks:** Destructive ops → confirm + recycle.
- **Deliverables:** Explorer ops + menus.
- **Acceptance:** All ops work; deletes recoverable; decorations show.
- **Testing:** E2E (ops), unit (decorations).
- **Future expansion:** Git/problems/AI decorations.

### Phase 35 — Editor Host (Monaco) Integration *(Complexity: L)*
- **Goal:** Monaco behind `IEditorHost` (Part VII §106, II §12.3).
- **Scope:** Mount Monaco; open a file into an editor; wrap API behind interface.
- **Features:** Edit code in a real editor.
- **Tech reqs:** Monaco integration; model↔file binding.
- **Dependencies:** 30,21.
- **Risks:** Editor coupling → interface wrapper.
- **Deliverables:** Editor host package.
- **Acceptance:** Open/edit/save a file; interface hides Monaco.
- **Testing:** E2E (edit/save), unit (host API).
- **Future expansion:** Diff editor, AI overlays (later).

### Phase 36 — Editor Tabs (preview/pinned/dirty) *(Complexity: M)*
- **Goal:** Tabbed editors (Part VII §105.1).
- **Scope:** Open/close, preview tabs, pin, dirty indicator, reorder, overflow, disambiguated labels.
- **Features:** Familiar tab UX.
- **Tech reqs:** Tab model per group.
- **Dependencies:** 35.
- **Risks:** Many tabs perf → virtualize overflow.
- **Deliverables:** Tab bar + model.
- **Acceptance:** Preview/pin/dirty/reorder behave correctly.
- **Testing:** E2E, unit.
- **Future expansion:** Drag across groups/windows (Phase 37/multi-window).

### Phase 37 — Editor Groups & Splits (grid) *(Complexity: L)*
- **Goal:** Split editors into a grid (Part VII §105.2).
- **Scope:** H/V splits, move/duplicate editors between groups, maximize; independent scroll/selection.
- **Features:** Side-by-side editing.
- **Tech reqs:** Editor-group manager; grid layout.
- **Dependencies:** 36.
- **Risks:** Grid complexity → tested layout engine.
- **Deliverables:** Split/group support.
- **Acceptance:** Arbitrary grid; drag tabs between groups.
- **Testing:** E2E (split/drag), unit.
- **Future expansion:** Cross-window drag; diff/merge editors.

### Phase 38 — Text Model, Encodings, EOL & Save/Auto-save *(Complexity: M)*
- **Goal:** Robust document handling (Part VII §106.5, VI §88.4).
- **Scope:** Encoding detect/convert (UTF-8/16/BOM), EOL (LF/CRLF), auto-save modes, dirty-buffer journaling, external-change detection.
- **Features:** Safe, correct file handling.
- **Tech reqs:** Encoding lib; journal integration (Phase 16).
- **Dependencies:** 16,30,35.
- **Risks:** EOL/encoding churn → detect + editorconfig.
- **Deliverables:** Text-model service.
- **Acceptance:** Encodings/EOL correct; unsaved survives crash.
- **Testing:** Integration (encoding/EOL), recovery test.
- **Future expansion:** Large-file mode (Epoch J).

### Phase 39 — Syntax Highlighting (Tree-sitter + fallback) *(Complexity: L)*
- **Goal:** Fast incremental highlighting (Part VII §106.2).
- **Scope:** Tree-sitter (WASM) highlighting in worker; TextMate fallback; folding + basic outline from Tree-sitter.
- **Features:** Accurate, structure-aware coloring.
- **Tech reqs:** Tree-sitter WASM grammars; worker-based parsing.
- **Dependencies:** 35.
- **Risks:** Hot-path latency → off-thread + incremental.
- **Deliverables:** Highlighting + folding.
- **Acceptance:** Highlight within input budget; folding works.
- **Testing:** Perf (large file), visual.
- **Future expansion:** Semantic highlighting via LSP (Epoch D).

### Phase 40 — Core Editor Features *(Complexity: M)*
- **Goal:** Pro editing features (Part VII §106.1).
- **Scope:** Multi-cursor, smart select, find widget, minimap, sticky scroll, bracket colorization/guides, line ops.
- **Features:** VS Code-class editing ergonomics.
- **Tech reqs:** Monaco config + custom actions.
- **Dependencies:** 35,39.
- **Risks:** Feature perf → virtualization/off-thread.
- **Deliverables:** Editing feature set.
- **Acceptance:** Features work within latency budget (B4/B5).
- **Testing:** E2E + perf.
- **Future expansion:** AI ghost text coexistence (Epoch G).

### Phase 41 — Formatting *(Complexity: M)*
- **Goal:** Format document/selection + on-save/type/paste (Part VII §106.6).
- **Scope:** Formatter registry; `.editorconfig`; default-formatter selection.
- **Features:** Consistent code formatting.
- **Tech reqs:** Format provider interface.
- **Dependencies:** 35.
- **Risks:** Multiple formatters → default selection UX.
- **Deliverables:** Formatting service.
- **Acceptance:** Format on save/type/paste per config.
- **Testing:** Integration (formatters), unit.
- **Future expansion:** LSP/extension formatters (Epoch D/I).

### Phase 42 — In-File Find & Replace *(Complexity: M)*
- **Goal:** Editor find/replace (Part VII §110.1).
- **Scope:** Case/word/regex, in-selection, match nav/count, replace/all with capture groups.
- **Features:** Powerful in-file search.
- **Tech reqs:** Monaco find integration.
- **Dependencies:** 35.
- **Risks:** Regex perf on huge files → guard.
- **Deliverables:** Find widget.
- **Acceptance:** All modes work; safe on large files.
- **Testing:** E2E, perf.
- **Future expansion:** —

### Phase 43 — Workspace Search UI + ripgrep (Node) *(Complexity: L)*
- **Goal:** Full-text search across the workspace (Part VII §110.2).
- **Scope:** Bundled ripgrep invoked from Main; streamed results tree; include/exclude globs; ignore-aware. (Moves into Rust Core in Epoch C.)
- **Features:** Fast repo-wide search.
- **Tech reqs:** ripgrep binary (bundled); streaming results over IPC.
- **Dependencies:** 6,30,33.
- **Risks:** Huge result sets → stream + bounded + load-more.
- **Deliverables:** Search view + service.
- **Acceptance:** First results <300ms on large repo (B9); cancellable.
- **Testing:** Perf (large repo), integration.
- **Future expansion:** Rust Core search + semantic (Epoch C/F).

### Phase 44 — Search & Replace Across Files *(Complexity: M)*
- **Goal:** Multi-file replace with preview (Part VII §110.3).
- **Scope:** Preview matches per file, per-match exclude, apply as undoable batch; regex capture replace.
- **Features:** Safe bulk edits.
- **Tech reqs:** Batch-edit engine (atomic, snapshot-friendly).
- **Dependencies:** 43,38.
- **Risks:** Bad replace → preview + undo batch.
- **Deliverables:** Replace-across-files.
- **Acceptance:** Preview accurate; batch undoable.
- **Testing:** Integration (apply/undo).
- **Future expansion:** AI-assisted replace (Epoch G).

### Phase 45 — Breadcrumbs & Outline *(Complexity: M)*
- **Goal:** Structural navigation (Part VII §105.4/§104.7).
- **Scope:** Breadcrumbs (path+symbol), Outline view from Tree-sitter; click-to-navigate.
- **Features:** Jump by structure.
- **Tech reqs:** Symbol provider (Tree-sitter now, LSP later).
- **Dependencies:** 39.
- **Risks:** Symbol accuracy → LSP later.
- **Deliverables:** Breadcrumbs + outline.
- **Acceptance:** Reflect file structure; navigate on click.
- **Testing:** Unit + e2e.
- **Future expansion:** LSP symbols (Epoch D).

### Phase 46 — Settings UI (GUI + JSON) *(Complexity: L)*
- **Goal:** Settings experience (Part VII §120, IX §167).
- **Scope:** Searchable GUI, per-scope tabs, typed controls, modified filter, reset; `settings.json` editor in sync.
- **Features:** Configure the IDE via GUI/JSON.
- **Tech reqs:** Settings schema→controls; deep-link ("Configure…").
- **Dependencies:** 10,13.
- **Risks:** GUI/JSON drift → single schema.
- **Deliverables:** Settings editor.
- **Acceptance:** GUI↔JSON in sync; search + reset work.
- **Testing:** E2E, unit.
- **Future expansion:** Sync/profiles/managed (Epoch E/I).

### Phase 47 — Keybindings Editor & Keymaps (base) *(Complexity: M)*
- **Goal:** Manage shortcuts + import keymaps (Part VII §119).
- **Scope:** Keybindings editor (search/rebind/record/conflict); Axiom + VS Code keymaps (JetBrains/Vim later).
- **Features:** Customizable, familiar shortcuts.
- **Tech reqs:** Keymap definitions; conflict UI.
- **Dependencies:** 27,46.
- **Risks:** Keymap fidelity → tests + docs.
- **Deliverables:** Keybindings editor + 2 keymaps.
- **Acceptance:** Rebind + import work; conflicts surfaced.
- **Testing:** Unit + e2e.
- **Future expansion:** Vim mode, more keymaps (Epoch I).

### Phase 48 — Welcome/Home, Recents & Session Restore *(Complexity: M)*
- **Goal:** Entry screen + full tab/layout restore (Part IX §157, VI §87.7).
- **Scope:** Welcome tab (Start/Recent/Tips), restore open tabs/active editor/layout on relaunch (lazy content).
- **Features:** Fast return to work.
- **Tech reqs:** Session state in journal; welcome view.
- **Dependencies:** 16,22,36,31.
- **Risks:** Restore correctness → recovery tests.
- **Deliverables:** Welcome + session restore.
- **Acceptance:** Tabs/layout restore; welcome shows recents.
- **Testing:** E2E (restore), recovery test.
- **Future expansion:** Walkthroughs, onboarding wizard (Epoch E/I).

**Epoch B Exit Criteria:** Axiom is a functional standalone code editor — open single/multi-root workspaces; browse a virtualized explorer with full file ops; edit in Monaco with tabs, splits, highlighting, formatting, and multi-cursor; find/replace in-file and across files (ripgrep); navigate via palette/quick-open/breadcrumbs/outline; configure via settings + keybindings; and restore the full session after relaunch — all within input-latency and large-repo budgets. No AI/Git/terminal/debug yet.

---

*Part XIV continues in the next installment (Epoch C — Rust Core Engine & Indexing, Phases 49–72).*


## EPOCH C — RUST CORE ENGINE & INDEXING (Phases 49–72)

*Objective: stand up the Rust Core sidecar and give Axiom deep, on-device understanding of a codebase — file walking/watching, Tree-sitter symbols, ripgrep search moved into Core, semantic chunking + local embeddings + HNSW vectors, incremental indexing, hybrid retrieval, and the knowledge graph. This is the foundation grounding all AI features. Everything here is local (INV-4).*

### Phase 49 — Rust Core Engine Bootstrap *(Complexity: L)*
- **Goal:** Launch the Rust sidecar with a JSON-RPC server under supervision.
- **Scope:** `axiom-core` crate: process entry, JSON-RPC over stdio, handshake/version negotiation, supervisor integration (Part II §12.5/§13).
- **Features:** Main can call Core methods; Core streams progress.
- **Tech reqs:** Tokio runtime; length-prefixed JSON-RPC; codegen'd types shared with `core-ipc`.
- **Dependencies:** 6,20.
- **Risks:** TS↔Rust boundary drift → shared schema codegen.
- **Deliverables:** Supervised Core sidecar + sample RPC.
- **Acceptance:** Core starts, handshakes, survives restart; version mismatch handled.
- **Testing:** Integration (RPC round-trip), chaos (kill/restart).
- **Future expansion:** Hosts indexer/search/embeddings/graph.

### Phase 50 — Cross-Platform File Walker *(Complexity: M)*
- **Goal:** Enumerate the workspace efficiently.
- **Scope:** Parallel walker respecting `.gitignore`/`files.exclude`, size/binary skip, symlink loop detection (Part VII §104.8).
- **Features:** Fast, ignore-aware file discovery.
- **Tech reqs:** Rust walker (ignore crate style); PAL path rules.
- **Dependencies:** 49.
- **Risks:** 1M-file perf → parallel + streaming.
- **Deliverables:** Walker API (stream file list).
- **Acceptance:** Walks large repo within budget; ignores respected.
- **Testing:** Perf (huge repo), unit (ignore/symlink).
- **Future expansion:** Feeds indexer + watcher reconciliation.

### Phase 51 — Native File Watcher (Rust) *(Complexity: L)*
- **Goal:** Efficient recursive file watching.
- **Scope:** ReadDirectoryChangesW-based watcher with debounce, rename coalescing, ignore filtering; normalized events (Part II §18).
- **Features:** Incremental awareness of file changes.
- **Tech reqs:** Rust watcher; back-pressure to consumers.
- **Dependencies:** 49,50.
- **Risks:** Event storms → debounce/coalesce + scoped watch.
- **Deliverables:** Watcher service emitting normalized events.
- **Acceptance:** Reliable events on large trees; no storms freeze UI.
- **Testing:** Integration (rename/bulk change), perf.
- **Future expansion:** Drives incremental indexing (Phase 61) + explorer updates.

### Phase 52 — Tree-sitter Parsing in Core *(Complexity: L)*
- **Goal:** Server-side incremental parsing for many languages.
- **Scope:** Tree-sitter grammars for top languages; incremental re-parse on edit; error-tolerant trees.
- **Features:** Structural understanding for symbols/nav.
- **Tech reqs:** Bundled grammars; parse cache; incremental edits.
- **Dependencies:** 49,50.
- **Risks:** Grammar coverage → prioritize top languages, extend later.
- **Deliverables:** Parser service.
- **Acceptance:** Parses top languages; incremental updates fast.
- **Testing:** Unit (per-grammar), perf (large file).
- **Future expansion:** More grammars; feeds symbols/graph.

### Phase 53 — Symbol Extraction *(Complexity: M)*
- **Goal:** Extract symbols (functions/classes/types/exports).
- **Scope:** Per-language symbol queries from Tree-sitter; symbol records with ranges (Part VIII §125.2).
- **Features:** Document + workspace symbols.
- **Tech reqs:** Tree-sitter queries; symbol schema.
- **Dependencies:** 52.
- **Risks:** Query accuracy → per-language tests.
- **Deliverables:** Symbol extractor.
- **Acceptance:** Accurate symbols for top languages.
- **Testing:** Unit (golden symbol sets).
- **Future expansion:** Powers outline, quick-open `@#`, graph.

### Phase 54 — Symbol Graph (foundation) *(Complexity: L)*
- **Goal:** Build defs/refs/import edges.
- **Scope:** Cross-file symbol relationships (defs, references, imports) from parsing (Part VIII §127).
- **Features:** Graph foundation for navigation/impact.
- **Tech reqs:** Graph store; incremental edge updates.
- **Dependencies:** 53.
- **Risks:** Dynamic-language incompleteness → best-effort + tests.
- **Deliverables:** Symbol graph API.
- **Acceptance:** Resolves defs/refs for top languages.
- **Testing:** Integration (nav queries).
- **Future expansion:** Knowledge graph (Phase 65), impact (66).

### Phase 55 — ripgrep Bridge in Core *(Complexity: M)*
- **Goal:** Move full-text search into Core with ranking.
- **Scope:** ripgrep-equivalent search in Rust; streaming results; regex/glob/ignore; relevance ranking.
- **Features:** Fast, integrated lexical search.
- **Tech reqs:** Rust regex/search; streamed over RPC.
- **Dependencies:** 49,50.
- **Risks:** Result volume → stream + bounded.
- **Deliverables:** Core search API.
- **Acceptance:** First results <300ms large repo (B9); cancellable.
- **Testing:** Perf, integration.
- **Future expansion:** Hybrid with vectors (Phase 64).

### Phase 56 — Wire Search & Symbol Quick-Open to Core *(Complexity: M)*
- **Goal:** Repoint Epoch-B search + `@#` quick-open to Core.
- **Scope:** Replace Node ripgrep (Phase 43) with Core; wire workspace symbols (`#`) and outline to Core symbols.
- **Features:** Faster search; real symbol navigation.
- **Tech reqs:** IPC wiring; feature-flag cutover.
- **Dependencies:** 43,45,53,55.
- **Risks:** Regression → flag + parity tests.
- **Deliverables:** Core-backed search/symbols.
- **Acceptance:** Parity+perf vs Node; symbols populate quick-open/outline.
- **Testing:** Integration (parity), perf.
- **Future expansion:** LSP symbols augment (Epoch D).

### Phase 57 — Index Catalog (SQLite schema) *(Complexity: M)*
- **Goal:** Persistent catalog of files/symbols/chunks.
- **Scope:** SQLite tables (files, symbols, chunks, hashes, meta) with migrations; content-hash tracking (Part II §12.8, XI §199).
- **Features:** Durable, queryable index metadata.
- **Tech reqs:** Schema + migrations; WAL.
- **Dependencies:** 11,53.
- **Risks:** Schema churn → versioned migrations.
- **Deliverables:** Index catalog.
- **Acceptance:** Catalog persists + migrates; integrity-checked.
- **Testing:** Integration (migrations, integrity).
- **Future expansion:** Vector table linkage (Phase 60).

### Phase 58 — Semantic Chunking *(Complexity: M)*
- **Goal:** Chunk code by logical boundaries for embedding.
- **Scope:** Function/class/block-aware chunking with overlap; doc/comment inclusion; size limits.
- **Features:** High-quality retrieval units.
- **Tech reqs:** Tree-sitter-driven chunker.
- **Dependencies:** 52,57.
- **Risks:** Poor chunking hurts retrieval → boundary-aware + eval.
- **Deliverables:** Chunker.
- **Acceptance:** Chunks respect structure; sized within limits.
- **Testing:** Unit (boundaries), retrieval eval.
- **Future expansion:** Adaptive chunking.

### Phase 59 — Local Embedding Host (bundled, offline) *(Complexity: L)*
- **Goal:** Generate embeddings on-device with zero egress.
- **Scope:** Bundled local embedding model in Core (ONNX/GGUF); content-hash cache to skip unchanged (Part V §76, VIII §125.5). (Provider-based embeddings added in Epoch F.)
- **Features:** Offline, keyless semantic indexing.
- **Tech reqs:** Rust inference runtime (CPU; optional GPU); embedding cache.
- **Dependencies:** 57,58.
- **Risks:** Model size/CPU cost → efficient model + batching + caching.
- **Deliverables:** Embedding service (local).
- **Acceptance:** Embeds chunks offline; cache skips unchanged.
- **Testing:** Unit (cache), perf (throughput).
- **Future expansion:** Provider embeddings via egress (Epoch F); GPU accel.

### Phase 60 — HNSW Vector Index *(Complexity: L)*
- **Goal:** On-device approximate nearest-neighbor search.
- **Scope:** HNSW build/insert/query, persisted + memory-mapped, linked to catalog (Part II §12.9).
- **Features:** Fast semantic similarity search.
- **Tech reqs:** Rust HNSW; mmap persistence; incremental updates.
- **Dependencies:** 59.
- **Risks:** Memory on huge repos → mmap + budgets.
- **Deliverables:** Vector index.
- **Acceptance:** Sub-100ms top-k on large index; persists/reloads.
- **Testing:** Perf (query), integration (persist).
- **Future expansion:** External vector engine option (Post-1.0).

### Phase 61 — Incremental Indexing Pipeline *(Complexity: XL)*
- **Goal:** Keep the index fresh incrementally.
- **Scope:** Watcher-driven re-parse/re-embed of changed files only; content-hash skip; prioritize open/active files; back-pressure (Part XI §199).
- **Features:** Always-current index without full rebuilds.
- **Tech reqs:** Pipeline orchestration; bounded concurrency; priority queue.
- **Dependencies:** 51,52,53,58,59,60.
- **Risks:** CPU contention → throttle + priority + budgets.
- **Deliverables:** Indexing pipeline.
- **Acceptance:** Single-file save searchable ≤500ms (B12); no UI stall.
- **Testing:** Integration (incremental), perf/soak.
- **Future expansion:** Partial/scoped indexing controls.

### Phase 62 — Index Persistence & Resume *(Complexity: M)*
- **Goal:** Survive restarts; resume/rebuild safely.
- **Scope:** Persist catalog+vectors+graph; resume partial index; rebuild-from-source on corruption (Part XI §199).
- **Features:** No re-index from scratch each launch.
- **Tech reqs:** Versioned index format; integrity checks.
- **Dependencies:** 57,60,61.
- **Risks:** Corruption → safe rebuild (never authoritative over code).
- **Deliverables:** Persistence/resume.
- **Acceptance:** Reopen uses persisted index; corruption → clean rebuild.
- **Testing:** Recovery (corrupt index), integration.
- **Future expansion:** Index format migrations.

### Phase 63 — Index Status, Progress & Control UI *(Complexity: M)*
- **Goal:** Visibility + control over indexing.
- **Scope:** Status-bar indicator; pause/resume/rebuild; includes/excludes; coverage; embedding-model choice (Part VIII §125.6).
- **Features:** User control of indexing.
- **Tech reqs:** Progress streaming; settings.
- **Dependencies:** 28,61.
- **Risks:** Noisy progress → sampled updates.
- **Deliverables:** Index status UI.
- **Acceptance:** Status accurate; controls work; excludes honored.
- **Testing:** E2E, integration.
- **Future expansion:** Per-embedding-provider selection (Epoch F).

### Phase 64 — Hybrid Retrieval API *(Complexity: L)*
- **Goal:** One retrieval call combining vector + lexical + symbol.
- **Scope:** Hybrid ranking/dedup; top-k with file/line provenance; query API for features (Part V §69.3, VIII §126).
- **Features:** Grounded retrieval for AI + semantic search UI.
- **Tech reqs:** Fusion ranking; provenance mapping.
- **Dependencies:** 55,60,54.
- **Risks:** Ranking quality → eval + tuning.
- **Deliverables:** Retrieval API.
- **Acceptance:** Relevant results with citations; within latency budget.
- **Testing:** Retrieval eval, perf.
- **Future expansion:** Semantic-search UI (Epoch G), context engine (Epoch F).

### Phase 65 — Knowledge Graph Construction *(Complexity: L)*
- **Goal:** Persist a repo-wide knowledge graph.
- **Scope:** Nodes (files/symbols/modules/packages) + edges (imports/calls/extends/refs); incremental updates (Part VIII §127.1).
- **Features:** Whole-repo relationship model.
- **Tech reqs:** Graph store atop symbol graph + manifests.
- **Dependencies:** 54,57.
- **Risks:** Multi-language edges → per-language extractors.
- **Deliverables:** Knowledge graph.
- **Acceptance:** Graph reflects real structure; updates incrementally.
- **Testing:** Integration (edges), eval.
- **Future expansion:** Impact/Q&A (66/67); viz (Epoch I).

### Phase 66 — Dependency & Impact Analysis API *(Complexity: M)*
- **Goal:** "What depends on X / what X depends on / blast radius."
- **Scope:** Graph queries for dependents/dependencies, cycles, dead-code candidates, impact set (Part VIII §127.2).
- **Features:** Safer refactors/review inputs.
- **Tech reqs:** Graph traversal API.
- **Dependencies:** 65.
- **Risks:** Dynamic edges missed → combine with tests.
- **Deliverables:** Impact API.
- **Acceptance:** Correct impact sets on test repos.
- **Testing:** Integration (known graphs).
- **Future expansion:** Refactor-safety (Epoch H).

### Phase 67 — Knowledge Graph Query & Q&A API *(Complexity: M)*
- **Goal:** Programmatic + NL-ready graph queries.
- **Scope:** Structured query API (paths, neighborhoods) usable by AI features later (Part VIII §127.3).
- **Features:** "Show request path route→DB" foundation.
- **Tech reqs:** Query language/API; result serialization.
- **Dependencies:** 65.
- **Risks:** Query complexity → bounded traversals.
- **Deliverables:** Graph query API.
- **Acceptance:** Path/neighborhood queries return correct results.
- **Testing:** Integration.
- **Future expansion:** NL graph Q&A (Epoch G/H).

### Phase 68 — Automatic Project Understanding *(Complexity: M)*
- **Goal:** Derive a project profile/repo map.
- **Scope:** Detect languages/frameworks/package managers/entry points/test+build commands; produce editable "Project Overview" (Part VIII §125.4).
- **Features:** Grounded first answers + sensible defaults.
- **Tech reqs:** Manifest parsers + heuristics + graph.
- **Dependencies:** 65.
- **Risks:** Misdetection → user-editable overview.
- **Deliverables:** Project understanding service.
- **Acceptance:** Correct profile on representative repos.
- **Testing:** Integration (fixture repos).
- **Future expansion:** Task/run-config suggestions (Epoch D), onboarding (Epoch H).

### Phase 69 — Core-Backed Code Navigation (pre-LSP) *(Complexity: M)*
- **Goal:** Go-to-def/refs + workspace symbols from the graph.
- **Scope:** Navigation using symbol graph as a fast, always-available baseline (before/without LSP) (Part VII §108).
- **Features:** Navigation even for languages lacking a server.
- **Tech reqs:** Nav API → editor.
- **Dependencies:** 54,56.
- **Risks:** Accuracy vs LSP → LSP overrides when present (Epoch D).
- **Deliverables:** Graph-based navigation.
- **Acceptance:** Reasonable go-to-def/refs for top languages.
- **Testing:** Integration.
- **Future expansion:** LSP-preferred, graph fallback.

### Phase 70 — Core Resource Management & Throttling *(Complexity: M)*
- **Goal:** Bound Core CPU/memory; respect interactivity/battery.
- **Scope:** Bounded pools, back-pressure, per-workspace budgets, throttle on battery/idle (Part XI §199/§208).
- **Features:** Indexing never starves the user.
- **Tech reqs:** Scheduler + budgets + power awareness.
- **Dependencies:** 61.
- **Risks:** Over-throttle slows indexing → adaptive.
- **Deliverables:** Resource manager.
- **Acceptance:** Interactive priority holds; battery mode reduces load.
- **Testing:** Stress, soak, perf.
- **Future expansion:** Agent-orchestration sharing (Epoch H).

### Phase 71 — Core Crash Isolation & Graceful Degradation *(Complexity: M)*
- **Goal:** Core failure degrades, never breaks editing.
- **Scope:** On Core crash → supervised restart; features degrade (lexical-only search, no embeddings) with clear status (Part II §13.4).
- **Features:** Resilient understanding layer.
- **Tech reqs:** Fallback paths; state re-sync on restart.
- **Dependencies:** 20,49,55,61.
- **Risks:** Silent degradation → visible status.
- **Deliverables:** Degradation + recovery.
- **Acceptance:** Kill Core mid-index → editing continues; auto-recovers.
- **Testing:** Chaos (kill Core), integration.
- **Future expansion:** Partial-feature availability signaling to AI.

### Phase 72 — Index Privacy, Exclusions & Clear *(Complexity: S)*
- **Goal:** On-device guarantees + user control.
- **Scope:** Exclude paths/globs from indexing; "clear index"; confirm index stays local (INV-4) (Part VIII §125.5).
- **Features:** Privacy control over understanding data.
- **Tech reqs:** Exclusion config; secure delete of index.
- **Dependencies:** 63,62.
- **Risks:** Accidental indexing of secrets → excludes + secret-skip.
- **Deliverables:** Privacy/exclusion controls.
- **Acceptance:** Excludes honored; clear wipes index; nothing leaves device.
- **Testing:** Integration (excludes/clear), privacy assertion test.
- **Future expansion:** Enterprise indexing policy (Post-1.0).

**Epoch C Exit Criteria:** the Rust Core sidecar delivers on-device repository intelligence — ignore-aware walking/watching, Tree-sitter symbols + graph, fast integrated search, semantic chunking + local (offline, keyless) embeddings + HNSW vectors, incremental resumable indexing, hybrid retrieval with citations, a knowledge graph with impact/query APIs, automatic project understanding, and graph-based navigation — all bounded, crash-isolated, privacy-controlled, and wired into the editor. Axiom now *understands* code; the AI engine (Epoch F) will consume this.

---

*Part XIV continues in the next installment (Epoch D — Developer Tooling: Terminal, Git, LSP, Debug — Phases 73–104).*


## EPOCH D — DEVELOPER TOOLING: TERMINAL, GIT, LSP, DEBUG (Phases 73–104)

*Objective: complete the professional IDE — integrated terminal, full Git source control, LSP language intelligence, the DAP debugger, tasks/build, and the Problems panel. At the end of Epoch D, Axiom is a complete, AI-free IDE suitable for an internal alpha (a developer could ship real work in it).*

### Phase 73 — PTY Host (ConPTY) *(Complexity: L)*
- **Goal:** Native pseudo-terminal backend.
- **Scope:** `IPtyHost` impl (ConPTY) with spawn/resize/write/kill; flow-controlled streaming (Part II §18, VII §112.1).
- **Features:** Backend for the integrated terminal.
- **Tech reqs:** node-pty/ConPTY; dedicated high-throughput IPC channel.
- **Dependencies:** 7,20.
- **Risks:** Throughput/flow control → windowed back-pressure.
- **Deliverables:** PTY host.
- **Acceptance:** Spawn shell; stream I/O; resize/kill work.
- **Testing:** Integration (I/O, resize, kill).
- **Future expansion:** mac/Linux forkpty (Epoch K).

### Phase 74 — Terminal UI (xterm.js) *(Complexity: M)*
- **Goal:** Render a terminal in the panel.
- **Scope:** xterm.js bound to PTY; GPU renderer; scrollback buffer (Part VII §112).
- **Features:** Usable integrated terminal.
- **Tech reqs:** xterm + addons; buffer config.
- **Dependencies:** 73,21.
- **Risks:** Large-output perf → GPU + virtualized scrollback.
- **Deliverables:** Terminal view.
- **Acceptance:** Interactive shell; smooth output.
- **Testing:** E2E (run command), perf (firehose).
- **Future expansion:** AI terminal actions (Epoch G).

### Phase 75 — Multiple Terminals, Splits & Profiles *(Complexity: M)*
- **Goal:** Many terminals + shell profiles.
- **Scope:** Tabs/list, split panes, rename/color; auto-detected profiles (cmd/PowerShell/Git Bash/WSL) + custom (Part VII §112.2/§112.4).
- **Features:** Flexible terminal workflows.
- **Tech reqs:** Profile detection; per-terminal cwd/env.
- **Dependencies:** 74.
- **Risks:** WSL/profile quirks → matrix tests.
- **Deliverables:** Terminal management + profiles.
- **Acceptance:** Multiple/split terminals; profiles launch correctly.
- **Testing:** Compatibility (shells), e2e.
- **Future expansion:** Move terminal to editor area.

### Phase 76 — Shell Integration *(Complexity: M)*
- **Goal:** Command/cwd/exit-code awareness.
- **Scope:** Injected markers for command start/end, exit codes, cwd; command decorations; "rerun/copy output" (Part VII §112.3).
- **Features:** Rich terminal intelligence.
- **Tech reqs:** Shell integration scripts per shell.
- **Dependencies:** 75.
- **Risks:** Shell variance → per-shell scripts + fallback.
- **Deliverables:** Shell integration.
- **Acceptance:** Command boundaries + exit codes detected.
- **Testing:** Compatibility (per shell).
- **Future expansion:** AI "explain output/fix error" (Epoch G).

### Phase 77 — Terminal Interaction & Accessibility *(Complexity: M)*
- **Goal:** Links, find, copy/paste, a11y, perf.
- **Scope:** Clickable links (URL/file:line), find-in-terminal, copy-on-select/paste options, screen-reader mode; large-paste confirm (Part VII §112.5/§112.7).
- **Features:** Polished terminal UX.
- **Tech reqs:** Link providers; a11y buffer.
- **Dependencies:** 76.
- **Risks:** Perf on huge output → throttle.
- **Deliverables:** Terminal interactions.
- **Acceptance:** Links open files; find works; a11y passes.
- **Testing:** E2E + a11y + perf.
- **Future expansion:** Agent terminal tool (Epoch H).

### Phase 78 — Git Service Architecture *(Complexity: L)*
- **Goal:** `IGitService` using the user's Git.
- **Scope:** Repo detection (multi-root), `.git` watching, status computation (background), libgit2/CLI hybrid (Part VII §113.1).
- **Features:** Git foundation.
- **Tech reqs:** Git integration layer; async status.
- **Dependencies:** 30,31.
- **Risks:** Large-repo status perf → background + incremental.
- **Deliverables:** Git service.
- **Acceptance:** Detects repos; status updates on change.
- **Testing:** Integration (status, multi-repo).
- **Future expansion:** Hosting providers via extensions.

### Phase 79 — SCM View *(Complexity: M)*
- **Goal:** Changes/staging UI.
- **Scope:** Grouped staged/unstaged/merge; multi-repo sections; refresh (Part VII §113.2).
- **Features:** See and organize changes.
- **Tech reqs:** SCM view + provider model.
- **Dependencies:** 78.
- **Risks:** Many changes → virtualized list.
- **Deliverables:** SCM view.
- **Acceptance:** Reflects working tree accurately.
- **Testing:** Integration, e2e.
- **Future expansion:** AI review of changes (Epoch G/H).

### Phase 80 — Staging, Discard & Commit *(Complexity: M)*
- **Goal:** Stage/unstage/discard/commit.
- **Scope:** Per-file/hunk/line stage; discard (recycle/confirm); commit/amend/sign-off (Part VII §113.2).
- **Features:** Core commit workflow.
- **Tech reqs:** Hunk/line staging engine.
- **Dependencies:** 79,81.
- **Risks:** Data loss on discard → confirm + recovery.
- **Deliverables:** Staging/commit.
- **Acceptance:** Stage granularity + commit work.
- **Testing:** Integration (stage/commit/amend).
- **Future expansion:** AI commit messages (Epoch G).

### Phase 81 — Diff Editor (side-by-side + inline) *(Complexity: L)*
- **Goal:** Reusable diff viewer.
- **Scope:** Monaco diff editor; side-by-side/inline toggle; navigation; used by Git + later AI diff review (Part VII §105.3).
- **Features:** High-quality diffs.
- **Tech reqs:** Diff component; large-diff virtualization.
- **Dependencies:** 35.
- **Risks:** Huge diffs → virtualize.
- **Deliverables:** Diff editor.
- **Acceptance:** Accurate diffs; performant on large files.
- **Testing:** Visual + perf.
- **Future expansion:** AI diff review reuses this (Epoch G).

### Phase 82 — Gutter Indicators & Inline Stage/Revert *(Complexity: M)*
- **Goal:** In-editor change indicators.
- **Scope:** Added/modified/deleted gutter marks; inline hunk stage/revert; diff-against-HEAD (Part VII §113.3).
- **Features:** Edit-time Git awareness.
- **Tech reqs:** Decoration provider + diff computation.
- **Dependencies:** 78,81.
- **Risks:** Perf on large files → incremental diff.
- **Deliverables:** Gutter + inline actions.
- **Acceptance:** Indicators accurate; inline stage/revert work.
- **Testing:** Integration, e2e.
- **Future expansion:** —

### Phase 83 — Branch Operations *(Complexity: M)*
- **Goal:** Manage branches.
- **Scope:** Create/checkout/rename/delete; publish/track; branch picker (Part VII §113.4).
- **Features:** Branch workflow.
- **Tech reqs:** Git branch ops.
- **Dependencies:** 78.
- **Risks:** Uncommitted-changes conflicts → guard/stash prompt.
- **Deliverables:** Branch management.
- **Acceptance:** All branch ops work with guards.
- **Testing:** Integration.
- **Future expansion:** —

### Phase 84 — Merge/Rebase/Cherry-pick/Revert/Reset + Stash *(Complexity: L)*
- **Goal:** Advanced history operations.
- **Scope:** Merge, rebase, cherry-pick, revert, reset (guarded), tag; stash create/apply/pop/list (Part VII §113.4).
- **Features:** Full Git operation set.
- **Tech reqs:** Op orchestration; in-progress state tracking.
- **Dependencies:** 83.
- **Risks:** Destructive ops → confirm + non-destructive defaults.
- **Deliverables:** Advanced Git ops.
- **Acceptance:** Ops succeed; in-progress states indicated.
- **Testing:** Integration (each op), recovery.
- **Future expansion:** AI-assisted rebase/conflict (Epoch H).

### Phase 85 — History, Commit Graph & Blame *(Complexity: L)*
- **Goal:** Visualize history.
- **Scope:** Commit graph (repo + per-file), blame (inline + gutter), timeline view (Part VII §113.4, §104.7).
- **Features:** Understand code evolution.
- **Tech reqs:** Graph rendering; blame computation.
- **Dependencies:** 78.
- **Risks:** Large history perf → virtualize + paginate.
- **Deliverables:** History/blame views.
- **Acceptance:** Accurate graph/blame; performant.
- **Testing:** Integration, perf.
- **Future expansion:** "Explain this history/PR" (Epoch H).

### Phase 86 — 3-Way Merge Editor *(Complexity: L)*
- **Goal:** Resolve conflicts visually.
- **Scope:** Incoming/current/result panes; accept-incoming/current/both; conflict nav; marker fallback (Part VII §113.5).
- **Features:** Conflict resolution UX.
- **Tech reqs:** Merge editor component.
- **Dependencies:** 81,84.
- **Risks:** Complex conflicts → clear UX + fallback.
- **Deliverables:** Merge editor.
- **Acceptance:** Resolve conflicts correctly; save resolution.
- **Testing:** Integration (conflict scenarios).
- **Future expansion:** AI resolution suggestions (Epoch H).

### Phase 87 — Remotes: Fetch/Pull/Push/Sync + Auth *(Complexity: M)*
- **Goal:** Interact with remotes.
- **Scope:** Fetch/pull/push/sync; manage remotes; auth via OS Git credential manager/SSH (Part VII §113.6).
- **Features:** Collaborate via remotes.
- **Tech reqs:** Delegate auth to Git; handle prompts.
- **Dependencies:** 78.
- **Risks:** Auth complexity → delegate to Git helpers.
- **Deliverables:** Remote operations.
- **Acceptance:** Push/pull/sync with real remotes.
- **Testing:** Integration (mock/real remote).
- **Future expansion:** PR/MR via extensions (Epoch I).

### Phase 88 — Git Scale & Edge Cases *(Complexity: M)*
- **Goal:** Robustness on real-world repos.
- **Scope:** Submodules, worktrees, LFS, sparse/partial clone awareness, huge diffs, detached HEAD, in-progress states with guidance (Part VII §113.9).
- **Features:** Reliable on complex repos.
- **Tech reqs:** Edge-state detection + UX.
- **Dependencies:** 84,85,87.
- **Risks:** Edge-state confusion → explicit indicators + next steps.
- **Deliverables:** Edge-case handling.
- **Acceptance:** Complex repos operate without corruption/confusion.
- **Testing:** Compatibility (submodule/LFS/worktree).
- **Future expansion:** —

### Phase 89 — LSP Client Architecture *(Complexity: L)*
- **Goal:** Host language servers out-of-process.
- **Scope:** LSP client, server lifecycle/supervision, multi-server per doc, settings (Part VII §107.1/§107.3).
- **Features:** Language-intelligence foundation.
- **Tech reqs:** LSP transport; supervised child processes; capability negotiation.
- **Dependencies:** 20,35.
- **Risks:** Server crashes → supervise + restart.
- **Deliverables:** LSP client.
- **Acceptance:** Start/stop servers; handle crashes.
- **Testing:** Integration (lifecycle).
- **Future expansion:** More servers via extensions.

### Phase 90 — Bundled Language Servers + On-Demand Install *(Complexity: M)*
- **Goal:** Out-of-box language support.
- **Scope:** Bundle TS/JS, JSON/HTML/CSS, Python, Markdown; on-demand install prompt for others (Part VII §107.3).
- **Features:** Immediate IntelliSense for top languages.
- **Tech reqs:** Server packaging; install flow.
- **Dependencies:** 89.
- **Risks:** Server size → bundle top few, install rest.
- **Deliverables:** Bundled servers + installer.
- **Acceptance:** Top languages work on open; others prompt.
- **Testing:** Integration (per language).
- **Future expansion:** Extension-provided servers (Epoch I).

### Phase 91 — Core Language Features + Completion Controller *(Complexity: L)*
- **Goal:** Hover/complete/signature/diagnostics + unified completion.
- **Scope:** LSP hover, completion (+resolve), signature help, diagnostics; a completion controller merging LSP/snippet/word sources (Part VII §107.2, §109).
- **Features:** IntelliSense.
- **Tech reqs:** Completion ranking/dedup; debounced diagnostics.
- **Dependencies:** 90.
- **Risks:** Latency → async, debounced, cancellable.
- **Deliverables:** Language features + completion.
- **Acceptance:** Fast, accurate completions/diagnostics.
- **Testing:** Integration + perf.
- **Future expansion:** AI ghost-text coexistence (Epoch G §109.2).

### Phase 92 — LSP Navigation (override graph baseline) *(Complexity: M)*
- **Goal:** Precise navigation via LSP.
- **Scope:** Go-to def/decl/type/impl, references, peek; prefer LSP, fall back to Core graph (Part VII §108, Phase 69).
- **Features:** Accurate code navigation.
- **Tech reqs:** LSP requests + peek UI.
- **Dependencies:** 91,69.
- **Risks:** Server gaps → graph fallback.
- **Deliverables:** LSP navigation.
- **Acceptance:** Precise nav where server present; fallback otherwise.
- **Testing:** Integration.
- **Future expansion:** AI "trace symbol" (Epoch H).

### Phase 93 — Code Actions, Quick Fixes & Rename *(Complexity: M)*
- **Goal:** Refactors/fixes via LSP.
- **Scope:** Code actions/quick fixes (lightbulb), rename with cross-file preview (Part VII §107.2).
- **Features:** Standard refactors.
- **Tech reqs:** Workspace-edit application (atomic/undoable).
- **Dependencies:** 91,44.
- **Risks:** Bad edits → preview + undo.
- **Deliverables:** Code actions + rename.
- **Acceptance:** Rename updates refs with preview; quick fixes apply.
- **Testing:** Integration.
- **Future expansion:** AI code actions alongside (Epoch G).

### Phase 94 — Semantic Highlighting, Inlay Hints & Code Lens *(Complexity: M)*
- **Goal:** Richer in-editor info.
- **Scope:** Semantic tokens overlay, inlay hints (types/params), code lens (refs/run) (Part VII §106.8).
- **Features:** Deeper visual intelligence.
- **Tech reqs:** LSP semantic tokens/inlay/lens.
- **Dependencies:** 91,39.
- **Risks:** Visual clutter/perf → toggles + debounce.
- **Deliverables:** Semantic overlays.
- **Acceptance:** Accurate highlighting/hints/lens; performant.
- **Testing:** Integration + perf.
- **Future expansion:** AI code lens (explain/test) (Epoch G).

### Phase 95 — Call/Type Hierarchy & Symbols (augment Core) *(Complexity: M)*
- **Goal:** Hierarchy + precise symbols.
- **Scope:** Call/type hierarchy; document/workspace symbols (LSP augmenting Core graph) (Part VII §108).
- **Features:** Advanced structural navigation.
- **Tech reqs:** LSP hierarchy requests; merge with Core.
- **Dependencies:** 92,56.
- **Risks:** Merge conflicts (LSP vs graph) → LSP-preferred.
- **Deliverables:** Hierarchy + symbols.
- **Acceptance:** Hierarchies correct; symbols enriched.
- **Testing:** Integration.
- **Future expansion:** Feeds AI reasoning/knowledge graph.

### Phase 96 — DAP Client Architecture *(Complexity: L)*
- **Goal:** Debug Adapter Protocol client.
- **Scope:** DAP transport, adapter lifecycle, multi-session support (Part VII §114.1).
- **Features:** Debugging foundation.
- **Tech reqs:** DAP client; supervised adapters.
- **Dependencies:** 20,35.
- **Risks:** Adapter variance → conformance handling.
- **Deliverables:** DAP client.
- **Acceptance:** Launch/attach a session; multi-session works.
- **Testing:** Integration (lifecycle).
- **Future expansion:** More adapters (Epoch I).

### Phase 97 — Debug UI *(Complexity: L)*
- **Goal:** Full debug views.
- **Scope:** Breakpoints (line/col), Variables (edit), Watch, Call Stack (multi-thread/session), Debug Console/REPL, loaded modules (Part VII §114.2).
- **Features:** Interactive debugging UX.
- **Tech reqs:** Debug views + editor breakpoint gutter.
- **Dependencies:** 96.
- **Risks:** Complex state UX → clear views.
- **Deliverables:** Debug UI.
- **Acceptance:** Inspect/step/evaluate in a paused session.
- **Testing:** E2E (debug session).
- **Future expansion:** AI debugging (Epoch H).

### Phase 98 — Launch Configurations *(Complexity: M)*
- **Goal:** Configure how to run/debug.
- **Scope:** `launch.json`-compatible configs; auto-generate per project; compound configs; pre-launch tasks; variable substitution (Part VII §114.3).
- **Features:** Easy debug setup.
- **Tech reqs:** Config schema + generator.
- **Dependencies:** 96,68.
- **Risks:** Misconfig → validation + templates.
- **Deliverables:** Launch config system.
- **Acceptance:** Auto-config runs; compound works.
- **Testing:** Integration.
- **Future expansion:** AI-generated configs.

### Phase 99 — Execution Control + Conditional/Logpoints *(Complexity: M)*
- **Goal:** Full stepping + advanced breakpoints.
- **Scope:** Continue/step over/into/out, restart, stop, pause; conditional/hit-count breakpoints; logpoints; run-to-cursor; hover-eval (Part VII §114.4).
- **Features:** Powerful debugging control.
- **Tech reqs:** DAP requests + editor integration.
- **Dependencies:** 97.
- **Risks:** Adapter capability variance → capability-gate.
- **Deliverables:** Execution control.
- **Acceptance:** Stepping/breakpoints/logpoints work.
- **Testing:** E2E.
- **Future expansion:** AI-set strategic breakpoints (Epoch H).

### Phase 100 — Bundled Debuggers + On-Demand Adapters *(Complexity: M)*
- **Goal:** Out-of-box debugging for Node/JS/TS.
- **Scope:** Bundle JS/Node adapter; on-demand install for Python/Go/etc. (Part VII §114.6).
- **Features:** Immediate debugging for JS ecosystem.
- **Tech reqs:** Adapter packaging + install flow.
- **Dependencies:** 96.
- **Risks:** Adapter availability → install prompts.
- **Deliverables:** Bundled + installable adapters.
- **Acceptance:** Node/JS/TS debug out-of-box.
- **Testing:** Integration.
- **Future expansion:** Extension-provided adapters (Epoch I).

### Phase 101 — Remote & Multi-Target Debugging *(Complexity: L)*
- **Goal:** Attach + remote/container/WSL debug.
- **Scope:** Attach to process; remote/WSL/container via adapters; multi-session orchestration (Part VII §114.5).
- **Features:** Debug beyond the local process.
- **Tech reqs:** Attach flows; session picker.
- **Dependencies:** 99,100.
- **Risks:** Environment variance → adapter reliance.
- **Deliverables:** Remote/multi-target debug.
- **Acceptance:** Attach + WSL debug work.
- **Testing:** Compatibility (WSL), integration.
- **Future expansion:** Full remote-dev (Post-1.0).

### Phase 102 — Task System *(Complexity: M)*
- **Goal:** Define and run tasks.
- **Scope:** `tasks.json`-compatible; shell/process tasks; groups (build/test); dependencies (seq/parallel); watch/background; auto-detect (npm/Make/Cargo) (Part VII §115).
- **Features:** Build/test automation.
- **Tech reqs:** Task runner (terminal integration); auto-detection.
- **Dependencies:** 74,68.
- **Risks:** Task correctness → validation.
- **Deliverables:** Task system.
- **Acceptance:** Run/auto-detect tasks; dependencies honored.
- **Testing:** Integration.
- **Future expansion:** Agents run tasks as tools (Epoch H).

### Phase 103 — Problem Matchers *(Complexity: M)*
- **Goal:** Parse task output into diagnostics.
- **Scope:** Problem matchers (file/line/severity) for common toolchains; background-task matching (Part VII §115).
- **Features:** Build/lint output → navigable problems.
- **Tech reqs:** Matcher engine + patterns.
- **Dependencies:** 102.
- **Risks:** Pattern coverage → common set + custom.
- **Deliverables:** Problem matchers.
- **Acceptance:** Output maps to Problems correctly.
- **Testing:** Integration (toolchain outputs).
- **Future expansion:** —

### Phase 104 — Problems Panel *(Complexity: M)*
- **Goal:** Aggregate diagnostics.
- **Scope:** Problems from LSP/linters/task matchers; grouped by file; severity filters; quick fixes; click-to-navigate; status-bar counts (Part VII §116).
- **Features:** One place for all issues.
- **Tech reqs:** Diagnostics aggregation; virtualized list.
- **Dependencies:** 91,103.
- **Risks:** Large diagnostic sets → virtualize + debounce.
- **Deliverables:** Problems panel.
- **Acceptance:** Aggregates all sources; navigate + quick-fix.
- **Testing:** Integration, e2e.
- **Future expansion:** "Explain/Fix with AI" (Epoch G).

**Epoch D Exit Criteria (Internal Alpha):** Axiom is a complete, AI-free IDE — integrated terminal (multi/split/profiles/shell-integration), full Git (stage/commit/branch/merge/rebase/stash/history/blame/3-way-merge/remotes/edge-cases), LSP intelligence (hover/complete/nav/actions/rename/semantic/hierarchy) for bundled languages, DAP debugging (breakpoints/stepping/logpoints/remote), tasks with problem matchers, and an aggregated Problems panel. A developer can realistically build and ship software in Axiom. **Milestone: Internal Alpha.**

---

*Part XIV continues in the next installment (Epoch E — Identity & Backend / Supabase, Phases 105–132).*


## EPOCH E — IDENTITY & BACKEND / SUPABASE (Phases 105–132)

*Objective: add the thin cloud plane — Supabase identity (desktop-correct OAuth with PKCE), the secret vault, sessions/tokens, the Postgres data model + authoritative RLS policies, Edge/DB Functions, settings/artifact sync, telemetry/analytics/crash upload, and feature flags (Postgres + Realtime) — plus the full first-run onboarding (minus the AI-provider step, added in Epoch F). Honors INV-2/3/4 throughout: secrets stay local, no code to cloud.*

### Phase 105 — Supabase Project & Client Integration *(Complexity: M)*
- **Goal:** Provision Supabase + wire clients + local stack.
- **Scope:** Auth/Postgres/Storage/Edge Functions/feature_flags/telemetry projects (dev/staging/prod); Supabase CLI local stack for tests (Part IV §41.2).
- **Features:** Backend available to the app + CI.
- **Tech reqs:** Client init in Main; local-stack config; env separation.
- **Dependencies:** 2,4.
- **Risks:** Env leakage → strict project separation.
- **Deliverables:** Supabase integration + local-stack setup.
- **Acceptance:** App connects (prod) + tests run on the local stack.
- **Testing:** Integration (local-stack connectivity).
- **Future expansion:** Backend swap via abstraction (Phase 106).

### Phase 106 — Backend Abstraction Layer *(Complexity: M)*
- **Goal:** Keep the backend swappable.
- **Scope:** `IBackendService`/`IAuthService`/`ISyncService` interfaces with Supabase impls (Part IV §41.4/§60).
- **Features:** Feature code independent of Supabase.
- **Tech reqs:** Interfaces + adapters; no Supabase types leak upward.
- **Dependencies:** 8,105.
- **Risks:** Leaky abstraction → fitness function.
- **Deliverables:** Backend abstraction.
- **Acceptance:** Features use interfaces only (CI-enforced).
- **Testing:** Unit (fakes), fitness function.
- **Future expansion:** Self-hosted/enterprise backend (Post-1.0).

### Phase 107 — Secret Vault (full implementation) *(Complexity: L)*
- **Goal:** Production secret storage (INV-3).
- **Scope:** DPAPI/Credential Manager via `ISecretStore`; `keyRef` aliases; redaction utils; memory hygiene (Part X §177).
- **Features:** Secure store/read/rotate/remove of secrets.
- **Tech reqs:** OS secure store; alias resolution; only Main access.
- **Dependencies:** 7.
- **Risks:** Store unavailable → treat signed-out, no insecure fallback.
- **Deliverables:** SecretVault service.
- **Acceptance:** Secrets encrypted at rest; never in renderer/logs (test).
- **Testing:** Unit + security assertion (no leakage).
- **Future expansion:** Org/shared keys (Post-1.0).

### Phase 108 — Loopback Auth Receiver & Crypto Params *(Complexity: M)*
- **Goal:** Desktop OAuth redirect handling.
- **Scope:** Ephemeral 127.0.0.1 server, PKCE verifier/challenge, state, nonce; constant-time state check; short TTL (Part III §27/§28).
- **Features:** Secure callback receiver.
- **Tech reqs:** Loopback server; crypto RNG.
- **Dependencies:** 4.
- **Risks:** Port unavailable → retry + scheme fallback (Phase 113).
- **Deliverables:** Loopback receiver + crypto.
- **Acceptance:** Receives one valid callback; rejects bad state.
- **Testing:** Integration (callback, state mismatch).
- **Future expansion:** Multiple providers reuse this.

### Phase 109 — OAuth Initiation & PKCE Setup *(Complexity: M)*
- **Goal:** Provider OAuth initiation with PKCE.
- **Scope:** `signInWithOAuth` (Google, PKCE) building the auth URL + code verifier; loopback/deep-link redirect registration; optional rate-limited Edge Function guarding sensitive auth endpoints (Part III §27.3).
- **Features:** Start sign-in in the system browser.
- **Tech reqs:** PKCE verifier/challenge; redirect config; rate limits.
- **Dependencies:** 105,108.
- **Risks:** Auth-endpoint abuse → rate limit + state binding.
- **Deliverables:** OAuth initiation + PKCE setup.
- **Acceptance:** Browser opens Google consent → redirect returns a single-use `code`.
- **Testing:** Integration (local stack), load (code exchange).
- **Future expansion:** More IdPs via the same PKCE flow.

### Phase 110 — Google Sign-In Flow *(Complexity: L)*
- **Goal:** End-to-end desktop Google sign-in.
- **Scope:** System-browser open → Google OAuth consent → loopback callback with `code` → `exchangeCodeForSession` → session (access/refresh) → identity to renderer (Part III §28).
- **Features:** Users sign in.
- **Tech reqs:** Browser handoff; token exchange; identity object (no tokens to renderer).
- **Dependencies:** 107,108,109.
- **Risks:** Flow failures → clear states + retry.
- **Deliverables:** Sign-in flow.
- **Acceptance:** Full flow succeeds; refresh token in vault; renderer gets identity only.
- **Testing:** E2E (mocked IdP), integration.
- **Future expansion:** GitHub/MS/Apple/SSO (Post-1.0).

### Phase 111 — Session Management & Hydration *(Complexity: M)*
- **Goal:** Durable sessions across restarts.
- **Scope:** Refresh token persisted; silent session/access-token refresh on launch; identity restore before UI needs it; multi-window broadcast (Part III §29).
- **Features:** No re-prompt on restart.
- **Tech reqs:** Token manager; auth-state events.
- **Dependencies:** 110.
- **Risks:** Startup blocking → staged, non-blocking hydration.
- **Deliverables:** Session lifecycle.
- **Acceptance:** Restart stays signed-in; all windows consistent.
- **Testing:** Integration (restart), e2e.
- **Future expansion:** —

### Phase 112 — Token Refresh, Rotation & Revocation *(Complexity: M)*
- **Goal:** Robust token lifecycle.
- **Scope:** Proactive de-duped refresh; rotation (atomic vault replace); revocation → clean sign-out; failure matrix (Part III §30).
- **Features:** Reliable long-lived sessions.
- **Tech reqs:** Refresh scheduler; clock-skew handling.
- **Dependencies:** 111.
- **Risks:** Refresh storms → single in-flight + jitter.
- **Deliverables:** Token manager (full).
- **Acceptance:** Refresh/rotate/revoke behave per matrix; local work unaffected on revoke.
- **Testing:** Integration (revoke, skew, offline).
- **Future expansion:** —

### Phase 113 — Custom-Scheme Fallback & Deep-Link Validation *(Complexity: M)*
- **Goal:** `axiom://` handler + safe deep links.
- **Scope:** Protocol registration (PAL); auth-callback fallback; validated deep links (state-checked, never auto-execute) (Part III §27.5, VI §89.5, X §183).
- **Features:** Auth works when loopback blocked; deep links.
- **Tech reqs:** Protocol handler; link router + validation.
- **Dependencies:** 108,7.
- **Risks:** Hijack/unsolicited links → validation + single-use tokens.
- **Deliverables:** Scheme handler + link validation.
- **Acceptance:** Fallback auth works; malicious links rejected.
- **Testing:** Integration (fallback, invalid link).
- **Future expansion:** Share links (Post-1.0).

### Phase 114 — Sign-Out (local + global) *(Complexity: S)*
- **Goal:** Clean logout flows.
- **Scope:** Local sign-out (clear vault token, mark session inactive); global "everywhere" (revoke all); preserve local work/keys (Part III §33).
- **Features:** Secure logout.
- **Tech reqs:** Revocation call; state reset.
- **Dependencies:** 112.
- **Risks:** Residual identity → verified cleanup.
- **Deliverables:** Sign-out flows.
- **Acceptance:** Local + global sign-out work; local data preserved.
- **Testing:** Integration, e2e.
- **Future expansion:** —

### Phase 115 — Postgres Data Model & Migrations *(Complexity: L)*
- **Goal:** Create the table schemas via SQL migrations.
- **Scope:** profiles/device_sessions/settings/keybindings/prompts/rules/agents/provider_configs/workspaces/usage_daily/audit_events/feedback + public config (Part IV §43).
- **Features:** Cloud data structures.
- **Tech reqs:** Typed models; `schema_version`; `created_at`/`updated_at` defaults + triggers.
- **Dependencies:** 106.
- **Risks:** Row-size/hotspots → normalization + date-partitioning.
- **Deliverables:** Data model + migrations + repositories.
- **Acceptance:** CRUD on all tables (local stack).
- **Testing:** Integration (local-stack CRUD).
- **Future expansion:** Org/team tables (Post-1.0).

### Phase 116 — RLS Policies + Policy Tests *(Complexity: L)*
- **Goal:** Authoritative server-side access control.
- **Scope:** Owner-scoping (`auth.uid()`), write validation (shape/size/field via `CHECK` + triggers), no-secret guard, config read-only; exhaustive pgTAP RLS tests as a **deploy gate** (Part IV §46, XII §215/§220).
- **Features:** Enforced data security.
- **Tech reqs:** Postgres + Storage RLS policies; pgTAP test suite.
- **Dependencies:** 115.
- **Risks:** Policy gaps → negative tests.
- **Deliverables:** Policies + tests.
- **Acceptance:** Cross-user denied; oversize/secret-shaped rejected; tests gate deploy.
- **Testing:** RLS/pgTAP tests (positive/negative).
- **Future expansion:** Org-role policies (Post-1.0).

### Phase 117 — Data Validation Layer *(Complexity: M)*
- **Goal:** Defense-in-depth validation.
- **Scope:** Client schema validators (Zod-style) + function-side re-validation; schema migrations (Part IV §47).
- **Features:** Malformed data rejected early + at server.
- **Tech reqs:** Shared schemas; migration map.
- **Dependencies:** 115.
- **Risks:** Client/rules drift → shared schema source.
- **Deliverables:** Validation layer.
- **Acceptance:** Invalid writes blocked client + server; migrations run.
- **Testing:** Unit + integration.
- **Future expansion:** —

### Phase 118 — Edge & Database Functions *(Complexity: L)*
- **Goal:** Privileged/atomic backend logic.
- **Scope:** `on_auth_user_created` (init-profile trigger), `delete_account` (service-role fan-out erasure), `aggregate_usage`, `ttl_cleanup` (`pg_cron`), `validate_provider_config` (no-secret re-assert trigger); idempotent, least-privileged, rate-limited (Part IV §51).
- **Features:** Server-side automation + compliance ops.
- **Tech reqs:** Edge/DB functions with validation, logging, warm paths for hot ones.
- **Dependencies:** 115,116.
- **Risks:** Non-idempotent retries → idempotency keys.
- **Deliverables:** Function suite.
- **Acceptance:** Functions correct + idempotent (local stack); deletion CASCADE verified.
- **Testing:** Integration (local stack), load.
- **Future expansion:** Org/team functions (Post-1.0).

### Phase 119 — Supabase Storage Integration *(Complexity: M)*
- **Goal:** Store avatars/backups/diagnostics (no code).
- **Scope:** Upload/download; content-type/size limits; Storage RLS policies; TTL on diagnostics (Part IV §44).
- **Features:** Binary/user-content storage.
- **Tech reqs:** Storage client + RLS policies; scrubbed diagnostics upload.
- **Dependencies:** 116.
- **Risks:** Oversize/wrong-type → policy limits.
- **Deliverables:** Storage integration.
- **Acceptance:** Owner-only access; limits enforced; TTL cleans diagnostics.
- **Testing:** RLS policy tests + integration.
- **Future expansion:** —

### Phase 120 — Offline Persistence & Sync Engine *(Complexity: L)*
- **Goal:** `ISyncService` with offline support.
- **Scope:** Local SQLite mirror for instant reads; queued writes; Realtime subscription lifecycle (Part IV §48/§49).
- **Features:** Sync foundation (opt-in).
- **Tech reqs:** Sync coordinator; subscription manager.
- **Dependencies:** 106,115.
- **Risks:** Read-cost blowup → subscription discipline.
- **Deliverables:** Sync engine.
- **Acceptance:** Offline reads/writes; reconcile on reconnect.
- **Testing:** Integration (offline/online), cost check.
- **Future expansion:** Team-shared tables (Post-1.0).

### Phase 121 — Settings Sync *(Complexity: M)*
- **Goal:** Sync settings/keybindings/snippets across devices.
- **Scope:** Per-scope rows, Realtime subscriptions, LWW + history conflict resolution, machine/secret allow-list exclusion (Part IV §55, VII §120.3).
- **Features:** Cross-device continuity (prefs only).
- **Tech reqs:** Sync mapping; conflict UI.
- **Dependencies:** 120,46.
- **Risks:** Syncing machine/secret values → write-time allow-list.
- **Deliverables:** Settings sync.
- **Acceptance:** Changes propagate; machine/secret excluded; conflicts handled.
- **Testing:** Integration (multi-device sim), security (exclusion).
- **Future expansion:** Prompt/rules/agents sync (Phase 125).

### Phase 122 — Profile & Account Management UI *(Complexity: M)*
- **Goal:** View/edit profile.
- **Scope:** Display name/avatar edit, linked providers, sync/telemetry toggles (Part III §32.2).
- **Features:** Account self-service.
- **Tech reqs:** Profile view; avatar upload (Storage).
- **Dependencies:** 110,119.
- **Risks:** —
- **Deliverables:** Account/profile UI.
- **Acceptance:** Edit profile; changes persist/sync.
- **Testing:** E2E.
- **Future expansion:** Account linking (Post-1.0).

### Phase 123 — Device / Session Management UI *(Complexity: M)*
- **Goal:** See/manage active devices.
- **Scope:** Device registry; devices list (platform/name/last-seen); rename; sign-out this/others/everywhere; revocation propagation (Part III §31).
- **Features:** Multi-device control/security.
- **Tech reqs:** Session docs; revocation signals.
- **Dependencies:** 111,115.
- **Risks:** Revocation lag → next-refresh enforcement.
- **Deliverables:** Devices UI.
- **Acceptance:** Devices listed; remote sign-out drops device.
- **Testing:** Integration (multi-device), e2e.
- **Future expansion:** Anomaly flags (Post-1.0).

### Phase 124 — Data Export & Account Deletion *(Complexity: M)*
- **Goal:** Privacy rights (portability + erasure).
- **Scope:** Export archive (JSON) of cloud data; guarded multi-step deletion (re-auth + confirm → fan-out) (Part III §32.3/§32.4, X §188.5).
- **Features:** GDPR/CCPA readiness.
- **Tech reqs:** Export builder; `delete_account` Edge Function wiring.
- **Dependencies:** 118,122.
- **Risks:** Incomplete deletion → post-deletion verification.
- **Deliverables:** Export + deletion flows.
- **Acceptance:** Export downloads; deletion removes all cloud data + auth user.
- **Testing:** Integration (local stack), verification.
- **Future expansion:** Data-residency options (Post-1.0).

### Phase 125 — Prompt/Rules/Agents Cloud Sync (C2) *(Complexity: M)*
- **Goal:** Sync small user-authored artifacts.
- **Scope:** Schema + sync for prompts/rules/agents (data only; features consume later); size caps; version history (Part IV §43.5–43.7).
- **Features:** Cross-device prompt library/rules.
- **Tech reqs:** Sync mapping; caps; history.
- **Dependencies:** 120.
- **Risks:** Large artifacts → size caps.
- **Deliverables:** Artifact sync.
- **Acceptance:** Artifacts sync with history; caps enforced.
- **Testing:** Integration.
- **Future expansion:** Team sharing (Post-1.0); consumed by Epoch H features.

### Phase 126 — Telemetry Upload Pipeline *(Complexity: M)*
- **Goal:** Ship the local telemetry buffer to cloud (opt-in).
- **Scope:** Batched/compressed/backoff upload to the telemetry sink (`ingest_telemetry` Edge Function → Postgres; optional PostHog); sampling; kill switch; wire Phase 18 kernel (Part IV §53).
- **Features:** Product/perf telemetry (consented).
- **Tech reqs:** Upload scheduler; consent gate; remote kill.
- **Dependencies:** 18,129.
- **Risks:** Privacy → opt-in, scrubbed, killable.
- **Deliverables:** Telemetry upload.
- **Acceptance:** Off = no upload; batches on consent; killable remotely.
- **Testing:** Integration (batching, consent, kill).
- **Future expansion:** —

### Phase 127 — Analytics Instrumentation *(Complexity: M)*
- **Goal:** Emit the event taxonomy.
- **Scope:** Instrument key events (app_start/signin/provider_added/ai_action(later)/error…); bucketed, no PII/code; event schema registry (Part IV §52).
- **Features:** Usage insight (consented).
- **Tech reqs:** Event API; schema registry + review.
- **Dependencies:** 126.
- **Risks:** Event sprawl/PII → registry + review + no-PII tests.
- **Deliverables:** Analytics events.
- **Acceptance:** Events fire (consented); no PII/code (test).
- **Testing:** Unit (no-PII), integration.
- **Future expansion:** AI-feature events (Epoch G/H).

### Phase 128 — Crash Reporting (crash pipeline) *(Complexity: M)*
- **Goal:** Opt-in crash reporting.
- **Scope:** Crash pipeline integration (`ingest_crash` Edge Function → Postgres `crash_reports`; optional self-hostable Sentry); symbolication (CI symbol upload); breadcrumb scrubbing; local crash journal always on (Part IV §58).
- **Features:** Crash visibility + triage.
- **Tech reqs:** Crash client; symbol pipeline; scrub filters.
- **Dependencies:** 9,105.
- **Risks:** PII/code in reports → scrub + tests.
- **Deliverables:** Crash reporting.
- **Acceptance:** Symbolicated crashes; no code/secrets (test); local journal independent.
- **Testing:** Integration (crash sim), scrub tests.
- **Future expansion:** Crash-rate rollout gates (Epoch J).

### Phase 129 — Feature Flags (feature_flags + Realtime) *(Complexity: M)*
- **Goal:** Runtime flags + targeting.
- **Scope:** Wire Phase 19 to the `config.feature_flags` table over Supabase Realtime; targeting (version/OS/locale/percentage), kill switches, exposure logging; cached + fail-safe defaults (Part IV §57).
- **Features:** Dark-launch, rollout, kill switches.
- **Tech reqs:** `feature_flags` fetch/subscribe/cache; single `IFeatureFlags`.
- **Dependencies:** 19,105.
- **Risks:** Fetch failure → compiled defaults.
- **Deliverables:** Runtime flags.
- **Acceptance:** Flags fetch + target; offline uses defaults; kill switch works.
- **Testing:** Integration (targeting, offline).
- **Future expansion:** Experiments/A-B (Epoch G/H).

### Phase 130 — Backend Abuse Controls (RLS + rate limiting) *(Complexity: M)*
- **Goal:** Server-authoritative access + rate limits.
- **Scope:** No App Check equivalent on desktop (documented limitation); per-IP/per-uid rate limits + anomaly detection on sensitive Edge Functions, backed by RLS (Part IV §61, X §176.8/§187.5).
- **Features:** Backend hardening.
- **Tech reqs:** Edge-Function rate limiting; anomaly signals; RLS enforcement.
- **Dependencies:** 118.
- **Risks:** Weak desktop attestation → compensate with RLS/limits.
- **Deliverables:** Abuse controls (RLS + rate limiting + anomaly detection).
- **Acceptance:** Rate limits enforced; anomalies flagged.
- **Testing:** Load/abuse tests.
- **Future expansion:** Stronger attestation as platform allows.

### Phase 131 — Consent & Privacy UI *(Complexity: M)*
- **Goal:** Transparent, granular privacy controls.
- **Scope:** Consent toggles (crash/analytics/perf), privacy page with data-flow map, revisitable; privacy-first defaults off (Part IV §52, X §188).
- **Features:** Trustworthy privacy UX.
- **Tech reqs:** Consent store; gating everywhere.
- **Dependencies:** 126,127,128.
- **Risks:** Dark patterns → clear, off-by-default.
- **Deliverables:** Consent/privacy UI.
- **Acceptance:** Toggles gate real network calls; data-flow shown.
- **Testing:** E2E, integration (gating).
- **Future expansion:** Enterprise-managed consent (Post-1.0).

### Phase 132 — Onboarding Wizard (identity/consent/import) *(Complexity: M)*
- **Goal:** Full first-run flow (minus AI-provider step).
- **Scope:** Welcome/theme/keymap/import(VS Code/Cursor)/sign-in/consent/open-folder; skippable/resumable stepper; re-runnable (Part VI §85, IX §156).
- **Features:** Smooth onboarding.
- **Tech reqs:** Wizard framework; import mappers.
- **Dependencies:** 110,131,47,32.
- **Risks:** Friction → skippable steps.
- **Deliverables:** Onboarding wizard.
- **Acceptance:** New user completes onboarding; import works; nothing blocks the editor.
- **Testing:** E2E (onboarding).
- **Future expansion:** AI-provider step (Epoch F Phase ~), walkthroughs (Epoch I).

**Epoch E Exit Criteria:** Axiom has a complete, secure cloud plane — desktop Google sign-in (loopback + PKCE + authorization-code exchange), secret vault, durable sessions with refresh/rotation/revocation, multi-device management, the full Postgres model behind authoritative (tested) RLS policies, Edge/DB Functions (incl. GDPR deletion), Supabase Storage, offline-capable settings/artifact sync, opt-in telemetry/analytics/crash upload, feature flags (Postgres + Realtime), backend abuse controls (RLS + rate limiting), granular privacy consent, and a full onboarding wizard — all honoring "secrets local, no code in cloud." Sign-in remains optional; the editor works signed-out.

---

*Part XIV continues in the next installment (Epoch F — AI Engine, Phases 133–170).*


## EPOCH F — AI ENGINE (Phases 133–170)

*Objective: build the provider-agnostic AI engine (Part V) — internal protocol, single egress gateway, all provider adapters (cloud + local), model registry, streaming/reasoning, context engine (grounded by Epoch C), memory, prompt management, cost/token accounting, caching, routing, and failover. At the end, Axiom can run grounded, cost-tracked, cancellable inference against any BYOK or local provider. No user-facing AI features yet (Epoch G) — this is the plumbing.*

### Phase 133 — Internal AI Protocol *(Complexity: L)*
- **Goal:** One normalized request/stream model (Part V §63).
- **Scope:** `AiRequest`, `AiStreamEvent`, `ContentPart` (multimodal-ready), `ToolSpec`, `ModelCapabilities`, error taxonomy.
- **Features:** Provider-agnostic core contract.
- **Tech reqs:** Types in `packages/ai`; versioned.
- **Dependencies:** 3.
- **Risks:** Under-general protocol → design for vision/tools/reasoning upfront.
- **Deliverables:** AI protocol types + docs.
- **Acceptance:** Protocol expresses text/tools/vision/reasoning/errors.
- **Testing:** Unit (serialization), design review.
- **Future expansion:** Audio/video parts (Post-1.0).

### Phase 134 — Egress Gateway *(Complexity: L)*
- **Goal:** The single network exit for AI/cloud (INV-2).
- **Scope:** Hardened Main-side HTTP/stream client; credential injection from vault; host allow-list; TLS/proxy/custom-CA; per-request audit metadata (no payload); cancellation (Part II §20, X §183).
- **Features:** Sovereign, auditable egress.
- **Tech reqs:** Pooled HTTP2 client; SSE; allow-list enforcement.
- **Dependencies:** 107.
- **Risks:** Egress leak → allow-list + fitness function (only egress pkg networks).
- **Deliverables:** Egress gateway.
- **Acceptance:** Only allow-listed hosts reachable; keys injected here only; cancel aborts stream.
- **Testing:** Integration + security (allow-list, no-key-in-renderer).
- **Future expansion:** Enterprise gateway routing.

### Phase 135 — Provider Registry & Adapter Contract *(Complexity: M)*
- **Goal:** `IProviderAdapter` + registry (Part V §64).
- **Scope:** Adapter interface (chat/embed/listModels/capabilities/health); registry resolving ModelRef→adapter+config.
- **Features:** Pluggable providers.
- **Tech reqs:** Contribution-based registration; adapter context (cred handle, gateway, cancel).
- **Dependencies:** 133,134.
- **Risks:** Adapter leakage of vendor types → strict interface.
- **Deliverables:** Registry + contract.
- **Acceptance:** Register + resolve adapters; adapters never see raw key.
- **Testing:** Unit (registry), contract scaffolding.
- **Future expansion:** Third-party adapters via SDK (Epoch I).

### Phase 136 — Model Registry & Catalog *(Complexity: M)*
- **Goal:** Model metadata + capability gating (Part V §65).
- **Scope:** Merge shipped defaults + `config/modelCatalog` + live discovery; capabilities/context/pricing; task profiles/aliases.
- **Features:** Capability-driven model selection.
- **Tech reqs:** Catalog cache (offline); discovery hooks.
- **Dependencies:** 135,129.
- **Risks:** Stale pricing/caps → catalog updates + probing.
- **Deliverables:** Model registry.
- **Acceptance:** Models list with capabilities; profiles map correctly.
- **Testing:** Unit + integration.
- **Future expansion:** New models auto-appear via discovery.

### Phase 137 — Provider Config & Add-Provider Wizard *(Complexity: M)*
- **Goal:** BYOK provider setup UI.
- **Scope:** Add/edit/enable providers; key → vault (`keyRef`); base URL for custom/local; health check; default model/profiles (Part V §64.5/§66, IV §43.8).
- **Features:** Users connect providers.
- **Tech reqs:** Provider config store (no secrets); health probe.
- **Dependencies:** 107,135,136.
- **Risks:** Key exposure → masked input, vault-only, never re-displayed.
- **Deliverables:** Provider management UI.
- **Acceptance:** Add key → health check passes → provider usable; key never leaves device except to its provider.
- **Testing:** E2E (add/validate), security (no leakage).
- **Future expansion:** Org/shared keys (Post-1.0).

### Phase 138 — OpenAI-Compatible Adapter (base) *(Complexity: L)*
- **Goal:** The workhorse adapter, parameterized.
- **Scope:** OpenAI-compatible chat + streaming + tools + embeddings; parameterized by base URL/auth/capability profile (Part V §64.4).
- **Features:** Covers many providers with one adapter.
- **Tech reqs:** SSE parsing → AiStreamEvent; error mapping.
- **Dependencies:** 135.
- **Risks:** Provider quirks → capability profiles.
- **Deliverables:** OpenAI-compatible adapter.
- **Acceptance:** Chat/stream/tools/embeddings against a compatible endpoint.
- **Testing:** Contract (fixtures).
- **Future expansion:** Reused by 142/144/145.

### Phase 139 — OpenAI Adapter Specifics *(Complexity: M)*
- **Goal:** OpenAI features.
- **Scope:** Responses/Chat Completions, reasoning effort (o-series), automatic prompt cache, vision, JSON schema (Part V §64.4).
- **Features:** Full OpenAI capability.
- **Tech reqs:** Capability descriptor; reasoning/vision handling.
- **Dependencies:** 138.
- **Risks:** API evolution → versioned + fixtures.
- **Deliverables:** OpenAI adapter.
- **Acceptance:** Reasoning/vision/tools/cache work.
- **Testing:** Contract (fixtures).
- **Future expansion:** —

### Phase 140 — Anthropic Adapter *(Complexity: M)*
- **Goal:** Anthropic Messages support.
- **Scope:** Messages API, tool use, extended thinking (budget), `cache_control` prompt caching, separate system, vision (Part V §64.4).
- **Features:** Full Anthropic capability.
- **Tech reqs:** Message/tool mapping; thinking/cache handling.
- **Dependencies:** 135.
- **Risks:** Format differences → dedicated adapter.
- **Deliverables:** Anthropic adapter.
- **Acceptance:** Tools/thinking/cache/vision work.
- **Testing:** Contract (fixtures).
- **Future expansion:** —

### Phase 141 — Google Gemini Adapter *(Complexity: M)*
- **Goal:** Gemini support.
- **Scope:** generateContent/stream, functionDeclarations, thinking (2.5), safety settings, vision (Part V §64.4).
- **Features:** Full Gemini capability.
- **Tech reqs:** Function-calling + safety mapping.
- **Dependencies:** 135.
- **Risks:** Safety-setting friction → configurable.
- **Deliverables:** Gemini adapter.
- **Acceptance:** Tools/thinking/vision/streaming work.
- **Testing:** Contract (fixtures).
- **Future expansion:** —

### Phase 142 — OpenRouter/Groq/DeepSeek/Qwen/Mistral *(Complexity: M)*
- **Goal:** Cover aggregator + fast + reasoning providers.
- **Scope:** Configure the OpenAI-compatible adapter with per-provider profiles (OpenRouter aggregator, Groq low-latency, DeepSeek R1, Qwen, Mistral) (Part V §64.4).
- **Features:** Broad provider coverage.
- **Tech reqs:** Capability profiles; discovery where available.
- **Dependencies:** 138.
- **Risks:** Per-provider deviations → profiles + fixtures.
- **Deliverables:** 5 provider profiles.
- **Acceptance:** Each provider chats/streams/tools per capabilities.
- **Testing:** Contract (fixtures per provider).
- **Future expansion:** More providers trivially added.

### Phase 143 — Ollama Adapter (local) *(Complexity: M)*
- **Goal:** Local Ollama, zero egress.
- **Scope:** Native + OpenAI-compat `/v1`; model list/pull; auto-detect on default port; streaming; tools where supported (Part V §64.4/§65.5).
- **Features:** Offline, keyless, free local inference.
- **Tech reqs:** Local HTTP (localhost, still via gateway for uniformity/audit); model management.
- **Dependencies:** 135,134.
- **Risks:** Local runtime absent → detect + guide.
- **Deliverables:** Ollama adapter.
- **Acceptance:** Detect Ollama; list/pull; chat offline.
- **Testing:** Integration (local runtime).
- **Future expansion:** Local fine-tune/adapter mgmt (Post-1.0).

### Phase 144 — LM Studio Adapter (local) *(Complexity: S)*
- **Goal:** LM Studio local server.
- **Scope:** OpenAI-compat local endpoint; auto-detect; model list (Part V §64.4).
- **Features:** Alternative local runtime.
- **Tech reqs:** Configurable local base URL.
- **Dependencies:** 138.
- **Risks:** Endpoint variance → configurable.
- **Deliverables:** LM Studio adapter.
- **Acceptance:** Chat via local LM Studio.
- **Testing:** Integration (local).
- **Future expansion:** —

### Phase 145 — Custom / Self-Hosted Provider Onboarding *(Complexity: M)*
- **Goal:** Any OpenAI-compatible/custom endpoint.
- **Scope:** Guided add: base URL, auth scheme, model list (fetch/manual), capability auto-probe + manual adjust (Part V §64.5).
- **Features:** Enterprise gateway / self-hosted sovereignty.
- **Tech reqs:** Capability probe; custom pricing entry.
- **Dependencies:** 137,138.
- **Risks:** Unknown capabilities → probe + conservative defaults.
- **Deliverables:** Custom-provider flow.
- **Acceptance:** Point at internal gateway → works with probed caps.
- **Testing:** Integration (mock custom endpoint).
- **Future expansion:** Org policy for allowed endpoints.

### Phase 146 — Provider Contract-Test & Fixture Harness *(Complexity: M)*
- **Goal:** Stable, churn-resistant adapter testing.
- **Scope:** Recorded-fixture harness (streaming/tools/reasoning/errors) per adapter; periodic non-gating live refresh (Part XII §215).
- **Features:** Confidence across providers.
- **Tech reqs:** Fixture recorder/player; capability assertions.
- **Dependencies:** 138–145.
- **Risks:** Fixture staleness → scheduled refresh job.
- **Deliverables:** Contract-test harness.
- **Acceptance:** All adapters pass fixtures; error mapping verified.
- **Testing:** Contract tests (CI gate).
- **Future expansion:** New adapters add fixtures.

### Phase 147 — Streaming Pipeline *(Complexity: L)*
- **Goal:** Normalize + relay streams responsively.
- **Scope:** Vendor stream → `AiStreamEvent` → streaming IPC; coalesce ≤60fps; end-to-end cancellation (Part V §67, II §14.4).
- **Features:** Live token streaming.
- **Tech reqs:** Stream normalizer; back-pressure.
- **Dependencies:** 133,134,138.
- **Risks:** Flooding renderer → coalescing.
- **Deliverables:** Streaming pipeline.
- **Acceptance:** Smooth streaming; instant Stop; partial retained.
- **Testing:** Integration + perf.
- **Future expansion:** Consumed by chat/inline (Epoch G).

### Phase 148 — Tool-Call & Reasoning Streaming *(Complexity: M)*
- **Goal:** Stream tool args + reasoning incrementally.
- **Scope:** Incremental tool-call arg assembly; reasoning deltas; ordered interleaving (Part V §63.5/§67.3).
- **Features:** Live "calling tool…" + thinking.
- **Tech reqs:** Delta assembly; event ordering.
- **Dependencies:** 147.
- **Risks:** Partial tool JSON → robust assembly.
- **Deliverables:** Tool/reasoning streaming.
- **Acceptance:** Tool args assemble; reasoning streams in order.
- **Testing:** Integration (fixtures).
- **Future expansion:** Agent runtime consumes (Epoch H).

### Phase 149 — Reasoning Models Support *(Complexity: M)*
- **Goal:** Cross-vendor reasoning abstraction.
- **Scope:** `reasoning{enabled,effort,budget,visibility}` mapped per vendor; visibility modes; reasoning-token cost separation; emulated fallback labeled (Part V §68).
- **Features:** Thinking-mode foundation.
- **Tech reqs:** Per-adapter reasoning mapping.
- **Dependencies:** 139,140,141,148.
- **Risks:** Vendor differences → capability-gate.
- **Deliverables:** Reasoning support.
- **Acceptance:** Effort/visibility honored; reasoning tokens counted.
- **Testing:** Contract + unit (cost).
- **Future expansion:** Thinking-mode UI (Epoch H).

### Phase 150 — Token Counting *(Complexity: M)*
- **Goal:** Accurate pre-flight token counts.
- **Scope:** Native `countTokens` where available; WASM tokenizers (tiktoken-family) otherwise; off-thread (Part V §69.7).
- **Features:** Budgeting + cost estimation inputs.
- **Tech reqs:** Tokenizer workers; per-model selection.
- **Dependencies:** 133,136.
- **Risks:** Count inaccuracy → reconcile with usage events.
- **Deliverables:** Token counter.
- **Acceptance:** Counts within tolerance; runs off UI thread.
- **Testing:** Unit (known texts), perf.
- **Future expansion:** —

### Phase 151 — Cost Estimation & Token Tracking *(Complexity: M)*
- **Goal:** Local, authoritative cost/token ledger.
- **Scope:** Per-request input/output/reasoning/cached tokens × catalog pricing; pre-flight estimate; live tracking; reconciliation; local SQLite ledger (Part IV §54, V §75).
- **Features:** Cost transparency (BYOK value).
- **Tech reqs:** Cost meter; ledger tables; integer minor units.
- **Dependencies:** 147,150,11.
- **Risks:** Pricing drift → catalog + custom overrides + reconcile (±5%).
- **Deliverables:** Cost/token accounting.
- **Acceptance:** Estimates + actuals recorded; within ±5% target.
- **Testing:** Unit (math), integration (reconcile).
- **Future expansion:** Cost dashboards + cloud aggregates (Epoch G).

### Phase 152 — Budgets & Alerts *(Complexity: M)*
- **Goal:** Spend controls.
- **Scope:** Per-provider/day/month budgets; per-run caps; on breach warn/pause/switch-cheaper; custom pricing (Part V §75.4).
- **Features:** Prevent cost surprises.
- **Tech reqs:** Budget rules; routing hooks.
- **Dependencies:** 151.
- **Risks:** Hard-stop UX → warn + confirm.
- **Deliverables:** Budgets/alerts.
- **Acceptance:** Threshold triggers warning/pause/route-switch.
- **Testing:** Unit + integration.
- **Future expansion:** Cost-aware autopilot (Epoch I).

### Phase 153 — Context Builder Pipeline *(Complexity: L)*
- **Goal:** Deterministic, budgeted context assembly.
- **Scope:** gather→score→dedupe→compress→order→budget-fit→freeze; manifest output (Part V §69.2).
- **Features:** Right context, never overflow.
- **Tech reqs:** Pipeline stages; budget calc.
- **Dependencies:** 136,150.
- **Risks:** Overflow → proactive budgeting.
- **Deliverables:** Context builder.
- **Acceptance:** Always within budget; deterministic; manifest produced.
- **Testing:** Unit + eval.
- **Future expansion:** Feeds all AI features.

### Phase 154 — RAG Integration (on-device) *(Complexity: M)*
- **Goal:** Ground context via Core retrieval.
- **Scope:** Hybrid retrieval (Phase 64) → top-k chunks with citations into context; code never leaves for retrieval (Part V §69.3).
- **Features:** Grounded, cited context.
- **Tech reqs:** Retrieval→context adapter; provenance.
- **Dependencies:** 64,153.
- **Risks:** Irrelevant retrieval → ranking + eval.
- **Deliverables:** RAG integration.
- **Acceptance:** Relevant cited chunks injected; on-device.
- **Testing:** Retrieval eval.
- **Future expansion:** Knowledge-graph context (Epoch H).

### Phase 155 — Context Sources & Prioritization *(Complexity: M)*
- **Goal:** Compose + prioritize all sources.
- **Scope:** system/rules/attachments(@)/open files/retrieved/symbols/recent edits/memory/repo map with per-source budget shares (Part V §69.4).
- **Features:** Balanced, relevant context.
- **Tech reqs:** Source providers; priority config.
- **Dependencies:** 153,154.
- **Risks:** One source crowding → per-source caps.
- **Deliverables:** Source composition.
- **Acceptance:** Sources included per priority/budget.
- **Testing:** Unit + eval.
- **Future expansion:** `@`-mentions UI (Epoch G).

### Phase 156 — Truncation & Compression *(Complexity: M)*
- **Goal:** Fit budget without breaking quality.
- **Scope:** Drop lowest-priority; hierarchical summarization; symbol skeletons; large-file windowing; visible in manifest (Part V §69.5).
- **Features:** Graceful over-budget handling.
- **Tech reqs:** Summarizer; skeleton extractor.
- **Dependencies:** 153.
- **Risks:** Lossy quality → visible + tuned.
- **Deliverables:** Truncation/compression.
- **Acceptance:** Over-budget handled; lossy steps shown.
- **Testing:** Eval (quality retention).
- **Future expansion:** —

### Phase 157 — Prompt / Context Caching *(Complexity: M)*
- **Goal:** Maximize provider prompt-cache hits.
- **Scope:** Stable-prefix (system+rules+pinned) vs volatile-suffix segmentation; provider cache directives; track cached tokens (Part V §69.6/§76).
- **Features:** Big cost/latency savings on multi-turn/agents.
- **Tech reqs:** Segmentation; per-provider cache API.
- **Dependencies:** 153,140,139.
- **Risks:** Cache misconfig → validated per provider.
- **Deliverables:** Prompt caching.
- **Acceptance:** Cache hits reduce cost/latency; cached tokens tracked.
- **Testing:** Integration (cache hit).
- **Future expansion:** —

### Phase 158 — Context Manifest (transparency) *(Complexity: S)*
- **Goal:** Show exactly what was sent.
- **Scope:** Manifest of sources + tokens each + total vs budget; inspectable per turn (Part V §69/VIII §150).
- **Features:** Trust + debugging.
- **Tech reqs:** Manifest capture + viewer API.
- **Dependencies:** 153.
- **Risks:** —
- **Deliverables:** Context manifest.
- **Acceptance:** Manifest accurate + inspectable.
- **Testing:** Unit.
- **Future expansion:** Manifest UI (Epoch G).

### Phase 159 — Provider-Based Embeddings (via egress) *(Complexity: M)*
- **Goal:** Optional cloud embeddings.
- **Scope:** Embed via user-chosen provider through egress (alternative to local, Phase 59); storage/search stay local; index embedding-model choice wired (Part V §69/VIII §125.5).
- **Features:** Higher-quality embeddings option.
- **Tech reqs:** Embedding via adapters + gateway; content-hash cache.
- **Dependencies:** 59,134,138.
- **Risks:** Sending code to embed → user's chosen provider only, local storage.
- **Deliverables:** Provider embeddings option.
- **Acceptance:** Choose provider embeddings; vectors stored locally.
- **Testing:** Integration.
- **Future expansion:** —

### Phase 160 — Memory System *(Complexity: L)*
- **Goal:** Multi-tier local memory.
- **Scope:** Turn/session/workspace/agent/long-term tiers; local SQLite + vectors (Part V §70.1/§70.2).
- **Features:** Continuity across turns/sessions.
- **Tech reqs:** Memory stores per tier.
- **Dependencies:** 11,60.
- **Risks:** Unbounded growth → caps/TTL.
- **Deliverables:** Memory stores.
- **Acceptance:** Memories persist per tier locally.
- **Testing:** Integration.
- **Future expansion:** Convention learner (Epoch I).

### Phase 161 — Memory Retrieval & Injection *(Complexity: M)*
- **Goal:** Use memory in context.
- **Scope:** Retrieve relevant memories; budgeted injection with provenance (Part V §70.3).
- **Features:** Contextual continuity.
- **Tech reqs:** Memory retrieval → context source.
- **Dependencies:** 160,155.
- **Risks:** Irrelevant memory → relevance threshold.
- **Deliverables:** Memory injection.
- **Acceptance:** Relevant memories improve responses; provenance shown.
- **Testing:** Eval.
- **Future expansion:** —

### Phase 162 — Memory Editing, Forgetting & Privacy *(Complexity: M)*
- **Goal:** User-controlled, private memory.
- **Scope:** View/edit/pin/delete ("forget"); TTL/caps/pruning; local + erasable; excluded from telemetry (Part V §70.4/§70.5).
- **Features:** Trustworthy memory.
- **Tech reqs:** Memory UI + lifecycle.
- **Dependencies:** 160.
- **Risks:** Sensitive retention → local + user control.
- **Deliverables:** Memory management.
- **Acceptance:** Edit/forget works; TTL prunes; nothing leaves device.
- **Testing:** Integration + privacy.
- **Future expansion:** Small memory sync (C2).

### Phase 163 — System Prompt Architecture *(Complexity: M)*
- **Goal:** Layered, composable system prompts.
- **Scope:** engine base + feature layer + workspace rules + task layer; deterministic composition + provenance (Part V §71.1).
- **Features:** Consistent, debuggable AI behavior.
- **Tech reqs:** Prompt composer; layer precedence.
- **Dependencies:** 133.
- **Risks:** Prompt conflicts → precedence + provenance.
- **Deliverables:** System-prompt architecture.
- **Acceptance:** Layers compose deterministically.
- **Testing:** Unit + eval.
- **Future expansion:** Workspace rules injection (Epoch H).

### Phase 164 — Prompt Templates, Variables & Guardrails *(Complexity: M)*
- **Goal:** Versioned templates + safe interpolation + guardrail prompts.
- **Scope:** Typed-variable templates; safe interpolation (content vs instruction separation); baseline guardrail prompts non-overridable (Part V §71.2/§71.5/§71.6, §78.1).
- **Features:** Maintainable, safe prompting.
- **Tech reqs:** Template engine; injection-safe slots.
- **Dependencies:** 163.
- **Risks:** Prompt injection → content/instruction separation.
- **Deliverables:** Template system + guardrails.
- **Acceptance:** Templates interpolate safely; guardrails always present.
- **Testing:** Unit (injection resistance), eval.
- **Future expansion:** Prompt library/A-B (Epoch G/H).

### Phase 165 — Model Routing Engine *(Complexity: L)*
- **Goal:** Policy-driven model selection.
- **Scope:** Policies (manual/auto/cost/latency/privacy/capability); task profiles; inputs (policy/caps/budget/health/latency/locality); logged rationale (Part V §73).
- **Features:** Smart, transparent routing.
- **Tech reqs:** Router; candidate ordering (primary+fallbacks).
- **Dependencies:** 136,152,137.
- **Risks:** Wrong routing → capability gating + transparency.
- **Deliverables:** Routing engine.
- **Acceptance:** Routes per policy/caps/budget; rationale logged.
- **Testing:** Unit (policies), integration.
- **Future expansion:** Cost-aware autopilot (Epoch I).

### Phase 166 — Mid-Conversation Switching, Pinning & Overrides *(Complexity: M)*
- **Goal:** Flexible model control.
- **Scope:** Switch model per turn/thread; context re-fit to new window/caps (drop vision if unsupported, with notice); pin/override (Part V §73.4/§73.5).
- **Features:** Draft-cheap→finalize-strong.
- **Tech reqs:** Context re-fit; pin state.
- **Dependencies:** 165,153.
- **Risks:** Capability mismatch on switch → re-fit + notice.
- **Deliverables:** Switching/pinning.
- **Acceptance:** Switch mid-thread; context re-fits; pins honored.
- **Testing:** Integration.
- **Future expansion:** A/B compare (Epoch I).

### Phase 167 — Fallback Chains & Failover *(Complexity: L)*
- **Goal:** Survive provider failures.
- **Scope:** Editable fallback chains; failover triggers (rate/quota/timeout/server/network); circuit breakers; local degradation; transparent + disable-able (Part V §74).
- **Features:** Resilient AI.
- **Tech reqs:** Breakers; chain traversal; UX signals.
- **Dependencies:** 165,134.
- **Risks:** Wrong failover (content-filter) → no silent failover on those.
- **Deliverables:** Failover system.
- **Acceptance:** Provider down → fails over → local → clear error; visible + costed.
- **Testing:** Integration (fault injection).
- **Future expansion:** —

### Phase 168 — AI Caching *(Complexity: M)*
- **Goal:** Response/semantic/autocomplete caches.
- **Scope:** Exact-match response cache (deterministic reqs), optional semantic cache (thresholded, labeled), autocomplete cache; content-hash + watcher invalidation (Part V §76).
- **Features:** Lower cost/latency.
- **Tech reqs:** Cache stores + invalidation.
- **Dependencies:** 151,61.
- **Risks:** Stale results → strict invalidation.
- **Deliverables:** AI caches.
- **Acceptance:** Cache hits reduce cost/latency; never stale across edits.
- **Testing:** Unit + integration.
- **Future expansion:** —

### Phase 169 — Rate Limiting, Quotas & Concurrency *(Complexity: M)*
- **Goal:** Respect limits; prioritize interactivity.
- **Scope:** Per-provider concurrency/RPM caps; fair queue (interactive>background); 429/`Retry-After` handling (Part V §77).
- **Features:** Avoid 429s; keep UI snappy.
- **Tech reqs:** Scheduler + queue + limiter.
- **Dependencies:** 134,165.
- **Risks:** Background starving interactive → priority scheduling.
- **Deliverables:** Rate/concurrency control.
- **Acceptance:** Limits respected; interactive prioritized; 429 handled.
- **Testing:** Load + integration.
- **Future expansion:** Agent concurrency sharing (Epoch H).

### Phase 170 — AI Safety Layer + Observability + Onboarding Provider Step *(Complexity: L)*
- **Goal:** Secret redaction, injection defense scaffolding, output validation, per-turn observability, and the onboarding AI step.
- **Scope:** Secret scanner/redaction before egress; content/instruction separation baseline; structured-output validation; local turn trace (model/tokens/cost/manifest); add AI-provider step to onboarding (Part V §78/§79, VIII §150, VI §85.4).
- **Features:** Safe, transparent engine + guided provider setup.
- **Tech reqs:** Redaction pre-egress hook; trace store; onboarding step.
- **Dependencies:** 134,137,151,158,132.
- **Risks:** Secret leak to provider → redaction on by default + tested.
- **Deliverables:** Safety + observability + onboarding step.
- **Acceptance:** Secrets redacted pre-egress (test); turns traceable; onboarding connects a provider.
- **Testing:** Security (redaction), integration (trace), e2e (onboarding).
- **Future expansion:** Full agent guardrails/approval (Epoch H).

**Epoch F Exit Criteria:** the AI engine is complete — a normalized protocol, a single hardened egress gateway, adapters for every listed provider (cloud + local Ollama/LM Studio + custom), a capability-driven model registry, streaming with reasoning + tool-call deltas, deterministic grounded context assembly (on-device RAG + memory + caching), local cost/token accounting with budgets, policy-based routing with failover, rate limiting, and a safety/observability layer. Axiom can now run grounded, cancellable, cost-tracked inference against any BYOK or local model — the foundation for every AI feature in Epochs G–H.

---

*Part XIV continues in the next installment (Epoch G — Core AI Features, Phases 171–200).*


## EPOCH G — CORE AI FEATURES (Phases 171–200)

*Objective: ship the everyday AI experiences on top of the engine — but first the trust substrate (snapshots, safe-edit engine, visual diff review, approval workflow), because every edit feature depends on it. Then chat, inline completion/edit, quick actions, semantic search, explanation, and multi-file editing. At the end, Axiom delivers Cursor-class core AI with reversible, reviewable, grounded edits.*

### Phase 171 — Snapshot & Checkpoint System *(Complexity: L)*
- **Goal:** Make every AI edit reversible (Part VIII §143).
- **Scope:** Auto-snapshot affected files before AI edits; AI-change timeline (what/when/model/cost); one-click restore (file/hunk/batch/run); dedup + TTL; local only.
- **Features:** Trust substrate for autonomy.
- **Tech reqs:** Snapshot store (SQLite + content); event-log linkage.
- **Dependencies:** 11,16.
- **Risks:** Storage growth → dedup + TTL.
- **Deliverables:** Snapshot/rollback system.
- **Acceptance:** Restore any checkpoint; snapshots local + bounded.
- **Testing:** Integration (restore), recovery.
- **Future expansion:** Time-travel agent review (Epoch I).

### Phase 172 — Safe Edit Engine *(Complexity: L)*
- **Goal:** Staged, atomic, validated edits (Part VIII §142.4).
- **Scope:** Stage edits (nothing to disk until apply); parse/validate before apply; atomic batch apply; reject malformed patches with feedback.
- **Features:** Corruption-proof AI edits.
- **Tech reqs:** Patch model; atomic writes (Phase 30); validation.
- **Dependencies:** 30,171.
- **Risks:** Bad patch corrupts files → validate + atomic + snapshot.
- **Deliverables:** Safe-edit engine.
- **Acceptance:** Edits apply atomically or not at all; malformed rejected.
- **Testing:** Integration (apply/rollback), fuzz (patches).
- **Future expansion:** Multi-file batches (Phase 195).

### Phase 173 — Visual Diff Review UI *(Complexity: L)*
- **Goal:** Review AI edits before/after apply (Part VIII §142).
- **Scope:** Diff editor per file; per-hunk/line accept/reject; edit-before-accept; streaming-in diffs; change-list navigation; sticky apply/discard bar.
- **Features:** The universal AI-edit review surface.
- **Tech reqs:** Reuse diff editor (Phase 81); review session model.
- **Dependencies:** 81,172.
- **Risks:** Large diffs → virtualize + stream.
- **Deliverables:** Diff review UI.
- **Acceptance:** Granular accept/reject; streaming review; clear pre/post-apply.
- **Testing:** E2E + visual.
- **Future expansion:** Multi-file sessions (Phase 195).

### Phase 174 — Approval Workflow & Guardrails *(Complexity: L)*
- **Goal:** Gate consequential AI actions (Part VIII §144, X §181).
- **Scope:** Action classes (read/mutate/exec/network/git-write) × auto/ask/deny; autonomy levels (manual/guided/autopilot); file/command/host scopes; high-risk hard-confirm; audit; "remember in workspace."
- **Features:** Safe autonomy.
- **Tech reqs:** Capability broker enforcement; policy store; audit log.
- **Dependencies:** 171,56, X-audit.
- **Risks:** Friction vs safety → smart defaults.
- **Deliverables:** Approval system.
- **Acceptance:** Policies enforced; high-risk confirmed; all actions audited.
- **Testing:** Integration (policy), security (scope escape denied).
- **Future expansion:** Agent runtime integration (Epoch H).

### Phase 175 — AI Chat UI Shell *(Complexity: L)*
- **Goal:** The chat surface (Part VIII §128, IX §159.1).
- **Scope:** Dockable panel; threads sidebar; message list; composer with mode toggle (Ask/Agent) + model picker; stop button.
- **Features:** Conversational AI home.
- **Tech reqs:** Chat components; thread model.
- **Dependencies:** 13,147,165.
- **Risks:** Layout/perf → virtualized message list.
- **Deliverables:** Chat shell.
- **Acceptance:** Open chat; send/stop; switch threads.
- **Testing:** E2E, visual.
- **Future expansion:** Agent mode (Epoch H).

### Phase 176 — Ask Mode (grounded Q&A) *(Complexity: M)*
- **Goal:** Read-only grounded chat.
- **Scope:** Assemble grounded context (RAG); stream answer + reasoning; no edits (Part VIII §128.3).
- **Features:** Ask questions about the repo.
- **Tech reqs:** Context builder + streaming wired to chat.
- **Dependencies:** 154,175.
- **Risks:** Ungrounded answers → citations + grounded mode.
- **Deliverables:** Ask mode.
- **Acceptance:** Grounded, streamed answers; no edits.
- **Testing:** Eval (grounding), e2e.
- **Future expansion:** Grounded-answer guarantee (Epoch I).

### Phase 177 — Context Attachment (@-mentions + images) *(Complexity: L)*
- **Goal:** Rich context control (Part VIII §128.2).
- **Scope:** `@file/folder/symbol/selection/repo/git/terminal/problems/url` + image attach (vision-gated); autocomplete for mentions.
- **Features:** Precise context.
- **Tech reqs:** Mention providers; content resolution; vision routing.
- **Dependencies:** 176,155.
- **Risks:** Token blowup → per-source budgets + manifest.
- **Deliverables:** Context attachment.
- **Acceptance:** Mentions resolve into context; images work on vision models.
- **Testing:** Integration, e2e.
- **Future expansion:** MCP resources as context (Epoch H).

### Phase 178 — Code Block Actions & Citations *(Complexity: M)*
- **Goal:** Act on AI code output (Part VIII §128.6/§128.7).
- **Scope:** Code-block bar: apply-as-diff/insert/copy/create-file/run(approval); clickable file:line citations.
- **Features:** Turn answers into safe edits.
- **Tech reqs:** Wire to diff review + safe-edit; citation links.
- **Dependencies:** 173,174,176.
- **Risks:** Direct writes → default to diff review.
- **Deliverables:** Code-block actions.
- **Acceptance:** Apply-as-diff opens review; citations navigate.
- **Testing:** E2E.
- **Future expansion:** —

### Phase 179 — Chat History, Threads & Search *(Complexity: M)*
- **Goal:** Persist and find conversations.
- **Scope:** Local thread persistence; auto-titles; pin/rename; full-text search; resume with context; export (Part VIII §128.8).
- **Features:** Durable chat.
- **Tech reqs:** Thread store (SQLite); search.
- **Dependencies:** 175,11.
- **Risks:** Privacy → local; optional C2 metadata sync (no code).
- **Deliverables:** Chat history.
- **Acceptance:** Threads persist/search/resume; export works.
- **Testing:** Integration.
- **Future expansion:** Team-shared threads (Post-1.0).

### Phase 180 — Slash Commands *(Complexity: M)*
- **Goal:** Quick command framework in chat.
- **Scope:** `/explain /fix /tests /refactor /review /doc /plan /search /commit /agent` + prompt-library entries; autocomplete/discovery (Part VIII §128.4).
- **Features:** Fast intent invocation.
- **Tech reqs:** Slash registry (contributed).
- **Dependencies:** 175,164.
- **Risks:** Command sprawl → registry.
- **Deliverables:** Slash-command system.
- **Acceptance:** Slash commands run; extensible.
- **Testing:** Unit + e2e.
- **Future expansion:** Custom-agent slash (Epoch H).

### Phase 181 — Context Manifest UI & Cost Footer *(Complexity: S)*
- **Goal:** Per-turn transparency (Part VIII §150).
- **Scope:** "What was sent" manifest viewer; message footer (model/tokens/cost/latency); reasoning toggle.
- **Features:** Trust + cost visibility.
- **Tech reqs:** Manifest (Phase 158) + cost (Phase 151) UI.
- **Dependencies:** 158,151,176.
- **Risks:** Clutter → collapsible.
- **Deliverables:** Manifest + footer UI.
- **Acceptance:** Manifest/cost accurate + inspectable.
- **Testing:** Unit + e2e.
- **Future expansion:** —

### Phase 182 — Model Switching & A/B Foundation *(Complexity: M)*
- **Goal:** Flexible model use in chat.
- **Scope:** Per-thread/message model switch; capability re-fit notice; A/B compare scaffold (same prompt, two models) (Part VIII §128.9, §151.3).
- **Features:** Model experimentation.
- **Tech reqs:** Wire routing/switching (Phase 166); dual-run UI scaffold.
- **Dependencies:** 166,175.
- **Risks:** Cost of A/B → estimate + confirm.
- **Deliverables:** Switching + A/B scaffold.
- **Acceptance:** Switch models; A/B runs two side-by-side.
- **Testing:** E2E.
- **Future expansion:** Full A/B compare (Epoch I).

### Phase 183 — Inline Completion (ghost text) *(Complexity: L)*
- **Goal:** Multi-line inline predictions (Part VIII §129.1).
- **Scope:** Ghost text (token→whole-function); Tab accept, word-accept, Esc dismiss; debounced; fast-model routing; cached.
- **Features:** Autocomplete-on-steroids.
- **Tech reqs:** Editor ghost-text overlay; completion provider; debounce.
- **Dependencies:** 40,165,168.
- **Risks:** Latency/hot-path → off-thread, cached, non-blocking (INV-1).
- **Deliverables:** Inline completion.
- **Acceptance:** First token ≤300ms (B10); never blocks typing.
- **Testing:** Perf + e2e + eval.
- **Future expansion:** Next-edit prediction (Phase 186).

### Phase 184 — AI + IntelliSense Coexistence *(Complexity: M)*
- **Goal:** Ghost text and LSP widget coexist (Part VIII §129, VII §109.2).
- **Scope:** Distinct keybindings (Tab ghost / Enter widget); no fighting; user prioritization.
- **Features:** Best of both completions.
- **Tech reqs:** Completion arbitration.
- **Dependencies:** 91,183.
- **Risks:** Conflict/confusion → clear bindings + settings.
- **Deliverables:** Coexistence controller.
- **Acceptance:** Both surfaces usable without conflict.
- **Testing:** E2E.
- **Future expansion:** —

### Phase 185 — Autocomplete Caching & Latency Tuning *(Complexity: M)*
- **Goal:** Fast, cheap completions.
- **Scope:** Prefix/context cache; fast/local model routing; prefetch; cancellation (Part V §76, XI §204).
- **Features:** Snappy inline AI.
- **Tech reqs:** Autocomplete cache; latency budget.
- **Dependencies:** 183,168.
- **Risks:** Cache staleness → invalidation on edit.
- **Deliverables:** Tuned completion.
- **Acceptance:** Latency within budget; cache hits reduce cost.
- **Testing:** Perf.
- **Future expansion:** —

### Phase 186 — Next-Edit Prediction *(Complexity: L)*
- **Goal:** Predict + jump to the next edit (Part VIII §129.2).
- **Scope:** Predict next edit location/change (e.g., propagate a rename); tab-to-jump + apply.
- **Features:** Accelerate repetitive edits.
- **Tech reqs:** Edit-pattern model; jump UX.
- **Dependencies:** 183,171.
- **Risks:** Wrong predictions → easy dismiss + snapshot.
- **Deliverables:** Next-edit prediction.
- **Acceptance:** Predicts+applies plausible next edits; reversible.
- **Testing:** Eval + e2e.
- **Future expansion:** —

### Phase 187 — Inline Edit (Cmd-K) *(Complexity: L)*
- **Goal:** Natural-language edit of selection/region (Part VIII §129.3).
- **Scope:** Inline input bar; generate edit → inline diff → accept/reject/refine; snapshot-protected.
- **Features:** Surgical NL edits in the editor.
- **Tech reqs:** Inline diff; safe-edit; region scoping.
- **Dependencies:** 172,173.
- **Risks:** Scope creep → region-scoped + review.
- **Deliverables:** Inline edit.
- **Acceptance:** Describe change → reviewable inline diff → apply/undo.
- **Testing:** E2E + eval.
- **Future expansion:** —

### Phase 188 — Inline Chat *(Complexity: M)*
- **Goal:** Anchored quick chat at cursor (Part VIII §129.4).
- **Scope:** Lightweight bubble for local Q&A; escalate to edit.
- **Features:** Fast local assistance.
- **Tech reqs:** Anchored widget; local context.
- **Dependencies:** 176,187.
- **Risks:** Overlap with panel chat → clear roles.
- **Deliverables:** Inline chat.
- **Acceptance:** Ask locally; escalate to inline edit.
- **Testing:** E2E.
- **Future expansion:** —

### Phase 189 — Quick Actions, Hover Explain & Lightbulb *(Complexity: M)*
- **Goal:** One-click AI on selection/symbol (Part VIII §129.5/§129.6).
- **Scope:** Explain/Fix/Optimize/Add-types/Add-docs/Generate-tests/Simplify/Find-bugs via context menu + code-lens + lightbulb; hover AI explain; comment↔code.
- **Features:** AI everywhere in the editor.
- **Tech reqs:** Action registry; hover integration.
- **Dependencies:** 187,94,104.
- **Risks:** Clutter → grouped "AI" section.
- **Deliverables:** Quick actions + hover.
- **Acceptance:** Actions produce reviewable diffs/explanations.
- **Testing:** E2E.
- **Future expansion:** —

### Phase 190 — Semantic Search UI *(Complexity: M)*
- **Goal:** Natural-language code search (Part VIII §126).
- **Scope:** NL query → hybrid retrieval results with snippets/scores/citations; open + "add to context"; offline with local embeddings.
- **Features:** Find code by meaning.
- **Tech reqs:** Wire Phase 64 retrieval to a search UI.
- **Dependencies:** 64,190-ui.
- **Risks:** Relevance → hybrid + eval.
- **Deliverables:** Semantic search.
- **Acceptance:** Relevant results with citations; works offline (local embed).
- **Testing:** Retrieval eval, e2e.
- **Future expansion:** Graph Q&A (Epoch H).

### Phase 191 — Code Explanation *(Complexity: M)*
- **Goal:** Explain at any granularity (Part VIII §141).
- **Scope:** Selection/symbol/file/module/repo; depth levels; citations; "explain like new to this codebase"; explain diff/PR.
- **Features:** Understanding + onboarding.
- **Tech reqs:** Explanation prompts + context recipes.
- **Dependencies:** 176,154.
- **Risks:** Shallow/ungrounded → citations + graph context.
- **Deliverables:** Explanation feature.
- **Acceptance:** Accurate grounded explanations at chosen depth.
- **Testing:** Eval + e2e.
- **Future expansion:** Repo Q&A onboarding (Epoch I).

### Phase 192 — Knowledge-Graph Context Enrichment *(Complexity: M)*
- **Goal:** Add graph context to features.
- **Scope:** Inject dependency/impact/relationship context (Phase 65–67) into chat/edit/explain/refactor recipes (Part VIII §127).
- **Features:** Whole-repo-aware AI.
- **Tech reqs:** Graph→context adapters.
- **Dependencies:** 65,155.
- **Risks:** Token cost → budgeted inclusion.
- **Deliverables:** Graph context enrichment.
- **Acceptance:** Features use graph context to improve accuracy.
- **Testing:** Eval.
- **Future expansion:** Refactor safety (Epoch H).

### Phase 193 — Multi-File Editing (Composer) *(Complexity: XL)*
- **Goal:** Coordinated edits across files (Part VIII §130).
- **Scope:** Describe change → gather cross-file context → plan → generate multi-file diff.
- **Features:** The core "Build" experience.
- **Tech reqs:** Multi-file edit orchestration; context via graph/RAG.
- **Dependencies:** 172,173,192.
- **Risks:** Incomplete edits → dependency-aware + review.
- **Deliverables:** Multi-file editing.
- **Acceptance:** Produces coherent multi-file diff for cross-cutting changes.
- **Testing:** Eval (multi-file tasks), e2e.
- **Future expansion:** Autonomous agent (Epoch H).

### Phase 194 — Cross-File Context & Dependency-Aware Edits *(Complexity: L)*
- **Goal:** Completeness in multi-file edits.
- **Scope:** Use knowledge graph to find all sites (call sites/imports/types) and update them (Part VIII §130).
- **Features:** No half-done refactors.
- **Tech reqs:** Impact analysis (Phase 66) → edit targets.
- **Dependencies:** 66,193.
- **Risks:** Dynamic-language gaps → verify + flag.
- **Deliverables:** Dependency-aware editing.
- **Acceptance:** Related sites updated; gaps flagged.
- **Testing:** Eval (completeness).
- **Future expansion:** Migration agent (Epoch H).

### Phase 195 — Multi-File Diff Review Session *(Complexity: L)*
- **Goal:** Review/apply multi-file batches (Part VIII §142.1).
- **Scope:** Change-list (files+hunks+summary); per-file/hunk accept/reject; single snapshot for batch; all-or-selected apply.
- **Features:** Confident bulk edits.
- **Tech reqs:** Extend diff review (Phase 173) to batches.
- **Dependencies:** 173,193,171.
- **Risks:** Large batches → virtualize + stream.
- **Deliverables:** Multi-file review.
- **Acceptance:** Review + apply/rollback batch as one unit.
- **Testing:** E2E + recovery.
- **Future expansion:** —

### Phase 196 — Iterative Refinement *(Complexity: M)*
- **Goal:** Refine edits from feedback.
- **Scope:** After review, user feedback → model revises the diff; keep context/plan (Part VIII §130).
- **Features:** Conversational editing loop.
- **Tech reqs:** Refinement loop over edit state.
- **Dependencies:** 193,195.
- **Risks:** Loop cost → budgets.
- **Deliverables:** Refinement.
- **Acceptance:** Feedback yields improved diff without restarting.
- **Testing:** E2E + eval.
- **Future expansion:** Agent re-planning (Epoch H).

### Phase 197 — Cost & Usage Dashboard *(Complexity: M)*
- **Goal:** Visualize spend/usage (Part IV §54, V §75).
- **Scope:** Session/provider/model/day breakdowns; budgets/alerts; optional cloud aggregates; per-accepted-action cost.
- **Features:** BYOK cost transparency (differentiator).
- **Tech reqs:** Ledger → dashboard; charts.
- **Dependencies:** 151,152.
- **Risks:** Accuracy → reconciliation (±5%).
- **Deliverables:** Cost dashboard.
- **Acceptance:** Accurate breakdowns; budgets visible.
- **Testing:** Integration + unit.
- **Future expansion:** Team cost (Post-1.0).

### Phase 198 — AI Status Surfaces *(Complexity: S)*
- **Goal:** Ambient AI status.
- **Scope:** Status-bar model + cost meter; index status; provider health; failover indicator (Part IX §159.7/§160).
- **Features:** At-a-glance AI state.
- **Tech reqs:** Status-bar items wired to engine.
- **Dependencies:** 28,151,167.
- **Risks:** Noise → concise items.
- **Deliverables:** AI status items.
- **Acceptance:** Model/cost/index/health shown; click actions.
- **Testing:** E2E.
- **Future expansion:** —

### Phase 199 — AI Errors & Offline UX *(Complexity: M)*
- **Goal:** Graceful AI failure UX (Part IX §165.3/§165.5).
- **Scope:** Map error taxonomy → actionable UX (auth/rate/quota/timeout/content/context-overflow/offline); failover transparency; local-only mode messaging.
- **Features:** Never dead-end AI.
- **Tech reqs:** Error→UX mapping; offline detection.
- **Dependencies:** 167,63.
- **Risks:** Confusing errors → clear next-action copy.
- **Deliverables:** AI error/offline UX.
- **Acceptance:** Every error states what/why/next; offline uses local.
- **Testing:** Integration (fault injection), e2e.
- **Future expansion:** —

### Phase 200 — AI Feature Flags, Telemetry & Eval Wiring *(Complexity: M)*
- **Goal:** Instrument + gate + evaluate core AI features.
- **Scope:** `ai_action` events (kind/provider/model/accepted/bucketed tokens); accept/revert tracking (WAEA); feature flags for each AI feature; wire core features into the eval suite (Part IV §52, V §79, XII §217).
- **Features:** Measured, safely-rollout-able AI.
- **Tech reqs:** Telemetry events; flags; eval harness cases.
- **Dependencies:** 127,129,183,187,193.
- **Risks:** Privacy → no code/PII in events.
- **Deliverables:** AI instrumentation + eval wiring.
- **Acceptance:** Events fire (consented, no code); flags gate features; eval runs on AI changes.
- **Testing:** Unit (no-PII), integration (flags), eval suite.
- **Future expansion:** Regression gates on accept/revert (Epoch J).

**Epoch G Exit Criteria:** Axiom delivers core AI with trust built-in — snapshots + safe-edit engine + visual diff review + approval workflow underpin every edit; chat (Ask mode) with rich `@`-context, citations, slash commands, history, model switching, and cost/manifest transparency; inline completion (ghost text) coexisting with IntelliSense, next-edit prediction, inline edit (Cmd-K), inline chat, and quick actions; semantic search and code explanation; and multi-file editing with dependency-aware, reviewable, reversible diffs. All grounded on-device, cost-tracked, and instrumented. **Milestone: AI-capable product (private beta candidate).**

---

*Part XIV continues in the next installment (Epoch H — Agentic & Advanced AI, Phases 201–238).*


## EPOCH H — AGENTIC & ADVANCED AI (Phases 201–238)

*Objective: deliver autonomous, safe, reviewable agents — the agent runtime + tool system, planning/thinking modes, the autonomous coding agent with self-verification, background/parallel execution + task queue, the full specialized-agent library, workspace rules/standards, custom agents, workflow automation/hooks, and MCP client support. Everything runs through approval + snapshots + audit (Epoch G substrate). This is where Axiom goes beyond Cursor.*

### Phase 201 — Agent Runtime Core *(Complexity: XL)*
- **Goal:** The plan-act-observe loop (Part V §72, VIII §131).
- **Scope:** Cancellable async run; event-sourced log (plan/tool/edit/checkpoint events); step tracking; resumable.
- **Features:** Foundation for all agents.
- **Tech reqs:** Orchestrator run engine; event store.
- **Dependencies:** 148,171,174.
- **Risks:** Runaway/thrash → budgets + loop-guard (Phase 208).
- **Deliverables:** Agent runtime.
- **Acceptance:** Runs a scripted multi-step task; log replayable.
- **Testing:** Integration (loop), unit (event log).
- **Future expansion:** Specialized/custom agents build on it.

### Phase 202 — Tool System & Executor *(Complexity: L)*
- **Goal:** Register + execute tools (Part V §72.2).
- **Scope:** Tool registry (`ToolSpec`); side-effect classes (read/mutate/exec/network); executor with approval hooks.
- **Features:** Agent capabilities framework.
- **Tech reqs:** Tool contract; execution + result feedback.
- **Dependencies:** 201,174.
- **Risks:** Unsafe tools → class-based approval.
- **Deliverables:** Tool executor.
- **Acceptance:** Register/execute a tool; approval class enforced.
- **Testing:** Integration.
- **Future expansion:** MCP tools (Phase 237).

### Phase 203 — Built-in Tools: File Read/Search/Edit *(Complexity: M)*
- **Goal:** Core code tools.
- **Scope:** Read file, semantic/lexical search, staged edit/apply-patch (reviewable) (Part V §72.2).
- **Features:** Agents can read + change code.
- **Tech reqs:** Wire to Core retrieval + safe-edit.
- **Dependencies:** 202,172,64.
- **Risks:** Unscoped edits → file scopes.
- **Deliverables:** File tools.
- **Acceptance:** Agent reads/searches/edits via reviewable diffs.
- **Testing:** Integration.
- **Future expansion:** —

### Phase 204 — Built-in Tools: Terminal/Command *(Complexity: M)*
- **Goal:** Run commands as a tool (approval-gated).
- **Scope:** Execute in terminal; preview command before run; capture output; allow/deny lists (Part VII §112.6, VIII §144).
- **Features:** Agents run builds/tests/scripts.
- **Tech reqs:** Terminal tool + approval + output capture.
- **Dependencies:** 202,76,174.
- **Risks:** Dangerous commands → preview + deny-list + confirm.
- **Deliverables:** Command tool.
- **Acceptance:** Commands shown+approved before running; output fed back.
- **Testing:** Integration (approval, capture).
- **Future expansion:** —

### Phase 205 — Built-in Tools: Tests/Build/Tasks *(Complexity: M)*
- **Goal:** Run project tasks as tools.
- **Scope:** Run tests/build via task system; parse results (problem matchers) for the agent (Part VII §115, VIII §137).
- **Features:** Verification-capable agents.
- **Tech reqs:** Task tool + result parsing.
- **Dependencies:** 202,102,103.
- **Risks:** Long tasks → budgets/timeouts.
- **Deliverables:** Task tools.
- **Acceptance:** Agent runs tests/build, reads pass/fail.
- **Testing:** Integration.
- **Future expansion:** Self-verification (Phase 217).

### Phase 206 — Built-in Tools: Git / Web / Ask-User *(Complexity: M)*
- **Goal:** Additional governed tools.
- **Scope:** Git read (status/diff/log; writes gated), web fetch (permissioned, allow-listed), "ask user" clarification (Part V §72.2, X §183).
- **Features:** Broader agent capability.
- **Tech reqs:** Tool wrappers + permissions.
- **Dependencies:** 202,78,134,174.
- **Risks:** SSRF/exfil via web → allow-list + approval.
- **Deliverables:** Git/web/ask tools.
- **Acceptance:** Git-read works; web fetch permissioned; ask-user pauses for input.
- **Testing:** Integration + security.
- **Future expansion:** —

### Phase 207 — Agent Guardrails & Approval Integration *(Complexity: L)*
- **Goal:** Enforce safety on every action.
- **Scope:** File/command/host scopes; deny-lists; secret redaction pre-egress; high-risk hard-confirm; per-agent policy (Part VIII §144, X §185).
- **Features:** Safe autonomy.
- **Tech reqs:** Wire tools→approval workflow + broker.
- **Dependencies:** 174,202,170.
- **Risks:** Injection-driven actions → content-as-data + approval.
- **Deliverables:** Agent guardrails.
- **Acceptance:** Out-of-scope/denied actions blocked; secrets redacted; high-risk confirmed.
- **Testing:** Security (scope escape, injection), integration.
- **Future expansion:** Org policy (Post-1.0).

### Phase 208 — Agent Budgets, Timeouts & Loop-Guard *(Complexity: M)*
- **Goal:** Bound agent cost/time; stop thrashing.
- **Scope:** maxSteps/maxCost/wall-clock; pause-on-breach; loop-guard detecting repeated failure → stop + diagnose (Part V §72.3/§72.6).
- **Features:** Predictable, affordable agents.
- **Tech reqs:** Budget enforcement; loop detection heuristics.
- **Dependencies:** 201,152.
- **Risks:** Premature stop → tunable + resumable.
- **Deliverables:** Budget/loop-guard.
- **Acceptance:** Breach pauses; loops stop with diagnosis.
- **Testing:** Integration (breach, loop).
- **Future expansion:** —

### Phase 209 — Agent Run Persistence & Resume *(Complexity: M)*
- **Goal:** Survive crashes mid-run.
- **Scope:** Persist run event log + snapshots; on crash, mark `interrupted`, offer resume/discard (Part V §72.7, VIII §143).
- **Features:** Resilient long runs.
- **Tech reqs:** Run store; resume logic.
- **Dependencies:** 201,171,16.
- **Risks:** Partial state → snapshot-protected + event-sourced.
- **Deliverables:** Run persistence/resume.
- **Acceptance:** Kill mid-run → resume from last step or discard cleanly.
- **Testing:** Recovery (kill mid-run).
- **Future expansion:** Time-travel review (Epoch I).

### Phase 210 — Agent Timeline UI *(Complexity: L)*
- **Goal:** Live, scrubbable run visualization (Part IX §159.4).
- **Scope:** Steps (plan/tool/edit/test) with status; expandable details (inputs/outputs/diffs); running cost/step; pause/stop/resume.
- **Features:** Transparent autonomy.
- **Tech reqs:** Timeline component over event log.
- **Dependencies:** 201,210-ui.
- **Risks:** Info overload → progressive disclosure.
- **Deliverables:** Agent timeline.
- **Acceptance:** Live steps shown; controls work.
- **Testing:** E2E.
- **Future expansion:** Redo-from-step (Epoch I).

### Phase 211 — Approval Prompts UI *(Complexity: M)*
- **Goal:** In-run approval UX (Part IX §159.5).
- **Scope:** Focused prompts (action/risk/scope) with Approve/Approve-remember/Deny/Always-in-workspace; high-risk stronger confirm.
- **Features:** Human-in-the-loop.
- **Tech reqs:** Approval UI wired to guardrails.
- **Dependencies:** 207,210.
- **Risks:** Prompt fatigue → scoped remember.
- **Deliverables:** Approval prompts.
- **Acceptance:** Approvals gate actions; remember-in-scope works.
- **Testing:** E2E.
- **Future expansion:** —

### Phase 212 — Agent Mode in Chat *(Complexity: M)*
- **Goal:** Run agents from chat (Part VIII §128.3).
- **Scope:** Agent-mode conversations; stream plan/tool calls; edits → diff review; timeline link.
- **Features:** Conversational agents.
- **Tech reqs:** Wire runtime to chat UI.
- **Dependencies:** 201,175,210.
- **Risks:** Confusing Ask/Agent → clear toggle + affordances.
- **Deliverables:** Agent chat mode.
- **Acceptance:** Describe task → agent runs with visible plan/tools/approvals.
- **Testing:** E2E.
- **Future expansion:** Custom-agent invocation (Phase 235).

### Phase 213 — Sub-Agents & Composition *(Complexity: M)*
- **Goal:** Agents spawn scoped sub-agents (Part V §72.9).
- **Scope:** Sub-agent runs with own budgets/tool scopes; results folded into parent.
- **Features:** Specialized decomposition.
- **Tech reqs:** Nested run orchestration.
- **Dependencies:** 201,208.
- **Risks:** Runaway nesting → depth/budget caps.
- **Deliverables:** Sub-agent support.
- **Acceptance:** Parent spawns sub-agent; results integrated; bounded.
- **Testing:** Integration.
- **Future expansion:** Multi-model debate (Epoch I).

### Phase 214 — Planning Mode *(Complexity: L)*
- **Goal:** Editable plan before execution (Part VIII §132).
- **Scope:** Generate ordered plan (steps/files/risks/acceptance); user edit/approve; execute + check off; re-plan on invalidation; save plans.
- **Features:** Controlled, predictable builds.
- **Tech reqs:** Plan model + tracking UI.
- **Dependencies:** 201,210.
- **Risks:** Plan/exec drift → re-plan + tracking.
- **Deliverables:** Planning mode.
- **Acceptance:** Plan editable/approvable; execution tracks it.
- **Testing:** E2E + eval.
- **Future expansion:** Spec-like artifacts (Post-1.0).

### Phase 215 — Thinking Mode *(Complexity: M)*
- **Goal:** Surface reasoning (Part VIII §133).
- **Scope:** Live collapsible reasoning stream (visibility settings); reasoning-token cost; emulated fallback labeled.
- **Features:** Trust + learning.
- **Tech reqs:** Reasoning stream UI (Phase 149).
- **Dependencies:** 149,175.
- **Risks:** Cost/verbosity → visibility control + cost shown.
- **Deliverables:** Thinking mode.
- **Acceptance:** Reasoning shows per setting; cost counted.
- **Testing:** E2E.
- **Future expansion:** —

### Phase 216 — Autonomous Coding Agent *(Complexity: XL)*
- **Goal:** Goal→plan→edit→verify→iterate (Part VIII §131).
- **Scope:** Accept goal + constraints; plan (Phase 214); multi-file edit; run tools; iterate; summarize; checkpoints.
- **Features:** Full autonomous coding.
- **Tech reqs:** Compose runtime + tools + planning + multi-file edit.
- **Dependencies:** 201,193,205,214.
- **Risks:** Wrong/unwanted changes → approval + snapshots + verify.
- **Deliverables:** Autonomous agent.
- **Acceptance:** Completes a defined feature/fix with reviewable diffs + verification.
- **Testing:** Eval (agent task success), e2e.
- **Future expansion:** Background/parallel (Phases 218/219).

### Phase 217 — Self-Verification Loop *(Complexity: L)*
- **Goal:** Prove success before claiming done (Part VIII §131.4).
- **Scope:** Run tests/typecheck/lint; read results; iterate on failure; report unverifiable honestly.
- **Features:** Trustworthy completion.
- **Tech reqs:** Verify step in loop; result interpretation.
- **Dependencies:** 216,205.
- **Risks:** False "done" → verification-first + honest reporting.
- **Deliverables:** Self-verification.
- **Acceptance:** Agent verifies (green tests/build) or states it couldn't.
- **Testing:** Eval.
- **Future expansion:** —

### Phase 218 — Background Agents *(Complexity: L)*
- **Goal:** Long tasks off the UI (Part VIII §131.6).
- **Scope:** Run in background; progress + completion toast; don't block editing.
- **Features:** Set-and-forget agents.
- **Tech reqs:** Background scheduling; notifications.
- **Dependencies:** 216,91-notify.
- **Risks:** Resource contention → bounded pool + priority.
- **Deliverables:** Background agents.
- **Acceptance:** Agent runs in background; editing unaffected; notifies on done.
- **Testing:** Integration + perf.
- **Future expansion:** Ambient health agent (Epoch I).

### Phase 219 — Parallel Agents *(Complexity: L)*
- **Goal:** Fan-out independent subtasks (Part V §72.4).
- **Scope:** Multiple concurrent agents; bounded pool; fair scheduling; gather results.
- **Features:** Faster large tasks.
- **Tech reqs:** Pool + scheduler + result aggregation.
- **Dependencies:** 218,70.
- **Risks:** CPU/cost → ceilings + budgets.
- **Deliverables:** Parallel agents.
- **Acceptance:** N agents run concurrently within limits; results merged.
- **Testing:** Stress (many agents).
- **Future expansion:** —

### Phase 220 — Task Queue & Agent Management UI *(Complexity: L)*
- **Goal:** Mission control for agents (Part VIII §149).
- **Scope:** Persistent queue (queued/running/paused/done/failed); progress/cost/model/steps; pause/resume/cancel/retry/reprioritize; links to timeline/diffs/audit.
- **Features:** Manage many/background runs.
- **Tech reqs:** Queue store + management view.
- **Dependencies:** 209,218,219.
- **Risks:** Queue overflow → caps + status.
- **Deliverables:** Task queue UI.
- **Acceptance:** Full lifecycle control; survives restart.
- **Testing:** Integration + recovery.
- **Future expansion:** —

### Phase 221 — Research Agent *(Complexity: M)*
- **Goal:** Deep exploration + report (no edits) (Part VIII §134.1).
- **Scope:** Explore repo (+ optional web/docs); grounded report with citations; compare approaches.
- **Features:** Understand/evaluate.
- **Tech reqs:** Read/search/web tools; report template.
- **Dependencies:** 202,206,191.
- **Risks:** Ungrounded → citations required.
- **Deliverables:** Research agent.
- **Acceptance:** Produces cited report; no edits.
- **Testing:** Eval + e2e.
- **Future expansion:** Repo Q&A onboarding (Epoch I).

### Phase 222 — Code Review Agent *(Complexity: L)*
- **Goal:** Structured review of changes (Part VIII §135).
- **Scope:** Review staged/commit/branch diff; inline comments with severity/category/rationale + suggested-fix diffs; enforce workspace rules; risk/test-gap summary.
- **Features:** "Ship" quality gate.
- **Tech reqs:** Diff analysis + rules; comment model.
- **Dependencies:** 216,233,81.
- **Risks:** Noisy nits → severity + config.
- **Deliverables:** Review agent.
- **Acceptance:** Actionable, standards-aware review; suggestions applyable.
- **Testing:** Eval + e2e.
- **Future expansion:** Automation triggers (Phase 236).

### Phase 223 — Testing Agent *(Complexity: L)*
- **Goal:** Generate/run/repair tests (Part VIII §137).
- **Scope:** Unit + integration generation (framework-aware); run + fix failures (code or tests, labeled); coverage-aware targeting; maintenance.
- **Features:** Automated testing.
- **Tech reqs:** Test-gen prompts + task tool + coverage.
- **Dependencies:** 216,205,68.
- **Risks:** Over-mocking/brittle → conventions + eval.
- **Deliverables:** Testing agent.
- **Acceptance:** Generates passing, meaningful tests; repairs failures.
- **Testing:** Eval (tests-pass), e2e.
- **Future expansion:** —

### Phase 224 — Bug-Fix / Debugging Agent *(Complexity: L)*
- **Goal:** Diagnose + fix from symptoms (Part VIII §136).
- **Scope:** From error/stack/failing test → root-cause hypothesis → fix diff; drive debugger (breakpoints/inspect) as a tool; verify by running the test.
- **Features:** Autonomous debugging.
- **Tech reqs:** Debugger tool integration; trace analysis.
- **Dependencies:** 216,97,217.
- **Risks:** Wrong fix → verify-first + review.
- **Deliverables:** Bug-fix agent.
- **Acceptance:** Proposes verified fix; explains bug.
- **Testing:** Eval (fix-verified), e2e.
- **Future expansion:** —

### Phase 225 — Refactoring Agent *(Complexity: L)*
- **Goal:** Graph-grounded refactor campaigns (Part VIII §138).
- **Scope:** Rename-concept/extract/restructure across files via impact analysis; multi-file diff; verify with tests.
- **Features:** Safe large-scale refactors.
- **Tech reqs:** Knowledge-graph completeness (Phase 194).
- **Dependencies:** 216,194,66.
- **Risks:** Incomplete → impact analysis + verify.
- **Deliverables:** Refactoring agent.
- **Acceptance:** Completes cross-file refactor; verified; reversible.
- **Testing:** Eval (completeness), e2e.
- **Future expansion:** —

### Phase 226 — Documentation Agent *(Complexity: M)*
- **Goal:** Generate/maintain docs (Part VIII §139).
- **Scope:** In-code docs; README/API/module docs; Mermaid diagrams from graph; drift detection.
- **Features:** Living documentation.
- **Tech reqs:** Doc-gen prompts + graph + diagram export.
- **Dependencies:** 216,65.
- **Risks:** Spammy docs → targeted + review.
- **Deliverables:** Docs agent.
- **Acceptance:** Accurate grounded docs + diagrams via diff review.
- **Testing:** Eval + e2e.
- **Future expansion:** —

### Phase 227 — Architecture Agent *(Complexity: L)*
- **Goal:** Design → scaffold → implement (Part VIII §140).
- **Scope:** From requirements: component/data/API design + trade-offs + diagrams; scaffold skeleton; on approval, flesh out (multi-file); respect existing architecture.
- **Features:** Greenfield + extension design.
- **Tech reqs:** Design prompts + scaffolding + multi-file edit.
- **Dependencies:** 216,193,68.
- **Risks:** Over-engineering → align to repo + review.
- **Deliverables:** Architecture agent.
- **Acceptance:** Produces design + working skeleton via review.
- **Testing:** Eval + e2e.
- **Future expansion:** —

### Phase 228 — Deployment Agent *(Complexity: L)*
- **Goal:** Prepare shipping artifacts (Part VIII §134.8).
- **Scope:** Generate/update CI/CD, Dockerfiles, IaC snippets, env checks, release notes, pre-deploy checklists; run build/test locally; **flag prod/infra as high-risk; never auto-deploy to prod**.
- **Features:** Ship-readiness (proposes, human ships).
- **Tech reqs:** Config generation + high-risk gating.
- **Dependencies:** 216,207.
- **Risks:** Prod changes → hard-confirm + no auto-deploy (Part X).
- **Deliverables:** Deployment agent.
- **Acceptance:** Prepares deploy artifacts; production actions gated.
- **Testing:** Eval + security (gating).
- **Future expansion:** Gated auto-deploy (Post-1.0).

### Phase 229 — Dependency / Security Agent *(Complexity: L)*
- **Goal:** Dependency + risk analysis (Part VIII §134.9).
- **Scope:** Outdated/vulnerable/unused deps, license issues, safe upgrades (+codemods); risky-pattern + secret-in-code scan; fixes as diffs; feed Problems.
- **Features:** Supply-chain + code security help.
- **Tech reqs:** Graph + manifests + vuln data; scan prompts.
- **Dependencies:** 216,65,229-data.
- **Risks:** False positives → review + severity.
- **Deliverables:** Dependency/security agent.
- **Acceptance:** Flags real issues; proposes safe fixes.
- **Testing:** Eval + e2e.
- **Future expansion:** Enterprise policy (Post-1.0).

### Phase 230 — Migration Agent *(Complexity: L)*
- **Goal:** Large mechanical migrations (Part VIII §134.10).
- **Scope:** Framework/version/API migrations via codemods + AI edits; graph for completeness; verify; coverage report ("142/145 done; 3 need decisions").
- **Features:** Confident big migrations.
- **Tech reqs:** Codemod + AI edit + completeness reporting.
- **Dependencies:** 225,194.
- **Risks:** Incomplete → graph completeness + report.
- **Deliverables:** Migration agent.
- **Acceptance:** Migrates majority; reports gaps; verified.
- **Testing:** Eval (completeness), e2e.
- **Future expansion:** —

### Phase 231 — Git AI Features *(Complexity: M)*
- **Goal:** AI in the Git flow (Part VIII §113.8).
- **Scope:** Commit messages (from staged diff), PR descriptions, changelog, conflict-resolution suggestions (in merge editor).
- **Features:** Faster, cleaner VCS.
- **Tech reqs:** Diff→text prompts; merge-editor integration.
- **Dependencies:** 80,86,176.
- **Risks:** Low-quality messages → editable + conventions.
- **Deliverables:** Git AI features.
- **Acceptance:** Useful commit/PR text; conflict suggestions.
- **Testing:** Eval + e2e.
- **Future expansion:** —

### Phase 232 — Agent Library UI & Invocation *(Complexity: M)*
- **Goal:** Discover + run specialized agents (Part VIII §134).
- **Scope:** Agent gallery; invoke from chat (`/agent`), palette, context menus, automation; per-agent config.
- **Features:** Easy access to the agent suite.
- **Tech reqs:** Agent registry + invocation surfaces.
- **Dependencies:** 221–231,212.
- **Risks:** Discoverability → gallery + slash.
- **Deliverables:** Agent library UI.
- **Acceptance:** All agents invokable from multiple surfaces.
- **Testing:** E2E.
- **Future expansion:** Custom agents (Phase 235).

### Phase 233 — Workspace Rules & Coding Standards *(Complexity: M)*
- **Goal:** Team/user rules that shape AI (Part VIII §145).
- **Scope:** `.axiom/rules/*.md` (workspace) + global; scoping (glob/priority); inject into generation; enforce in review; import `.cursorrules`/`AGENTS.md`; guardrail rules non-overridable.
- **Features:** Encoded standards.
- **Tech reqs:** Rules loader + precedence + injection.
- **Dependencies:** 163,222,125.
- **Risks:** Conflicts → specificity + priority.
- **Deliverables:** Rules system.
- **Acceptance:** Rules shape generation + review; import works.
- **Testing:** Eval + integration.
- **Future expansion:** Convention learner (Epoch I).

### Phase 234 — Prompt Library & History *(Complexity: M)*
- **Goal:** Reusable prompts + history (Part VIII §146).
- **Scope:** Save prompts (variables/tags/scope), insert via slash/palette/menu; searchable history (re-run/resume); C2 sync; starter set; usage stats.
- **Features:** Prompt reuse + recovery.
- **Tech reqs:** Library store (Phase 125) + history + UI.
- **Dependencies:** 180,125.
- **Risks:** —
- **Deliverables:** Prompt library + history.
- **Acceptance:** Save/insert/search prompts; history re-runnable.
- **Testing:** Integration + e2e.
- **Future expansion:** Team sharing (Post-1.0).

### Phase 235 — Custom Agents *(Complexity: L)*
- **Goal:** User/team-defined agents (Part VIII §147).
- **Scope:** Define persona/tools/model-routing/guardrails/rule-bindings; wizard + templates; workspace/user scope; share via `.axiom/agents/*`; optional code hooks.
- **Features:** Axiom as a platform.
- **Tech reqs:** Agent definition schema + SDK (Part II §19.5).
- **Dependencies:** 201,207,232.
- **Risks:** Misconfigured agents → validation + guardrail defaults.
- **Deliverables:** Custom agents.
- **Acceptance:** Define + run a custom agent; shareable.
- **Testing:** Integration + e2e.
- **Future expansion:** Marketplace (Post-1.0).

### Phase 236 — Workflow Automation & Hooks *(Complexity: L)*
- **Goal:** Event-driven + chained agent workflows (Part VIII §148).
- **Scope:** Triggers (file save/create/delete, pre-commit, post-checkout, schedule, manual); chained pipelines (plan→implement→test→review→doc) with conditions + human gates; cost estimates; audit; management UI.
- **Features:** Set-and-forget quality/automation.
- **Tech reqs:** Hook engine; pipeline orchestration; approval-aware.
- **Dependencies:** 216,222,235.
- **Risks:** Expensive/destructive triggers → confirm + estimate + scope.
- **Deliverables:** Automation + hooks.
- **Acceptance:** Triggered/chained workflows run safely + audited.
- **Testing:** Integration + e2e.
- **Future expansion:** Ambient health agent (Epoch I).

### Phase 237 — MCP Client Support *(Complexity: L)*
- **Goal:** Connect external tools/data via MCP (Part V §80.3).
- **Scope:** MCP client; connect servers (config per user/workspace); register their tools/resources into the ToolExecutor; permission-brokered; untrusted output treated as data; audited.
- **Features:** Extensible agent capabilities (DBs/APIs/docs).
- **Tech reqs:** MCP transport + broker + tool bridge.
- **Dependencies:** 202,207.
- **Risks:** Untrusted MCP → permissions + content-as-data + approval.
- **Deliverables:** MCP client.
- **Acceptance:** Connect MCP server; agents use its tools under approval.
- **Testing:** Integration + security.
- **Future expansion:** MCP marketplace (Post-1.0).

### Phase 238 — Refactor Safety, Grounded-Answer Guarantee & Agent Evals *(Complexity: M)*
- **Goal:** High-reliability differentiators + measurement.
- **Scope:** KG-aware refactor safety (predict blast radius pre-edit, verify completeness post-edit); grounded-answer mode (refuse uncited claims); agent success/step/revert/cost metrics in evals (Part VIII §151, XII §217).
- **Features:** Reliability edge + measured agents.
- **Tech reqs:** Impact prediction/verification; grounded-mode gate; eval metrics.
- **Dependencies:** 194,222,225,200.
- **Risks:** Over-strict grounding → user-toggleable.
- **Deliverables:** Reliability features + agent evals.
- **Acceptance:** Refactor safety predicts/verifies; grounded mode refuses uncited; agent evals tracked.
- **Testing:** Eval + integration.
- **Future expansion:** Multi-model debate/critic (Epoch I).

**Epoch H Exit Criteria:** Axiom is fully agentic and beyond Cursor — a resilient agent runtime + governed tool system; planning and thinking modes; an autonomous coding agent that self-verifies; background + parallel execution with a task-queue mission control; a complete specialized-agent library (research, review, testing, bug-fix, refactor, docs, architecture, deployment, dependency/security, migration) plus Git AI; workspace rules/standards, prompt library, custom agents, workflow automation/hooks, and MCP client support — all approval-gated, snapshot-reversible, audited, and evaluated. **Milestone: feature-complete AI (public beta candidate).**

---

*Part XIV continues in the next installment (Epoch I — Extensions, Themes, i18n, A11y & Novel AI, Phases 239–264).*


## EPOCH I — EXTENSIONS, THEMES, i18n, A11y & NOVEL AI (Phases 239–264)

*Objective: open the platform (extensions, provider/agent SDKs, VS Code compatibility), complete customization (themes, keymaps, profiles), ship the localization and accessibility passes, and land the novel differentiating AI systems that push Axiom ahead of competitors. After this epoch, Axiom is feature-complete and extensible — ready for hardening.*

### Phase 239 — Extension Host *(Complexity: L)*
- **Goal:** Sandboxed extension runtime (Part II §19, VII §117).
- **Scope:** Dedicated Node child; resource ceilings; crash isolation; per-workspace enablement; trust-aware activation.
- **Features:** Third-party extensibility foundation.
- **Tech reqs:** Supervised host; IPC façade; sandbox.
- **Dependencies:** 20,6,111-trust.
- **Risks:** Sandbox escape → isolation + broker (Phase 242).
- **Deliverables:** Extension host.
- **Acceptance:** Load/run a sample extension; crash isolated.
- **Testing:** Integration + security.
- **Future expansion:** Marketplace (Phase 243).

### Phase 240 — Extension API Surface *(Complexity: L)*
- **Goal:** Curated public API (Part VII §117.2).
- **Scope:** Commands, configuration, workspace/text-document, languages/diagnostics/completions, UI (views/tree/webview w/ CSP), tasks, debug, SCM provider.
- **Features:** Extensions contribute real capabilities.
- **Tech reqs:** Stable typed API over IPC.
- **Dependencies:** 239.
- **Risks:** API breadth vs security → curated subset.
- **Deliverables:** Extension API.
- **Acceptance:** Sample extensions use each API area.
- **Testing:** Integration (API), a11y (webviews).
- **Future expansion:** More API as needed.

### Phase 241 — AI Contribution Points *(Complexity: M)*
- **Goal:** Extensions extend AI (Part VII §19.2).
- **Scope:** Register tools, agents, prompt templates, context providers into the AI subsystem.
- **Features:** Community/enterprise AI extensions.
- **Tech reqs:** AI contribution registry (dogfooded by first-party).
- **Dependencies:** 240,202,232.
- **Risks:** Untrusted AI contributions → permissions + approval.
- **Deliverables:** AI contribution points.
- **Acceptance:** Extension registers a tool/agent/prompt usable by AI.
- **Testing:** Integration + security.
- **Future expansion:** SDKs (Phase 246).

### Phase 242 — Extension Manifest, Permissions & Broker *(Complexity: M)*
- **Goal:** Enforce least privilege (Part II §19.3, X §181.2).
- **Scope:** Manifest-declared permissions (fs scopes, network hosts, AI, no-secret); capability broker enforcement; resource limits.
- **Features:** Safe extensions.
- **Tech reqs:** Broker in Main; permission prompts.
- **Dependencies:** 239,181-broker.
- **Risks:** Over-permission → user review + deny undeclared.
- **Deliverables:** Permission system.
- **Acceptance:** Undeclared access denied + surfaced; limits enforced.
- **Testing:** Security (permission escape).
- **Future expansion:** Org allow-lists (Post-1.0).

### Phase 243 — Extension Registry / Marketplace *(Complexity: L)*
- **Goal:** Distribute extensions (Part VII §117.3).
- **Scope:** Curated signed registry (OpenVSX-style source + first-party); browse/search/install/update; VSIX-like package install.
- **Features:** Ecosystem.
- **Tech reqs:** Registry backend + client; signing verification.
- **Dependencies:** 239,84-signing.
- **Risks:** Supply chain → signing + review + sandbox.
- **Deliverables:** Extension registry + client.
- **Acceptance:** Browse/install/update signed extensions.
- **Testing:** Integration + security.
- **Future expansion:** Open publisher program (Post-1.0).

### Phase 244 — VS Code Compatibility Layer *(Complexity: XL)*
- **Goal:** Run many VS Code extensions (Part VII §117.4).
- **Scope:** Compatibility shim for a high-value API subset (themes, linters, language packs, formatters); per-extension compatibility labeling.
- **Features:** Ecosystem breadth without forking.
- **Tech reqs:** API shim mapping VS Code shapes → Axiom API.
- **Dependencies:** 240.
- **Risks:** Partial compat confusion → clear labels + tests.
- **Deliverables:** Compat layer.
- **Acceptance:** Curated popular extensions run; compat labeled.
- **Testing:** Compatibility (extension matrix).
- **Future expansion:** Broaden coverage (Post-1.0).

### Phase 245 — Extension Management UI *(Complexity: M)*
- **Goal:** Manage extensions (Part VII §117.5).
- **Scope:** Install/enable/disable/uninstall/update; per-workspace enablement; recommended extensions; permission view before install; logs; bulk update; trust-aware.
- **Features:** Extension control.
- **Tech reqs:** Management view.
- **Dependencies:** 243,242.
- **Risks:** — 
- **Deliverables:** Extensions UI.
- **Acceptance:** Full extension lifecycle; permissions shown.
- **Testing:** E2E.
- **Future expansion:** —

### Phase 246 — Provider Plugin SDK & Custom Agent SDK *(Complexity: M)*
- **Goal:** Public SDKs (Part II §19.4/§19.5).
- **Scope:** `IProviderAdapter` SDK (new providers out-of-band) + custom-agent SDK; docs + templates + samples.
- **Features:** Extend providers/agents without core releases.
- **Tech reqs:** SDK packages + generated docs.
- **Dependencies:** 135,235,241.
- **Risks:** API stability → versioned SDK.
- **Deliverables:** SDKs + docs.
- **Acceptance:** Build a sample provider + agent via SDK.
- **Testing:** Integration (sample plugins).
- **Future expansion:** —

### Phase 247 — Color Themes & Syntax Customization *(Complexity: M)*
- **Goal:** Full theming (Part VII §118, IX §154.7).
- **Scope:** Polished dark/light/HC built-ins; custom themes; import VS Code color themes; per-scope + semantic token color customization; live preview; OS auto-switch.
- **Features:** Deep visual customization.
- **Tech reqs:** Theme loader/importer.
- **Dependencies:** 12,39,94.
- **Risks:** Contrast issues → linter.
- **Deliverables:** Theme system.
- **Acceptance:** Import + customize themes; contrast validated.
- **Testing:** Visual + contrast.
- **Future expansion:** Theme marketplace (Post-1.0).

### Phase 248 — Icon Themes & UI Customization *(Complexity: S)*
- **Goal:** File/product icons + UI tuning (Part IX §154).
- **Scope:** File icon themes, product icon themes; density (comfortable/compact), font, layout customization.
- **Features:** Personalized UI.
- **Tech reqs:** Icon theme loader; density tokens.
- **Dependencies:** 12,13.
- **Risks:** —
- **Deliverables:** Icon themes + UI customization.
- **Acceptance:** Switch icon themes/density.
- **Testing:** Visual.
- **Future expansion:** —

### Phase 249 — Keymaps (complete) + Vim Mode + Profiles *(Complexity: L)*
- **Goal:** Full keymap coverage + profiles (Part VII §119/§120.4).
- **Scope:** JetBrains/Sublime/Emacs keymaps; modal **Vim mode**; **settings profiles** (bundle settings+keybindings+extensions+UI; switch/sync).
- **Features:** Switcher-friendly + context profiles.
- **Tech reqs:** Keymap defs; Vim engine; profile system.
- **Dependencies:** 47,46.
- **Risks:** Vim fidelity → tests + iteration.
- **Deliverables:** Keymaps + Vim + profiles.
- **Acceptance:** Keymaps import; Vim usable; profiles switch/sync.
- **Testing:** E2E + compatibility.
- **Future expansion:** —

### Phase 250 — i18n Infrastructure *(Complexity: L)*
- **Goal:** Localization pipeline (Part VI §95).
- **Scope:** Externalize all strings into catalogs; ICU MessageFormat (plural/format); lint gate for hard-coded strings.
- **Features:** Localizable product.
- **Tech reqs:** i18n framework; extraction tooling; lint rule.
- **Dependencies:** 13.
- **Risks:** Un-externalized strings → lint gate (CI).
- **Deliverables:** i18n infra.
- **Acceptance:** Strings externalized; lint blocks hard-coded UI text.
- **Testing:** Unit + lint gate.
- **Future expansion:** More locales (Post-1.0).

### Phase 251 — RTL & Layout Robustness *(Complexity: M)*
- **Goal:** RTL + expansion-tolerant layouts (Part VI §95, IX §172).
- **Scope:** Logical CSS + `dir` handling; ~30% text-expansion tolerance; locale detection + hot-switch.
- **Features:** Global-ready UI.
- **Tech reqs:** RTL styling; pseudo-loc testing.
- **Dependencies:** 250.
- **Risks:** Layout breakage → pseudo-loc smoke tests.
- **Deliverables:** RTL + robust layouts.
- **Acceptance:** RTL mirrors correctly; no truncation on expansion.
- **Testing:** Pseudo-loc + RTL visual.
- **Future expansion:** —

### Phase 252 — Fonts, CJK & First Localization *(Complexity: M)*
- **Goal:** Script coverage + English-complete + pipeline (Part VI §95).
- **Scope:** Bundle/fallback fonts (Latin/CJK/Cyrillic); English fully localized-ready; MT-assisted + human-review workflow scaffold.
- **Features:** Ready to add locales without code changes.
- **Tech reqs:** Font stack; translation workflow.
- **Dependencies:** 250.
- **Risks:** CJK rendering → coverage tests.
- **Deliverables:** Fonts + localization pipeline.
- **Acceptance:** CJK renders; adding a locale needs no code change.
- **Testing:** Rendering + i18n.
- **Future expansion:** Ship top locales (Post-1.0).

### Phase 253 — Component A11y Audit & Fixes *(Complexity: L)*
- **Goal:** Component-level accessibility (Part IX §171).
- **Scope:** ARIA roles/names/states across all components; WAI-ARIA keyboard patterns; focus management; live-region announcements.
- **Features:** Accessible UI.
- **Tech reqs:** axe integration; pattern conformance.
- **Dependencies:** 13,29.
- **Risks:** Gaps → axe gate + manual.
- **Deliverables:** A11y-fixed components.
- **Acceptance:** axe clean; keyboard patterns pass.
- **Testing:** Automated a11y + keyboard.
- **Future expansion:** —

### Phase 254 — Screen Reader & Editor A11y *(Complexity: L)*
- **Goal:** SR support + accessible editing (Part VI §94).
- **Scope:** UIA bridge for Narrator/NVDA/JAWS; Monaco screen-reader mode; audio cues (errors/breakpoints); accessible diff/merge/terminal.
- **Features:** Non-visual usability.
- **Tech reqs:** SR integration; editor a11y config.
- **Dependencies:** 253,35.
- **Risks:** SR quirks → manual AT testing.
- **Deliverables:** SR + editor a11y.
- **Acceptance:** Core journeys usable with NVDA/Narrator.
- **Testing:** Manual AT passes.
- **Future expansion:** —

### Phase 255 — Contrast, Zoom, DPI & Reduced Motion *(Complexity: M)*
- **Goal:** Visual accessibility (Part VI §94, IX §168).
- **Scope:** High-contrast themes; UI zoom + editor font scaling (no clipping); per-monitor DPI; reduced-motion honoring; contrast validation; WCAG 2.1 AA checklist.
- **Features:** Inclusive visuals.
- **Tech reqs:** Zoom/DPI handling; motion tokens; contrast linter.
- **Dependencies:** 12,247.
- **Risks:** Clipping on zoom → reflow tests.
- **Deliverables:** Visual a11y.
- **Acceptance:** AA contrast; zoom without clipping; reduced-motion respected.
- **Testing:** A11y + visual (with caveat: full conformance needs expert review).
- **Future expansion:** —

### Phase 256 — Time-Travel Agent Review *(Complexity: L)*
- **Goal:** Scrub + branch agent runs (Part VIII §151.1).
- **Scope:** Timeline scrubbing; view each step's decision/diff; "redo from step N with different approach"; branch runs.
- **Features:** Inspectable, editable autonomy.
- **Tech reqs:** Event-log replay + branching.
- **Dependencies:** 209,210.
- **Risks:** State branching complexity → snapshot-anchored.
- **Deliverables:** Time-travel review.
- **Acceptance:** Scrub run; branch/redo from a step.
- **Testing:** E2E + integration.
- **Future expansion:** —

### Phase 257 — Multi-Model Debate / Critic *(Complexity: M)*
- **Goal:** Cross-check high-stakes changes (Part VIII §151.2).
- **Scope:** One model proposes, another critiques; surface disagreements; optional majority-vote/self-consistency.
- **Features:** Higher correctness for critical edits.
- **Tech reqs:** Multi-model orchestration (sub-agents).
- **Dependencies:** 213,166.
- **Risks:** Cost → opt-in + budgets.
- **Deliverables:** Debate/critic.
- **Acceptance:** Proposer+critic run; disagreements shown.
- **Testing:** Eval (quality delta).
- **Future expansion:** —

### Phase 258 — Provider A/B Compare (full) *(Complexity: M)*
- **Goal:** Side-by-side model comparison (Part VIII §151.3).
- **Scope:** Same prompt on two providers/models; compare output/latency/cost; pick winner.
- **Features:** Model selection for BYOK/AI-engineer persona.
- **Tech reqs:** Dual-run UI (extend Phase 182).
- **Dependencies:** 182.
- **Risks:** Cost → estimate + confirm.
- **Deliverables:** A/B compare.
- **Acceptance:** Two models compared on quality/latency/cost.
- **Testing:** E2E.
- **Future expansion:** —

### Phase 259 — Ambient Codebase Health Agent *(Complexity: L)*
- **Goal:** Background drift monitoring (Part VIII §151.4).
- **Scope:** Opt-in, budget-capped background agent watching for failing tests, new lint/security issues, doc/code divergence, dead code, dep risks; prioritized one-click-fixable list; uses cheap/local models.
- **Features:** Continuous quality.
- **Tech reqs:** Scheduled background agent + health model.
- **Dependencies:** 218,229,236.
- **Risks:** Cost/noise → budgets + prioritization + local models.
- **Deliverables:** Health agent.
- **Acceptance:** Surfaces prioritized, fixable health items within budget.
- **Testing:** Integration + cost.
- **Future expansion:** Team health (Post-1.0).

### Phase 260 — Convention Learner *(Complexity: M)*
- **Goal:** Infer + propose workspace rules (Part VIII §151.5).
- **Scope:** Observe repo + accepted/rejected AI edits → infer conventions → propose rules (Phase 233) for approval.
- **Features:** Self-codifying standards.
- **Tech reqs:** Pattern inference over edits/repo.
- **Dependencies:** 233,160.
- **Risks:** Wrong inferences → propose (not auto-apply).
- **Deliverables:** Convention learner.
- **Acceptance:** Proposes plausible rules from the codebase.
- **Testing:** Eval.
- **Future expansion:** —

### Phase 261 — Cost-Aware Autopilot *(Complexity: M)*
- **Goal:** Quality bar at min spend (Part VIII §151.6).
- **Scope:** Routing that drafts cheap/local, escalates to frontier only when needed, within budgets.
- **Features:** Economical autonomy.
- **Tech reqs:** Cost-aware routing policy (extend Phase 165).
- **Dependencies:** 165,152.
- **Risks:** Quality dips → escalation heuristics + eval.
- **Deliverables:** Cost-aware autopilot.
- **Acceptance:** Meets quality within budget; escalates appropriately.
- **Testing:** Eval (quality/cost).
- **Future expansion:** —

### Phase 262 — Local-First Autonomy *(Complexity: M)*
- **Goal:** Full agent workflows on local models (Part VIII §151.7).
- **Scope:** Agents run entirely on Ollama/LM Studio — zero egress, zero cost, offline; capability-aware task fit.
- **Features:** Sovereign, offline autonomy (reseller IDEs can't match).
- **Tech reqs:** Local-model routing for agent loops; capability gating.
- **Dependencies:** 143,144,216.
- **Risks:** Local capability gaps → transparent labeling + "use stronger model?".
- **Deliverables:** Local-first agents.
- **Acceptance:** Complete an agent task offline on a local model.
- **Testing:** Integration (offline), eval.
- **Future expansion:** Local fine-tunes (Post-1.0).

### Phase 263 — Repo Q&A Onboarding *(Complexity: M)*
- **Goal:** "Explain this codebase to me" tour (Part VIII §151.8/§141).
- **Scope:** Guided interactive walkthrough of architecture/entry points/key flows using the knowledge graph; newcomer-oriented.
- **Features:** Fast onboarding to unfamiliar repos.
- **Tech reqs:** Guided tour over graph + explanation.
- **Dependencies:** 67,191.
- **Risks:** Shallow tour → graph-grounded + interactive.
- **Deliverables:** Repo Q&A onboarding.
- **Acceptance:** Newcomer gets a grounded architecture tour.
- **Testing:** Eval + e2e.
- **Future expansion:** —

### Phase 264 — UX Polish Pass *(Complexity: L)*
- **Goal:** Consistency + delight across the product (Part IX).
- **Scope:** Audit all empty/loading/error/success/offline states; tune motion; refine microcopy/voice; tune notifications; add interactive walkthroughs; final visual consistency.
- **Features:** Cohesive, calm, professional feel.
- **Tech reqs:** States checklist; walkthrough framework.
- **Dependencies:** 29,157,199.
- **Risks:** Inconsistency → shared components + design review.
- **Deliverables:** Polished UX.
- **Acceptance:** All views pass the states checklist; walkthroughs work; consistent voice/motion.
- **Testing:** Visual regression + manual review.
- **Future expansion:** Ongoing polish.

**Epoch I Exit Criteria:** Axiom is feature-complete and extensible — a sandboxed extension host with a curated API + AI contribution points + permissions + registry + VS Code compatibility + provider/agent SDKs; full theming, complete keymaps + Vim mode + settings profiles; a localization pipeline (English complete, others code-free to add) with RTL/CJK; a thorough accessibility pass (SR/keyboard/contrast/zoom/reduced-motion toward WCAG 2.1 AA); the novel differentiating AI systems (time-travel review, multi-model critic, A/B compare, ambient health, convention learner, cost-aware autopilot, local-first autonomy, repo-Q&A onboarding); and a full UX polish pass. **Milestone: feature-complete, public beta.**

---

*Part XIV continues in the next installment (Epoch J — Hardening, Performance, Security & Release, Phases 265–286).*


## EPOCH J — HARDENING, PERFORMANCE, SECURITY & RELEASE (Phases 265–286)

*Objective: take the feature-complete beta to a shippable, signed, secure, performant GA — enforce performance budgets, harden large-repo/large-file paths, lock down security (with an independent pen-test), pass accessibility/compatibility/recovery/soak audits, finalize installers + auto-update + crash recovery + enterprise deployment, run the beta program, and cut GA. This epoch turns "works" into "production-ready."*

### Phase 265 — Performance Budget Enforcement & CI Gates *(Complexity: L)*
- **Goal:** Make SLOs release-blocking (Part XI §194/§209).
- **Scope:** Perf harness on fixed reference hardware; baselines + tolerances; blocking gates for B1–B9/B12/B14–B19; flame-graph capture on regressions.
- **Features:** No perf regressions ship.
- **Tech reqs:** Perf CI job; baseline store; trend dashboards.
- **Dependencies:** 206-perf,14.
- **Risks:** Hardware variance → fixed runners + tolerances.
- **Deliverables:** Perf gates + dashboards.
- **Acceptance:** Regression past budget fails CI; trends tracked.
- **Testing:** Perf suite (CI).
- **Future expansion:** More SLIs over time.

### Phase 266 — Startup & Memory Optimization *(Complexity: L)*
- **Goal:** Hit cold/warm start + memory budgets (Part XI §195/§200).
- **Scope:** Tune staged startup/lazy activation; V8 snapshots; memory watchdog + cache eviction; fix leaks found in soak.
- **Features:** Fast, lean app.
- **Tech reqs:** Startup profiling; heap analysis.
- **Dependencies:** 14,265.
- **Risks:** Leaks → soak + heap diffs.
- **Deliverables:** Startup/memory optimizations.
- **Acceptance:** B1–B3, B14–B17 met on reference HW.
- **Testing:** Startup bench + soak.
- **Future expansion:** —

### Phase 267 — Large-Repository Hardening *(Complexity: L)*
- **Goal:** Survive 1M+ file repos (Part XI §197).
- **Scope:** Stress tree/search/index/Git at extreme scale; partial/scoped indexing; virtualization; watcher storm handling; graceful degradation.
- **Features:** Enterprise-repo readiness.
- **Tech reqs:** Synthetic 1M-file corpus; scale tuning.
- **Dependencies:** 61,267-corpus.
- **Risks:** Memory/CPU → mmap + budgets + partial index.
- **Deliverables:** Large-repo hardening.
- **Acceptance:** Usable on 1M-file repo within budgets/degradation.
- **Testing:** Stress (huge repo).
- **Future expansion:** —

### Phase 268 — Large-File Support Hardening *(Complexity: M)*
- **Goal:** Handle 50–256 MB files (Part XI §198).
- **Scope:** Performance mode; virtualized/streamed rendering; tokenization limits; binary/minified detection; windowed AI.
- **Features:** No freeze on huge files.
- **Tech reqs:** Large-file mode; chunked reads.
- **Dependencies:** 38,268-corpus.
- **Risks:** Pathological lines → limits + guards.
- **Deliverables:** Large-file hardening.
- **Acceptance:** Open/edit 50–256 MB within budget (B7).
- **Testing:** Stress (huge files).
- **Future expansion:** —

### Phase 269 — Editor Hot-Path Latency & Rendering *(Complexity: M)*
- **Goal:** Frame-perfect editing under load (Part XI §196).
- **Scope:** Keystroke→render ≤1 frame (hard); 60fps scroll; GPU tuning; ensure AI/index/agents never breach hot path (INV-1).
- **Features:** Editor stays sacred.
- **Tech reqs:** Input-latency instrumentation; off-thread verification.
- **Dependencies:** 40,265.
- **Risks:** AI overlays regressions → gate B4.
- **Deliverables:** Hot-path hardening.
- **Acceptance:** B4/B5 met even during indexing + agent runs.
- **Testing:** Perf (latency under load).
- **Future expansion:** —

### Phase 270 — Security Fitness Functions *(Complexity: M)*
- **Goal:** Enforce invariants in CI (Part X §190, II §15.3).
- **Scope:** Automated checks: only egress pkg networks; renderer can't import secrets; Postgres tables contain no code columns; no import cycles; hardening flags on.
- **Features:** Invariants can't silently break.
- **Tech reqs:** Fitness-function tests in CI.
- **Dependencies:** 134,107,116.
- **Risks:** Gaps → comprehensive checks + review.
- **Deliverables:** Security fitness functions.
- **Acceptance:** Violations fail CI.
- **Testing:** Fitness tests.
- **Future expansion:** —

### Phase 271 — SAST/SCA/Secret-Scan/Fuzzing Gates *(Complexity: M)*
- **Goal:** Automated security scanning (Part X §184/§190, XII §220).
- **Scope:** SAST (TS+Rust), SCA/dependency + typosquat scan, secret scanning, SBOM; fuzz parsers/IPC/deep-links; gate on criticals/highs.
- **Features:** Continuous security assurance.
- **Tech reqs:** Scanners + fuzzers in CI.
- **Dependencies:** 2.
- **Risks:** Noise → tuned severity gating.
- **Deliverables:** Security scan gates.
- **Acceptance:** New criticals/highs block; SBOM produced.
- **Testing:** CI security jobs.
- **Future expansion:** Bug bounty (Post-1.0).

### Phase 272 — Secrets & Egress Hardening Review *(Complexity: M)*
- **Goal:** Verify the sovereignty core (Part X §177/§183).
- **Scope:** Audit redaction (logs/telemetry/diagnostics), egress allow-list, DPAPI usage, memory hygiene, no-key-in-renderer; targeted tests.
- **Features:** Provable key/code protection.
- **Tech reqs:** Assertion tests + manual review.
- **Dependencies:** 270,107,134.
- **Risks:** Subtle leak paths → thorough audit + tests.
- **Deliverables:** Hardening review + tests.
- **Acceptance:** No secret/code in any sink (tested); egress constrained.
- **Testing:** Security assertion tests.
- **Future expansion:** —

### Phase 273 — RLS & Edge Functions Security Audit *(Complexity: M)*
- **Goal:** Backend security assurance (Part IV §46/§61, X §189).
- **Scope:** Exhaustive pgTAP RLS tests (cross-user/oversize/secret-shaped/config-write); function least-privilege + input validation + rate limits; abuse-control review.
- **Features:** Hardened backend.
- **Tech reqs:** RLS/function test suite (deploy gate).
- **Dependencies:** 116,118,130.
- **Risks:** Rules gaps → negative tests.
- **Deliverables:** Backend security audit.
- **Acceptance:** All negative cases denied; functions least-privileged.
- **Testing:** Rules + function tests (gate).
- **Future expansion:** —

### Phase 274 — Penetration Test & Remediation (GA Gate) *(Complexity: L)*
- **Goal:** Independent security validation (Part X §189/§190).
- **Scope:** Third-party pen test across attack surface (installer/updater/IPC/preload/protocol/loopback/egress/extensions/MCP); remediate criticals/highs.
- **Features:** External assurance.
- **Tech reqs:** Engagement + fix cycle.
- **Dependencies:** 270,271,272,273.
- **Risks:** Findings delay GA → schedule early.
- **Deliverables:** Pen-test report + fixes.
- **Acceptance:** No open criticals/highs at GA.
- **Testing:** Re-test after remediation.
- **Future expansion:** Periodic re-tests.

### Phase 275 — Accessibility Audit & Sign-Off *(Complexity: M)*
- **Goal:** WCAG 2.1 AA validation (Part VI §94, IX §171, XII §219).
- **Scope:** Manual AT passes (NVDA/Narrator/JAWS) on core journeys; keyboard-only; WCAG AA checklist completion + sign-off (with honest manual-testing caveat).
- **Features:** Inclusive product.
- **Tech reqs:** AT test plan; checklist.
- **Dependencies:** 253,254,255.
- **Risks:** Late a11y bugs → early + continuous testing.
- **Deliverables:** A11y audit + fixes.
- **Acceptance:** Core journeys AT-usable; AA checklist complete.
- **Testing:** Manual AT + automated.
- **Future expansion:** Ongoing a11y.

### Phase 276 — Compatibility Matrix Testing *(Complexity: L)*
- **Goal:** Validate across environments (Part XII §224).
- **Scope:** Win 10/11 × x64/ARM64; hardware tiers; GPU/driver variance + software fallback; all providers (contract + live smoke); shells (cmd/pwsh/gitbash/WSL); encodings/languages; locales/RTL; proxy/CA.
- **Features:** Works everywhere targeted.
- **Tech reqs:** Compatibility matrix + runners.
- **Dependencies:** 138–145,73–77.
- **Risks:** Environment surprises → broad matrix.
- **Deliverables:** Compatibility validation.
- **Acceptance:** Green across the matrix (or documented degradations).
- **Testing:** Compatibility suite.
- **Future expansion:** mac/Linux (Epoch K).

### Phase 277 — Recovery, Resilience & Chaos Testing *(Complexity: M)*
- **Goal:** Prove data safety + resilience (Part XII §225).
- **Scope:** Crash/force-kill (each tier), power-loss (atomic writes), interrupted-agent resume, corrupt DB/index recovery, network loss/failover, bad-update rollback, safe mode.
- **Features:** No data loss; graceful recovery.
- **Tech reqs:** Chaos harness; recovery scenarios.
- **Dependencies:** 16,88,209,71,167.
- **Risks:** Hidden loss paths → comprehensive scenarios.
- **Deliverables:** Recovery validation.
- **Acceptance:** All scenarios recover with no data loss.
- **Testing:** Chaos + recovery suite.
- **Future expansion:** —

### Phase 278 — Soak & Reliability Testing *(Complexity: M)*
- **Goal:** Long-run stability (Part XII §226).
- **Scope:** Multi-hour/day sessions with scripted activity; leak detection; crash-free-rate measurement toward ≥99.5%.
- **Features:** Stable over time.
- **Tech reqs:** Soak harness; heap monitoring.
- **Dependencies:** 266.
- **Risks:** Slow leaks → soak + heap diffs.
- **Deliverables:** Soak results.
- **Acceptance:** No leaks/degradation; crash-free target met.
- **Testing:** Soak (long-running).
- **Future expansion:** —

### Phase 279 — Code Signing & Signing Pipeline *(Complexity: M)*
- **Goal:** Trusted, signed artifacts (Part VI §84, X §184).
- **Scope:** EV signing of all executables/installers/updates/native modules/sidecar; HSM/KMS keys on protected CI; timestamping; SmartScreen reputation.
- **Features:** No "unknown publisher"; tamper-proof.
- **Tech reqs:** Signing in CI; key custody.
- **Dependencies:** 2,17.
- **Risks:** Key compromise → HSM + restricted access.
- **Deliverables:** Signing pipeline.
- **Acceptance:** All artifacts signed + timestamped; SmartScreen clean.
- **Testing:** Signature verification.
- **Future expansion:** macOS notarization (Epoch K).

### Phase 280 — Installers (NSIS/MSI/MSIX/winget/Portable) *(Complexity: L)*
- **Goal:** Full distribution (Part VI §83).
- **Scope:** NSIS (consumer, auto-update), MSI/MSIX (enterprise, silent, ADMX), winget manifest, portable ZIP; per-user/per-machine; associations/CLI opt-in; uninstall (keep/remove data).
- **Features:** Install anywhere.
- **Tech reqs:** electron-builder + MSI/MSIX tooling.
- **Dependencies:** 279.
- **Risks:** Installer bugs → matrix tests.
- **Deliverables:** All installers.
- **Acceptance:** Install/upgrade/uninstall across modes; silent MSI works.
- **Testing:** Install matrix.
- **Future expansion:** Store submission.

### Phase 281 — Auto-Update: Delta + Rollout + Rollback *(Complexity: L)*
- **Goal:** Production auto-update (Part VI §86).
- **Scope:** Delta updates; staged percentage rollout (feature flags); health gates (crash-free); kill switch; one-generation rollback; atomic sidecar/schema update; enterprise controls.
- **Features:** Safe fleet updates.
- **Tech reqs:** Delta packaging; rollout controller.
- **Dependencies:** 17,129,279.
- **Risks:** Bad release → gates + kill switch + rollback.
- **Deliverables:** Production updater.
- **Acceptance:** Delta updates; rollout halts/rolls back on regression.
- **Testing:** Integration (rollout/rollback), tamper.
- **Future expansion:** —

### Phase 282 — Crash Recovery Hardening & Safe Mode *(Complexity: M)*
- **Goal:** Bulletproof recovery (Part VI §88).
- **Scope:** Full restore (buffers/tabs/layout/terminal-layout/agent-runs); crash-loop → Safe Mode (disable extensions/GPU); "Recovered your session" UX.
- **Features:** Never lose work.
- **Tech reqs:** Journal completeness; safe-mode path.
- **Dependencies:** 16,48,209,277.
- **Risks:** Unbootable loops → safe mode.
- **Deliverables:** Recovery hardening.
- **Acceptance:** Full restore after kill; safe mode recovers crash loops.
- **Testing:** Recovery suite.
- **Future expansion:** —

### Phase 283 — Diagnostics, Support & Observability Finalization *(Complexity: M)*
- **Goal:** Supportability (Part VI §97, II §23, XIII §264-runbooks).
- **Scope:** Diagnostics bundle (scrubbed, preview-before-send); support self-help (reset caches/rebuild index/safe mode/GPU toggle); SLO dashboards; runbooks (release/rollback/incident/backup/rotation).
- **Features:** Fast support + ops.
- **Tech reqs:** Bundle finalization; dashboards; runbook docs.
- **Dependencies:** 9,23-telemetry,128.
- **Risks:** Secret leakage → scrub tests.
- **Deliverables:** Diagnostics + runbooks.
- **Acceptance:** Bundle scrubbed; runbooks complete; dashboards live.
- **Testing:** Scrub tests + runbook dry-runs.
- **Future expansion:** —

### Phase 284 — Enterprise Deployment *(Complexity: M)*
- **Goal:** Fleet deployability (Part VI §83.3/§96, X §189).
- **Scope:** MSI/MSIX silent deploy (SCCM/Intune/GPO); ADMX managed policy (update control, telemetry off, provider allow-lists, proxy/CA); audit export.
- **Features:** Enterprise-ready.
- **Tech reqs:** ADMX template; managed-config path.
- **Dependencies:** 280,281,131.
- **Risks:** Policy gaps → documented ADMX.
- **Deliverables:** Enterprise deployment.
- **Acceptance:** Silent managed deploy with locked policies works.
- **Testing:** Enterprise deploy sim.
- **Future expansion:** Org control plane (Post-1.0).

### Phase 285 — Beta Program & Release Channels *(Complexity: M)*
- **Goal:** Real-world stabilization (Part VI §82.4, XII §227/§230).
- **Scope:** dev/beta/stable channels (side-by-side); staged rollout; structured feedback + telemetry + crash triage loop; bug-bash + dogfooding.
- **Features:** Data-driven pre-GA stabilization.
- **Tech reqs:** Channels; feedback intake (Phase 43.13/onFeedback).
- **Dependencies:** 281,128,132.
- **Risks:** Beta instability → gated promotion.
- **Deliverables:** Beta program.
- **Acceptance:** Beta runs; feedback/telemetry drive fixes; crash-free healthy.
- **Testing:** Field telemetry + triage.
- **Future expansion:** —

### Phase 286 — GA Release & Launch Readiness *(Complexity: L)*
- **Goal:** Ship Axiom 1.0 (Part XII §230).
- **Scope:** Release sign-off (all gates green: perf/security/a11y/compat/recovery/soak/pen-test); user docs + security whitepaper + site; changelog; staged GA rollout + monitoring; hotfix path ready.
- **Features:** **Production launch.**
- **Tech reqs:** Release checklist; monitoring; docs/site.
- **Dependencies:** 265–285.
- **Risks:** Launch regressions → staged rollout + rollback + monitoring window.
- **Deliverables:** **Axiom 1.0 GA.**
- **Acceptance:** All release gates pass; GA rolled out; SLOs/crash-free healthy post-release.
- **Testing:** Full release-gate suite + post-release monitoring.
- **Future expansion:** Post-1.0 roadmap (Epoch K).

**Epoch J Exit Criteria (GA):** Axiom 1.0 is production-ready — performance budgets enforced (incl. hot-path, large-repo, large-file), security hardened and independently pen-tested with invariant fitness functions, accessibility/compatibility/recovery/soak audits passed, signed installers (NSIS/MSI/MSIX/winget/portable) with delta staged auto-update + rollback, bulletproof crash recovery + safe mode, finalized diagnostics/observability/runbooks, enterprise deployment, a beta-validated build, and a monitored GA rollout. **Milestone: General Availability (Axiom 1.0).**

---

*Part XIV continues in the final installment (Epoch K — Post-1.0 Groundwork & Cross-Platform, Phases 287–290).*


## EPOCH K — POST-1.0 GROUNDWORK & CROSS-PLATFORM (Phases 287–290)

*Objective: stabilize the GA release and lay non-breaking groundwork for the Year-2/3 horizon (Part I §2.4) — team/enterprise, cross-platform, remote/cloud, and a continuous-improvement engine. These phases begin after GA and are scoped as directional; the 1.0 architecture already accommodates them (interfaces, abstractions, reserved schema).*

### Phase 287 — Post-GA Stabilization & Feedback Loop *(Complexity: M)*
- **Goal:** Harden the live product from real-world signal.
- **Scope:** Monitor SLOs/crash-free/error rates/AI accept-revert; triage top field issues; fast-tracked hotfixes; telemetry-driven prioritization; expand eval suite from real failures.
- **Features:** A tight measure→fix loop post-launch.
- **Tech reqs:** Dashboards + triage process + hotfix channel (Part XII §230/§231).
- **Dependencies:** 286.
- **Risks:** Regression whack-a-mole → root-cause + regression tests (bug→test).
- **Deliverables:** Stabilization cycle + expanded evals.
- **Acceptance:** Field SLOs healthy and trending up; top issues resolved; no escaped-defect backlog growth.
- **Testing:** Field monitoring + regression suite.
- **Future expansion:** Continuous-improvement engine (Phase 290).

### Phase 288 — Team & Enterprise Groundwork *(Complexity: XL)*
- **Goal:** Enable the enterprise/team horizon without a rewrite.
- **Scope:** Org/team data model + roles (owner/admin/member); enterprise SSO (SAML/OIDC) + SCIM behind `IAuthService`; shared workspace rules/prompts/custom agents; org policy (allowed providers, telemetry, update control) + audit export; self-hosted/region-pinned backend prep behind `IBackendService`.
- **Features:** Team collaboration + enterprise control (directional).
- **Tech reqs:** Reserve org id/role in schema (already noted, Part III §36); provider abstraction; policy plane.
- **Dependencies:** 106,116,233,235,284.
- **Risks:** Scope explosion → phased Post-1.0 delivery; keep 1.0 single-user intact.
- **Deliverables:** Enterprise/team groundwork.
- **Acceptance:** Org model + SSO + shared artifacts + policy demonstrable in a Post-1.0 branch without breaking 1.0.
- **Testing:** Integration (org/SSO), security (policy/rules).
- **Future expansion:** Full team features, org control plane, compliance certs (SOC 2/ISO 27001).

### Phase 289 — Cross-Platform & Remote Development Groundwork *(Complexity: XL)*
- **Goal:** macOS/Linux + remote dev via existing abstractions.
- **Scope:** Implement PAL for macOS (Keychain/FSEvents/forkpty/notarization) + Linux (libsecret/inotify/forkpty; AppImage/deb/rpm); Tauri-shell evaluation via `IShell`; remote/SSH/container dev; cloud-agent-execution prep; extension marketplace maturation.
- **Features:** Beyond Windows-desktop-only (directional).
- **Tech reqs:** PAL implementations (Part II §18); packaging per OS; remote transport.
- **Dependencies:** 7,5,238,101,243.
- **Risks:** Platform parity effort → PAL isolates most work; phase by OS.
- **Deliverables:** Cross-platform + remote groundwork.
- **Acceptance:** A macOS/Linux build boots + edits via PAL impls (alpha); remote-dev prototype works.
- **Testing:** Cross-platform + remote integration.
- **Future expansion:** Full mac/Linux GA; cloud agents; remote-first workflows.

### Phase 290 — Continuous Improvement Engine & Long-Term Roadmap *(Complexity: M)*
- **Goal:** Institutionalize ongoing quality + model/feature velocity.
- **Scope:** Eval-driven model/prompt update cadence (regression-gated); rapid new-provider/model onboarding process; novel-feature pipeline (multi-model, ambient, autopilot maturation); community/feedback + roadmap governance; ADR/doc upkeep.
- **Features:** A durable engine for staying ahead.
- **Tech reqs:** Eval harness cadence (Part V §79, XII §217); feature-flag experiments; roadmap process.
- **Dependencies:** 200,238,287.
- **Risks:** Model/API churn → adapters + evals + capability gating already in place.
- **Deliverables:** Improvement engine + governed roadmap.
- **Acceptance:** New models/providers onboard quickly (eval-gated); prompt/model changes ship safely via evals + rollout.
- **Testing:** Eval cadence + rollout monitoring.
- **Future expansion:** The living Year-2/3 roadmap (Part I §2.4).

**Epoch K Exit Criteria:** GA is stabilized on real-world signal, and non-breaking groundwork exists for the enterprise/team, cross-platform, remote/cloud, and continuous-improvement horizons — all enabled by the 1.0 architecture's interfaces, abstractions, and reserved schema. Axiom is positioned to grow into one of the world's leading AI IDEs without a rewrite.

---

## PART XIV — SUMMARY & PHASE INDEX

**Total phases: 290**, across 11 epochs, progressing foundation → GA → beyond:

| Epoch | Theme | Phases | Count | Milestone |
|---|---|---|---|---|
| A | Foundation & Tooling | 1–20 | 20 | Chassis |
| B | Core Workbench & Editor | 21–48 | 28 | Standalone editor |
| C | Rust Core Engine & Indexing | 49–72 | 24 | Code understanding |
| D | Developer Tooling (Terminal/Git/LSP/Debug) | 73–104 | 32 | **Internal Alpha** |
| E | Identity & Backend (Supabase) | 105–132 | 28 | Cloud plane |
| F | AI Engine | 133–170 | 38 | Inference foundation |
| G | Core AI Features | 171–200 | 30 | **AI-capable (private beta)** |
| H | Agentic & Advanced AI | 201–238 | 38 | **Feature-complete AI (public beta cand.)** |
| I | Extensions, Themes, i18n, A11y, Novel AI | 239–264 | 26 | **Feature-complete (public beta)** |
| J | Hardening, Performance, Security & Release | 265–286 | 22 | **GA — Axiom 1.0** |
| K | Post-1.0 Groundwork & Cross-Platform | 287–290 | 4 | Beyond 1.0 |

**Sequencing logic:** shell → editor → understanding → tooling (alpha) → identity → AI engine → AI features (beta) → agents → ecosystem/polish → hardening (GA) → beyond. Each epoch ends in a demonstrable, shippable increment; dependencies flow forward; the editor hot path and the sovereignty/security invariants are protected at every phase. Complexity mix (S/M/L/XL) supports realistic planning and parallelization across the council's DRIs (Part XIII §235 dependency map).

---

# END OF MASTER PRD — AXIOM (Think. Build. Ship.)

This document specifies Axiom 1.0 end to end: **Part I** (product foundation), **Part II** (system architecture + ratified ADRs + invariants), **Parts III–X** (authentication, data/backend, AI engine, desktop app, IDE core, AI features, UX, security), **Parts XI–XIII** (performance, quality/testing, per-subsystem documentation), and **Part XIV** (the 290-phase execution plan). It is designed to be built incrementally, honors its core invariants (single egress, secrets local, no user code in the cloud, editor-never-blocks), and positions Axiom to become one of the world's leading AI-native IDEs — with the user's sovereignty over providers, data, and cost as its defining, durable advantage.

*Document status: Complete (v1.0.0 baseline). Living document — maintained via ADRs, subsystem dossiers, and the phase plan.*
