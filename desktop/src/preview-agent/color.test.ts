import { describe, expect, it } from 'vitest'
import { formatCssColor, isDarkColor, parseCssColor, toHexColor } from './color'

describe('parseCssColor', () => {
  it('解析 getComputedStyle 常见的 rgb / rgba 写法', () => {
    expect(parseCssColor('rgb(26, 29, 41)')).toEqual({ r: 26, g: 29, b: 41, a: 1 })
    expect(parseCssColor('rgba(255, 255, 255, 0.5)')).toEqual({ r: 255, g: 255, b: 255, a: 0.5 })
    expect(parseCssColor('rgba(0, 0, 0, 0)')).toEqual({ r: 0, g: 0, b: 0, a: 0 })
  })

  it('解析 hex 的 3/4/6/8 位写法', () => {
    expect(parseCssColor('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 })
    expect(parseCssColor('#1a1d29')).toEqual({ r: 26, g: 29, b: 41, a: 1 })
    expect(parseCssColor('#ff000080')).toEqual({ r: 255, g: 0, b: 0, a: 128 / 255 })
    expect(parseCssColor('#F00')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
  })

  it('解析 transparent 与现代空格 / 斜杠语法', () => {
    expect(parseCssColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 })
    expect(parseCssColor('rgb(10 20 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 })
    expect(parseCssColor('rgb(10 20 30 / 50%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 })
  })

  it('把越界通道夹回 0-255、alpha 夹回 0-1', () => {
    expect(parseCssColor('rgb(300, -20, 12)')).toEqual({ r: 255, g: 0, b: 12, a: 1 })
    expect(parseCssColor('rgba(0, 0, 0, 2)')).toEqual({ r: 0, g: 0, b: 0, a: 1 })
  })

  it('认不出来的写法返回 null，不猜颜色', () => {
    expect(parseCssColor('')).toBeNull()
    expect(parseCssColor('   ')).toBeNull()
    expect(parseCssColor('rebeccapurple')).toBeNull()
    expect(parseCssColor('#ab')).toBeNull()
    expect(parseCssColor('#abcde')).toBeNull()
    expect(parseCssColor('rgb(1, 2)')).toBeNull()
    expect(parseCssColor('rgb(1, 2, 3, 4, 5)')).toBeNull()
    expect(parseCssColor('rgb(a, b, c)')).toBeNull()
    expect(parseCssColor('color(srgb 0 0 0)')).toBeNull()
  })
})

describe('toHexColor', () => {
  it('补零输出 6 位 hex 并丢弃 alpha', () => {
    expect(toHexColor({ r: 26, g: 29, b: 41, a: 1 })).toBe('#1a1d29')
    expect(toHexColor({ r: 0, g: 0, b: 0, a: 0 })).toBe('#000000')
    expect(toHexColor({ r: 255, g: 255, b: 255, a: 0.2 })).toBe('#ffffff')
  })
})

describe('formatCssColor', () => {
  it('不透明写 hex、半透明写 rgba、全透明写 transparent', () => {
    expect(formatCssColor({ r: 26, g: 29, b: 41, a: 1 })).toBe('#1a1d29')
    expect(formatCssColor({ r: 255, g: 0, b: 0, a: 0.5 })).toBe('rgba(255, 0, 0, 0.5)')
    expect(formatCssColor({ r: 12, g: 34, b: 56, a: 0 })).toBe('transparent')
  })

  it('alpha 保留三位小数避免浮点噪声', () => {
    expect(formatCssColor({ r: 0, g: 0, b: 0, a: 128 / 255 })).toBe('rgba(0, 0, 0, 0.502)')
  })

  it('与 parseCssColor 往返一致', () => {
    for (const value of ['#1a1d29', 'rgba(255, 0, 0, 0.5)', 'transparent']) {
      expect(formatCssColor(parseCssColor(value)!)).toBe(value)
    }
  })
})

describe('isDarkColor', () => {
  it('按感知亮度判断深浅', () => {
    expect(isDarkColor({ r: 0, g: 0, b: 0, a: 1 })).toBe(true)
    expect(isDarkColor({ r: 26, g: 29, b: 41, a: 1 })).toBe(true)
    expect(isDarkColor({ r: 255, g: 255, b: 255, a: 1 })).toBe(false)
    expect(isDarkColor({ r: 255, g: 255, b: 0, a: 1 })).toBe(false)
  })
})
