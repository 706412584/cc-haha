import type { ReactNode } from 'react'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslation } from '../../i18n'

export function SlashCommandPanelShell({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: string
  subtitle: string
  children: ReactNode
  onClose: () => void
}) {
  const t = useTranslation()
  return (
    <div className="absolute bottom-full left-0 right-0 z-[var(--z-dropdown)] mb-3 overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] shadow-[var(--shadow-overlay)]">
      <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] px-5 py-4">
        <div>
          <h3 className="text-lg font-semibold text-[var(--color-text-primary)]">{title}</h3>
          <p className="mt-1 text-sm text-[var(--color-text-tertiary)]">{subtitle}</p>
        </div>
        <IconButton
          icon="close"
          label={t('tabs.close')}
          size="lg"
          tone="secondary"
          shape="circle"
          onClick={onClose}
        />
      </div>
      <div className="max-h-[min(620px,72vh)] overflow-y-auto px-5 py-4">{children}</div>
    </div>
  )
}
