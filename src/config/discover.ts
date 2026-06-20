import { existsSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { BkError, Codes } from '../core/errors.js'

export function discoverProjectRoot(startDir: string): string {
  let dir = startDir
  const rootPath = parse(dir).root
  while (true) {
    if (existsSync(join(dir, 'bk_config.yml'))) return dir
    if (dir === rootPath) break
    dir = dirname(dir)
  }
  throw new BkError(Codes.CONFIG_INVALID,
    '未找到 bk_config.yml；请在项目内运行，或先 `bk init`。',
    { remediation: '在 main 仓库根运行 `bk init`' })
}
