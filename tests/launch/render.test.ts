import { describe, it, expect } from 'vitest'
import { renderPosix, renderPowerShell } from '../../src/launch/render.js'

describe('renderPosix', () => {
  it('env 前缀 + 单引号包裹每个 argv 元素', () => {
    expect(renderPosix({ K: 'v' }, ['java', '-jar', 'app.jar']))
      .toBe(`K='v' 'java' '-jar' 'app.jar'`)
  })
  it('含空格的元素整体括起，不被拆断', () => {
    expect(renderPosix({}, ['mvn', 'spring-boot:run', '-Dargs=--a=1 --b=2']))
      .toBe(`'mvn' 'spring-boot:run' '-Dargs=--a=1 --b=2'`)
  })
  it('值里的单引号被转义', () => {
    expect(renderPosix({ K: `a'b` }, ['x'])).toBe(`K='a'\\''b' 'x'`)
  })
  it('无 env 时无前缀', () => expect(renderPosix({}, ['x'])).toBe(`'x'`))
  it('空 argv 无 env 时返回空字符串', () => expect(renderPosix({}, [])).toBe(''))
  it('空 argv 有 env 时返回仅环境前缀', () => expect(renderPosix({ K: 'v' }, [])).toBe(`K='v' `))
})

describe('renderPowerShell', () => {
  it('$env 前缀 + 调用算子 + 单引号', () => {
    expect(renderPowerShell({ K: 'v' }, ['java', '-jar', 'app.jar']))
      .toBe(`$env:K='v'; & 'java' '-jar' 'app.jar'`)
  })
  it('含空格元素整体括起', () => {
    expect(renderPowerShell({}, ['mvn', '-Dargs=--a=1 --b=2']))
      .toBe(`& 'mvn' '-Dargs=--a=1 --b=2'`)
  })
  it('值里单引号翻倍转义', () => {
    expect(renderPowerShell({}, [`a'b`])).toBe(`& 'a''b'`)
  })
  it('空 argv 无 env 时返回空字符串', () => expect(renderPowerShell({}, [])).toBe(''))
  it('空 argv 有 env 时返回仅环境前缀', () => expect(renderPowerShell({ K: 'v' }, [])).toBe(`$env:K='v'; `))
})
