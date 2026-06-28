// src/hooks/postAllocate.ts
import { join } from 'node:path'
import { execa } from 'execa'
import type { Ctx } from '../core/types.js'
import { BkError, Codes } from '../core/errors.js'

/**
 * 按 service 声明顺序串行跑 post_allocate 钩子。
 * - 每条在该 service 的 dir 下用平台 shell 执行（Unix: /bin/sh，Windows: cmd.exe）
 * - 进程环境 = process.env（execa 默认 extendEnv）叠加该 dir 的 BK_* 与 BK_N
 * - fail-fast：某条退出码非 0 立即抛 HOOK_FAILED，不跑后续
 */
export async function runPostAllocate(
  ctx: Ctx,
  worktreeDir: string,
  dirEnvs: Map<string, Record<string, string>>,
  n: number,
): Promise<void> {
  for (const svc of ctx.config.services) {
    const cmd = svc.post_allocate
    if (!cmd) continue
    const dir = svc.dir ?? '.'
    const cwd = join(worktreeDir, dir)
    const env = { ...(dirEnvs.get(dir) ?? {}), BK_N: String(n) }
    // shell:true → Unix 用 /bin/sh、Windows 用 cmd.exe；两者都支持 && 链
    const result = await execa(cmd, { cwd, env, stdio: 'inherit', reject: false, shell: true })
    if (result.exitCode !== 0) {
      throw new BkError(
        Codes.HOOK_FAILED,
        `service ${svc.name} 的 post_allocate 失败（exit code ${result.exitCode}）\n  命令：${cmd}\n  工作目录：${cwd}`,
        { remediation: '修复后用 bk setup 重跑' },
      )
    }
  }
}
