import { IconButton } from '@/components/ui/IconButton'
import { useUIStore, type Toast as ToastType } from '../../stores/uiStore'
import { useTranslation } from '../../i18n'

// The tone lives in a 3px left rule rather than a tinted body: on the paper
// themes a filled banner would fight the surrounding surface layering.
const typeStyles: Record<ToastType['type'], string> = {
  success: 'border-l-[3px] border-l-[var(--color-success)]',
  error: 'border-l-[3px] border-l-[var(--color-error)]',
  warning: 'border-l-[3px] border-l-[var(--color-warning)]',
  info: 'border-l-[3px] border-l-[var(--color-info)]',
}

function ToastItem({ toast }: { toast: ToastType }) {
  const t = useTranslation()
  const removeToast = useUIStore((s) => s.removeToast)
  const isUrgent = toast.type === 'warning' || toast.type === 'error'

  return (
    <div
      role={isUrgent ? 'alert' : 'status'}
      aria-live={isUrgent ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={`
        rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]
        px-4 py-3 text-[13.5px] text-[var(--color-text-primary)] shadow-[var(--shadow-overlay)]
        ${typeStyles[toast.type]}
        animate-overlay-in-right
      `}
    >
      <div className="flex items-center justify-between gap-2.5">
        <span className="min-w-0 flex-1 leading-[1.5]">{toast.message}</span>
        <IconButton
          icon="close"
          label={t('common.dismissNotification')}
          onClick={() => removeToast(toast.id)}
          size="xs"
          tone="muted"
        />
      </div>
    </div>
  )
}

export function ToastContainer() {
  const toasts = useUIStore((s) => s.toasts)

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-[var(--z-toast)] flex flex-col gap-2 max-w-sm">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  )
}
