import { useTranslation } from '../../i18n'
import { ActionDialog } from '@/components/ui/ActionDialog'

type Props = {
  open: boolean
  loading?: boolean
  onClose: () => void
  onConfirm: () => void | Promise<void>
}

export function AutoModeOptInDialog({ open, loading = false, onClose, onConfirm }: Props) {
  const t = useTranslation()

  return (
    <ActionDialog
      open={open}
      onClose={onClose}
      title={t('permMode.enableAutoTitle')}
      width={460}
      loading={loading}
      body={(
        <div className="space-y-3">
          {/* Warning tones are paired: `--color-warning` is the marker (icon,
              border) and `--color-on-warning-container` is the only readable
              foreground on the container fill. The `/N` alpha this replaced is
              also dropped outright by the Safari 15 WebView. */}
          <div className="flex items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--color-warning)] bg-[var(--color-warning-container)] px-3 py-3">
            <span className="material-symbols-outlined mt-0.5 text-[20px] text-[var(--color-warning)]">warning</span>
            <div className="space-y-2 text-sm leading-6 text-[var(--color-on-warning-container)]">
              <p className="font-semibold">{t('permMode.enableAutoBody')}</p>
              <p>{t('permMode.enableAutoDetail')}</p>
            </div>
          </div>
        </div>
      )}
      actions={[
        {
          label: t('common.cancel'),
          onClick: onClose,
          variant: 'secondary',
        },
        {
          label: t('permMode.enableAutoBtn'),
          onClick: onConfirm,
          variant: 'primary',
          loading,
        },
      ]}
    />
  )
}
