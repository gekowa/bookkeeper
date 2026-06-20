// src/state/store.ts
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import lockfile from 'proper-lockfile'
import { StateFile, emptyState } from './schema.js'

function home(): string { return process.env.BK_HOME ?? homedir() }
export function stateDir(project: string): string { return join(home(), '.bookkeeper', project) }
function statePath(project: string): string { return join(stateDir(project), 'state.json') }
function lockPath(project: string): string { return join(stateDir(project), 'lock') }

function ensureDir(project: string) { mkdirSync(stateDir(project), { recursive: true }) }

export async function readState(project: string): Promise<StateFile> {
  const p = statePath(project)
  if (!existsSync(p)) return emptyState(project)
  return JSON.parse(readFileSync(p, 'utf8')) as StateFile
}

function atomicWrite(project: string, s: StateFile) {
  const p = statePath(project)
  const tmp = p + '.tmp'
  writeFileSync(tmp, JSON.stringify(s, null, 2))
  renameSync(tmp, p)
}

export async function withState<T>(
  project: string, fn: (s: StateFile) => Promise<T> | T,
): Promise<T> {
  ensureDir(project)
  // 锁文件必须存在才能加锁
  const lp = lockPath(project)
  if (!existsSync(lp)) writeFileSync(lp, '')
  const release = await lockfile.lock(lp, { retries: { retries: 50, factor: 1.2, minTimeout: 20 } })
  try {
    const s = await readState(project)
    const result = await fn(s)
    atomicWrite(project, s)
    return result
  } finally {
    await release()
  }
}
