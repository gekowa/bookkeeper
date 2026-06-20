import { describe, it, expect } from 'vitest'
import { pickNumber } from '../../src/core/numbering.js'
import type { StateFile } from '../../src/state/schema.js'

const mk = (sets: Record<string, 'allocated' | 'free'>): StateFile => ({
  project_name: 'foo', config_fingerprint: '',
  sets: Object.fromEntries(Object.entries(sets).map(([n, st]) =>
    [n, { status: st, owner: null, resources: {}, created_at: 'x' }])),
})

describe('pickNumber', () => {
  it('空状态返回 1、非复用', () => {
    expect(pickNumber(mk({}))).toEqual({ n: 1, reuse: false })
  })
  it('有 free set 时复用最小 free', () => {
    expect(pickNumber(mk({ '1': 'allocated', '3': 'free', '4': 'free' }))).toEqual({ n: 3, reuse: true })
  })
  it('无 free 时取最小空洞', () => {
    expect(pickNumber(mk({ '1': 'allocated', '2': 'allocated' }))).toEqual({ n: 3, reuse: false })
  })
  it('填补销毁后的空洞', () => {
    expect(pickNumber(mk({ '1': 'allocated', '3': 'allocated' }))).toEqual({ n: 2, reuse: false })
  })
})
