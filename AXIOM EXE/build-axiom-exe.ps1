# AXIOM Windows x64 release workflow.
# Public/signed build: ./build-axiom-exe.ps1
# Local unsigned build: ./build-axiom-exe.ps1 -AllowUnsigned
[CmdletBinding()]
param([switch]$AllowUnsigned)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
Write-Host "==> Repo: $repo" -ForegroundColor DarkGray

# Capture release credentials once, then remove them before any dependency,
# build, validation, electron-vite, electron-builder, or project hook executes.
$signingLink = [string]$env:CSC_LINK
$signingPassword = [string]$env:CSC_KEY_PASSWORD
$signerThumbprint = [string]$env:AXIOM_SIGNER_SHA1
$signerSubject = [string]$env:AXIOM_SIGNER_SUBJECT
foreach ($name in @('CSC_LINK', 'CSC_KEY_PASSWORD', 'AXIOM_SIGNER_SHA1', 'AXIOM_SIGNER_SUBJECT')) {
  Remove-Item "Env:$name" -ErrorAction SilentlyContinue
}

$signingValues = @($signingLink, $signingPassword, $signerThumbprint, $signerSubject)
$present = @($signingValues | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count
if ($present -ne 0 -and $present -ne 4) {
  throw 'CSC_LINK, CSC_KEY_PASSWORD, AXIOM_SIGNER_SHA1, and AXIOM_SIGNER_SUBJECT must all be set or all be absent.'
}
$signingEnabled = $present -eq 4
if (-not $signingEnabled -and -not $AllowUnsigned) {
  throw 'Signing identity is absent. Use -AllowUnsigned only for local/internal testing.'
}

if ($signingEnabled) {
  # Existence check only: this ignored credential artifact is never opened or read.
  if (Test-Path -LiteralPath (Join-Path $repo 'process.env.GITHUB_CLIENT_SECRET')) {
    throw 'Remove the ignored credential artifact and revoke/rotate the exposed secret before a signed release build.'
  }
  $dirty = @(git status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0) { throw 'Unable to verify the signed-release Git worktree.' }
  if ($dirty.Count -ne 0) { throw 'A signed release requires a reviewed clean Git worktree.' }
  Write-Host '==> Signed public-release mode.' -ForegroundColor Green
} else {
  Write-Host '==> Unsigned local/internal mode; do not publish this artifact.' -ForegroundColor Yellow
}

$dist = Join-Path $PSScriptRoot 'dist'
if (Test-Path -LiteralPath $dist) {
  $existingOutput = @(Get-ChildItem -LiteralPath $dist -Force)
  if ($existingOutput.Count -ne 0) {
    throw 'Release output directory must be absent or empty; move prior artifacts aside before building.'
  }
}

Write-Host '==> Installing exactly from package-lock.json...' -ForegroundColor Cyan
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }

Write-Host '==> Extracting cached Electron binary...' -ForegroundColor Cyan
$electronCachePath = "C:\Users\SIDHU\AppData\Local\electron\Cache\electron-v33.2.0-win32-x64.zip"
$electronDest = Join-Path $repo 'node_modules/electron/dist'
Expand-Archive -Force -Path $electronCachePath -DestinationPath $electronDest

Write-Host '==> Patching node-pty gyp files to disable SpectreMitigation...' -ForegroundColor Cyan
$bindingGyp = Join-Path $repo 'node_modules/node-pty/binding.gyp'
(Get-Content -Path $bindingGyp -Raw).Replace("'SpectreMitigation': 'Spectre'", "'SpectreMitigation': 'false'") | Set-Content -Path $bindingGyp -NoNewline

$winptyGyp = Join-Path $repo 'node_modules/node-pty/deps/winpty/src/winpty.gyp'
(Get-Content -Path $winptyGyp -Raw).Replace("'SpectreMitigation': 'Spectre'", "'SpectreMitigation': 'false'") | Set-Content -Path $winptyGyp -NoNewline

Write-Host '==> Rebuilding node-pty natively...' -ForegroundColor Cyan
$oldCwd = Get-Location
Set-Location (Join-Path $repo 'node_modules/node-pty')
& npx.cmd node-gyp rebuild
if ($LASTEXITCODE -eq 0) {
  & node scripts/post-install.js
}
Set-Location $oldCwd
if ($LASTEXITCODE -ne 0) { throw 'node-pty rebuild failed' }

Write-Host '==> Building the pinned native core...' -ForegroundColor Cyan
cargo build --release --locked -p axiom-core
if ($LASTEXITCODE -ne 0) { throw 'native core build failed' }

$checks = @(
  @('run', 'typecheck', '--workspace', 'apps/desktop'),
  @('run', 'validate:agentic-chat', '--workspace', 'apps/desktop'),
  @('run', 'validate:github-scm', '--workspace', 'apps/desktop'),
  @('run', 'validate:god-mode', '--workspace', 'apps/desktop'),
  @('run', 'validate:security-hardening', '--workspace', 'apps/desktop')
)
foreach ($arguments in $checks) {
  Write-Host "==> npm $($arguments -join ' ')" -ForegroundColor Cyan
  & npm.cmd @arguments
  if ($LASTEXITCODE -ne 0) { throw "Validation failed: npm $($arguments -join ' ')" }
}

Write-Host '==> Building production bundles without signing material...' -ForegroundColor Cyan
npm.cmd run build --workspace apps/desktop
if ($LASTEXITCODE -ne 0) { throw 'production build failed' }
node apps/desktop/scripts/prepare-package-output.cjs
if ($LASTEXITCODE -ne 0) { throw 'package output preparation failed' }

$builder = Join-Path $repo 'node_modules/.bin/electron-builder.cmd'
$unpacked = Join-Path $dist 'win-unpacked'
Write-Host '==> Creating unsigned unpacked application (credentials absent)...' -ForegroundColor Cyan
Push-Location 'apps/desktop'
& $builder --win --dir --config.win.sign=null
Pop-Location
if ($LASTEXITCODE -ne 0) { throw 'unsigned unpacked application build failed' }

function Invoke-DedicatedSigner([string]$mode, [string]$target) {
  if (-not $signingEnabled) { return }
  try {
    $env:CSC_LINK = $signingLink
    $env:CSC_KEY_PASSWORD = $signingPassword
    $env:AXIOM_SIGNER_SHA1 = $signerThumbprint
    $env:AXIOM_SIGNER_SUBJECT = $signerSubject
    & (Join-Path $PSScriptRoot 'sign-release-artifacts.ps1') -Mode $mode -Path $target
  } finally {
    foreach ($name in @('CSC_LINK', 'CSC_KEY_PASSWORD', 'AXIOM_SIGNER_SHA1', 'AXIOM_SIGNER_SUBJECT')) {
      Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }
  }
}

Invoke-DedicatedSigner 'App' $unpacked
if ($signingEnabled) {
  node apps/desktop/scripts/verify-packaged-runtime.cjs $unpacked
  if ($LASTEXITCODE -ne 0) { throw 'post-sign packaged runtime verification failed' }
}

Write-Host '==> Creating unsigned NSIS from the already-signed app (credentials absent)...' -ForegroundColor Cyan
Push-Location 'apps/desktop'
& $builder --win nsis --prepackaged $unpacked --config.win.sign=null
Pop-Location
if ($LASTEXITCODE -ne 0) { throw 'unsigned NSIS assembly failed' }
$installers = @(Get-ChildItem -LiteralPath $dist -Filter 'AXIOM-Setup-*-x64.exe' -File)
if ($installers.Count -ne 1) { throw "Expected exactly one installer; found $($installers.Count)." }
Invoke-DedicatedSigner 'Installer' $installers[0].FullName

if ($signingEnabled) {
  # Recheck resource/fuses/inventory/launch after every signing and installer step.
  node apps/desktop/scripts/verify-packaged-runtime.cjs $unpacked
  if ($LASTEXITCODE -ne 0) { throw 'final packaged runtime verification failed' }
}

# Sidecars are generated only after final signatures so they hash final bytes.
$artifacts = @(Get-ChildItem -LiteralPath $dist -File | Where-Object {
  $_.Name -match '^AXIOM-Setup-.*-x64\.exe$|\.blockmap$|^latest(?:-[A-Za-z0-9._-]+)?\.(?:yml|yaml|json)$'
})
if ($artifacts.Count -eq 0 -or $artifacts.Count -gt 64) { throw 'Final artifact count is invalid.' }
Get-ChildItem -LiteralPath $dist -Filter '*.sha256' -File -ErrorAction SilentlyContinue |
  Remove-Item -Force
foreach ($artifact in $artifacts) {
  $digest = (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText("$($artifact.FullName).sha256", "$digest  $($artifact.Name)`n", [Text.UTF8Encoding]::new($false))
}
foreach ($artifact in $artifacts) {
  $sidecar = "$($artifact.FullName).sha256"
  if (-not (Test-Path -LiteralPath $sidecar -PathType Leaf)) {
    throw "Final artifact has no checksum sidecar: $($artifact.Name)"
  }
}

$signingLink = $null
$signingPassword = $null
$signerThumbprint = $null
$signerSubject = $null
Write-Host "==> Package complete: $dist" -ForegroundColor Green
$artifacts | Select-Object Name, @{ N = 'MB'; E = { [math]::Round($_.Length / 1MB, 2) } }
