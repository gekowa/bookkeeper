import { describe, it, expect } from 'vitest'
import { gridShape } from '../../src/launch/grid.js'

describe('gridShape', () => {
  it('n<=0 → []', () => {
    expect(gridShape(0)).toEqual([])
    expect(gridShape(-1)).toEqual([])
  })
  const cases: [number, number[]][] = [
    [1, [1]], [2, [1, 1]], [3, [2, 1]], [4, [2, 2]], [5, [2, 2, 1]],
    [6, [2, 2, 2]], [7, [3, 2, 2]], [10, [3, 3, 2, 2]], [12, [3, 3, 3, 3]],
  ]
  for (const [n, want] of cases)
    it(`n=${n} → [${want.join(',')}]`, () => expect(gridShape(n)).toEqual(want))
  it('总格数守恒：sum(colCounts) === n（n=1..30）', () => {
    for (let n = 1; n <= 30; n++)
      expect(gridShape(n).reduce((a, b) => a + b, 0)).toBe(n)
  })
})
