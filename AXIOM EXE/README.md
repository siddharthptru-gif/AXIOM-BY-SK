# AXIOM EXE — Windows x64 release kit

This folder contains the Windows 10/11 **x64** NSIS workflow. ARM64 is not configured.
Generated artifacts land in `dist/`; `apps/desktop/electron-builder.yml` is the authoritative
package configuration and contains no upload destination.

## Build modes

- **Local/internal unsigned:** `./build-axiom-exe.ps1 -AllowUnsigned`
- **Public signed:** set approved `CSC_LINK`, `CSC_KEY_PASSWORD`, `AXIOM_SIGNER_SHA1`, and
  `AXIOM_SIGNER_SUBJECT`, use a reviewed clean checkout with no credential artifacts, then run
  `./build-axiom-exe.ps1` without the switch. Direct npm package commands are always unsigned.
- `build-axiom-exe.cmd` is only a thin wrapper around that same PowerShell path
- GitHub CI is x64-only, lockfile-based, and refuses to emit an unsigned release artifact

The workflow builds the pinned native core, runs TypeScript and focused validators, lets
configured electron-builder rebuild the native terminal module, applies ASAR integrity/fuses,
and generates SHA-256 sidecars. There is no duplicate `npx --yes` or `--no-save` build path.

## Trust and limitations

Unsigned output is for local testing or controlled internal use. SmartScreen, Defender, or
organization policy may warn or block it. An unsigned binary and SHA-256 checksum do not
prove publisher identity or trusted update provenance.

A public release requires CA-backed code signing and trusted timestamping of the app, shipped
native executables, and installer, plus clean-machine acceptance and post-download signature
and hash verification. ASAR/minification do not hide code. Local administrator compromise is
outside the application threat model.

The packaged Electron runtime retains `RunAsNode` for Main-supervised Git askpass and bundled
language servers. Executable extension entry points remain disabled and do not spawn Node
children. `RunAsNode` is still a broader same-user local execution surface and a documented
residual risk—not an askpass-only fuse exception.

## Updates

The app reads the newest valid Supabase `public.app_releases` row for its channel. That row
supplies the credential-free direct HTTPS installer URL, version, policy, byte size, and
SHA-256. Upload is a separate authenticated step; never point a mandatory row at a missing,
unsigned, or unverified artifact.

See `BUILD.md`, `../docs/release-hardening.md`, and `../SECURITY.md`.

| Path                  | Purpose                                                             |
| --------------------- | ------------------------------------------------------------------- |
| `BUILD.md`            | Authoritative build, signing, acceptance, and publication procedure |
| `build-axiom-exe.ps1` | Deterministic x64 workflow with explicit unsigned opt-in            |
| `build-axiom-exe.cmd` | Thin CMD wrapper for the PowerShell workflow                        |
| `legal/`              | Installer EULA and legal pointers                                   |
| `dist/`               | Generated artifacts; existence alone does not establish trust       |
