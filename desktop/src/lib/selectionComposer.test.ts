import { expect, it } from 'vitest'
import { buildSelectionBatchMessage, buildSelectionComposerText, buildSelectionDirectMessage } from './selectionComposer'

it('renders only the user instruction + concrete changes (no selector/DOM/page noise)', () => {
  const text = buildSelectionComposerText({
    pageUrl: 'http://127.0.0.1:4321/preview-fs/s1/index.html',
    sourceHint: 'index.html',
    element: { selector: '#title', tag: 'h1', text: '模型还没用熟', classes: [] } as never,
    change: { text: { from: '模型还没用熟', to: '模型用熟了' }, description: '标题改积极一点' } as never,
  })
  // 用户的话 + 具体改动在
  expect(text).toContain('标题改积极一点')
  expect(text).toContain('模型用熟了')
  // selector / 页面 URL / 「请在源码中落地」 等 DOM 噪音不在（截图才是引用）
  expect(text).not.toContain('#title')
  expect(text).not.toContain('index.html')
  expect(text).not.toContain('请在源码中落地')
})

it('returns empty text when there is no description or change (image alone is the reference)', () => {
  const text = buildSelectionComposerText({
    pageUrl: 'http://x/',
    element: { selector: '#t', tag: 'div', classes: [] } as never,
  })
  expect(text).toBe('')
})

it('builds a model prompt while keeping the visible selection label compact', () => {
  const message = buildSelectionDirectMessage({
    pageUrl: 'http://localhost:5174/',
    sourceHint: 'Todo preview',
    element: {
      selector: '#todo-title',
      tag: 'h1',
      text: 'Todo 管理',
      classes: ['title'],
      boundingBox: { x: 10, y: 20, w: 300, h: 80 },
    } as never,
    change: { description: '这个标题更轻一点' } as never,
  })

  expect(message.modelText).toContain('截图中编号 1')
  expect(message.modelText).toContain('<h1>')
  expect(message.modelText).toContain('#todo-title')
  expect(message.modelText).toContain('这个标题更轻一点')
  expect(message.displayName).toBe('<h1>')
  expect(message.note).toBe('这个标题更轻一点')
})

it('builds one numbered model prompt for a batch of selections', () => {
  const message = buildSelectionBatchMessage([
    {
      id: 'one',
      number: 1,
      payload: {
        pageUrl: 'http://localhost:5174/',
        element: { selector: '#title', tag: 'h1', classes: [] } as never,
        change: { description: '标题更轻一点' } as never,
      },
    },
    {
      id: 'three',
      number: 3,
      payload: {
        pageUrl: 'http://localhost:5174/',
        element: { selector: '#cta', tag: 'button', classes: [] } as never,
        change: { description: '按钮更醒目' } as never,
      },
    },
  ])

  expect(message.modelText).toContain('[元素 1]')
  expect(message.modelText).toContain('[元素 3]')
  expect(message.modelText).not.toContain('[元素 2]')
  expect(message.modelText).toContain('标题更轻一点')
  expect(message.modelText).toContain('按钮更醒目')
  expect(message.items.map((item) => item.displayName)).toEqual(['<h1>', '<button>'])
})
