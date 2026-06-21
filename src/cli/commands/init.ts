// src/cli/commands/init.ts
import type { Command } from 'commander'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { detectType } from '../../frameworks/registry.js'
import { ensureGitignore } from '../../inject/gitignore.js'
import { runCommand } from '../context.js'
import { success, warn } from '../output.js'

function detectWorkerLibs(dir: string): ('arq' | 'celery')[] {
  const p = join(dir, 'pyproject.toml')
  if (!existsSync(p)) return []
  const text = readFileSync(p, 'utf8')
  const libs: ('arq' | 'celery')[] = []
  if (/\barq\b/.test(text)) libs.push('arq')
  if (/\bcelery\b/.test(text)) libs.push('celery')
  return libs
}

export function buildConfigDraft(projectDir: string): string {
  const subdirs = readdirSync(projectDir)
    .filter(d => { try { return statSync(join(projectDir, d)).isDirectory() } catch { return false } })
  const detected: { name: string; type: string | null; dir: string }[] = []
  const rootType = detectType(projectDir)
  if (rootType) detected.push({ name: basename(projectDir), type: rootType, dir: '.' })
  for (const d of subdirs) detected.push({ name: d, type: detectType(join(projectDir, d)), dir: d })
  const services = detected.filter(d => d.type)

  const lines = ['---', `project_name: ${basename(projectDir)}`, '', 'services:']
  let base = 10000
  for (const s of services) {
    lines.push(`  ${s.name}:`, `    type: ${s.type}`, `    port_base: ${base}`, `    dir: ${s.dir}`)
    if (s.type === 'fastapi') lines.push(`    # app: app.main:app   # TODO fastapi 入口`)
    for (const lib of detectWorkerLibs(join(projectDir, s.dir))) {
      lines.push(
        `  # ${s.name}_worker:`,
        `  #   type: ${lib}`,
        `  #   dir: ${s.dir}`,
        `  #   app: app.worker   # TODO 填 ${lib === 'arq' ? 'WorkerSettings 所在模块' : 'celery app 模块'}`)
    }
    base += 100
  }
  if (!services.length) lines.push('  # TODO 未侦测到 service，请手动填写')
  lines.push('', 'infra:',
    '  postgres: { host: localhost, port: 5432, username: postgres, password: postgres }',
    '  redis: { host: localhost, port: 6379, isolation: db_number }',
    '  minio: { endpoint: localhost:9000, access_key: minioadmin, secret_key: minioadmin }')
  return lines.join('\n') + '\n'
}

export function registerInit(program: Command) {
  program.command('init').description('侦测当前项目并生成 bk_config.yml 草稿')
    .option('--force', '覆盖已存在的 bk_config.yml')
    .action((opts: { force?: boolean }) => runCommand(async () => {
      const dir = process.cwd()
      const target = join(dir, 'bk_config.yml')
      if (existsSync(target) && !opts.force) { warn('bk_config.yml 已存在，加 --force 覆盖'); return }
      writeFileSync(target, buildConfigDraft(dir))
      ensureGitignore(dir, ['.env'])
      success('已生成 bk_config.yml 草稿，请审核（尤其 infra 凭据与 fastapi app 字段）后再使用')
    }))
}
