# AXIOM EXE — Windows x64 build, sign, and release guide

This is the authoritative Windows 10/11 **x64** NSIS workflow. ARM64 is not configured.
Artifacts are written to `AXIOM EXE/dist`; packaging never uploads them.

## Build-machine prerequisites

Use a controlled Windows x64 machine with:

- Node.js 20 compatible with `package-lock.json`
- the exact Rust toolchain in `rust-toolchain.toml`
- Visual Studio Build Tools with **Desktop development with C++**
- Python 3
- approved CA-backed signing credentials for any public build

Do not make an agent install system packages, elevate, enable Developer Mode, or change
security policy without explicit authorization.

## Local/internal unsigned package

An unsigned package must be explicitly requested:

```powershell
./build-axiom-exe.ps1 -AllowUnsigned
```

The CMD wrapper accepts the same switch:

```bat
build-axiom-exe.cmd -AllowUnsigned
```

For a faster already-installed-worktree build, the underlying command is:

```powershell
npm.cmd run package --workspace apps/desktop
```

Unsigned output is only for local testing or controlled internal use. SmartScreen,
Defender, or enterprise policy may warn or block it. It has no verified publisher identity;
do not publish or describe it as production-trusted.

## Signed public-release gate

Before a public build:

1. Start from a reviewed clean checkout with no staged, unstaged, untracked, or ignored
   credentials.
2. Revoke/rotate the previously exposed GitHub OAuth client secret and remove its ignored
   local artifact. Device Flow uses only the public client ID.
3. Set `CSC_LINK`, `CSC_KEY_PASSWORD`, `AXIOM_SIGNER_SHA1`, and `AXIOM_SIGNER_SUBJECT`
   from approved secret storage. Direct npm package commands remain unsigned and are not a
   substitute for this dedicated release workflow.
4. Run without `-AllowUnsigned`:

```powershell
./build-axiom-exe.ps1
```

The script fails closed if signing credentials are incomplete/absent, the Git worktree is
not clean, or the known ignored credential artifact remains. It uses `npm ci`, builds the
native core with the pinned toolchain and `--locked`, runs TypeScript and all four focused
validators (including `validate:god-mode`), packages through the configured x64 electron-builder path, verifies checksum
sidecars, and requires valid Authenticode signatures in signed mode.

The GitHub workflow is also x64-only and signing-required. It uses the lockfile and package
scripts; it does not use `npx --yes`, `--no-save` dependencies, or a duplicate native rebuild.

## Produced artifacts

A full package normally includes:

- `AXIOM-Setup-<version>-x64.exe`
- installer blockmap/update metadata
- basename-only `.sha256` sidecars generated atomically by the release hook
- `win-unpacked/` for package inspection and clean-machine smoke work

The builder has no `publish.url` or generic publish provider.

## Security verification

For a public release, code-sign and timestamp the app, shipped native executables, and final
installer. Verify every signature, chain, digest, and trusted timestamp after packaging and
after download. Test install/uninstall, first launch, terminal/ConPTY, GitHub Device Flow,
Git askpass, bundled language servers, declarative extension behavior, executable-extension
rejection, and updater behavior on a clean Windows x64 VM.

`RunAsNode` remains enabled for two Main-supervised subprocess paths: operation-scoped Git
askpass and bundled language-server CLIs. Executable extension entry points remain disabled
and do not spawn a Node child. `RunAsNode` is still a broader same-user local execution
surface and remains documented residual risk until both reachable consumers move to a
separate validated runtime or are re-architected.

SHA-256 sidecars are checksums, **not signatures**. ASAR and minification are not secrecy or
authenticity controls. Local administrator compromise is outside the threat model. Complete
every item in `docs/release-hardening.md` before public distribution.

## Publishing an update

Publication is a separate authenticated operation:

1. Upload the final signed/timestamped x64 installer, metadata, and checksum sidecars through
   an approved authenticated channel.
2. Insert the verified release through the Supabase dashboard/service role into
   `public.app_releases` with `channel`, `latest_version`, `minimum_supported_version`,
   `update_type`, `release_notes`, a credential-free direct HTTPS `download_url`, the final
   installer `checksum`, and `size_bytes`.
3. Download the artifact again and verify URL, size, checksum, signature, certificate, and
   timestamp before making the row newest. Never make a missing or unverified artifact
   mandatory.

Blockmaps may be retained as release artifacts, but generic `latest.yml` metadata from a
previous publisher configuration is removed before packaging. The hardened updater uses the
validated Supabase `app_releases` installer URL, size, and SHA-256; no electron-builder
publisher/feed is configured.
