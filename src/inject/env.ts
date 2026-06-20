// src/inject/env.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const BEGIN = '# >>> bk managed >>>'
const END = '# <<< bk managed <<<'

function renderBlock(vars: Record<string, string>): string {
  const body = Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n')
  return `${BEGIN}\n${body}\n${END}`
}
function stripBlock(content: string): string {
  const re = new RegExp(`\\n?${escape(BEGIN)}[\\s\\S]*?${escape(END)}\\n?`, 'g')
  return content.replace(re, '\n').replace(/^\n+/, '')
}
function escape(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

export function writeEnvBlock(envPath: string, vars: Record<string, string>): void {
  const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
  const without = stripBlock(existing)
  const sep = without && !without.endsWith('\n') ? '\n' : ''
  const head = without ? without + sep : ''
  writeFileSync(envPath, `${head}${renderBlock(vars)}\n`)
}
export function removeEnvBlock(envPath: string): void {
  if (!existsSync(envPath)) return
  writeFileSync(envPath, stripBlock(readFileSync(envPath, 'utf8')))
}
