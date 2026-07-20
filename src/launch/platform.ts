import { execa } from 'execa'

// wt.exe 是否在 PATH —— 仅 win32 才探测，其余平台直接 false。
export async function hasWindowsTerminal(
  env: NodeJS.ProcessEnv & { __platform?: string } = process.env,
): Promise<boolean> {
  const platform = env.__platform ?? process.platform
  if (platform !== 'win32') return false
  try { await execa('where', ['wt']); return true } catch { return false }
}

// 宿主 shell：优先 PowerShell 7（pwsh，支持 &&），否则回退内置 powershell 5.1。
export async function resolvePsHost(): Promise<'pwsh' | 'powershell'> {
  try { await execa('where', ['pwsh']); return 'pwsh' } catch { return 'powershell' }
}
