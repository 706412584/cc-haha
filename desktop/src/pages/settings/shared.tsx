/**
 * The few things more than one Settings panel needs.
 *
 * Extracted while splitting `Settings.tsx` into one module per panel, so a
 * panel never imports from the file that imports it. The hand-rolled checkbox
 * mark that used to live here is gone: settings toggles are `Switch` rows of
 * the shared skeleton (`components/settings/SettingsSection`), and dialog
 * checkboxes use `ui/Checkbox`.
 */

export function isValidHttpProxyUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/* Fork: hand-rolled checkbox rows still used by GeneralSettings's fork-only toggles. */
export const SETTINGS_CHECKBOX_INPUT_CLASS = 'settings-checkbox-input peer'

export function SettingsCheckboxMark({ checked, disabled = false }: { checked: boolean; disabled?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-md)] border transition-all peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--color-border-focus)] ${
        checked
          ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-[var(--color-on-primary)] shadow-[var(--shadow-button-primary)]'
          : 'border-[var(--color-border-focus)] bg-[var(--color-surface)] text-transparent'
      } ${disabled ? 'opacity-50' : ''}`}
    >
      <span className="material-symbols-outlined text-[16px] leading-none" style={{ fontVariationSettings: "'FILL' 1" }}>
        check
      </span>
    </span>
  )
}
