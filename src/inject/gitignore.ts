// src/inject/gitignore.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function ensureGitignore(root: string, entries: string[]): void {
  const p = join(root, '.gitignore')
  const existing = existsSync(p) ? readFileSync(p, 'utf8') : ''
  const have = new Set(existing.split('\n').map(l => l.trim()))
  const add = entries.filter(e => !have.has(e))
  if (!add.length) return
  const sep = existing && !existing.endsWith('\n') ? '\n' : ''
  writeFileSync(p, existing + sep + add.join('\n') + '\n')
}
