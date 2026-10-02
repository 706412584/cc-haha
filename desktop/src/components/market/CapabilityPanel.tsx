import { useMemo } from 'react'
import { TriangleAlert } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Badge, type Tone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import {
  detectCapabilities,
  extractTriggers,
  type Capability,
  type CapabilityLevel,
} from '../../lib/skillInsights'
import type { NormalizedSkillDetail } from '../../types/market'

type Translate = ReturnType<typeof useTranslation>

export const CAPABILITY_LEVEL_TONES: Record<CapabilityLevel, Tone> = {
  high: 'danger',
  medium: 'warning',
  low: 'neutral',
}

/** One capability, phrased with its evidence. */
export function capabilityText(t: Translate, capability: Capability): { title: string; detail: string } {
  const evidence = capability.evidence.join(capability.kind === 'shell' ? ' / ' : '、')
  return {
    title: t(`market.cap.${capability.kind}`),
    detail: t(`market.cap.${capability.kind}.detail`, { evidence }),
  }
}

/** Capabilities and triggers, read once per detail off its own SKILL.md and file list. */
export function useSkillInsights(detail: NormalizedSkillDetail | null | undefined): {
  capabilities: Capability[]
  triggers: string[]
} {
  return useMemo(() => {
    if (!detail) return { capabilities: [], triggers: [] }
    const description = detail.descriptionFrontmatter?.description
    return {
      capabilities: detectCapabilities({
        markdown: detail.description,
        frontmatter: detail.descriptionFrontmatter,
        files: detail.files,
      }),
      triggers: extractTriggers(typeof description === 'string' ? description : undefined),
    }
  }, [detail])
}

/**
 * "Before installing: what this skill does."
 *
 * Every card cites the file, command, variable or host it came from, so the
 * reader can check the claim rather than trust it. Renders nothing when no
 * rule fired: an empty "nothing risky here" panel would be a verdict these
 * rules cannot make.
 */
export function CapabilityPanel({
  capabilities,
  onViewReport,
}: {
  capabilities: readonly Capability[]
  /** Shown as the header link; omitted where the panel already sits in the report. */
  onViewReport?: () => void
}) {
  const t = useTranslation()
  if (capabilities.length === 0) return null

  return (
    <section
      aria-labelledby="market-capabilities-title"
      data-testid="market-capability-panel"
      className="flex-shrink-0 rounded-[var(--radius-xl)] border border-[var(--color-warning)] bg-[var(--color-warning-container)] px-5 py-[18px]"
    >
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2
          id="market-capabilities-title"
          className="flex items-center gap-2 text-[15px] font-semibold text-[var(--color-on-warning-container)]"
        >
          <TriangleAlert className="h-[17px] w-[17px] flex-shrink-0" strokeWidth={1.8} aria-hidden="true" />
          {t('market.cap.title')}
        </h2>
        {onViewReport && (
          <Button variant="link" size="sm" data-testid="market-capability-view-report" onClick={onViewReport}>
            {t('market.cap.viewReport')}
          </Button>
        )}
      </header>
      <ul className="mt-3.5 grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
        {capabilities.map((capability) => {
          const text = capabilityText(t, capability)
          return (
            <li
              key={capability.kind}
              data-testid={`market-capability-${capability.kind}`}
              className="flex min-w-0 flex-col gap-1.5 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3"
            >
              <span className="flex items-center justify-between gap-2">
                <strong className="text-[13.5px] font-semibold text-[var(--color-text-primary)]">{text.title}</strong>
                <Badge tone={CAPABILITY_LEVEL_TONES[capability.level]} size="xs" pill={false}>
                  {t(`market.cap.level.${capability.level}`)}
                </Badge>
              </span>
              <span className="break-words font-mono text-xs leading-5 text-[var(--color-text-secondary)]">
                {text.detail}
              </span>
            </li>
          )
        })}
      </ul>
      <p className="mt-3 text-xs leading-5 text-[var(--color-on-warning-container)]">{t('market.cap.note')}</p>
    </section>
  )
}
