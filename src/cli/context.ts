// src/cli/context.ts
import { discoverProjectRoot } from '../config/discover.js'
import { loadConfig } from '../config/load.js'
import type { Ctx } from '../core/types.js'
import { BkError } from '../core/errors.js'
import { error as printError } from './output.js'

export function loadCtx(cwd: string = process.cwd()): Ctx {
  const projectRoot = discoverProjectRoot(cwd)
  return { projectRoot, config: loadConfig(projectRoot) }
}
export function maxAttempts(ctx: Ctx): number {
  return ctx.config.allocation?.max_probe_attempts ?? 20
}
export async function runCommand(fn: () => Promise<void>): Promise<void> {
  try { await fn() }
  catch (e) {
    if (e instanceof BkError) {
      printError(`${e.message}  [${e.code}]`)
      if (e.remediation) printError(`  → ${e.remediation}`)
    } else {
      printError((e as Error).message)
    }
    process.exitCode = 1
  }
}
