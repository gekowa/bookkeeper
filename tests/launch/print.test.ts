import { describe, it, expect } from 'vitest'
import { renderPrint } from '../../src/launch/print.js'

describe('renderPrint', () => {
  it('每个 service 一行命令 + cwd', () => {
    const out = renderPrint([
      { name: 'backend', command: 'uv run ... :10002', cwd: '/wt' },
      { name: 'frontend', command: 'npm run dev -- --port 10102', cwd: '/wt' },
    ])
    expect(out).toContain('backend')
    expect(out).toContain('uv run ... :10002')
    expect(out).toContain('frontend')
  })
})
