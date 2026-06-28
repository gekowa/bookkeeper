import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('execa', () => ({ execa: vi.fn() }))
import { execa } from 'execa'
import { hasWindowsTerminal, resolvePsHost } from '../../src/launch/platform.js'

const mockExeca = vi.mocked(execa)
beforeEach(() => { mockExeca.mockReset() })

describe('hasWindowsTerminal', () => {
  it('非 win32 → false，且不调用 execa', async () => {
    expect(await hasWindowsTerminal({ __platform: 'darwin' })).toBe(false)
    expect(mockExeca).not.toHaveBeenCalled()
  })
  it('win32 且 where wt 成功 → true', async () => {
    mockExeca.mockResolvedValue({ stdout: 'C:\\wt.exe' } as never)
    expect(await hasWindowsTerminal({ __platform: 'win32' })).toBe(true)
    expect(mockExeca).toHaveBeenCalledWith('where', ['wt'])
  })
  it('win32 但 where wt 抛错 → false', async () => {
    mockExeca.mockRejectedValue(new Error('not found'))
    expect(await hasWindowsTerminal({ __platform: 'win32' })).toBe(false)
  })
})

describe('resolvePsHost', () => {
  it('where pwsh 成功 → pwsh', async () => {
    mockExeca.mockResolvedValue({ stdout: 'C:\\pwsh.exe' } as never)
    expect(await resolvePsHost()).toBe('pwsh')
  })
  it('where pwsh 抛错 → powershell', async () => {
    mockExeca.mockRejectedValue(new Error('not found'))
    expect(await resolvePsHost()).toBe('powershell')
  })
})
