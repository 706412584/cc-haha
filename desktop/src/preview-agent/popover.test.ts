import { describe, expect, it, beforeEach } from 'vitest'
import { applyEdit, canEditText, readElementText, writeElementText } from './popover'

beforeEach(() => { document.body.innerHTML = `<h1 id="t" style="color:rgb(0,0,0)">Old</h1>` })

describe('applyEdit', () => {
  it('applies text + color to the live DOM and returns a diff', () => {
    const el = document.getElementById('t')!
    const diff = applyEdit(el, { text: 'New', color: 'rgb(255,0,0)' })
    expect(el.textContent).toBe('New')
    expect(el.style.color).toBe('rgb(255, 0, 0)')
    expect(diff.text).toEqual({ from: 'Old', to: 'New' })
    expect(diff.color?.to).toBe('rgb(255,0,0)')
  })

  it('把不透明度 0 当作有效值写进去（而不是被 falsy 判断吃掉）', () => {
    const el = document.getElementById('t')!
    const diff = applyEdit(el, { opacity: '0' })
    expect(el.style.opacity).toBe('0')
    expect(diff.opacity?.to).toBe('0')
  })

  it('改表单控件的文本写 value 而不是 textContent', () => {
    document.body.innerHTML = '<input id="f" value="旧值">'
    const field = document.getElementById('f') as HTMLInputElement
    const diff = applyEdit(field, { text: '新值' })
    expect(field.value).toBe('新值')
    expect(diff.text).toEqual({ from: '旧值', to: '新值' })
  })
})

describe('readElementText / writeElementText', () => {
  it('表单控件读写 value，其余元素读写 textContent', () => {
    document.body.innerHTML = '<input id="f" value="v"><p id="p">t</p>'
    const field = document.getElementById('f') as HTMLInputElement
    const paragraph = document.getElementById('p')!
    expect(readElementText(field)).toBe('v')
    expect(readElementText(paragraph)).toBe('t')

    writeElementText(field, 'v2')
    writeElementText(paragraph, 't2')
    expect(field.value).toBe('v2')
    expect(paragraph.textContent).toBe('t2')
  })
})

describe('canEditText', () => {
  it('对表单控件和无子元素的节点开放，对容器关闭（避免夷平子树）', () => {
    document.body.innerHTML = '<input id="f"><p id="p">t</p><div id="d"><span>a</span></div>'
    expect(canEditText(document.getElementById('f')!)).toBe(true)
    expect(canEditText(document.getElementById('p')!)).toBe(true)
    expect(canEditText(document.getElementById('d')!)).toBe(false)
  })
})
