import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, CircleSlash2, FileText, Folder, type LucideIcon } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import type {
  InstallState,
  NotInstallableReason,
  SecurityReport,
  SecurityStatus,
} from '../../types/market'
import { InstallStateBadge } from './InstallStateBadge'
import { SecurityBadge } from './SecurityBadge'
import { FilePreview, type PreviewFile, type PreviewFileContent } from './FilePreview'
import { FrontmatterPanel } from './FrontmatterPanel'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { SkillAvatar } from './SkillAvatar'
import { splitFrontmatter, type SkillFrontmatter } from '../../lib/skillFrontmatter'

export type SkillDetailMetaItem = {
  label: string
  value: ReactNode
}

export type SkillDetailTab = {
  key: string
  label: string
  icon?: LucideIcon
  /** Small trailing marker: a count, or a warning dot. */
  badge?: ReactNode
  content: ReactNode
}

export type SkillDetailStat = {
  label: string
  value: string
}

export type SkillDetailViewProps = {
  name: string
  version?: string
  iconUrl?: string
  sourceLabel: string
  summary?: string
  securityStatus?: SecurityStatus
  securityReports?: SecurityReport[]
  installState?: InstallState
  notInstallableReason?: NotInstallableReason
  /** Action buttons rendered in the decision area (install / uninstall / open). */
  actions?: ReactNode
  /** Optional banner below the header (e.g. install errors). */
  banner?: ReactNode
  meta: SkillDetailMetaItem[]
  description: string
  /** Additional content appended to the overview without affecting market callers. */
  overviewContent?: ReactNode
  /**
   * Frontmatter the caller already parsed. Used when `description` arrives with
   * its YAML block stripped upstream, so the overview can still show it.
   */
  descriptionFrontmatter?: SkillFrontmatter
  files: PreviewFile[]
  loadFile: (path: string) => Promise<PreviewFileContent>
  onBack: () => void
  backLabel: string

  // Everything below is optional and only the market detail passes it. The
  // installed-skill page renders exactly as it did before these existed.

  /** One line of facts under the title ("by … · source · license · updated"). Replaces the source label above it. */
  metaLine?: ReactNode
  /** Replaces the default security / install badge row under the title. */
  chips?: ReactNode
  /** Headline numbers in a strip under the header. */
  stats?: SkillDetailStat[]
  /** Tabs after Overview and Files. */
  extraTabs?: SkillDetailTab[]
  /** Controlled tab; pair with `onTabChange`. Uncontrolled when omitted. */
  activeTab?: string
  onTabChange?: (tab: string) => void
  /** Rendered above the document in the overview tab. */
  overviewLead?: ReactNode
  /** A header row inside the overview document card (file name, size, reading time). */
  docHeader?: ReactNode
  /** Cards stacked above the meta card in the side rail. */
  sideCards?: ReactNode
  /** Heading for the meta card. */
  metaTitle?: string
  /**
   * `hero` puts the actions at the header's trailing edge. The side rail then
   * belongs to the overview alone, and the other tabs take the full width.
   */
  actionsPlacement?: 'sidebar' | 'hero'
}

/**
 * Shared, data-source-agnostic skill detail layout. Both the online market
 * detail and the locally-installed skill detail render through this view so
 * the reading experience stays identical.
 */
export function SkillDetailView(props: SkillDetailViewProps) {
  const t = useTranslation()
  const [uncontrolledTab, setUncontrolledTab] = useState('overview')
  const tab = props.activeTab ?? uncontrolledTab
  const setTab = (next: string) => {
    if (props.activeTab === undefined) setUncontrolledTab(next)
    props.onTabChange?.(next)
  }
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  // Some sources hand us the raw SKILL.md (frontmatter included), others strip
  // it upstream and pass the parsed block separately. Handle both.
  const overview = useMemo(() => splitFrontmatter(props.description), [props.description])
  const skillFrontmatter = overview.frontmatter ?? props.descriptionFrontmatter

  const heroActions = props.actionsPlacement === 'hero'
  const sidebarActions = heroActions ? undefined : props.actions
  const showAside = !heroActions || tab === 'overview'
  const extraTabs = props.extraTabs ?? []
  const activeExtra = extraTabs.find((extra) => extra.key === tab)

  const tabs: Array<{ key: string; label: string; icon: LucideIcon; badge?: ReactNode }> = [
    { key: 'overview', label: t('market.detail.overview'), icon: FileText },
    {
      key: 'files',
      label: t('market.detail.files'),
      icon: Folder,
      badge: <Badge pill={false} size="sm" className="leading-5">{props.files.length}</Badge>,
    },
    ...extraTabs.map((extra) => ({ key: extra.key, label: extra.label, icon: extra.icon ?? FileText, badge: extra.badge })),
  ]

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto bg-[var(--color-surface)]"
      data-testid="skill-detail-view"
    >
      {/*
        `lg:h-full` (not `min-h-full`) on purpose: a flex column sized by
        min-height stays `height: auto`, so `flex-1`'s `flex-basis: 0%` cannot
        resolve and the panel below falls back to content height — which is what
        left the bottom of the page empty. A definite height makes the tab panel
        claim the leftover space. Narrow layouts keep the page scrolling.
      */}
      <div className="mx-auto flex w-full max-w-[1280px] flex-col px-6 pb-12 pt-6 lg:h-full lg:px-11">
        {/* `size="base"` is h-8, matching the `min-h-8` this button carried
            before it became a component. */}
        <Button
          variant="ghost"
          size="base"
          className="w-fit"
          icon={<ArrowLeft className="h-4 w-4" strokeWidth={1.6} aria-hidden="true" />}
          onClick={props.onBack}
        >
          {props.backLabel}
        </Button>

        <header className="mt-[18px] flex-shrink-0">
          <div className="flex min-w-0 flex-wrap items-start gap-5 sm:flex-nowrap sm:gap-6">
            <SkillAvatar skill={{ name: props.name, iconUrl: props.iconUrl }} size={props.metaLine ? 72 : 92} />
            <div className="min-w-0 flex-1">
              {!props.metaLine && (
                <div className="font-mono text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                  {props.sourceLabel}
                </div>
              )}
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                <h1
                  ref={headingRef}
                  tabIndex={-1}
                  style={{ fontFamily: 'var(--font-headline)' }}
                  className="min-w-0 break-words text-[26px] font-bold leading-tight tracking-[-0.012em] text-[var(--color-text-primary)] outline-none sm:text-[30px]"
                >
                  {props.name}
                </h1>
                {props.version && (
                  <Badge variant="outline" size="sm" pill={false} mono data-testid="skill-detail-version">
                    v{props.version}
                  </Badge>
                )}
              </div>
              {props.metaLine && (
                <p
                  data-testid="skill-detail-meta-line"
                  className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[var(--color-text-tertiary)]"
                >
                  {props.metaLine}
                </p>
              )}
              {props.summary && (
                <p className="mt-3 max-w-3xl break-words text-[15px] leading-relaxed text-[var(--color-text-secondary)]">
                  {props.summary}
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {props.chips ?? (
                  <>
                    {props.securityStatus && <SecurityBadge status={props.securityStatus} />}
                    {props.installState && <InstallStateBadge state={props.installState} />}
                  </>
                )}
              </div>
            </div>
            {heroActions && props.actions && (
              <div data-testid="skill-detail-hero-actions" className="flex flex-shrink-0 flex-wrap items-center gap-2.5">
                {props.actions}
              </div>
            )}
          </div>

          {props.installState === 'not-installable' && props.notInstallableReason && (
            <div
              data-testid="market-not-installable-reason"
              className="mt-5 flex items-start gap-2 rounded-[var(--radius-lg)] border border-[var(--color-error)] bg-[var(--color-error-container)] px-3.5 py-2.5 text-sm text-[var(--color-on-error-container)]"
            >
              <CircleSlash2 className="mt-0.5 h-4 w-4 flex-shrink-0" strokeWidth={1.6} aria-hidden="true" />
              <span>{t(`market.reason.${props.notInstallableReason}`)}</span>
            </div>
          )}

          {props.securityReports && props.securityReports.length > 0 && (
            <div
              className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 border-y border-[var(--color-border)] px-0.5 py-3.5 text-sm"
              data-testid="market-security-reports"
            >
              <span className="text-[var(--color-text-tertiary)]">{t('market.detail.securityReport')}</span>
              {props.securityReports.map((report) => (
                <span key={report.vendor} className="inline-flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <strong className="font-mono text-[13.5px] font-semibold text-[var(--color-text-primary)]">
                    {report.vendor}
                  </strong>
                  <span className="text-[var(--color-text-secondary)]">{report.statusText}</span>
                  {report.reportUrl && (
                    <a
                      href={report.reportUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center rounded-[var(--radius-sm)] bg-[var(--color-brand-soft)] px-3 py-1 text-[13px] font-semibold text-[var(--color-on-brand-soft)] transition-colors hover:bg-[var(--color-brand-soft-hover)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {t('market.detail.viewReport')}
                    </a>
                  )}
                </span>
              ))}
            </div>
          )}

          {props.stats && props.stats.length > 0 && (
            // Hairline grid: the 1px gap shows the separator colour through,
            // so the dividers stay right however many cells wrap per row.
            <dl
              data-testid="skill-detail-stats"
              className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-px overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-border-separator)]"
            >
              {props.stats.map((stat) => (
                <div key={stat.label} className="min-w-0 bg-[var(--color-surface)] px-[18px] py-3.5">
                  <dt className="text-xs text-[var(--color-text-tertiary)]">{stat.label}</dt>
                  <dd className="mt-1 truncate font-mono text-xl font-semibold tabular-nums text-[var(--color-text-primary)]">
                    {stat.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {props.banner}
        </header>

        <div
          className={`mt-6 grid gap-6 lg:min-h-0 lg:flex-1 lg:items-stretch lg:gap-9 ${
            showAside ? 'lg:grid-cols-[minmax(0,1fr)_300px]' : ''
          }`}
        >
          <main className="flex min-w-0 flex-col lg:min-h-0">
            <div
              role="tablist"
              aria-label={props.name}
              className="flex flex-shrink-0 flex-wrap items-center gap-x-[26px] border-b border-[var(--color-border)]"
            >
              {tabs.map((entry) => {
                const active = tab === entry.key
                const Icon = entry.icon
                return (
                  <button
                    key={entry.key}
                    id={`skill-detail-tab-${entry.key}-trigger`}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-controls={`skill-detail-${entry.key}-panel`}
                    data-testid={`skill-detail-tab-${entry.key}`}
                    onClick={() => setTab(entry.key)}
                    className={`relative -mb-px inline-flex min-h-11 items-center gap-2 border-b-[3px] px-1 text-[15px] font-semibold transition-colors focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] ${
                      active
                        ? 'border-[var(--color-brand)] text-[var(--color-text-primary)]'
                        : 'border-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
                    }`}
                  >
                    <Icon className="h-[15px] w-[15px]" strokeWidth={1.5} aria-hidden="true" />
                    {entry.label}
                    {entry.badge}
                  </button>
                )
              })}
            </div>

            {tab === 'overview' && (
              <div className="mt-[22px] flex flex-col gap-4 lg:min-h-0 lg:flex-1">
                {props.overviewLead}
                <section
                  id="skill-detail-overview-panel"
                  role="tabpanel"
                  aria-labelledby="skill-detail-tab-overview-trigger"
                  className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-7 sm:px-[34px] sm:py-[30px] lg:min-h-0 lg:flex-1 lg:overflow-y-auto"
                  data-testid="skill-detail-overview"
                >
                  {props.docHeader && (
                    <header
                      data-testid="skill-detail-doc-header"
                      className="mb-6 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-separator)] pb-3 text-xs text-[var(--color-text-tertiary)]"
                    >
                      {props.docHeader}
                    </header>
                  )}
                  {overview.body.trim() ? (
                    <MarkdownRenderer content={overview.body} variant="document" className="mx-auto max-w-[72ch]" />
                  ) : !props.overviewContent ? (
                    <p className="py-6 text-center text-sm text-[var(--color-text-tertiary)]">{t('market.detail.noDescription')}</p>
                  ) : null}
                  {props.overviewContent}
                </section>
              </div>
            )}

            {tab === 'files' && (
              <section
                id="skill-detail-files-panel"
                role="tabpanel"
                aria-labelledby="skill-detail-tab-files-trigger"
                className="mt-[22px] flex min-h-[22rem] flex-col lg:min-h-0 lg:flex-1"
                data-testid="skill-detail-files"
              >
                <FilePreview files={props.files} loadFile={props.loadFile} />
              </section>
            )}

            {activeExtra && (
              <section
                id={`skill-detail-${activeExtra.key}-panel`}
                role="tabpanel"
                aria-labelledby={`skill-detail-tab-${activeExtra.key}-trigger`}
                className="mt-[22px] flex flex-col gap-4"
                data-testid={`skill-detail-${activeExtra.key}`}
              >
                {activeExtra.content}
              </section>
            )}
          </main>

          {showAside && (
            <aside
              data-testid="skill-detail-sidebar"
              className="order-first flex min-w-0 flex-col gap-4 lg:order-none lg:max-h-full lg:self-start lg:overflow-y-auto"
            >
              {props.sideCards}
              <Card radius="xl" surface="base" padding="none" className="overflow-hidden">
                {props.metaTitle && (
                  <h2 className="px-[18px] pt-4 text-sm font-semibold text-[var(--color-text-primary)]">
                    {props.metaTitle}
                  </h2>
                )}
                {sidebarActions && (
                  <div className="px-[18px] pt-[18px] [&>button]:w-full [&>button]:justify-center">
                    {sidebarActions}
                  </div>
                )}
                {props.meta.length > 0 && (
                  <dl className="px-[18px]">
                    {props.meta.map((item) => (
                      <div
                        key={item.label}
                        className="flex min-w-0 items-baseline justify-between gap-4 border-b border-[var(--color-border)] py-[13px] last:border-b-0"
                      >
                        <dt className="text-sm leading-5 text-[var(--color-text-secondary)]">{item.label}</dt>
                        <dd className="max-w-[62%] break-words text-right text-[14.5px] font-bold leading-5 text-[var(--color-text-primary)]">
                          {item.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
                {/*
                  The skill's own declared attributes belong with the market ones
                  above — same kind of data, different source. Keeping them here
                  leaves the overview tab free to answer "what is this skill?"
                  first, which is what a reader opens the page for.
                */}
                <FrontmatterPanel
                  frontmatter={skillFrontmatter}
                  variant="sidebar"
                  className={sidebarActions || props.meta.length > 0 ? 'border-t border-[var(--color-border)]' : ''}
                />
              </Card>
            </aside>
          )}
        </div>
      </div>
    </div>
  )
}
