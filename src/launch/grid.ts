// 均匀网格形状（wt 与 iterm 共用）：cols = ceil(sqrt(n))，列优先填充。
// 返回每列格数（数组长度即列数）；n<=0 返回 []。
export function gridShape(n: number): number[] {
  if (n <= 0) return []
  const cols = Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  const fullCols = n - cols * (rows - 1)
  return Array.from({ length: cols }, (_, c) => (c < fullCols ? rows : rows - 1))
}
