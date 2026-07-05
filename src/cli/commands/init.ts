// src/cli/commands/init.ts
import type { Command } from 'commander'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { detectType } from '../../frameworks/registry.js'
import { discoverSpringBootServices } from '../../frameworks/springboot.js'
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

/** 容器目录下若有 maven-settings*.xml（私有镜像等），启动/安装命令需带 `-s <file>`。 */
function detectMavenSettings(containerDir: string): string | null {
  try {
    return readdirSync(containerDir).find(x => /^maven-settings.*\.xml$/.test(x)) ?? null
  } catch { return null }
}

function sbRunCommand(moduleRelPath: string, settings: string | null): string {
  const s = settings ? `-s ${settings} ` : ''
  return `mvn ${s}spring-boot:run -pl ${moduleRelPath} -Dmaven.test.skip=true -Dspring-boot.run.jvmArguments=-DSERVER_PORT={port}`
}

function sbInstallCommand(settings: string | null): string {
  const s = settings ? `-s ${settings} ` : ''
  return `mvn ${s}install -Dmaven.test.skip=true -Dcheckstyle.skip=true -Dspotbugs.skip=true -Denforcer.skip=true`
}
function detectViteApiEnvs(dir: string): { name: string; url: string }[] {
  const files = ['.env', '.env.example', '.env.local', '.env.development']
  const out: { name: string; url: string }[] = []
  const seen = new Set<string>()
  for (const f of files) {
    const p = join(dir, f)
    if (!existsSync(p)) continue
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(
        /^\s*(VITE_[A-Z0-9_]+)\s*=\s*["']?(https?:\/\/(?:localhost|127\.0\.0\.1):\d+[^\s"']*)["']?\s*$/)
      if (m && !seen.has(m[1])) { seen.add(m[1]); out.push({ name: m[1], url: m[2] }) }
    }
  }
  return out
}

export function buildConfigDraft(projectDir: string): string {
  const subdirs = readdirSync(projectDir)
    .filter(d => { try { return statSync(join(projectDir, d)).isDirectory() } catch { return false } })
  const detected: { name: string; type: string | null; dir: string; module?: string; settings?: string | null }[] = []
  const rootType = detectType(projectDir)
  if (rootType) detected.push({ name: basename(projectDir), type: rootType, dir: '.' })
  for (const d of subdirs) {
    const abs = join(projectDir, d)
    // springboot 多模块容器（如 backend/）：展开为每微服务一条，dir 指向 Maven 根
    const sbServices = discoverSpringBootServices(abs)
    if (sbServices.length) {
      const settings = detectMavenSettings(abs)
      for (const svc of sbServices)
        detected.push({ name: svc.name, type: 'springboot', dir: d, module: svc.moduleRelPath, settings })
    } else {
      detected.push({ name: d, type: detectType(abs), dir: d })
    }
  }
  const services = detected.filter(d => d.type)

  const lines = [`project_name: ${basename(projectDir)}`, '', 'services:']
  let base = 10000
  let installHookEmitted = false
  for (const s of services) {
    lines.push(`  ${s.name}:`, `    type: ${s.type}`, `    port_base: ${base}`, `    dir: ${s.dir}`)
    if (s.module) {
      lines.push(`    command: '${sbRunCommand(s.module, s.settings ?? null)}'`)
      if (!installHookEmitted) {
        lines.push(`    post_allocate: '${sbInstallCommand(s.settings ?? null)}'  # 刷 m2：common/*.client/*-starter 入本地仓库`)
        installHookEmitted = true
      }
      lines.push(`    # TODO 按需补 -Dspring-boot.run.profiles=dev 等（profile/Nacos 密钥由项目定）`)
    }
    if (s.type === 'fastapi') lines.push(`    # app: app.main:app   # TODO fastapi 入口`)
    if (s.type === 'vite') {
      // 单后端假设：取第一个非 vite 服务作为占位符目标；多后端消歧属非目标
      const target = services.find(x => x.type !== 'vite')?.name ?? 'backend'
      const apiEnvs = detectViteApiEnvs(join(projectDir, s.dir))
      if (apiEnvs.length) {
        lines.push('    envs:')
        for (const e of apiEnvs)
          lines.push(`      ${e.name}: ${e.url.replace(/:(\d+)/, `:{${target}.port}`)}`)
      } else {
        lines.push(
          '    # envs:                                        # 取消注释并按需填写',
          `    #   VITE_API_BASE: http://localhost:{${target}.port}`)
      }
    }
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
    '  postgres:',
    '    host: localhost',
    '    port: 5432',
    '    username: postgres',
    '    password: postgres',
    '  redis:',
    '    host: localhost',
    '    port: 6379',
    '    isolation: db_number',
    '  minio:',
    '    endpoint: localhost:9000',
    '    access_key: minioadmin',
    '    secret_key: minioadmin')
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
