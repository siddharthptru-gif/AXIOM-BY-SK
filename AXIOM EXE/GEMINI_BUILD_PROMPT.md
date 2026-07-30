# AXIOM Windows x64 packaging handoff

This file intentionally contains no alternate build recipe. The authoritative process is
`AXIOM EXE/BUILD.md`, implemented by `build-axiom-exe.ps1` and
`apps/desktop/electron-builder.yml`.

Rules for any build agent:

- Target Windows x64 only. Do not claim or generate ARM64 artifacts.
- Do not install system packages, enable Developer Mode, elevate privileges, alter signing
  policy, or transmit source/secrets without explicit user approval.
- Use `npm ci` and the committed lockfile; never use `npx --yes`, `--no-save` dependencies,
  or a duplicate manual native-rebuild/package path.
- Build the native core with the committed pinned Rust toolchain and `--locked`.
- Run desktop type checks and all four focused validators before packaging.
- Let the configured electron-builder package command rebuild `node-pty` and apply the
  ASAR-integrity/fuse/artifact-hash hooks. Direct npm package commands are always unsigned.
- For a public signed build, set approved `CSC_LINK`, `CSC_KEY_PASSWORD`,
  `AXIOM_SIGNER_SHA1`, and `AXIOM_SIGNER_SUBJECT`, then run
  `./build-axiom-exe.ps1` without `-AllowUnsigned`. This is the only signed-build path.
- A public artifact requires approved CA-backed signing credentials, trusted timestamping,
  post-build signature verification, and the full release checklist.
- For an explicitly requested local/internal unsigned package, use
  `./build-axiom-exe.ps1 -AllowUnsigned`. Such output is not public-release trusted.
- GitHub Device Flow uses only the approved public client ID. Never read, copy, use, print,
  or package a confidential OAuth client secret; revoke/rotate the previously exposed one.
