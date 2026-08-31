import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

let warned = false

/**
 * A low-level keyboard hook installed by a medium-integrity process usually
 * still sees keys headed for an elevated window, but not always — and when it
 * does not, the hotkeys simply stop working with no error anywhere. Detecting
 * the condition lets us say so instead of leaving the user guessing.
 */
export async function isElevated(): Promise<boolean> {
  try {
    const { stdout } = await run(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())' +
          '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
      ],
      { timeout: 8000 }
    )
    return stdout.trim().toLowerCase() === 'true'
  } catch {
    return false
  }
}

/**
 * Names the foreground process when it runs at a higher integrity level than we
 * do. Returns null when everything is fine, so the caller can stay quiet.
 */
export async function elevatedForegroundApp(): Promise<string | null> {
  const script = `
$sig = @'
using System;
using System.Runtime.InteropServices;
public class Fg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
Add-Type -TypeDefinition $sig
$pid2 = 0
[Fg]::GetWindowThreadProcessId([Fg]::GetForegroundWindow(), [ref]$pid2) | Out-Null
if ($pid2 -eq 0) { '' ; exit }
$p = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
if (-not $p) { '' ; exit }
try { $null = $p.Path; '' } catch { $p.ProcessName }
`.trim()

  try {
    const { stdout } = await run(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 8000 }
    )
    const name = stdout.trim()
    return name.length > 0 ? name : null
  } catch {
    return null
  }
}

/**
 * Checks once per session, only while something is actually being recorded —
 * the warning is worthless before the user has tried to use a hotkey.
 */
export async function warnIfHotkeysBlocked(
  notify: (message: string) => void
): Promise<void> {
  if (warned) return
  if (await isElevated()) return

  const blocker = await elevatedForegroundApp()
  if (!blocker) return

  warned = true
  notify(
    `${blocker} yönetici olarak çalışıyor. Kısayolların o pencere öndeyken çalışması için ` +
      `Capture Assistant'ı da yönetici olarak açman gerekebilir.`
  )
}
