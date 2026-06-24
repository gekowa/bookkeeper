import { describe, it, expect } from 'vitest'
import { buildItermScript } from '../../src/launch/iterm.js'
import { planGrid } from '../../src/launch/itermGrid.js'
import type { LaunchSpec } from '../../src/launch/index.js'

const mk = (n: number): LaunchSpec[] =>
  Array.from({ length: n }, (_, i) => ({ name: `s${i}`, command: `run ${i}`, cwd: `/w/${i}` }))

describe('buildItermScript', () => {
  it('开窗 + 捕获首个 session 为 s0', () => {
    const lines = buildItermScript(mk(2), planGrid(2))
    expect(lines).toContain('tell application "iTerm2"')
    expect(lines).toContain('create window with default profile')
    expect(lines).toContain('set s0 to (current session of current window)')
    expect(lines[lines.length - 1]).toBe('end tell')
  })

  it('每个 split step 渲染成对应方向、并把新 session 存进 s{next}', () => {
    const plan = planGrid(2) // 1 个垂直 split：{target:0,dir:"v",next:1}
    const lines = buildItermScript(mk(2), plan).join('\n')
    expect(lines).toContain('tell s0')
    expect(lines).toContain('set s1 to (split vertically with default profile)')
  })

  it('水平 split 渲染成 split horizontally', () => {
    const plan = planGrid(3) // 含一个 dir:"h" 的 step
    const lines = buildItermScript(mk(3), plan).join('\n')
    expect(lines).toContain('set s2 to (split horizontally with default profile)')
  })

  it('按 order 把第 k 个 service 的命令写进对应 session，且 cd 到 cwd', () => {
    const specs = mk(3)
    const plan = planGrid(3)
    expect(plan.order).toEqual([0, 2, 1]) // 固定映射，若 planGrid 变了此处先报警
    const text = buildItermScript(specs, plan).join('\n')
    // service0 → s0：tell 紧跟其 write
    expect(text).toContain('tell s0\nwrite text "cd /w/0 && run 0"')
    // service2 → s1：证明走的是 order 映射而非 service 下标
    expect(text).toContain('tell s1\nwrite text "cd /w/2 && run 2"')
  })

  it('命令与路径中的双引号被转义', () => {
    const specs: LaunchSpec[] = [{ name: 'a', command: 'echo "hi"', cwd: '/w/a b' }]
    const lines = buildItermScript(specs, planGrid(1)).join('\n')
    expect(lines).toContain('write text "cd /w/a b && echo \\"hi\\""')
  })

  it('cwd 中的双引号也被转义', () => {
    const specs: LaunchSpec[] = [{ name: 'a', command: 'run', cwd: '/w/a"b' }]
    const text = buildItermScript(specs, planGrid(1)).join('\n')
    expect(text).toContain('write text "cd /w/a\\"b && run"')
  })

  it('n=1 不产生任何 split', () => {
    const lines = buildItermScript(mk(1), planGrid(1)).join('\n')
    expect(lines).not.toContain('split ')
  })

  it('反斜杠被转义（避免破坏 AppleScript 字符串）', () => {
    const specs: LaunchSpec[] = [{ name: 'a', command: 'run', cwd: '/w/a\\b' }]
    const text = buildItermScript(specs, planGrid(1)).join('\n')
    // 源串里的单个反斜杠应渲染成两个
    expect(text).toContain('write text "cd /w/a\\\\b && run"')
  })

  it('末尾按 order 返回各 session 的 unique id（在 end tell 之前）', () => {
    const lines = buildItermScript(mk(3), planGrid(3)) // order = [0,2,1]
    const ret = lines[lines.length - 2]
    expect(ret).toBe('return {unique id of s0, unique id of s2, unique id of s1}')
    expect(lines[lines.length - 1]).toBe('end tell')
  })
  it('n=1：返回单个 unique id', () => {
    const lines = buildItermScript(mk(1), planGrid(1))
    expect(lines[lines.length - 2]).toBe('return {unique id of s0}')
  })
})
