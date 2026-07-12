import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type FetchedModelEntry = { id: string; contextWindow?: number }

const CONTEXT_WINDOW_KEYS = ['context_length', 'context_window', 'max_context_window_tokens', 'max_input_tokens', 'max_tokens', 'max_model_len', 'context_size', 'token_limit'] as const

export function readContextWindow(obj: Record<string, unknown>): number | undefined {
  const containers = [obj]
  for (const key of ['top_provider', 'spec', 'limits']) {
    const nested = obj[key]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) containers.push(nested as Record<string, unknown>)
  }
  for (const container of containers) for (const key of CONTEXT_WINDOW_KEYS) {
    const raw = container[key]
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN
    if (Number.isFinite(value) && value > 0) return Math.floor(value)
  }
}

export function extractModelEntries(payload: unknown): FetchedModelEntry[] {
  const entries: FetchedModelEntry[] = []
  const seen = new Map<string, FetchedModelEntry>()
  const visit = (item: unknown) => {
    if (!item || typeof item !== 'object') return
    const obj = item as Record<string, unknown>
    const id = typeof obj.id === 'string' ? obj.id : typeof obj.name === 'string' ? obj.name : typeof obj.model === 'string' ? obj.model : ''
    if (!id) return
    const contextWindow = readContextWindow(obj)
    const existing = seen.get(id)
    if (existing) { if (existing.contextWindow === undefined && contextWindow !== undefined) existing.contextWindow = contextWindow; return }
    const entry = { id, ...(contextWindow === undefined ? {} : { contextWindow }) }
    seen.set(id, entry); entries.push(entry)
  }
  if (Array.isArray(payload)) payload.forEach(visit)
  else if (payload && typeof payload === 'object') for (const key of ['data', 'models', 'items', 'results']) {
    const list = (payload as Record<string, unknown>)[key]
    if (Array.isArray(list)) list.forEach(visit)
  }
  return entries
}

function compact(value: number) {
  const unit = value >= 1_000_000 ? [1_000_000, 'M'] as const : value >= 1_000 ? [1_000, 'K'] as const : [1, ''] as const
  const rounded = Math.round(value / unit[0] * 10) / 10
  return `${rounded}${unit[1]}`
}

export function ModelComboInput({ label, required, value, onChange, placeholder, options, toggleLabel = 'Toggle model list' }: { label: string; required?: boolean; value: string; onChange: (value: string) => void; placeholder?: string; options: FetchedModelEntry[]; toggleLabel?: string }) {
  const id = useId()
  const listboxId = `${id}-listbox`
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const suppressFocusOpenRef = useRef(false)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0 })
  const close = () => { setOpen(false); setActiveIndex(-1) }
  const show = (index = -1) => { if (options.length) { setActiveIndex(index); setOpen(true) } }

  useEffect(() => {
    if (!open) return
    const place = () => { const rect = inputRef.current?.getBoundingClientRect(); if (rect) setPosition({ left: rect.left, top: rect.bottom + 4, width: rect.width }) }
    const click = (event: MouseEvent) => { const target = event.target as Node; if (!rootRef.current?.contains(target) && !listRef.current?.contains(target)) close() }
    place(); document.addEventListener('mousedown', click); window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { document.removeEventListener('mousedown', click); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [open])

  const restoreFocus = () => { suppressFocusOpenRef.current = true; inputRef.current?.focus(); suppressFocusOpenRef.current = false }
  const select = (index: number) => { const option = options[index]; if (!option) return; onChange(option.id); close(); restoreFocus() }
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      if (!open) show(direction > 0 ? 0 : options.length - 1)
      else setActiveIndex(current => current < 0 ? (direction > 0 ? 0 : options.length - 1) : (current + direction + options.length) % options.length)
    } else if (event.key === 'Enter' && open && activeIndex >= 0) { event.preventDefault(); select(activeIndex) }
    else if (event.key === 'Escape' && open) { event.preventDefault(); close(); restoreFocus() }
  }

  const listbox = open && options.length > 0 && createPortal(<div ref={listRef} id={listboxId} role="listbox" style={{ position: 'fixed', ...position }} className="z-[70] max-h-[260px] overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-lg">{options.map((option, index) => <button id={`${listboxId}-option-${index}`} key={option.id} type="button" role="option" aria-selected={option.id === value} onMouseDown={event => event.preventDefault()} onClick={() => select(index)} className={`flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-hover)] ${index === activeIndex ? 'bg-[var(--color-surface-hover)]' : ''}`}><span className="truncate">{option.id}</span>{option.contextWindow !== undefined && <span className="text-xs text-[var(--color-text-tertiary)]">{compact(option.contextWindow)}</span>}</button>)}</div>, document.body)

  return <div ref={rootRef} className="relative flex flex-col gap-1"><label htmlFor={id} className="text-sm font-medium text-[var(--color-text-primary)]">{label}{required && <span className="ml-0.5 text-[var(--color-error)]">*</span>}</label><div className="relative"><input ref={inputRef} id={id} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listboxId : undefined} aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined} value={value} onChange={e => onChange(e.target.value)} onFocus={() => { if (!suppressFocusOpenRef.current) show() }} onKeyDown={handleKeyDown} placeholder={placeholder} autoComplete="off" spellCheck={false} className="h-10 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 pr-9 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--color-border-focus)]" />{options.length > 0 && <button type="button" aria-label={toggleLabel} aria-expanded={open} aria-controls={listboxId} tabIndex={-1} onClick={() => open ? close() : show()} className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2"><span className="material-symbols-outlined text-[18px]">expand_more</span></button>}</div>{listbox}</div>
}
