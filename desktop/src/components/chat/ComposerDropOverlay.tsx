type ComposerDropOverlayProps = {
  title: string
  description: string
  testId: string
}

export function ComposerDropOverlay({ title, description, testId }: ComposerDropOverlayProps) {
  return (
    <div
      data-testid={testId}
      // Opaque tokens throughout: `--color-brand/45` and `/88` compile to a
      // color function the Safari 15 WebView drops, which left the drop target
      // with no edge and a fully transparent scrim there.
      className="composer-drop-overlay pointer-events-none absolute inset-0 z-[var(--z-scrim)] flex items-center justify-center rounded-[inherit] border border-[var(--color-primary-fixed-dim)] bg-[var(--color-surface-glass)] p-4 backdrop-blur-[2px]"
      aria-hidden="true"
    >
      <div className="flex max-w-[280px] items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-primary-fixed-dim)] bg-[var(--color-surface-container-low)] px-4 py-3 text-left shadow-[var(--shadow-overlay)]">
        <span className="material-symbols-outlined flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-brand-soft)] text-[20px] text-[var(--color-brand)]">
          upload_file
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold leading-5 text-[var(--color-text-primary)]">{title}</span>
          <span className="block text-xs leading-5 text-[var(--color-text-tertiary)]">{description}</span>
        </span>
      </div>
    </div>
  )
}
