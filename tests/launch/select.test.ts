import { describe, it, expect } from 'vitest'
import { selectStrategy } from '../../src/launch/index.js'

describe('selectStrategy', () => {
  it('force 优先', () => expect(selectStrategy({}, 'print')).toBe('print'))
  it('TMUX 环境 → tmux', () => expect(selectStrategy({ TMUX: '/tmp/x' })).toBe('tmux'))
  it('macOS iTerm → iterm', () =>
    expect(selectStrategy({ __platform: 'darwin', TERM_PROGRAM: 'iTerm.app' })).toBe('iterm'))
  it('其他 → print', () => expect(selectStrategy({ __platform: 'linux' })).toBe('print'))
})
