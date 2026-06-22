import { describe, it, expect } from 'vitest'
import { planGrid, type GridPlan } from '../../src/launch/itermGrid.js'

// 按 steps 模拟分屏，重建每个 session 的矩形（窗口归一化到 1×1）
function simulate(plan: GridPlan): Map<number, { x: number; y: number; w: number; h: number }> {
  const rect = new Map<number, { x: number; y: number; w: number; h: number }>()
  if (plan.paneCount >= 1) rect.set(0, { x: 0, y: 0, w: 1, h: 1 })
  for (const s of plan.steps) {
    const r = rect.get(s.target)!
    if (s.dir === 'v') {
      rect.set(s.target, { ...r, w: r.w / 2 })
      rect.set(s.next, { x: r.x + r.w / 2, y: r.y, w: r.w / 2, h: r.h })
    } else {
      rect.set(s.target, { ...r, h: r.h / 2 })
      rect.set(s.next, { x: r.x, y: r.y + r.h / 2, w: r.w, h: r.h / 2 })
    }
  }
  return rect
}

function ratio(values: number[]): number {
  return Math.max(...values) / Math.min(...values)
}

describe('planGrid 边界', () => {
  it('n<=0 → 空计划', () => {
    expect(planGrid(0)).toEqual({ paneCount: 0, steps: [], order: [] })
    expect(planGrid(-3)).toEqual({ paneCount: 0, steps: [], order: [] })
  })
  it('n=1 → 单 pane 无 split', () => {
    expect(planGrid(1)).toEqual({ paneCount: 1, steps: [], order: [0] })
  })
})

describe('planGrid 结构不变量', () => {
  for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10, 12]) {
    it(`n=${n}: pane 数、step 数、order 是 0..n-1 的排列`, () => {
      const p = planGrid(n)
      expect(p.paneCount).toBe(n)
      expect(p.steps.length).toBe(n - 1)
      // next 恒为 1..n-1 递增
      expect(p.steps.map(s => s.next)).toEqual(Array.from({ length: n - 1 }, (_, i) => i + 1))
      // 每个 target 在它出现前必须已存在（0 或更早的 next）
      const seen = new Set([0])
      for (const s of p.steps) { expect(seen.has(s.target)).toBe(true); seen.add(s.next) }
      // order 是 0..n-1 的排列
      expect([...p.order].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i))
    })
  }
})

describe('planGrid 均匀度（列宽比/行高比 ≤ 2）', () => {
  for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10, 12]) {
    it(`n=${n}: 所有 pane 宽比≤2、高比≤2`, () => {
      const p = planGrid(n)
      const rects = [...simulate(p).values()]
      expect(ratio(rects.map(r => r.w))).toBeLessThanOrEqual(2 + 1e-9)
      expect(ratio(rects.map(r => r.h))).toBeLessThanOrEqual(2 + 1e-9)
    })
  }
  for (const n of [1, 2, 4]) {
    it(`n=${n}: 严格等分（所有 pane 等面积）`, () => {
      const rects = [...simulate(planGrid(n)).values()]
      const areas = rects.map(r => r.w * r.h)
      expect(ratio(areas)).toBeCloseTo(1, 9)
    })
  }
})

describe('planGrid 列优先映射', () => {
  it('n=3: order 把 service 落到 左上→左下→右整列', () => {
    const p = planGrid(3)
    const rect = simulate(p)
    const pos = p.order.map(id => rect.get(id)!)
    // service0 左上、service1 左下、service2 右列（x 更大、占满高度）
    expect(pos[0].x).toBeCloseTo(0); expect(pos[0].y).toBeCloseTo(0)
    expect(pos[1].x).toBeCloseTo(0); expect(pos[1].y).toBeCloseTo(0.5)
    expect(pos[2].x).toBeGreaterThan(0); expect(pos[2].h).toBeCloseTo(1)
  })
})
