import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { springboot } from '../../src/frameworks/springboot.js'
import type { ResolveContext, ServiceConfig } from '../../src/core/types.js'

function withDir(files: Record<string, string>, fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'sb-'))
  try { for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c); fn(dir) }
  finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('springboot.detect', () => {
  it('pom 含 spring-boot 且非聚合 → true', () =>
    withDir({ 'pom.xml': '<project><parent><groupId>org.springframework.boot</groupId></parent></project>' },
      (d) => expect(springboot.detect(d)).toBe(true)))
  it('父聚合 pom（packaging=pom）→ false', () =>
    withDir({ 'pom.xml': '<project><packaging>pom</packaging><dependency>org.springframework.boot</dependency></project>' },
      (d) => expect(springboot.detect(d)).toBe(false)))
  it('build.gradle 含 spring-boot → true', () =>
    withDir({ 'build.gradle': "plugins { id 'org.springframework.boot' version '3.2.0' }" },
      (d) => expect(springboot.detect(d)).toBe(true)))
  it('无特征 → false', () => withDir({ 'README.md': 'x' }, (d) => expect(springboot.detect(d)).toBe(false)))
})

describe('springboot.defaultStartCommand', () => {
  it('无默认命令 → CONFIG_INVALID 要求 startCommand', () => {
    const s: ServiceConfig = { name: 'api', type: 'springboot', port_base: 10200 }
    const rc: ResolveContext = { self: s, names: { ports: { api: 10202 } }, infra: {} }
    expect(() => springboot.defaultStartCommand(s, rc)).toThrow(/CONFIG_INVALID|startCommand/)
  })
})
