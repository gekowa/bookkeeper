// iTerm 均匀网格的几何计算（纯函数，不碰 AppleScript）
export type SplitDir = 'v' | 'h'
export interface SplitStep { target: number; dir: SplitDir; next: number }
export interface GridPlan {
  paneCount: number
  steps: SplitStep[]
  order: number[]
}

interface Seg { id: number; pos: number; size: number } // size 仅用于挑「最大段」，不下发给 iTerm

export function planGrid(n: number): GridPlan {
  if (n <= 0) return { paneCount: 0, steps: [], order: [] }
  if (n === 1) return { paneCount: 1, steps: [], order: [0] }

  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  // 列优先填充：前 fullCols 列放满 rows 格，其余列放 rows-1 格
  const fullCols = n - cols * (rows - 1)
  const colCounts = Array.from({ length: cols }, (_, c) => (c < fullCols ? rows : rows - 1))

  const steps: SplitStep[] = []
  let nextId = 1

  // 把 rootId 这个 session 按「反复切最大段」二分成 count 个，返回子段（按 pos 升序）
  function bisect(rootId: number, count: number, dir: SplitDir): Seg[] {
    const segs: Seg[] = [{ id: rootId, pos: 0, size: 1 }]
    while (segs.length < count) {
      let mi = 0 // 最大段下标（平局取最靠前，保证确定性）
      for (let i = 1; i < segs.length; i++) if (segs[i].size > segs[mi].size + 1e-9) mi = i
      const t = segs[mi]
      const id = nextId++
      steps.push({ target: t.id, dir, next: id })
      const half = t.size / 2 // 新段在「右/下」（pos 更大的一侧）
      segs.splice(mi, 1, { id: t.id, pos: t.pos, size: half }, { id, pos: t.pos + half, size: half })
    }
    return [...segs].sort((a, b) => a.pos - b.pos)
  }

  // 阶段1：建列（垂直切）；阶段2：每列建行（水平切）
  const colSegs = bisect(0, cols, 'v')
  const panes: { col: number; row: number; id: number }[] = []
  colSegs.forEach((cs, col) => {
    bisect(cs.id, colCounts[col], 'h').forEach((rs, row) => panes.push({ col, row, id: rs.id }))
  })

  // 列优先排序 → order[k] = 第 k 个 service 应写入的 session 下标
  panes.sort((a, b) => a.col - b.col || a.row - b.row)
  return { paneCount: n, steps, order: panes.map(p => p.id) }
}
