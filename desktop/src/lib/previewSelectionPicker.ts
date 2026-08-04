import { t } from '../i18n'
import type { PreviewPickerMessage } from './desktopHost/types'

export function buildPreviewPickerMessage(
  mode: 'single' | 'batch',
  label: number,
): PreviewPickerMessage {
  return {
    v: 1,
    type: 'enter-picker',
    mode,
    label,
    copy: {
      cancel: t('browser.selection.cancel'),
      send: t('browser.selection.sendOne'),
      queueAndContinue: t('browser.selection.queueAndContinue'),
      add: t('browser.selection.add'),
      descriptionPlaceholder: t('browser.selection.descriptionPlaceholder'),
    },
  }
}
