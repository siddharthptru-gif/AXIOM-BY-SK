# Axiom security architecture

## Scope and threat model

Axiom is a local-first Electron IDE that opens developer-controlled workspaces and can invoke tools, Git, language servers, terminals, extension hosts, AI providers, synchronization, and updates. The design assumes workspace files, repository metadata, model/provider output, extension manifests, MCP responses, web links, and network responses may be malicious. Opening or trusting a workspace does not make its contents safe. The application protects its own process boundaries and asks Main to authorize sensitive effects; it does not claim to contain arbitrary native tools after the user approves them.

The model addresses renderer compromise, malicious workspace paths and symlinks, forged IPC, credential disclosure through renderer APIs or logs, unintended Git destinations, update corruption, and accidental release misconfiguration. It assumes the OS security boundary, Electron/Chromium sandbox, TLS implementation, dependency supply chain, release backend, and code-signing keys have not already been compromised. A local administrator can modify installed files, processes, trust stores, or application data and is out of scope.

## Process and data trust boundaries

- **Main is the authority.** It owns filesystem, process, Git, credential, update, network, dialog, and OS integration. Main revalidates IPC arguments, renderer ownership, workspace trust, path containment, expected file identity, and operation state at the point of use. Network functions with secrets or executable downloads remain in Main.
- **Preload is a narrow bridge.** It uses context isolation and exposes explicit IPC methods rather than Node primitives. It is not a second authority: Main still validates every request. Credential material is not returned to preload or renderer.
- **Renderer is untrusted UI.** It runs with sandboxing and context isolation, `nodeIntegration: false`, `webSecurity: true`, and production DevTools disabled. Production navigation is limited to the exact renderer URL including query and fragment. New windows, downloads, permissions, device selection, and non-approved navigation are denied. Production external browsing is HTTPS-only and credential-bearing URLs are rejected; development additionally permits loopback HTTP for local tooling.
- **Native core and supervised child processes are privileged dependencies.** The release packages only the required core executable outside ASAR and the native `node-pty` files required for loading. Main bounds protocols and owns lifecycle termination, but a user-approved terminal or tool has the user's OS privileges.

The production CSP starts from `default-src 'none'`, allows only local scripts and connections, permits the inline styles and local/blob workers Monaco requires, and denies objects, frames, children, forms, and media. Development has a separate policy for Vite HMR and local sourcemaps.

`script-src` is `'self' 'wasm-unsafe-eval'`. The second token is required by the TextMate highlighting engine, whose regular-expression matcher is the Oniguruma WebAssembly module — the same engine VS Code uses, and without which grammar-based highlighting from extensions cannot run. Chromium treats WebAssembly compilation as a capability distinct from `eval`: `'wasm-unsafe-eval'` permits compiling and instantiating WebAssembly and nothing else, so `eval`, `new Function`, inline scripts, and scripts from other origins all remain denied and are asserted absent by the release gate. The WebAssembly module ships inside the application bundle and is fetched same-origin; it is never downloaded, and extension packages cannot supply one. Grammar files themselves are read by Main, addressed by scope name rather than by path, and reach the renderer as text.

## Extensions and the extension host

Two extension systems exist and they are not the same thing. AXIOM's own native extensions are declarative only: executable extension entry points are rejected, and that path has no dormant process launcher. Extensions installed from the Open VSX registry are a separate subsystem, and those do run code.

Running that code is a privilege grant, described here in the terms the consent prompt uses. An extension host is a `utilityProcess` — a real Node process with the user's own OS privileges. It can read and write files and reach the network through Node directly. The request set the `vscode` shim offers bounds what the _API_ provides; it does not sandbox Node, and nothing in this document should be read as claiming otherwise. This is the same trust model VS Code asks users to accept, stated plainly rather than implied.

What is enforced:

- **Consent is per extension and precedes the first process.** Installing a package is not permission to execute it. The decision is recorded as granted or denied, so a refusal is not re-asked, and it is removed when the extension is uninstalled.
- **One process per extension.** A crash, hang, or runaway allocation is contained to the extension that caused it, attributable to it, and restarted without touching the others. Restarts are bounded by a single pure policy — three crashes inside three minutes with backoff, after which AXIOM stops restarting and asks the user whether to disable it.
- **`utilityProcess.fork` is the only launcher.** Not `child_process`, not a re-launch of the packaged binary under `ELECTRON_RUN_AS_NODE`, and never a worker inside a renderer. The release gate asserts the packaged bundle retains this launcher and that the supervisor has no second one, because the alternatives would either widen the RunAsNode surface the fuse policy describes or place extension code in the process that owns the DOM and the IPC bridge.
- **The worker reaches nothing directly.** It imports no Electron, has no `BrowserWindow`, no `webContents`, and no `ipcRenderer`. Its only outward path is a closed, enumerable request set, each message parsed and each payload validated before Main acts.
- **Effects are re-checked at the point of use.** File reads and writes go through the same workspace path authorization as any renderer request, external URLs through the same HTTPS-only policy, and writes and deletions are audited.
- **Secrets are not exposed.** `ExtensionContext.secrets` and settings writes are refused rather than emulated, and an extension reads only its own configuration keys plus a small editor set — never the provider, account, or telemetry settings.
- **Unimplemented API members fail loudly.** Reaching one throws an error naming the member instead of returning a value the extension will act on.

## Workspace trust and untrusted content

Workspace trust is an authorization decision, not content verification. Restricted workspaces must not gain mutation, process, extension, workflow, MCP, Git, or provider authority merely because their text is displayed. Path authorization canonicalizes existing paths and mutation candidates, checks the trusted root again immediately before effects, and rejects traversal, root changes, and unsafe destinations. Symlinks and replacement races remain OS-level concerns and are handled where possible with identity checks and point-of-use revalidation.

Prompts, model responses, diagnostics, repository text, and provider payloads are data. They cannot grant approval or bypass policy. Users should review workspace rules, extension code, workflows, MCP servers, shell commands, and generated edits before granting trust or approval.

## Safe Edit, checkpoints, and dirty buffers

Safe Edit stages a plan against current file state and expected hashes, validates paths in Main, serializes file mutations, revalidates immediately before commit, and uses atomic replacement where supported. Checkpoints capture content-addressed file snapshots before approved changes and support guarded restoration. They improve recovery but are not a backup service; users still need source control and external backups.

Renderer dirty-buffer state is registered per window and workspace. Main blocks protected mutations when unsaved editor buffers would be bypassed, and close guards require the user to resolve dirty state. Dirty-buffer tracking cannot protect changes made by unrelated external processes and does not replace file identity revalidation.

## Approvals and cancellation

High-risk or mutating agent actions require the policy-selected approval. Approval tokens are operation-scoped, bound to the owning renderer and current request, and settled once. Previewing a proposed edit is not approval to execute a different command or destination. Main rechecks trust, paths, file state, and ownership after approval.

Cancellation aborts active network/agent work, invalidates pending approval, and drains owned process trees during shutdown. Cancellation is cooperative until Main terminates a child process; an external process may already have completed an effect before cancellation arrives. The UI must report this honestly rather than implying rollback.

## Credentials, GitHub, and Git destinations

GitHub authentication uses OAuth Device Flow with the fixed public client ID. There is no confidential client-secret field, endpoint override, renderer token API, or browser callback listener. Main opens only GitHub's fixed verification URL. Device and access responses are bounded, time-limited, redirect-denied, ownership-checked, and sanitized. Credentials are validated before persistence and stored in Main's encrypted auth store using Electron `safeStorage`; if OS encryption is unavailable, persistence fails closed.

System Git receives credentials only through an operation-scoped askpass broker. The broker uses an unpredictable local pipe, a nonce, two strictly ordered prompts, request and time limits, a minimal environment, disabled credential helpers/hooks, and cleanup after the operation. The packaged Electron executable currently remains usable as Node (`RunAsNode: true`) for two Main-supervised subprocess paths: the operation-scoped Git askpass helper and bundled language-server CLIs resolved from packaged dependencies. Renderer code receives no API to invoke this mode. Executable extension entry points are rejected; only declarative extension contributions are enabled, so the disabled extension-host lifecycle API does not spawn Node children. Nevertheless, `RunAsNode` is a broader same-user local execution surface, not an askpass-only capability. Disabling it requires shipping and validating a separate runtime or re-architecting both reachable consumers; until then it is an explicit residual risk.

Git remote names, branch refs, GitHub clone/remote URLs, and fetch/push destinations are canonicalized and revalidated. Pushes use explicit source and destination refspecs and do not silently follow `pushRemote` or stale upstream configuration. Repository publication records partial-failure recovery stages rather than pretending an irreversible remote action was rolled back.

## IPC, logging, and networking

IPC channels have bounded schemas and sender/owner checks. Main authorizes workspace roots, document URIs, mutation paths, and operation capabilities; preload only forwards typed requests. Permission and device APIs are default-deny.

The shared logger redacts secret-shaped keys, URL userinfo, credential query parameters, authorization schemes, common provider/GitHub tokens, and JWT-shaped values. Production fatal, rejection, startup, shutdown, and window-load diagnostics use fixed event text and classifications/counts rather than stacks, absolute internal paths, credential URLs, arbitrary rejection strings, or provider payloads. Development may retain richer diagnostics. Redaction is defense in depth: callers must still avoid logging workspace contents and secrets.

AI, synchronization, GitHub, release policy, and updates are separate Main-owned network paths. Requests use fixed or validated HTTPS destinations, bounded bodies/timeouts, redirect policy, and sanitized errors as appropriate. The updater accepts credential-free HTTPS artifact URLs from validated release metadata, rejects redirects, enforces declared and absolute byte limits plus a timeout, streams into a private temporary file, verifies SHA-256 and optional size from bytes read back from disk, rechecks file type/size/hash immediately before a synchronous installer launch, and never delegates executable download to renderer content.

## Dependencies and release integrity

Dependencies are lockfile-resolved and reviewed/scanned before release. Native modules are rebuilt for Electron's ABI. Production bundles omit source maps and debugger statements, use a narrow packaging allowlist, and pack code into ASAR except the rebuilt Windows x64 `node-pty` runtime `.node`/`.dll`/helper `.exe` files. `node-pty` source, scripts, symbols, build intermediates, duplicate prebuilds, and other platform/architecture payloads are omitted. Electron fuses disable Node options and CLI inspect, enable cookie encryption, enforce ASAR-only app loading, remove extra `file:` privileges, and enable embedded ASAR integrity validation; the hook reads the packaged executable fuse wire back and fails on mismatch.

Electron 33 supports ASAR integrity on Windows, but it requires an `INTEGRITY`/`ELECTRONASAR` PE resource containing the packaged ASAR header hash. The pinned electron-builder 24.13.3 computes ASAR integrity data for macOS but does not automatically embed that Windows resource. A custom after-pack step therefore hashes the bounded ASAR JSON header, writes the official resource payload through the Windows resource API, reads it back byte-for-byte, then flips and verifies the fuses. This bridge must run before code signing; release engineering must independently inspect the resource after packaging/signing and reject any package that fails a clean Windows launch. A fuse bit or successful hook alone is not proof of publisher authenticity or an adequate smoke test. Both the app executable and installer must be code-signed and timestamped. ASAR and minification are packaging/inspection barriers, not secrecy or authenticity controls.

Release SHA-256 sidecars are generated only for selected installer, blockmap, and update metadata artifacts, with containment checks, regular-file checks, size/path bounds, and atomic writes. They are checksums, not signatures, and must be distributed over a trusted authenticated channel or compared against independently trusted values.

## Data locations and retention

On Windows, Main stores application state under Electron's `userData` directory (normally below `%APPDATA%` for AXIOM). This includes settings, keybindings, layouts, recents, conversations, prompts, memories, run journals, audit/telemetry buffers, encrypted auth/secrets stores, workspace-trust decisions, extension state, checkpoints under `snapshots`, and verified update downloads under `updates/download`. Workspace-specific settings, rules, extensions, or registry data may exist under the opened workspace's `.axiom` directory. Git metadata remains in the workspace repository. Provider and sync services receive data only according to configured features, consent, and egress policy.

Uninstall settings may retain application data. Users should sign out/disconnect accounts, remove provider credentials through the UI, and delete the Electron `userData` directory when they require local erasure; workspace `.axiom` data and repository history must be handled separately. OS backups, roaming profiles, crash dumps, provider retention, and remote Git history may retain copies outside Axiom's control.

## Limitations and non-guarantees

Axiom cannot guarantee that generated code is correct or safe, that cancellation reverses completed effects, that checkpoints replace backups, or that trusted tools/extensions are benign. TLS and SHA-256 protect transport/integrity only within their trust assumptions. Unsigned/local builds and hashes alone do not establish publisher authenticity. ASAR/minification do not hide code. A compromised administrator, OS, build runner, dependency, signing key, release backend, provider account, or user-approved native process can defeat application controls.
