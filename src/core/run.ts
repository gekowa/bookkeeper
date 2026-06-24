import type { RunRecord, RunHandle } from './types.js'

// restart 重新派发后，把新句柄并回既有 run 记录。
// - launched 为 null（print 策略）：保持 existing 不变。
// - existing 为空或 strategy 变了：整体替换为 launched。
// - 同 strategy：替换 launched 涉及的服务句柄，保留其余服务与原 startedAt。
export function mergeRun(
  existing: RunRecord | undefined,
  launched: RunHandle | null,
  startedAt: string,
): RunRecord | null {
  if (!launched) return existing ?? null
  if (!existing || existing.strategy !== launched.strategy)
    return { ...launched, startedAt }
  const others = existing.services.filter(o => !launched.services.some(r => r.name === o.name))
  return {
    strategy: existing.strategy,
    startedAt: existing.startedAt,
    tmuxSession: launched.tmuxSession ?? existing.tmuxSession,
    services: [...others, ...launched.services],
  }
}
