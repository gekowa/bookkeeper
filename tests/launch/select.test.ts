import { describe, it, expect } from 'vitest'
import { selectStrategy } from '../../src/launch/index.js'

describe('selectStrategy', () => {
  it('force 优先', () => expect(selectStrategy({}, { force: 'print' })).toBe('print'))
  it('TMUX 环境 → tmux', () => expect(selectStrategy({ TMUX: '/tmp/x' })).toBe('tmux'))
  it('macOS iTerm → iterm', () =>
    expect(selectStrategy({ __platform: 'darwin', TERM_PROGRAM: 'iTerm.app' })).toBe('iterm'))
  it('Windows 有 wt → wt', () =>
    expect(selectStrategy({ __platform: 'win32' }, { hasWt: true })).toBe('wt'))
  it('Windows 无 wt → win', () =>
    expect(selectStrategy({ __platform: 'win32' }, { hasWt: false })).toBe('win'))
  it('其他 → print', () => expect(selectStrategy({ __platform: 'linux' })).toBe('print'))
})
