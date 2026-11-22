param([ValidateSet('read','write')][string]$Action = 'read')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AntigravityNativeKeyring {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Credential {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredWriteW(ref Credential credential, uint flags);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr value);
}
'@
$target = 'gemini:antigravity'
if ($Action -eq 'read') {
  $pointer = [IntPtr]::Zero
  if (-not [AntigravityNativeKeyring]::CredReadW($target,1,0,[ref]$pointer)) {
    if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { [Console]::Write('{"found":false}'); exit 0 }
    throw 'Cannot read the native Antigravity Windows credential'
  }
  try {
    $record = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer,[type][AntigravityNativeKeyring+Credential])
    $bytes = New-Object byte[] $record.CredentialBlobSize
    [Runtime.InteropServices.Marshal]::Copy($record.CredentialBlob,$bytes,0,$bytes.Length)
    $value = @{found=$true;userName=$record.UserName;persist=$record.Persist;blob=[Convert]::ToBase64String($bytes)}
    [Console]::Write(($value | ConvertTo-Json -Compress))
  } finally { [AntigravityNativeKeyring]::CredFree($pointer) }
} else {
  $inputValue = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $bytes = [Convert]::FromBase64String([string]$inputValue.blob)
  if ($bytes.Length -lt 1 -or $bytes.Length -gt 24576) { throw 'Invalid native credential size' }
  $pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  try {
    [Runtime.InteropServices.Marshal]::Copy($bytes,0,$pointer,$bytes.Length)
    $record = New-Object AntigravityNativeKeyring+Credential
    $record.Type=1; $record.TargetName=$target; $record.UserName=[string]$inputValue.userName
    $record.Persist=2; $record.CredentialBlobSize=$bytes.Length; $record.CredentialBlob=$pointer
    if (-not [AntigravityNativeKeyring]::CredWriteW([ref]$record,0)) { throw 'Cannot update the native Antigravity Windows credential' }
    [Console]::Write('{"written":true}')
  } finally {
    for ($index=0; $index -lt $bytes.Length; $index++) { [Runtime.InteropServices.Marshal]::WriteByte($pointer,$index,0) }
    [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer)
  }
}
