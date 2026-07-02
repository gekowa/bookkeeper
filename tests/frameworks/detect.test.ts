import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { detectType } from '../../src/frameworks/registry.js'

const fx = (p: string) => join(__dirname, '..', 'fixtures', p)

describe('detectType', () => {
  it('manage.py → django', () => expect(detectType(fx('django-proj'))).toBe('django'))
  it('pyproject 含 fastapi → fastapi', () => expect(detectType(fx('fastapi-proj'))).toBe('fastapi'))
  it('vite.config → vite', () => expect(detectType(fx('vite-proj'))).toBe('vite'))
  it('无特征 → null', () => expect(detectType(fx('.'))).toBe(null))
  it('arq/celery adapter detect 恒为 false（不污染目录侦测）', async () => {
    const { arq } = await import('../../src/frameworks/arq.js')
    const { celery } = await import('../../src/frameworks/celery.js')
    expect(arq.detect(fx('fastapi-proj'))).toBe(false)
    expect(celery.detect(fx('fastapi-proj'))).toBe(false)
  })
  it('pom.xml 含 spring-boot → springboot', () => expect(detectType(fx('springboot-proj'))).toBe('springboot'))
  it('build.gradle 含 org.springframework.boot → springboot', () => expect(detectType(fx('springboot-proj-gradle'))).toBe('springboot'))
})
