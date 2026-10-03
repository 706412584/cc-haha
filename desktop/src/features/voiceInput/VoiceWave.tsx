import { memo, useEffect, useRef } from 'react'

const HEIGHT = 44
/** Idle undulation: the line stays visibly alive, but reads as flat. */
const BASE_AMPLITUDE = 0.04 * HEIGHT
/** Level smoothing time constants: rise quickly on speech, fall back slowly. */
const ATTACK_SECONDS = 0.06
const RELEASE_SECONDS = 0.35
/** Longest step folded into one frame, so a stalled tab does not lurch on return. */
const MAX_FRAME_SECONDS = 0.1
const POINT_SPACING = 2

/**
 * Three overlapping sine waves. Only the top one is fully opaque; the others
 * are thinner and fainter so the shape reads as one motion, not three lines.
 * `speed` is radians per second; all flow the same way at slightly different
 * rates, which keeps the layers drifting against each other.
 */
const LAYERS = [
  { wavelength: 150, speed: 1.8, offset: 0, scale: 1, lineWidth: 2, alpha: 1 },
  { wavelength: 104, speed: 1.3, offset: 1.7, scale: 0.68, lineWidth: 1.25, alpha: 0.42 },
  { wavelength: 76, speed: 2.4, offset: 3.4, scale: 0.48, lineWidth: 1, alpha: 0.26 },
] as const

type Props = {
  /** Input loudness in 0..1. Read every frame from a ref, so a new function identity never restarts the loop. */
  getLevel: () => number
  /** Animate from `getLevel`. Inactive draws a single calm line and does no work. */
  active: boolean
  className?: string
}

function readColor(canvas: HTMLCanvasElement): string {
  const style = getComputedStyle(canvas)
  return style.getPropertyValue('--color-brand').trim() || style.color
}

/**
 * A quiet, layered waveform for the recording level.
 *
 * Drawn straight onto a canvas from requestAnimationFrame: level changes never
 * touch React state, so the parent does not re-render 60 times a second.
 */
export const VoiceWave = memo(function VoiceWave({ getLevel, active, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const getLevelRef = useRef(getLevel)
  getLevelRef.current = getLevel

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d') ?? null
    if (!canvas || !context) return

    const reducedMotion = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
    let width = 0
    let pixelRatio = 1
    let color = readColor(canvas)
    let frame: number | null = null
    let lastTime = 0
    let phase = 0
    let level = 0

    const paint = () => {
      if (width <= 0) return
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
      context.clearRect(0, 0, width, HEIGHT)
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.strokeStyle = color

      const middle = HEIGHT / 2
      const amplitude = BASE_AMPLITUDE + level * (middle - BASE_AMPLITUDE - 2)
      for (const layer of LAYERS) {
        context.globalAlpha = layer.alpha
        context.lineWidth = layer.lineWidth
        context.beginPath()
        for (let x = 0; x <= width; x += POINT_SPACING) {
          // The envelope pins both ends to the centre line, so the wave floats
          // in the middle instead of hitting the edges.
          const envelope = Math.pow(Math.sin((Math.PI * x) / width), 1.6)
          const angle = (x / layer.wavelength) * Math.PI * 2 - phase * layer.speed + layer.offset
          const y = middle + Math.sin(angle) * amplitude * layer.scale * envelope
          if (x === 0) context.moveTo(x, y)
          else context.lineTo(x, y)
        }
        context.stroke()
      }
      context.globalAlpha = 1
    }

    const layout = (nextWidth: number) => {
      width = Math.max(0, Math.round(nextWidth))
      pixelRatio = window.devicePixelRatio || 1
      canvas.width = Math.round(width * pixelRatio)
      canvas.height = Math.round(HEIGHT * pixelRatio)
      color = readColor(canvas)
      paint()
    }

    const tick = (now: number) => {
      const elapsed = lastTime ? Math.min(MAX_FRAME_SECONDS, (now - lastTime) / 1000) : 0
      lastTime = now
      const target = Math.max(0, Math.min(1, getLevelRef.current()))
      const seconds = target > level ? ATTACK_SECONDS : RELEASE_SECONDS
      level += (target - level) * (1 - Math.exp(-elapsed / seconds))
      if (!reducedMotion?.matches) phase += elapsed
      paint()
      frame = requestAnimationFrame(tick)
    }
    const start = () => {
      if (frame !== null || document.hidden) return
      lastTime = 0
      frame = requestAnimationFrame(tick)
    }
    const stop = () => {
      if (frame === null) return
      cancelAnimationFrame(frame)
      frame = null
    }
    // A hidden window would spin the loop for nothing; resume when it returns.
    const onVisibilityChange = () => (document.hidden ? stop() : start())

    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver((entries) => {
        const entry = entries[entries.length - 1]
        if (entry) layout(entry.contentRect.width)
      })
      : null
    observer?.observe(canvas)
    layout(canvas.clientWidth)

    if (active) {
      document.addEventListener('visibilitychange', onVisibilityChange)
      start()
    }
    return () => {
      stop()
      observer?.disconnect()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [active])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={className ? `block w-full ${className}` : 'block w-full'}
      style={{ height: HEIGHT }}
    />
  )
})
