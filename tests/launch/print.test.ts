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

  it('startupArgs spec：渲染 posix env 前缀 + argv', () => {
    const out = renderPrint([{ name: 'api', cwd: '/wt/api', argv: ['mvn', 'spring-boot:run'], env: { K: 'v' } }])
    expect(out).toContain(`K='v' 'mvn' 'spring-boot:run'`)
  })
})
