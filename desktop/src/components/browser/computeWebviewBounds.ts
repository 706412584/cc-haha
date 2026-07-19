export type WebviewBounds = { x: number; y: number; width: number; height: number }

export function computeWebviewBounds(
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  appZoom = 1,
): WebviewBounds {
  return {
    x: rect.left * appZoom,
    y: rect.top * appZoom,
    width: Math.max(0, rect.width * appZoom),
    height: Math.max(0, rect.height * appZoom),
  }
}
