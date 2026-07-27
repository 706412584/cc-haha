import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useDismissable } from '@/hooks/useDismissable'
import { useTranslation } from '../../i18n'
import type { ReasoningEffortLevel } from '../../types/settings'

type Props = {
  open: boolean
  anchorRef: React.RefObject<HTMLElement>
  options: ReasoningEffortLevel[]
  value: ReasoningEffortLevel
  labels: Record<ReasoningEffortLevel, string>
  onChange: (value: ReasoningEffortLevel) => void
  onClose: () => void
  ariaLabel?: string
}

type PopoverPosition = {
  bottom: number
  left: number
  width: number
}

const POPOVER_WIDTH = 300
const VIEWPORT_MARGIN = 16
const POPOVER_GAP = 10

export function ReasoningEffortPopover({
  open,
  anchorRef,
  options,
  value,
  labels,
  onChange,
  onClose,
  ariaLabel,
}: Props) {
  const t = useTranslation()
  // The default used to be a hardcoded Chinese literal, so a caller that left
  // `ariaLabel` off announced the slider in Chinese under every locale.
  const label = ariaLabel ?? t('model.effort')
  const popoverRef = useRef<HTMLDivElement>(null)
  const sliderRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const [position, setPosition] = useState<PopoverPosition | null>(null)
  const selectedIndex = Math.max(0, options.indexOf(value))
  const maxIndex = Math.max(0, options.length - 1)
  const fillPercent = maxIndex === 0 ? 0 : (selectedIndex / maxIndex) * 100

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }

    const updatePosition = () => {
      const rect = anchorRef.current?.getBoundingClientRect()
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth
      const width = Math.min(POPOVER_WIDTH, viewportWidth - VIEWPORT_MARGIN * 2)
      const anchorRight = rect?.right ?? viewportWidth - VIEWPORT_MARGIN
      const anchorTop = rect?.top ?? window.innerHeight / 2
      const left = Math.min(
        Math.max(VIEWPORT_MARGIN, anchorRight - width),
        Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN),
      )
      setPosition({
        bottom: Math.max(VIEWPORT_MARGIN, window.innerHeight - anchorTop + POPOVER_GAP),
        left,
        width,
      })
    }

    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [anchorRef, open])

  // Escape is deliberately left to the slider's own key handler below, which
  // also returns focus to the anchor; letting the hook handle it too would fire
  // `onClose` twice for one key press.
  useDismissable({
    open,
    refs: [popoverRef],
    triggerRef: anchorRef,
    onDismiss: onClose,
    capture: false,
    closeOnEscape: false,
  })

  if (!open || !position || options.length === 0) return null

  const selectFromClientX = (clientX: number) => {
    const rect = sliderRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const nextIndex = Math.round(ratio * maxIndex)
    const nextValue = options[nextIndex]
    if (nextValue && nextValue !== value) onChange(nextValue)
  }

  const moveBy = (offset: number) => {
    const nextIndex = Math.min(maxIndex, Math.max(0, selectedIndex + offset))
    const nextValue = options[nextIndex]
    if (nextValue && nextValue !== value) onChange(nextValue)
  }

  return createPortal(
    <div
      ref={popoverRef}
      data-testid="reasoning-effort-popover"
      className="fixed z-[var(--z-popover)] rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] px-[22px] pb-[19px] pt-[19px] shadow-[var(--shadow-overlay)]"
      style={{ bottom: position.bottom, left: position.left, width: position.width }}
    >
      <div
        data-testid="reasoning-effort-header"
        className="mb-[15px] flex items-baseline justify-between gap-3"
      >
        <div
          data-testid="reasoning-effort-label"
          className="text-[19px] font-bold leading-none text-[var(--color-text-primary)]"
          style={{ fontFamily: 'var(--font-headline)' }}
        >
          {labels[value]}
        </div>
        <div
          data-testid="reasoning-effort-context-label"
          className="text-[12.5px] text-[var(--color-text-tertiary)]"
        >
          {label}
        </div>
      </div>

      <div
        ref={sliderRef}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={maxIndex}
        aria-valuenow={selectedIndex}
        aria-valuetext={labels[value]}
        className="group relative flex h-[26px] touch-none cursor-pointer items-center outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)] focus-visible:ring-offset-4 focus-visible:ring-offset-[var(--color-surface-container-lowest)]"
        onClick={(event) => selectFromClientX(event.clientX)}
        onPointerDown={(event) => {
          draggingRef.current = true
          event.currentTarget.setPointerCapture?.(event.pointerId)
          selectFromClientX(event.clientX)
        }}
        onPointerMove={(event) => {
          if (draggingRef.current) selectFromClientX(event.clientX)
        }}
        onPointerUp={(event) => {
          if (!draggingRef.current) return
          draggingRef.current = false
          selectFromClientX(event.clientX)
          event.currentTarget.releasePointerCapture?.(event.pointerId)
        }}
        onPointerCancel={() => {
          draggingRef.current = false
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
            anchorRef.current?.focus()
            return
          }
          if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            event.preventDefault()
            moveBy(-1)
          } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            event.preventDefault()
            moveBy(1)
          } else if (event.key === 'Home') {
            event.preventDefault()
            const firstValue = options[0]
            if (firstValue && firstValue !== value) onChange(firstValue)
          } else if (event.key === 'End') {
            event.preventDefault()
            const lastValue = options[maxIndex]
            if (lastValue && lastValue !== value) onChange(lastValue)
          }
        }}
      >
        <div
          data-testid="reasoning-effort-track"
          className="absolute inset-x-0 h-[14px] overflow-hidden rounded-full bg-[var(--color-surface-hover)]"
        >
          <div
            data-testid="reasoning-effort-fill"
            className="h-full rounded-full bg-[var(--color-brand)] transition-[width] duration-[180ms] motion-reduce:transition-none"
            style={{ width: `${fillPercent}%` }}
          />
        </div>

        <div className="absolute inset-x-0 flex items-center justify-between px-[11px]">
          {options.map((option, index) => (
            <span
              key={option}
              data-testid="reasoning-effort-stop"
              // Foreground token rather than `white/45`: the `/N` modifier
              // compiles to a color function Safari 15's WebView drops, and the
              // unfilled half of the track is a light surface under every
              // palette, where white dots are invisible.
              className={`h-[7px] w-[7px] rounded-full ${index <= selectedIndex ? 'bg-[var(--color-on-primary)]' : 'bg-[var(--color-outline)]'}`}
            />
          ))}
        </div>

        <div
          aria-hidden="true"
          data-testid="reasoning-effort-thumb"
          // The hairline is what makes the knob readable on the ink themes,
          // where `--color-surface` resolves to the same value as the popover
          // it sits on and `--shadow-card` has nothing lighter to cast against.
          className="absolute top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[var(--color-outline)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] transition-[left] duration-[180ms] motion-reduce:transition-none"
          style={{ left: `${fillPercent}%` }}
        />
      </div>
    </div>,
    document.body,
  )
}
