# Release hardening checklist

This checklist is a release gate for Axiom `1.0.5` / Electron `33.2.0`, not a claim that a local package is publishable.

## Before building

- [ ] Build from a reviewed, clean checkout with no staged, unstaged, untracked, or ignored credentials and with network/dependency inputs recorded. Reinstall from the committed lockfile (`npm ci`) using an approved Node version compatible with `@electron/fuses@2.0.0`.
- [ ] Confirm root, desktop, and shared package versions are exactly `1.0.5`; Electron manifest/lockfile and `electronVersion` are exactly `33.2.0`; NSIS remains Windows x64; and `apps/desktop/build/logo.png` matches the approved logo.
- [ ] Confirm GitHub Device Flow is enabled with only the public client ID. Revoke/rotate the previously exposed GitHub client secret and verify no confidential OAuth field or secret is present in source, environment templates, artifacts, logs, or release metadata.
- [ ] Run dependency provenance/license review, vulnerability scan, and SBOM generation. Review all exceptions, especially native `node-pty`, Electron, updater, installer, and build tooling.
- [ ] Run the node/web TypeScript checks and `validate:security-hardening`, `validate:god-mode`, `validate:github-scm`, and `validate:agentic-chat`. Run the production build and all targeted tests from a clean dependency install.

## Bundle and package

- [ ] Verify production Main, preload, and renderer bundles are minified, deterministic for identical inputs, contain no `debugger` statements, and emit no `.map` files. Confirm structured logging was retained and no secrets or workspace/provider payloads appear in output.
- [ ] Inspect the electron-builder file list: ASAR enabled, maximum compression, only compiled output/manifest plus required production dependencies, no source maps/tests/debug fixtures/scripts/source, only rebuilt Windows x64 runtime `.node`/`.dll`/helper `.exe` files from `node-pty` unpacked (its JavaScript remains in ASAR), no other platform/architecture or build baggage, and only the native `axiom-core.exe` extra resource.
- [ ] Confirm no generic/placeholder publish target exists. Generate update metadata only for the approved authenticated release destination.
- [ ] Package on the controlled Windows release runner. The native core input must exist and be built from the reviewed source; do not substitute an unreviewed binary.
- [ ] Verify the after-pack hook ran and read the actual packaged executable fuse wire: `RunAsNode=true` (documented Main-supervised subprocess exception for operation-scoped Git askpass and bundled language-server CLIs; executable extension entry points remain disabled), cookie encryption enabled, Node options and CLI inspect disabled, embedded ASAR integrity and ASAR-only loading enabled, browser V8 snapshot disabled, and extra `file:` privileges disabled.
- [ ] Inspect `resources/app.asar`, its header/block integrity, and the packaged executable. Electron 33 supports Windows ASAR integrity only when the PE contains a valid `INTEGRITY` resource named `ELECTRONASAR`. Pinned electron-builder 24.13.3 does not add this Windows resource automatically; confirm the custom after-pack hook computed the ASAR JSON-header hash, embedded the official payload, read it back byte-for-byte, and then verified the fuse wire. Independently recheck the resource after signing and fail the release if it is absent or mismatched.

## Signing and artifact verification

- [ ] Direct npm package commands remain unsigned. For a signed release, set `CSC_LINK`, `CSC_KEY_PASSWORD`, `AXIOM_SIGNER_SHA1`, and `AXIOM_SIGNER_SUBJECT` from approved secret storage and run `AXIOM EXE/build-axiom-exe.ps1` without `-AllowUnsigned`.
- [ ] Code-sign only inside the dedicated boundary: keep signing credentials out of `npm ci`, Cargo, all validators, electron-vite, electron-builder, dependency lifecycle scripts, `afterPack`, and `afterAllArtifactBuild`. Build the unpacked application with `--config.win.sign=null`; only `AXIOM EXE/sign-release-artifacts.ps1` may receive `CSC_LINK`, `CSC_KEY_PASSWORD`, `AXIOM_SIGNER_SHA1`, and `AXIOM_SIGNER_SUBJECT`.
- [ ] Require `CSC_LINK` to be a local PFX path or base64 PFX bytes—never a remote URL—and pin both the certificate SHA-1 thumbprint and exact subject. The dedicated boundary must sign only the exact bounded `win-unpacked` native inventory with SHA-256 and the fixed RFC3161 endpoint, then verify valid Authenticode status, signer identity, SHA-256, and a timestamp certificate for every target.
- [ ] Run `verify-packaged-runtime.cjs` after application signing. It must independently recheck the ASAR and exact unpacked native inventory, `ELECTRONASAR` resource, complete fuse wire, and a bounded packaged `--version` launch with a positive environment allowlist.
- [ ] Assemble unsigned NSIS from the already-signed unpacked app with `--prepackaged` and `--config.win.sign=null`, so installer assembly and project hooks receive no certificate or password. Sign exactly one `AXIOM-Setup-1.0.5-x64.exe` in the dedicated boundary, then repeat signature checks and packaged-runtime verification after assembly/signing.
- [ ] Verify every signature, exact certificate subject/thumbprint and chain, SHA-256 digest algorithm, trusted timestamp/countersignature, and timestamp authority in a credential-free final step. Confirm neither installer assembly nor upload invalidated an application signature.
- [ ] Generate SHA-256 sidecars only after final application and installer signatures and after all installer, blockmap, and update metadata artifacts exist. Confirm every uploaded artifact class has a matching sidecar containing the digest of the final byte-for-byte artifact and only its basename.
- [ ] Treat sidecars as checksums, not signatures. Unsigned/local builds and hashes alone do not establish publisher authenticity; authenticity comes from a protected signing key, validated certificate/timestamp, and trusted distribution channel.
- [ ] Confirm update metadata URLs, version, size, and SHA-256 match the signed installer; redirects are not required; no URL credentials or secrets are embedded; downgrade and minimum-version policy are correct; and mandatory policy cannot point to a missing artifact.

## Clean-machine acceptance

- [ ] Install on a clean supported Windows x64 VM with no development tools or repository checkout. Verify SmartScreen/signature presentation, installer wizard, install/uninstall, shortcuts, first launch, restart, and retained/deleted data behavior.
- [ ] Smoke-test packaged startup with networking offline and online. A missing/incorrect Windows `ELECTRONASAR` resource with the integrity fuse enabled must fail this test and block release; a successful hook log does not replace this launch test.
- [ ] Verify the production menu is absent; DevTools cannot open by F12 or Ctrl+Shift+I/J/C; ordinary editor shortcuts still work; renderer downloads/devices/permissions are denied; external HTTPS links work; HTTP/non-web/credential-bearing links fail; and the fixed GitHub verification link opens only from Main.
- [ ] Exercise Device Flow connect/cancel/disconnect, OS-encrypted credential persistence, Git fetch/push askpass cleanup, workspace trust, Safe Edit/checkpoints/restore, dirty-buffer close/mutation guards, approval rejection, cancellation, and child-process shutdown.
- [ ] Test update check/download with valid bytes, wrong hash, wrong/oversized content length, streaming overflow, timeout, TLS failure, redirect, superseded plan, disk failure, and installer replacement. Only a current regular file with the expected size and SHA-256 may execute.
- [ ] Verify blockmap/update metadata and their sidecars from the final upload location, then repeat signature and digest checks after download.

## Release record and limitations

- [ ] Archive the source revision, lockfile, SBOM, dependency scan, tool/runner versions, build logs, fuse report, ASAR/PE-resource report, signature/timestamp verification, artifact digests, updater metadata, and clean-VM results without secrets.
- [ ] Record known limitations: `RunAsNode` remains enabled for two Main-supervised subprocess paths—operation-scoped Git askpass and bundled language-server CLIs—and therefore remains a broader same-user local execution surface until a separate runtime or re-architecture replaces both; executable extension entry points remain disabled and do not spawn Node children; Electron 33 Windows integrity requires independently verified PE metadata; cancellation cannot undo completed external effects; checkpoints are not backups; and local administrator compromise is out of scope.
- [ ] State in release notes that ASAR/minification do not hide code and that checksums do not replace code signing. Do not describe an unsigned package, fuse state, ASAR, or SHA-256 sidecar as proof of publisher identity.
