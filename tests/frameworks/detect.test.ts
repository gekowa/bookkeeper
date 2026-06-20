import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { detectType } from '../../src/frameworks/registry.js'

const fx = (p: string) => join(__dirname, '..', 'fixtures', p)

describe('detectType', () => {
  it('manage.py → django', () => expect(detectType(fx('django-proj'))).toBe('django'))
  it('pyproject 含 fastapi → fastapi', () => expect(detectType(fx('fastapi-proj'))).toBe('fastapi'))
  it('vite.config → vite', () => expect(detectType(fx('vite-proj'))).toBe('vite'))
  it('无特征 → null', () => expect(detectType(fx('.'))).toBe(null))
})
