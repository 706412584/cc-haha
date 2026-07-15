import { describe, expect, it, vi } from 'vitest'

const pixi = vi.hoisted(() => {
  class Point {
    x = 0
    y = 0
    set(x: number, y = x) {
      this.x = x
      this.y = y
    }
  }

  class Container {
    children: Container[] = []
    visible = true
    alpha = 1
    position = new Point()
    addChild(...children: Container[]) {
      this.children.push(...children)
    }
  }

  class Graphics extends Container {
    clear = vi.fn(() => this)
    roundRect = vi.fn(() => this)
    fill = vi.fn(() => this)
    stroke = vi.fn(() => this)
    moveTo = vi.fn(() => this)
    lineTo = vi.fn(() => this)
    circle = vi.fn(() => this)
  }

  class Text extends Container {
    text: string
    anchor = new Point()
    constructor(options: { text: string }) {
      super()
      this.text = options.text
    }
    get width() { return this.text.length * 6 }
    get height() { return 12 }
  }

  return { Container, Graphics, Text }
})

vi.mock('pixi.js', () => pixi)

import { Bubble } from './Bubble'
import { StatusLabel } from './StatusLabel'

describe('Bubble', () => {
  it('shows text above its tail and expires after its duration', () => {
    const bubble = new Bubble()
    const message = bubble.children[1] as unknown as InstanceType<typeof pixi.Text>

    expect(bubble.visible).toBe(false)
    bubble.show('Review complete', 1)

    expect(bubble.visible).toBe(true)
    expect(message.text).toBe('Review complete')
    expect(message.position.y).toBeLessThan(Bubble.TAIL_TIP_Y)
    expect(bubble.update(0.75)).toBe(true)
    expect(bubble.alpha).toBeCloseTo(0.5)
    expect(bubble.update(0.25)).toBe(false)
    expect(bubble.visible).toBe(false)
  })

  it('does nothing while hidden and supports explicit hiding', () => {
    const bubble = new Bubble()
    expect(bubble.update(1)).toBe(false)
    bubble.show('Temporary')
    bubble.hide()
    expect(bubble.visible).toBe(false)
  })
})

describe('StatusLabel', () => {
  it('lays the name above the crown and a task above the name', () => {
    const label = new StatusLabel('Agent')
    const [taskBg, nameText, taskText] = label.children as unknown as [
      InstanceType<typeof pixi.Graphics>,
      InstanceType<typeof pixi.Text>,
      InstanceType<typeof pixi.Text>,
      InstanceType<typeof pixi.Graphics>,
    ]

    label.layout(-50)
    const withoutTask = label.getLabelTopY(-50)
    expect(label.position.y).toBe(-58)
    expect(taskBg.visible).toBe(false)

    label.setTask('Reviewing coverage')
    const withTask = label.getLabelTopY(-50)
    expect(taskBg.visible).toBe(true)
    expect(taskText.text).toBe('Reviewing coverage')
    expect(withTask).toBeLessThan(withoutTask)
    expect(taskText.position.y).toBeLessThan(nameText.position.y)

    label.setTask()
    expect(taskBg.visible).toBe(false)
    expect(taskText.text).toBe('')
  })

  it('updates name and accepts known and unknown states', () => {
    const label = new StatusLabel('Old')
    const nameText = label.children[1] as unknown as InstanceType<typeof pixi.Text>

    label.setName('New')
    label.setState('working')
    label.setState('unrecognized')

    expect(nameText.text).toBe('New')
  })
})
