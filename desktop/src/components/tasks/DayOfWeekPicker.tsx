import { useTranslation } from '../../i18n'

type Props = {
  selected: number[]
  onChange: (days: number[]) => void
}

// Display order: Mon(1) → Sun(0), matching Chinese convention
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

const DAY_KEYS = [
  'newTask.daySun',
  'newTask.dayMon',
  'newTask.dayTue',
  'newTask.dayWed',
  'newTask.dayThu',
  'newTask.dayFri',
  'newTask.daySat',
] as const

export function DayOfWeekPicker({ selected, onChange }: Props) {
  const t = useTranslation()

  const toggle = (day: number) => {
    if (selected.includes(day)) {
      // Don't allow deselecting the last day
      if (selected.length <= 1) return
      onChange(selected.filter((d) => d !== day))
    } else {
      onChange([...selected, day])
    }
  }

  return (
    <div className="flex gap-1.5">
      {DAY_ORDER.map((day) => {
        const isActive = selected.includes(day)
        return (
          <button
            key={day}
            type="button"
            onClick={() => toggle(day)}
            aria-pressed={isActive}
            className={`
              h-8 w-8 cursor-pointer rounded-full border text-xs font-medium
              transition-[background-color,color,border-color] duration-150 ease-out
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-border-focus)]
              focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)]
              ${isActive
                // The handoff's active chip: terracotta wash, its paired ink,
                // and the accent border. `--color-brand` as the text would be
                // 4.3:1 on this fill under the two ink palettes.
                ? 'border-[var(--color-primary-fixed-dim)] bg-[var(--color-brand-soft)] text-[var(--color-on-brand-soft)]'
                : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-tertiary)] hover:border-[var(--color-outline)] hover:bg-[var(--color-surface-hover)]'
              }
            `}
          >
            {t(DAY_KEYS[day]!)}
          </button>
        )
      })}
    </div>
  )
}
