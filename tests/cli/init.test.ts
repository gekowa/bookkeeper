// tests/cli/init.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { buildConfigDraft } from '../../src/cli/commands/init.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'proj-'))
  mkdirSync(join(dir, 'backend')); writeFileSync(join(dir, 'backend', 'manage.py'), '')
  mkdirSync(join(dir, 'frontend')); writeFileSync(join(dir, 'frontend', 'vite.config.ts'), '')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('buildConfigDraft', () => {
  it('侦测 backend=django、frontend=vite', () => {
    const yml = buildConfigDraft(dir)
    expect(yml).toContain('project_name:')
    expect(yml).toMatch(/backend:[\s\S]*type: django/)
    expect(yml).toMatch(/frontend:[\s\S]*type: vite/)
    expect(yml).toContain('port_base: 10000')
    expect(yml).toMatch(/backend:[\s\S]*dir: backend/)
    expect(yml).toMatch(/frontend:[\s\S]*dir: frontend/)
  })

  it('fastapi service 发出 # app: TODO 注释', () => {
    const apiDir = mkdtempSync(join(tmpdir(), 'proj-'))
    try {
      mkdirSync(join(apiDir, 'api'))
      writeFileSync(join(apiDir, 'api', 'pyproject.toml'), '[tool.poetry]\nname = "api"\ndependencies = ["fastapi"]\n')
      const yml = buildConfigDraft(apiDir)
      expect(yml).toMatch(/api:[\s\S]*type: fastapi/)
      expect(yml).toContain('# app: app.main:app   # TODO fastapi 入口')
    } finally {
      rmSync(apiDir, { recursive: true, force: true })
    }
  })

  it('未侦测到 service 发出 TODO 行', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'proj-'))
    try {
      const yml = buildConfigDraft(emptyDir)
      expect(yml).toContain('# TODO 未侦测到 service，请手动填写')
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  it('pyproject 含 arq 依赖 → 输出注释 worker stub', () => {
    const wdir = mkdtempSync(join(tmpdir(), 'proj-'))
    try {
      mkdirSync(join(wdir, 'backend'))
      writeFileSync(join(wdir, 'backend', 'pyproject.toml'),
        '[project]\ndependencies = ["fastapi>=0.100", "arq>=0.25"]\n')
      const yml = buildConfigDraft(wdir)
      expect(yml).toMatch(/backend:[\s\S]*type: fastapi/)
      expect(yml).toContain('#   type: arq')
      expect(yml).toContain('#   dir: backend')
    } finally {
      rmSync(wdir, { recursive: true, force: true })
    }
  })

  it('vite dir 有 .env.example 含 VITE_API_BASE → 写 envs（端口换占位符）', () => {
    writeFileSync(join(dir, 'frontend', '.env.example'), 'VITE_API_BASE=http://localhost:8000/api\n')
    const yml = buildConfigDraft(dir)
    expect(yml).toMatch(/frontend:[\s\S]*    envs:/)
    expect(yml).toContain('      VITE_API_BASE: http://localhost:{backend.port}/api')
  })

  it('vite dir 无 .env* → 写注释 envs stub', () => {
    const yml = buildConfigDraft(dir)
    expect(yml).toContain('    # envs:')
    expect(yml).toContain('    #   VITE_API_BASE: http://localhost:{backend.port}')
  })

  it('vite dir 的 VITE_* URL 无端口 → 不写 envs，落到注释 stub', () => {
    writeFileSync(join(dir, 'frontend', '.env.example'), 'VITE_API_BASE=http://localhost/api\n')
    const yml = buildConfigDraft(dir)
    expect(yml).toContain('    # envs:')
    expect(yml).not.toContain('      VITE_API_BASE:')
  })

  it('springboot 多模块容器：展开为多条服务 + -pl 命令 + 首条 install 钩子 + -s settings，过滤库', () => {
    const root = mkdtempSync(join(tmpdir(), 'proj-'))
    try {
      const back = join(root, 'backend')
      mkdirSync(back)
      writeFileSync(join(back, 'pom.xml'),
        '<project><packaging>pom</packaging><modules><module>pangumall-foo</module></modules></project>')
      writeFileSync(join(back, 'maven-settings-bytz.xml'), '<settings/>')
      // 多模块服务 foo：.server 有 plugin，-starter 无
      mkdirSync(join(back, 'pangumall-foo'))
      writeFileSync(join(back, 'pangumall-foo', 'pom.xml'), '<project><packaging>pom</packaging><modules><module>pangumall-foo.server</module></modules></project>')
      mkdirSync(join(back, 'pangumall-foo', 'pangumall-foo.server'))
      writeFileSync(join(back, 'pangumall-foo', 'pangumall-foo.server', 'pom.xml'),
        '<project><build><plugins><plugin>spring-boot-maven-plugin</plugin></plugins></build></project>')
      mkdirSync(join(back, 'pangumall-foo', 'pangumall-foo-starter'))
      writeFileSync(join(back, 'pangumall-foo', 'pangumall-foo-starter', 'pom.xml'), '<project/>')
      // 库：无 plugin → 过滤
      mkdirSync(join(back, 'pangumall-common'))
      writeFileSync(join(back, 'pangumall-common', 'pom.xml'), '<project/>')

      const yml = buildConfigDraft(root)
      expect(yml).toMatch(/pangumall-foo:[\s\S]*type: springboot/)
      expect(yml).toContain('    dir: backend')
      expect(yml).toContain('-pl pangumall-foo/pangumall-foo.server')
      expect(yml).toContain('-s maven-settings-bytz.xml')
      expect(yml).toContain('-DSERVER_PORT={port}')
      expect(yml).toMatch(/pangumall-foo:[\s\S]*post_allocate:/)
      expect(yml).toContain('mvn -s maven-settings-bytz.xml install')
      expect(yml).not.toMatch(/pangumall-common:[\s\S]*type: springboot/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('侦测 springboot（pom.xml 含 spring-boot）→ 草稿含 type: springboot', () => {
    const sdir = mkdtempSync(join(tmpdir(), 'proj-'))
    try {
      mkdirSync(join(sdir, 'api'))
      writeFileSync(join(sdir, 'api', 'pom.xml'),
        '<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId></parent></project>')
      const yml = buildConfigDraft(sdir)
      expect(yml).toMatch(/api:[\s\S]*type: springboot/)
      expect(yml).toMatch(/api:[\s\S]*dir: api/)
    } finally {
      rmSync(sdir, { recursive: true, force: true })
    }
  })
})
