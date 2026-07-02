import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, basename } from 'node:path'
import type { FrameworkAdapter } from './types.js'
import { backendEnvVars } from './backendEnv.js'

function pickBuildTool(dir: string): { tool: 'maven' | 'gradle'; runner: string } {
  if (existsSync(join(dir, 'pom.xml')))
    return { tool: 'maven', runner: existsSync(join(dir, 'mvnw')) ? './mvnw' : 'mvn' }
  return { tool: 'gradle', runner: existsSync(join(dir, 'gradlew')) ? './gradlew' : 'gradle' }
}

/** 一个 Maven 模块「可被 spring-boot:run 运行」的可靠信号：pom 声明了 spring-boot-maven-plugin。 */
function hasSpringBootPlugin(pomPath: string): boolean {
  return existsSync(pomPath) && /spring-boot-maven-plugin/.test(readFileSync(pomPath, 'utf8'))
}

function childDirs(dir: string): string[] {
  return readdirSync(dir)
    .filter(d => { try { return statSync(join(dir, d)).isDirectory() } catch { return false } })
    .map(d => join(dir, d))
}

/**
 * 服务目录 s 的可运行模块：自身 pom 有 plugin（单模块，如 gateway）或某子模块 pom 有 plugin
 * （多模块，如 `<svc>/<svc>.server`）。都没有 → null（是库，如 common / *-starter）。
 */
function findRunnableModule(s: string): string | null {
  if (hasSpringBootPlugin(join(s, 'pom.xml'))) return s
  for (const child of childDirs(s)) if (hasSpringBootPlugin(join(child, 'pom.xml'))) return child
  return null
}

export interface SpringBootService { name: string; moduleRelPath: string }

/**
 * 在一个 Maven 容器目录（如 `backend/`）下发现可运行的 Spring Boot 微服务：遍历一级子目录，
 * 逐个 findRunnableModule。返回 `{ name, moduleRelPath }`（moduleRelPath 相对 container，
 * 可直接用于 `mvn ... -pl <moduleRelPath>`）。无 plugin 的库目录被过滤。
 */
export function discoverSpringBootServices(containerDir: string): SpringBootService[] {
  const out: SpringBootService[] = []
  for (const svcDir of childDirs(containerDir)) {
    const runnable = findRunnableModule(svcDir)
    if (runnable) out.push({ name: basename(svcDir), moduleRelPath: relative(containerDir, runnable) })
  }
  return out
}

export const springboot: FrameworkAdapter = {
  type: 'springboot',
  detect: (dir) => {
    const pom = join(dir, 'pom.xml')
    if (existsSync(pom)) return /spring-boot/.test(readFileSync(pom, 'utf8'))
    for (const f of ['build.gradle', 'build.gradle.kts']) {
      const p = join(dir, f)
      if (existsSync(p) && /org\.springframework\.boot/.test(readFileSync(p, 'utf8'))) return true
    }
    return false
  },
  defaultInjectionMode: 'startupArgs',
  defaultStartCommand: (_svc, dir) => {
    const { tool, runner } = pickBuildTool(dir)
    return tool === 'maven'
      ? `${runner} spring-boot:run -Dspring-boot.run.arguments="--server.port={port} {args}"`
      : `${runner} bootRun --args='--server.port={port} {args}'`
  },
  envVars: backendEnvVars,
}
