export const Codes = {
  PORT_IN_USE: 'PORT_IN_USE', DB_EXISTS: 'DB_EXISTS',
  INFRA_UNREACHABLE: 'INFRA_UNREACHABLE', PERMISSION_DENIED: 'PERMISSION_DENIED',
  REDIS_DB_EXHAUSTED: 'REDIS_DB_EXHAUSTED', PROBE_EXHAUSTED: 'PROBE_EXHAUSTED',
  SET_IN_USE: 'SET_IN_USE', CONFIG_INVALID: 'CONFIG_INVALID',
  NOT_IN_WORKTREE: 'NOT_IN_WORKTREE',
} as const
export type Code = (typeof Codes)[keyof typeof Codes]

export class BkError extends Error {
  code: string
  recoverable: boolean
  remediation?: string
  constructor(code: string, message: string,
              opts: { recoverable?: boolean; remediation?: string } = {}) {
    super(message)
    this.name = 'BkError'
    this.code = code
    this.recoverable = opts.recoverable ?? false
    this.remediation = opts.remediation
  }
}
