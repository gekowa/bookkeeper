function sqPosix(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'` }
function sqPs(s: string): string { return `'${s.replace(/'/g, `''`)}'` }

export function renderPosix(env: Record<string, string>, argv: string[]): string {
  const e = Object.entries(env).map(([k, v]) => `${k}=${sqPosix(v)}`).join(' ')
  const cmd = argv.map(sqPosix).join(' ')
  return e ? `${e} ${cmd}` : cmd
}

export function renderPowerShell(env: Record<string, string>, argv: string[]): string {
  const e = Object.entries(env).map(([k, v]) => `$env:${k}=${sqPs(v)}; `).join('')
  const [exe, ...rest] = argv
  const cmd = [`& ${sqPs(exe)}`, ...rest.map(sqPs)].join(' ')
  return `${e}${cmd}`
}
