param(
  [Parameter(Mandatory = $true)][string]$ExecutablePath,
  [Parameter(Mandatory = $true)][string]$PayloadBase64,
  [ValidateSet('set', 'verify')][string]$Mode = 'set'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class AxiomPeResource
{
    private const uint LOAD_LIBRARY_AS_DATAFILE = 0x00000002;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr BeginUpdateResourceW(string fileName, bool deleteExistingResources);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool UpdateResourceW(
        IntPtr update,
        string type,
        string name,
        ushort language,
        byte[] data,
        uint dataLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool EndUpdateResourceW(IntPtr update, bool discard);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibraryExW(string fileName, IntPtr file, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindResourceW(IntPtr module, string name, string type);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint SizeofResource(IntPtr module, IntPtr resource);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LoadResource(IntPtr module, IntPtr resource);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LockResource(IntPtr resourceData);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeLibrary(IntPtr module);

    private static Win32Exception LastError(string operation)
    {
        return new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    public static void Set(string executablePath, byte[] data)
    {
        IntPtr update = BeginUpdateResourceW(executablePath, false);
        if (update == IntPtr.Zero) throw LastError("BeginUpdateResourceW failed");
        bool ended = false;
        try
        {
            if (!UpdateResourceW(update, "INTEGRITY", "ELECTRONASAR", 0, data, (uint)data.Length))
                throw LastError("UpdateResourceW failed");
            if (!EndUpdateResourceW(update, false))
                throw LastError("EndUpdateResourceW failed");
            ended = true;
        }
        finally
        {
            if (!ended) EndUpdateResourceW(update, true);
        }
    }

    public static byte[] Read(string executablePath)
    {
        IntPtr module = LoadLibraryExW(executablePath, IntPtr.Zero, LOAD_LIBRARY_AS_DATAFILE);
        if (module == IntPtr.Zero) throw LastError("LoadLibraryExW failed");
        try
        {
            IntPtr resource = FindResourceW(module, "ELECTRONASAR", "INTEGRITY");
            if (resource == IntPtr.Zero) throw LastError("FindResourceW failed");
            uint length = SizeofResource(module, resource);
            if (length == 0) throw LastError("SizeofResource failed");
            IntPtr loaded = LoadResource(module, resource);
            if (loaded == IntPtr.Zero) throw LastError("LoadResource failed");
            IntPtr pointer = LockResource(loaded);
            if (pointer == IntPtr.Zero) throw LastError("LockResource failed");
            byte[] result = new byte[length];
            Marshal.Copy(pointer, result, 0, checked((int)length));
            return result;
        }
        finally
        {
            FreeLibrary(module);
        }
    }
}
'@

$expected = [Convert]::FromBase64String($PayloadBase64)
if ($Mode -eq 'set') {
  [AxiomPeResource]::Set($ExecutablePath, $expected)
}
$actual = [AxiomPeResource]::Read($ExecutablePath)
if ($actual.Length -ne $expected.Length) {
  throw 'ElectronAsar resource length verification failed.'
}
for ($index = 0; $index -lt $expected.Length; $index += 1) {
  if ($actual[$index] -ne $expected[$index]) {
    throw 'ElectronAsar resource content verification failed.'
  }
}
Write-Output 'ElectronAsar resource verified.'
