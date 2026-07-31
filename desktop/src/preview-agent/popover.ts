export type EditInput = { text?: string; color?: string; background?: string; opacity?: string; fontFamily?: string }
export type EditDiff = {
  text?: { from: string; to: string }; color?: { from: string; to: string }
  background?: { from: string; to: string }; opacity?: { from: string; to: string }; fontFamily?: { from: string; to: string }
}

function isTextFormControl(el: HTMLElement): el is HTMLInputElement | HTMLTextAreaElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
}

/** 表单控件的文本在 value 上，textContent 恒为空 —— 直接读 textContent 会让输入框的文本字段永远空白。 */
export function readElementText(el: HTMLElement): string {
  return isTextFormControl(el) ? el.value : el.textContent ?? ''
}

export function writeElementText(el: HTMLElement, text: string): void {
  if (isTextFormControl(el)) el.value = text
  else el.textContent = text
}

/** 改文本会把子树夷平成一段纯文本，所以只对表单控件和无元素子节点的元素开放。 */
export function canEditText(el: HTMLElement): boolean {
  return isTextFormControl(el) || el.children.length === 0
}

export function applyEdit(el: HTMLElement, input: EditInput): EditDiff {
  const cs = window.getComputedStyle(el)
  const diff: EditDiff = {}
  if (input.text != null) {
    const from = readElementText(el)
    if (input.text !== from) { diff.text = { from, to: input.text }; writeElementText(el, input.text) }
  }
  if (input.color) { diff.color = { from: cs.color, to: input.color }; el.style.color = input.color }
  if (input.background) { diff.background = { from: cs.backgroundColor, to: input.background }; el.style.background = input.background }
  // '0' 是合法且有意义的不透明度，不能被 falsy 判断吃掉
  if (input.opacity != null && input.opacity !== '') { diff.opacity = { from: cs.opacity, to: input.opacity }; el.style.opacity = input.opacity }
  if (input.fontFamily) { diff.fontFamily = { from: cs.fontFamily, to: input.fontFamily }; el.style.fontFamily = input.fontFamily }
  return diff
}
