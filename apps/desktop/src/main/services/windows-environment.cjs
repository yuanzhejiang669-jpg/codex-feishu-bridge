const { execFile } = require('node:child_process');

// .NET's User setter synchronously broadcasts to every desktop window after it
// commits the registry value. A slow notification must not turn a commit into a
// reported failure. No credential is put in command arguments or output.
async function writeWindowsUserEnvironment(name, value, options = {}) {
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(name)) throw new Error('环境变量名称格式无效');
  const run = options.execFile || execFile;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
    'try {',
    "if ($env:CFB_ENV_REMOVE -eq '1') { $key.DeleteValue($env:CFB_ENV_NAME, $false) }",
    'else { $key.SetValue($env:CFB_ENV_NAME, $env:CFB_ENV_VALUE, [Microsoft.Win32.RegistryValueKind]::String) }',
    "$actual = $key.GetValue($env:CFB_ENV_NAME, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    "if ($env:CFB_ENV_REMOVE -eq '1') { if ($null -ne $actual) { throw 'Environment removal verification failed' } }",
    "elseif ($actual -cne $env:CFB_ENV_VALUE) { throw 'Environment write verification failed' }",
    "[Console]::Out.Write('OK')",
    '} finally { $key.Close() }',
  ].join('\n');
  await new Promise((resolve, reject) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 15000, encoding: 'utf8',
    env: { ...process.env, CFB_ENV_NAME: name, CFB_ENV_VALUE: value == null ? '' : String(value), CFB_ENV_REMOVE: value == null ? '1' : '0' },
  }, (error, stdout) => error ? reject(new Error('用户级凭据保存或读回校验失败', { cause: error }))
    : String(stdout).trim() === 'OK' ? resolve() : reject(new Error('用户级凭据保存未得到确认'))));
  if (value == null || value === '') delete process.env[name]; else process.env[name] = String(value);
  const notify = options.notify || notifyEnvironmentChanged;
  // Notification is deliberately outside the persistence transaction.
  try { Promise.resolve(notify()).catch(() => {}); } catch {}
}

function notifyEnvironmentChanged() {
  const script = "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CfbEnvNotify { [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, string l, uint f, uint t, out IntPtr r); }'; $r=[IntPtr]::Zero; [void][CfbEnvNotify]::SendMessageTimeout([IntPtr]65535,26,[IntPtr]::Zero,'Environment',2,100,[ref]$r)";
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 2000, encoding: 'utf8',
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP },
  }, () => resolve()));
}
module.exports = { writeWindowsUserEnvironment };
