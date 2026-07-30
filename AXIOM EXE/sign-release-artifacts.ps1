# Dedicated Windows signing boundary. This script never builds, packages, installs,
# or invokes repository lifecycle hooks; it signs only an already-built bounded target set.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('App', 'Installer')]
  [string]$Mode,

  [Parameter(Mandatory = $true)]
  [string]$Path
)

$ErrorActionPreference = 'Stop'
$certificateInput = [string]$env:CSC_LINK
$certificatePassword = [string]$env:CSC_KEY_PASSWORD
$expectedThumbprint = ([string]$env:AXIOM_SIGNER_SHA1).Replace(' ', '').ToUpperInvariant()
$expectedSubject = [string]$env:AXIOM_SIGNER_SUBJECT
Remove-Item Env:CSC_LINK -ErrorAction SilentlyContinue
Remove-Item Env:CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
Remove-Item Env:AXIOM_SIGNER_SHA1 -ErrorAction SilentlyContinue
Remove-Item Env:AXIOM_SIGNER_SUBJECT -ErrorAction SilentlyContinue

if ([string]::IsNullOrWhiteSpace($certificateInput) -or
    [string]::IsNullOrWhiteSpace($certificatePassword) -or
    $expectedThumbprint -notmatch '^[0-9A-F]{40}$' -or
    [string]::IsNullOrWhiteSpace($expectedSubject)) {
  throw 'Signing requires CSC_LINK, CSC_KEY_PASSWORD, AXIOM_SIGNER_SHA1, and AXIOM_SIGNER_SUBJECT.'
}

$resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
$item = Get-Item -LiteralPath $resolved -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'Signing target must not be a reparse point.'
}
if ($Mode -eq 'App' -and (-not $item.PSIsContainer -or $item.Name -ne 'win-unpacked')) {
  throw 'App signing requires the exact win-unpacked application directory.'
}
if ($Mode -eq 'Installer') {
  $desktopManifestPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'apps/desktop/package.json'
  $desktopManifest = Get-Content -LiteralPath $desktopManifestPath -Raw -ErrorAction Stop | ConvertFrom-Json
  $desktopVersion = [string]$desktopManifest.version
  if ($desktopVersion -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    throw 'Desktop package version must be a stable semantic version before installer signing.'
  }
  $expectedInstallerName = "AXIOM-Setup-$desktopVersion-x64.exe"
  if ($item.PSIsContainer -or $item.Name -cne $expectedInstallerName) {
    throw "Installer signing requires the exact $expectedInstallerName artifact."
  }
}

$maxTargetBytes = 1GB
$maxTotalBytes = 2GB
$expectedAppTargets = @(
  'AXIOM.exe'
  'd3dcompiler_47.dll'
  'ffmpeg.dll'
  'libEGL.dll'
  'libGLESv2.dll'
  'resources/app.asar.unpacked/node_modules/node-pty/build/Release/conpty.node'
  'resources/app.asar.unpacked/node_modules/node-pty/build/Release/conpty/OpenConsole.exe'
  'resources/app.asar.unpacked/node_modules/node-pty/build/Release/conpty/conpty.dll'
  'resources/app.asar.unpacked/node_modules/node-pty/build/Release/conpty_console_list.node'
  'resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node'
  'resources/app.asar.unpacked/node_modules/node-pty/build/Release/winpty-agent.exe'
  'resources/app.asar.unpacked/node_modules/node-pty/build/Release/winpty.dll'
  'resources/bin/axiom-core.exe'
  'resources/elevate.exe'
  'vk_swiftshader.dll'
  'vulkan-1.dll'
) | Sort-Object

if ($Mode -eq 'App') {
  $entries = @(Get-ChildItem -LiteralPath $item.FullName -Recurse -Force)
  $reparseEntries = @($entries | Where-Object {
    ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  })
  if ($reparseEntries.Count -ne 0) {
    throw 'The unpacked application contains a reparse point.'
  }
  $targets = @($entries | Where-Object {
    -not $_.PSIsContainer -and $_.Extension.ToLowerInvariant() -in @('.exe', '.dll', '.node')
  } | Sort-Object FullName)
  $actualTargets = @($targets | ForEach-Object {
    [IO.Path]::GetRelativePath($item.FullName, $_.FullName).Replace('\', '/')
  } | Sort-Object)
  $differences = @(Compare-Object -ReferenceObject $expectedAppTargets -DifferenceObject $actualTargets)
  if ($differences.Count -ne 0) {
    throw "The unpacked native signing inventory is not exact: $($actualTargets -join ', ')"
  }
} else {
  $targets = @($item)
}

$totalBytes = 0L
foreach ($target in $targets) {
  if ($target.Length -le 0 -or $target.Length -gt $maxTargetBytes) {
    throw "Signing target size is outside the allowed range: $($target.Name)"
  }
  $totalBytes += $target.Length
}
if ($targets.Count -eq 0 -or $targets.Count -gt $expectedAppTargets.Count -or $totalBytes -gt $maxTotalBytes) {
  throw "Signing target count or aggregate size is outside the allowed range: $($targets.Count) file(s), $totalBytes byte(s)."
}

$signTool = Get-Command signtool.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $signTool) {
  $kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  $signTool = Get-ChildItem -LiteralPath $kitsRoot -Filter signtool.exe -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.DirectoryName -match '\\x64$' } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
}
if (-not $signTool) { throw 'signtool.exe was not found.' }
$signToolPath = [string]$signTool.Source
if ([string]::IsNullOrWhiteSpace($signToolPath)) { $signToolPath = [string]$signTool.FullName }

$tempCertificate = Join-Path ([IO.Path]::GetTempPath()) ("axiom-signing-{0}.pfx" -f [Guid]::NewGuid().ToString('N'))
try {
  if (Test-Path -LiteralPath $certificateInput -PathType Leaf) {
    $source = Get-Item -LiteralPath $certificateInput -Force
    if (($source.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Signing certificate input must not be a reparse point.'
    }
    Copy-Item -LiteralPath $source.FullName -Destination $tempCertificate -Force
  } elseif ($certificateInput -match '^https?://') {
    throw 'Remote certificate URLs are not accepted by the signing boundary.'
  } else {
    try {
      [IO.File]::WriteAllBytes($tempCertificate, [Convert]::FromBase64String($certificateInput))
    } catch {
      throw 'CSC_LINK must be a local PFX path or base64-encoded PFX bytes.'
    }
  }

  $securePassword = ConvertTo-SecureString -String $certificatePassword -AsPlainText -Force
  $certificate = Get-PfxCertificate -FilePath $tempCertificate -Password $securePassword
  if (-not $certificate) { throw 'The signing certificate could not be loaded.' }
  if ($certificate.Thumbprint.Replace(' ', '').ToUpperInvariant() -ne $expectedThumbprint) {
    throw 'The PFX certificate thumbprint does not match AXIOM_SIGNER_SHA1.'
  }
  if ($certificate.Subject -ne $expectedSubject) {
    throw 'The PFX certificate subject does not match AXIOM_SIGNER_SUBJECT.'
  }

  foreach ($target in $targets) {
    if (($target.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Signing target is a reparse point: $($target.FullName)"
    }
    & $signToolPath sign /f $tempCertificate /p $certificatePassword /fd SHA256 /td SHA256 /tr 'https://timestamp.digicert.com' /v $target.FullName
    if ($LASTEXITCODE -ne 0) { throw "signtool sign failed for $($target.Name)." }
  }

  foreach ($target in $targets) {
    $signature = Get-AuthenticodeSignature -LiteralPath $target.FullName
    if ($signature.Status -ne 'Valid') {
      throw "Invalid Authenticode status for $($target.Name): $($signature.Status)"
    }
    if (-not $signature.SignerCertificate -or
        $signature.SignerCertificate.Thumbprint.Replace(' ', '').ToUpperInvariant() -ne $expectedThumbprint -or
        $signature.SignerCertificate.Subject -ne $expectedSubject) {
      throw "Unexpected signer identity for $($target.Name)."
    }
    if (-not $signature.TimeStamperCertificate) {
      throw "Trusted timestamp is missing for $($target.Name)."
    }
    $verification = & $signToolPath verify /pa /all /v $target.FullName 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $verification -notmatch '(?i)sha256' -or $verification -notmatch '(?i)timestamp') {
      throw "SHA-256 signature/timestamp verification failed for $($target.Name)."
    }
  }
  Write-Host "Verified $($targets.Count) signed $Mode target(s) for $expectedSubject." -ForegroundColor Green
} finally {
  Remove-Item -LiteralPath $tempCertificate -Force -ErrorAction SilentlyContinue
  $certificateInput = $null
  $certificatePassword = $null
  $securePassword = $null
}
