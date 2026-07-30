# Build resources (Windows x64 installer)

electron-builder reads this directory for packaging resources.

## App and installer icon

- `logo.png` is the approved AXIOM brand source.
- `icon.ico` is the Windows app/installer/shortcut icon generated from that logo.
- `icon.svg` is an earlier vector reference.

For pixel-perfect small sizes, a release engineer may regenerate a multi-resolution icon
with a reviewed image tool; do not alter the approved `logo.png`:

```sh
magick build/logo.png -define icon:auto-resize=256,128,64,48,32,16 build/icon.ico
```

## Building

From the repository root, these npm commands always produce unsigned local artifacts:

```powershell
npm.cmd run package --workspace apps/desktop      # unsigned x64 NSIS installer
npm.cmd run package:dir --workspace apps/desktop  # unsigned unpacked x64 smoke package
```

Output is written to `AXIOM EXE/dist`. The package config has no upload destination.

## Signing

For a controlled signed build, set `CSC_LINK`, `CSC_KEY_PASSWORD`, `AXIOM_SIGNER_SHA1`,
and `AXIOM_SIGNER_SUBJECT` from approved secret storage, then use only the dedicated release
workflow:

```powershell
& '.\AXIOM EXE\build-axiom-exe.ps1'
```

The npm package commands never sign. Public distribution additionally requires CA-backed
signing/timestamping and independent verification of the packaged app, shipped native
executables, and installer. Unsigned output is suitable only for local/internal testing;
SmartScreen, Defender, or enterprise policy may warn or block it.

SHA-256 sidecars are checksums, not signatures. ASAR/minification do not hide code. Follow
`docs/release-hardening.md` before any public release.

## Native packaging

`node-pty` is rebuilt for Electron's ABI. Only its rebuilt Windows x64 runtime `.node`,
`.dll`, and helper `.exe` files are unpacked; its JavaScript stays in ASAR and source,
scripts, symbols, build intermediates, and other platform/architecture payloads are omitted.
The reviewed native core is packaged separately as `resources/bin/axiom-core.exe`.
