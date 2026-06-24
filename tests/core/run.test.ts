import { describe, it, expect } from 'vitest'
import { mergeRun } from '../../src/core/run.js'
import type { RunRecord, RunHandle } from '../../src/core/types.js'

const rec = (services: RunRecord['services']): RunRecord =>
  ({ strategy: 'iterm', startedAt: 't0', services })

describe('mergeRun', () => {
  it('launched 为 null（print）→ 原样返回 existing', () => {
    const e = rec([{ name: 'a', itermSessionId: 'A' }])
    expect(mergeRun(e, null, 't1')).toEqual(e)
  })
  it('existing 为空 → 用 launched 建新记录、带 startedAt', () => {
    const launched: RunHandle = { strategy: 'iterm', services: [{ name: 'a', itermSessionId: 'A' }] }
    expect(mergeRun(undefined, launched, 't1')).toEqual(
      { strategy: 'iterm', startedAt: 't1', services: [{ name: 'a', itermSessionId: 'A' }] })
  })
  it('strategy 不同 → 整体替换为 launched', () => {
    const e = rec([{ name: 'a', itermSessionId: 'A' }])
    const launched: RunHandle = { strategy: 'tmux', tmuxSession: 'bk-x', services: [{ name: 'a', tmuxPaneId: '%1' }] }
    expect(mergeRun(e, launched, 't1')).toEqual(
      { strategy: 'tmux', startedAt: 't1', tmuxSession: 'bk-x', services: [{ name: 'a', tmuxPaneId: '%1' }] })
  })
  it('同 strategy 单服务重启 → 替换该服务句柄、保留其余、保留原 startedAt', () => {
    const e = rec([{ name: 'a', itermSessionId: 'A' }, { name: 'b', itermSessionId: 'B' }])
    const launched: RunHandle = { strategy: 'iterm', services: [{ name: 'b', itermSessionId: 'B2' }] }
    expect(mergeRun(e, launched, 't1')).toEqual({
      strategy: 'iterm', startedAt: 't0',
      services: [{ name: 'a', itermSessionId: 'A' }, { name: 'b', itermSessionId: 'B2' }],
    })
  })
})
