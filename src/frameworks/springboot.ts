import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FrameworkAdapter } from './types.js'
import { backendEnvVars } from './backendEnv.js'

function pickBuildTool(dir: string): { tool: 'maven' | 'gradle'; runner: string } {
  if (existsSync(join(dir, 'pom.xml')))
    return { tool: 'maven', runner: existsSync(join(dir, 'mvnw')) ? './mvnw' : 'mvn' }
  return { tool: 'gradle', runner: existsSync(join(dir, 'gradlew')) ? './gradlew' : 'gradle' }
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
