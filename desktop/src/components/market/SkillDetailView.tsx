import { useState, type ReactNode } from 'react'
import { ArrowLeft, CircleSlash2, FileText, Folder } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type {
  InstallState,
  NotInstallableReason,
  SecurityReport,
  SecurityStatus,
} from '../../types/market'
import { InstallStateBadge } from './InstallStateBadge'
import { SecurityBadge } from './SecurityBadge'
import { FilePreview, type PreviewFile, type PreviewFileContent } from './FilePreview'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { SkillAvatar } from './SkillAvatar'

export type SkillDetailMetaItem = {
  label: string
  value: ReactNode
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
  files: PreviewFile[]
  loadFile: (path: string) => Promise<PreviewFileContent>
  onBack: () => void
  backLabel: string
}

/**
 * Shared, data-source-agnostic skill detail layout. Both the online market
 * detail and the locally-installed skill detail render through this view so
 * the reading experience stays identical.
 */
export function SkillDetailView(props: SkillDetailViewProps) {
  const t = useTranslation()
  const [tab, setTab] = useState<'overview' | 'files'>('overview')

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[var(--color-surface-container-lowest)]"
      data-testid="skill-detail-view"
    >
      <div className="mx-auto w-full max-w-[1320px] px-6 py-6 lg:px-8">
        <button
          type="button"
          onClick={props.onBack}
          className="inline-flex min-h-8 w-fit items-center gap-1.5 rounded-md pr-2 text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] active:scale-[0.98]"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
          {props.backLabel}
        </button>

        <header className="mt-5 border-b border-[var(--color-border)]/70 pb-6">
          <div className="flex min-w-0 items-start gap-4 sm:gap-5">
            <SkillAvatar skill={{ name: props.name, iconUrl: props.iconUrl }} size={64} />
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-tertiary)]">
                <span>{props.sourceLabel}</span>
                {props.version && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="font-mono font-normal normal-case tracking-normal">v{props.version}</span>
                  </>
                )}
              </div>
              <h1 className="mt-1.5 break-words text-2xl font-semibold leading-8 tracking-[-0.03em] text-[var(--color-text-primary)] sm:text-[28px]">
                {props.name}
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {props.securityStatus && <SecurityBadge status={props.securityStatus} />}
                {props.installState && <InstallStateBadge state={props.installState} />}
              </div>
              {props.summary && (
                <p className="mt-3 max-w-3xl text-[13px] leading-6 text-[var(--color-text-secondary)] break-words sm:text-sm">
                  {props.summary}
                </p>
              )}
            </div>
          </div>

          {props.installState === 'not-installable' && props.notInstallableReason && (
            <div
              data-testid="market-not-installable-reason"
              className="mt-5 flex items-start gap-2 rounded-lg border border-[var(--color-error)]/25 bg-[var(--color-error-container)]/35 px-3.5 py-2.5 text-sm text-[var(--color-text-primary)]"
            >
              <CircleSlash2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--color-error)]" strokeWidth={2} aria-hidden="true" />
              <span>{t(`market.reason.${props.notInstallableReason}`)}</span>
            </div>
          )}

          {props.securityReports && props.securityReports.length > 0 && (
            <div
              className="mt-5 flex flex-wrap items-center gap-x-2.5 gap-y-2 border-t border-[var(--color-border)]/60 pt-4"
              data-testid="market-security-reports"
            >
              <span className="mr-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
                {t('market.detail.securityReport')}
              </span>
              {props.securityReports.map((report) => (
                <span
                  key={report.vendor}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-surface-container-low)] px-2.5 py-1.5 text-[11px] text-[var(--color-text-secondary)]"
                >
                  <span className="font-medium text-[var(--color-text-primary)]">{report.vendor}</span>
                  {report.statusText}
                  {report.reportUrl && (
                    <a
                      href={report.reportUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[var(--color-brand)] hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {t('market.detail.viewReport')}
                    </a>
                  )}
                </span>
              ))}
            </div>
          )}

          {props.banner}
        </header>

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
          <main className="min-w-0">
            <div
              role="tablist"
              aria-label={props.name}
              className="flex items-center gap-1 border-b border-[var(--color-border)]"
            >
              {(['overview', 'files'] as const).map((key) => {
                const active = tab === key
                const Icon = key === 'overview' ? FileText : Folder
                return (
                  <button
                    key={key}
                    id={`skill-detail-tab-${key}-trigger`}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    aria-controls={`skill-detail-${key}-panel`}
                    data-testid={`skill-detail-tab-${key}`}
                    onClick={() => setTab(key)}
                    className={`relative -mb-px inline-flex min-h-10 items-center gap-1.5 border-b-2 px-3.5 text-sm transition-colors focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)] ${
                      active
                        ? 'border-[var(--color-brand)] font-medium text-[var(--color-text-primary)]'
                        : 'border-transparent text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
                    }`}
                  >
                    <Icon className="h-4 w-4" strokeWidth={1.9} aria-hidden="true" />
                    {t(`market.detail.${key}`)}
                    {key === 'files' && (
                      <span className="rounded-md bg-[var(--color-surface-container-high)] px-1.5 py-0.5 text-[10px] leading-4 text-[var(--color-text-tertiary)]">
                        {props.files.length}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>

            {tab === 'overview' && (
              <section
                id="skill-detail-overview-panel"
                role="tabpanel"
                aria-labelledby="skill-detail-tab-overview-trigger"
                className="mt-5 rounded-xl border border-[var(--color-border)]/70 bg-[var(--color-surface)] px-6 py-6 sm:px-8 sm:py-7"
                data-testid="skill-detail-overview"
              >
                {props.description.trim() ? (
                  <MarkdownRenderer content={props.description} variant="document" className="mx-auto max-w-[72ch]" />
                ) : !props.overviewContent ? (
                  <p className="py-6 text-center text-sm text-[var(--color-text-tertiary)]">{t('market.detail.noDescription')}</p>
                ) : null}
                {props.overviewContent}
              </section>
            )}

            {tab === 'files' && (
              <section
                id="skill-detail-files-panel"
                role="tabpanel"
                aria-labelledby="skill-detail-tab-files-trigger"
                className="mt-5"
              >
                <FilePreview files={props.files} loadFile={props.loadFile} />
              </section>
            )}
          </main>

          <aside
            data-testid="skill-detail-sidebar"
            className="order-first min-w-0 lg:order-none lg:sticky lg:top-5"
          >
            <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] shadow-[0_1px_2px_rgba(27,28,26,0.05)]">
              {props.actions && (
                <div
                  className={`p-3 [&>button]:w-full [&>button]:justify-center ${props.meta.length > 0 ? 'border-b border-[var(--color-border)]' : ''}`}
                >
                  {props.actions}
                </div>
              )}
              {props.meta.length > 0 && (
                <dl>
                  {props.meta.map((item) => (
                    <div
                      key={item.label}
                      className="flex min-w-0 items-start justify-between gap-4 border-b border-[var(--color-border)]/65 px-4 py-3 last:border-b-0"
                    >
                      <dt className="text-[11px] leading-5 text-[var(--color-text-tertiary)]">{item.label}</dt>
                      <dd className="max-w-[62%] break-words text-right text-[12px] font-medium leading-5 text-[var(--color-text-primary)]">
                        {item.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
