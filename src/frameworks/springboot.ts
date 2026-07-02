import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FrameworkAdapter } from './types.js'
import { BkError, Codes } from '../core/errors.js'

const SPRING = /org\.springframework\.boot/
const AGGREGATOR = /<packaging>\s*pom\s*<\/packaging>/

function detect(dir: string): boolean {
  const pom = join(dir, 'pom.xml')
  if (existsSync(pom)) {
    const t = readFileSync(pom, 'utf8')
    return SPRING.test(t) && !AGGREGATOR.test(t)
  }
  for (const g of ['build.gradle', 'build.gradle.kts']) {
    const p = join(dir, g)
    if (existsSync(p) && SPRING.test(readFileSync(p, 'utf8'))) return true
  }
  return false
}

export const springboot: FrameworkAdapter = {
  type: 'springboot',
  defaultInjectionMode: 'startupArgs',
  detect,
  defaultStartCommand: (svc) => {
    throw new BkError(Codes.CONFIG_INVALID,
      `springboot service ${svc.name} 没有默认启动命令，请配置 startCommand`,
      { remediation: 'mvn / gradle / java -jar 各异，需在 bk_config.yml 显式写 startCommand 数组' })
  },
  envVars: () => ({}),
}
