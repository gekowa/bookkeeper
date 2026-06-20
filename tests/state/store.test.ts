// tests/state/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withState, readState } from '../../src/state/store.js'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bkhome-')); process.env.BK_HOME = home })
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.BK_HOME })

describe('state store', () => {
  it('首次读返回空 sets 并可写入', async () => {
    await withState('foo', (s) => {
      expect(s.sets).toEqual({})
      s.project_name = 'foo'
      s.sets['1'] = { status: 'free', owner: null, resources: {}, created_at: 'x' }
    })
    const s = await readState('foo')
    expect(s.sets['1'].status).toBe('free')
  })
  it('并发 withState 串行化、不丢更新', async () => {
    await Promise.all([1, 2, 3].map(n =>
      withState('foo', (s) => { s.sets[String(n)] = { status: 'free', owner: null, resources: {}, created_at: 'x' } })
    ))
    const s = await readState('foo')
    expect(Object.keys(s.sets).sort()).toEqual(['1', '2', '3'])
  })
})
