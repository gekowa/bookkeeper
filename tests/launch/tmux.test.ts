import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))
import { execa } from 'execa'
import { runTmux } from '../../src/launch/tmux.js'
import type { LaunchSpec } from '../../src/launch/index.js'

const mockExeca = vi.mocked(execa)
const spec = (name: string, cwd: string): LaunchSpec => ({ name, command: `run ${name}`, cwd })

beforeEach(() => {
  mockExeca.mockReset()
  // new-session / split-window 用 -P -F '#{pane_id}' 打印 pane id；select-layout 无 stdout
  let pane = 0
  mockExeca.mockImplementation(((_file: string, args: string[]) => {
    if (args[0] === 'new-session' || args[0] === 'split-window')
      return Promise.resolve({ stdout: `%${++pane}` })
    return Promise.resolve({ stdout: '' })
  }) as unknown as typeof execa)
})

describe('runTmux', () => {
  it('new-session 与 split-window 都带 -P -F #{pane_id}', async () => {
    await runTmux([spec('backend', '/wt/backend'), spec('frontend', '/wt/frontend')])
    const calls = mockExeca.mock.calls.map(c => (c[1] as string[]))
    expect(calls[0]).toEqual(expect.arrayContaining(['new-session', '-P', '-F', '#{pane_id}']))
    expect(calls[1]).toEqual(expect.arrayContaining(['split-window', '-P', '-F', '#{pane_id}']))
  })
  it('返回 session 名与按 spec 顺序的 paneIds', async () => {
    const r = await runTmux([spec('backend', '/wt/backend'), spec('frontend', '/wt/frontend')])
    expect(r.session).toBe('bk-backend')
    expect(r.paneIds).toEqual(['%1', '%2'])
  })
  it('空 specs → 空结果、不调用 tmux', async () => {
    const r = await runTmux([])
    expect(r).toEqual({ session: '', paneIds: [] })
    expect(mockExeca).not.toHaveBeenCalled()
  })
})
