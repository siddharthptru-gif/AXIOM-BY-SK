$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
Push-Location $PSScriptRoot
try {
    & $compiler /nologo /target:winexe /platform:x64 /optimize+ /out:AXIOM-Studio.exe /r:System.Web.Extensions.dll Axiom.cs
    if ($LASTEXITCODE -ne 0) { throw 'AXIOM compilation failed.' }
    $check = Start-Process -FilePath (Join-Path $PSScriptRoot 'AXIOM-Studio.exe') -ArgumentList '--self-test' -WindowStyle Hidden -Wait -PassThru
    if ($check.ExitCode -ne 0) { throw 'AXIOM smoke test failed.' }
} finally {
    Pop-Location
}
