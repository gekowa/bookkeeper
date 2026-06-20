import { describe, it, expect } from 'vitest'
import { BkError, Codes } from '../../src/core/errors.js'

describe('BkError', () => {
  it('携带 code/recoverable/remediation', () => {
    const e = new BkError(Codes.INFRA_UNREACHABLE, 'Postgres 连不上', {
      recoverable: false, remediation: '启动你的本地数据库',
    })
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('INFRA_UNREACHABLE')
    expect(e.recoverable).toBe(false)
    expect(e.remediation).toBe('启动你的本地数据库')
  })
  it('recoverable 默认 false', () => {
    const e = new BkError(Codes.DB_EXISTS, 'x')
    expect(e.recoverable).toBe(false)
  })
})
