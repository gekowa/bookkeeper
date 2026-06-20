import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { doDestroy } from '../../src/cli/commands/destroy.js'
import { withState, readState } from '../../src/state/store.js'
import { Codes } from '../../src/core/errors.js'
import type { Ctx } from '../../src/core/types.js'

let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bkhome-')); process.env.BK_HOME = home })
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.BK_HOME })

const ctx = (): Ctx => ({ projectRoot: '/x', config: {
  project_name: 'foo', services: [{ name: 'backend', type: 'django', port_base: 10000 }], infra: {} }})

describe('doDestroy', () => {
  it('free set 直接销毁', async () => {
    await withState('foo', (s) => { s.sets['2'] = { status: 'free', owner: null, resources: {}, created_at: 'x' } })
    await doDestroy(ctx(), 2, { force: false })
    expect((await readState('foo')).sets['2']).toBeUndefined()
  })
  it('allocated set 无 force 抛 SET_IN_USE', async () => {
    await withState('foo', (s) => { s.sets['2'] = { status: 'allocated', owner: { worktree: '/w', branch: 'x' }, resources: {}, created_at: 'x' } })
    await expect(doDestroy(ctx(), 2, { force: false })).rejects.toMatchObject({ code: Codes.SET_IN_USE })
  })
})
