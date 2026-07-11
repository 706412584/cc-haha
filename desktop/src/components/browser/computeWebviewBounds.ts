export type WebviewBounds = { x: number; y: number; width: number; height: number }

export function computeWebviewBounds(rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>): WebviewBounds {
  return {
    x: rect.left,
    y: rect.top,
    width: Math.max(0, rect.width),
    height: Math.max(0, rect.height),
  }
}
