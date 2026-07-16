import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  diagnosticsApi,
  type DiagnosticEvent,
  type DiagnosticsStatus,
  type LocalIndexState,
  type LocalIndexStatus,
} from '../api/diagnostics'
import { Button } from '../components/shared/Button'
import { copyTextToClipboard } from '../components/chat/clipboard'
import { useTranslation } from '../i18n'
import { formatBytes } from '../lib/formatBytes'
import { useUIStore } from '../stores/uiStore'
import { DoctorPanel } from '../components/doctor/DoctorPanel'
import { ConfirmDialog } from '../components/shared/ConfirmDialog'

export function DiagnosticsSettings() {
  const t = useTranslation()
  const addToast = useUIStore((s) => s.addToast)
  const [status, setStatus] = useState<DiagnosticsStatus | null>(null)
  const [localIndexStatus, setLocalIndexStatus] = useState<LocalIndexStatus | null>(null)
  const [localIndexUnavailable, setLocalIndexUnavailable] = useState(false)
  const [events, setEvents] = useState<DiagnosticEvent[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isExporting, setIsExporting] = useState(false)
  const [isCopyingIssueReport, setIsCopyingIssueReport] = useState(false)
  const [isClearing, setIsClearing] = useState(false)
  const [isRebuildingIndex, setIsRebuildingIndex] = useState(false)
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
  const [rebuildConfirmOpen, setRebuildConfirmOpen] = useState(false)
  const [rebuildSucceeded, setRebuildSucceeded] = useState(false)
  const [lastExportPath, setLastExportPath] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const loadRequestIdRef = useRef(0)
  const localIndexReadIdRef = useRef(0)
  const localIndexMutationIdRef = useRef(0)
  const localIndexMutationGenerationRef = useRef(0)
  const activeLoadCountRef = useRef(0)
  const rebuildInFlightRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      loadRequestIdRef.current += 1
      localIndexReadIdRef.current += 1
      localIndexMutationIdRef.current += 1
      localIndexMutationGenerationRef.current += 1
    }
  }, [])

  const load = useCallback(async () => {
    const loadRequestId = ++loadRequestIdRef.current
    const localIndexReadId = ++localIndexReadIdRef.current
    const mutationGeneration = localIndexMutationGenerationRef.current
    activeLoadCountRef.current += 1
    if (mountedRef.current) {
      setIsLoading(true)
      setRebuildSucceeded(false)
    }

    try {
      const [diagnosticsResult, localIndexResult] = await Promise.allSettled([
        Promise.all([diagnosticsApi.getStatus(), diagnosticsApi.getEvents(100)]),
        diagnosticsApi.getLocalIndexStatus(),
      ])

      if (!mountedRef.current) return

      if (loadRequestId === loadRequestIdRef.current) {
        if (diagnosticsResult.status === 'fulfilled') {
          const [nextStatus, eventResult] = diagnosticsResult.value
          setStatus(nextStatus)
          setEvents(eventResult.events)
        } else {
          const error = diagnosticsResult.reason
          addToast({
            type: 'error',
            message: error instanceof Error ? error.message : t('settings.diagnostics.loadFailed'),
          })
        }
      }

      // A mutation owns local-index state until it settles. Reads that began
      // before or during that mutation cannot overwrite the mutation result.
      const canCommitLocalIndexRead = localIndexReadId === localIndexReadIdRef.current
        && mutationGeneration === localIndexMutationGenerationRef.current
        && !rebuildInFlightRef.current
      if (canCommitLocalIndexRead) {
        if (localIndexResult.status === 'fulfilled') {
          setLocalIndexStatus(localIndexResult.value)
          setLocalIndexUnavailable(false)
        } else {
          // Older servers may not expose the additive local-index endpoint yet.
          // Keep all legacy diagnostics usable and show one quiet inline state.
          setLocalIndexStatus(null)
          setLocalIndexUnavailable(true)
        }
      }
    } finally {
      activeLoadCountRef.current = Math.max(0, activeLoadCountRef.current - 1)
      if (mountedRef.current) setIsLoading(activeLoadCountRef.current > 0)
    }
  }, [addToast, t])

  useEffect(() => {
    void load()
  }, [load])

  const recentErrorSummary = useMemo(() => {
    return events
      .filter((event) => event.severity === 'error' || event.severity === 'warn')
      .slice(0, 20)
      .map(formatEventForCopy)
      .join('\n')
  }, [events])

  const handleOpenDir = async () => {
    try {
      await diagnosticsApi.openLogDir()
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('settings.diagnostics.openFailed'),
      })
    }
  }

  const handleExport = async () => {
    setIsExporting(true)
    try {
      const { bundle } = await diagnosticsApi.exportBundle()
      setLastExportPath(bundle.path)
      addToast({
        type: 'success',
        message: t('settings.diagnostics.exported', { file: bundle.fileName }),
      })
      await load()
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('settings.diagnostics.exportFailed'),
      })
    } finally {
      setIsExporting(false)
    }
  }

  const handleCopySummary = async () => {
    const text = recentErrorSummary || t('settings.diagnostics.noRecentErrors')
    const copied = await copyTextToClipboard(text)
    if (copied) {
      addToast({ type: 'success', message: t('settings.diagnostics.summaryCopied') })
      return
    }
    addToast({ type: 'error', message: t('settings.diagnostics.copyFailed') })
  }

  const handleCopyIssueReport = async () => {
    setIsCopyingIssueReport(true)
    try {
      const { report } = await diagnosticsApi.getIssueReport()
      const copied = await copyTextToClipboard(report)
      addToast({
        type: copied ? 'success' : 'error',
        message: copied
          ? t('settings.diagnostics.issueReportCopied')
          : t('settings.diagnostics.issueReportCopyFailed'),
      })
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('settings.diagnostics.issueReportCopyFailed'),
      })
    } finally {
      setIsCopyingIssueReport(false)
    }
  }

  const handleClear = async () => {
    setIsClearing(true)
    try {
      await diagnosticsApi.clear()
      setEvents([])
      setStatus(await diagnosticsApi.getStatus())
      setLastExportPath(null)
      setClearConfirmOpen(false)
      addToast({ type: 'success', message: t('settings.diagnostics.cleared') })
    } catch (error) {
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('settings.diagnostics.clearFailed'),
      })
    } finally {
      setIsClearing(false)
    }
  }

  const handleRebuildIndex = async () => {
    if (rebuildInFlightRef.current) return
    rebuildInFlightRef.current = true
    const mutationId = ++localIndexMutationIdRef.current
    localIndexMutationGenerationRef.current += 1
    setIsRebuildingIndex(true)
    setRebuildSucceeded(false)
    try {
      const nextStatus = await diagnosticsApi.rebuildLocalIndex()
      if (!mountedRef.current || mutationId !== localIndexMutationIdRef.current) return
      setLocalIndexStatus(nextStatus)
      setLocalIndexUnavailable(false)
      setRebuildSucceeded(true)
      setRebuildConfirmOpen(false)
      addToast({ type: 'success', message: t('settings.diagnostics.localIndex.rebuildSucceeded') })
    } catch (error) {
      if (!mountedRef.current || mutationId !== localIndexMutationIdRef.current) return
      addToast({
        type: 'error',
        message: error instanceof Error ? error.message : t('settings.diagnostics.localIndex.rebuildFailed'),
      })
    } finally {
      rebuildInFlightRef.current = false
      if (mutationId === localIndexMutationIdRef.current) {
        localIndexMutationGenerationRef.current += 1
      }
      if (mountedRef.current) setIsRebuildingIndex(false)
    }
  }

  return (
    <div className="max-w-4xl">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-5">
        <div>
          <h2 className="text-base font-semibold text-[var(--color-text-primary)]">{t('settings.diagnostics.title')}</h2>
          <p className="text-sm text-[var(--color-text-tertiary)] mt-0.5">{t('settings.diagnostics.description')}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={load} loading={isLoading} disabled={isRebuildingIndex}>
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">refresh</span>
          {t('settings.diagnostics.refresh')}
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
        <Metric label={t('settings.diagnostics.totalSize')} value={status ? formatBytes(status.totalBytes) : '-'} />
        <Metric label={t('settings.diagnostics.completeEvents')} value={status ? t('settings.diagnostics.completeEventsValue', { count: status.eventCount }) : '-'} />
        <Metric label={t('settings.diagnostics.visibleEvents')} value={t('settings.diagnostics.visibleEventsValue', { count: events.length })} />
        <Metric label={t('settings.diagnostics.recentErrors')} value={status ? String(status.recentErrorCount) : '-'} />
        <Metric label={t('settings.diagnostics.retention')} value={status ? t('settings.diagnostics.retentionValue', { days: String(status.retentionDays), size: formatBytes(status.maxBytes) }) : '-'} />
      </div>

      {status && status.corruptLineCount > 0 ? (
        <div role="alert" className="mb-5 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2 text-xs text-[var(--color-warning)]">
          {t('settings.diagnostics.corruptLinesWarning', {
            count: status.corruptLineCount,
            physical: status.physicalLineCount,
          })}
        </div>
      ) : null}

      {status?.storageLimitExceeded ? (
        <div role="alert" className="mb-5 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2 text-xs text-[var(--color-warning)]">
          {t('settings.diagnostics.storageLimitExceededWarning')}
        </div>
      ) : null}

      <LocalIndexPanel
        status={localIndexStatus}
        unavailable={localIndexUnavailable}
        rebuilding={isRebuildingIndex}
        rebuildSucceeded={rebuildSucceeded}
        onRebuild={() => setRebuildConfirmOpen(true)}
      />

      <div className="mb-5">
        <DoctorPanel />
      </div>

      <div className="border border-[var(--color-border)] rounded-lg mb-5">
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-[var(--color-text-primary)]">{t('settings.diagnostics.logDirectory')}</div>
            <div className="text-xs text-[var(--color-text-tertiary)] font-mono break-all mt-0.5">{status?.logDir ?? '-'}</div>
          </div>
          <Button variant="secondary" size="sm" onClick={handleOpenDir}>
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">folder_open</span>
            {t('settings.diagnostics.openDirectory')}
          </Button>
        </div>
        <div className="px-4 py-3 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={handleExport} loading={isExporting}>
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">archive</span>
            {t('settings.diagnostics.exportBundle')}
          </Button>
          <Button variant="secondary" size="sm" onClick={handleCopySummary}>
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">content_copy</span>
            {t('settings.diagnostics.copySummary')}
          </Button>
          <Button variant="secondary" size="sm" onClick={handleCopyIssueReport} loading={isCopyingIssueReport}>
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">assignment</span>
            {t('settings.diagnostics.copyIssueReport')}
          </Button>
          <Button variant="danger" size="sm" onClick={() => setClearConfirmOpen(true)} loading={isClearing}>
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">delete</span>
            {t('settings.diagnostics.clearLogs')}
          </Button>
          {lastExportPath && (
            <span className="w-full text-xs text-[var(--color-text-tertiary)] font-mono break-all">
              {lastExportPath}
            </span>
          )}
        </div>
      </div>

      <div className="mb-3">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">{t('settings.diagnostics.recentEvents')}</h3>
        <p className="text-xs text-[var(--color-text-tertiary)] mt-0.5">{t('settings.diagnostics.privacyNote')}</p>
      </div>

      <div className="border border-[var(--color-border)] rounded-lg overflow-hidden">
        {events.length === 0 ? (
          <div className="px-4 py-8 text-sm text-[var(--color-text-tertiary)] text-center">
            {isLoading ? t('common.loading') : t('settings.diagnostics.noEvents')}
          </div>
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {events.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                detailsLabel={t('settings.diagnostics.eventDetails')}
                eventIdLabel={t('settings.diagnostics.eventId')}
                copyEventIdLabel={t('settings.diagnostics.copyEventId')}
                eventIdCopiedLabel={t('settings.diagnostics.eventIdCopied')}
                eventIdCopyFailedLabel={t('settings.diagnostics.eventIdCopyFailed')}
                addToast={addToast}
              />
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={rebuildConfirmOpen}
        onClose={() => {
          if (!isRebuildingIndex) setRebuildConfirmOpen(false)
        }}
        onConfirm={handleRebuildIndex}
        title={t('settings.diagnostics.localIndex.rebuild')}
        body={t('settings.diagnostics.localIndex.confirmRebuild')}
        confirmLabel={t('settings.diagnostics.localIndex.rebuild')}
        cancelLabel={t('common.cancel')}
        confirmVariant="primary"
        loading={isRebuildingIndex}
      />

      <ConfirmDialog
        open={clearConfirmOpen}
        onClose={() => {
          if (!isClearing) setClearConfirmOpen(false)
        }}
        onConfirm={handleClear}
        title={t('settings.diagnostics.clearLogs')}
        body={t('settings.diagnostics.confirmClear')}
        confirmLabel={t('settings.diagnostics.clearLogs')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        loading={isClearing}
      />
    </div>
  )
}

function LocalIndexPanel({
  status,
  unavailable,
  rebuilding,
  rebuildSucceeded,
  onRebuild,
}: {
  status: LocalIndexStatus | null
  unavailable: boolean
  rebuilding: boolean
  rebuildSucceeded: boolean
  onRebuild: () => void
}) {
  const t = useTranslation()
  const titleId = 'local-index-diagnostics-title'
  const stateMessage = status?.state === 'building'
    ? t('settings.diagnostics.localIndex.buildingMessage')
    : status?.state === 'degraded'
      ? t('settings.diagnostics.localIndex.degradedMessage')
      : null

  return (
    <section
      role="region"
      aria-labelledby={titleId}
      className="mb-5 rounded-lg border border-[var(--color-border)]"
    >
      <div className="flex flex-col gap-3 border-b border-[var(--color-border)] px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 id={titleId} className="text-sm font-medium text-[var(--color-text-primary)]">
            {t('settings.diagnostics.localIndex.title')}
          </h3>
          <p className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">
            {t('settings.diagnostics.localIndex.description')}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={onRebuild}
          loading={rebuilding}
          disabled={unavailable}
        >
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">database</span>
          {t('settings.diagnostics.localIndex.rebuild')}
        </Button>
      </div>

      {status ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3 sm:grid-cols-4">
          <IndexMetric label={t('settings.diagnostics.localIndex.state')} value={localIndexStateLabel(status.state, t)} />
          <IndexMetric
            label={t('settings.diagnostics.localIndex.indexed')}
            value={`${status.indexed} / ${status.discovered}`}
          />
          <IndexMetric label={t('settings.diagnostics.localIndex.degradedSources')} value={String(status.degradedSources)} />
          <IndexMetric label={t('settings.diagnostics.localIndex.databaseSize')} value={formatBytes(status.databaseBytes)} />
          <IndexMetric label={t('settings.diagnostics.localIndex.walSize')} value={formatBytes(status.walBytes)} />
          <IndexMetric
            label={t('settings.diagnostics.localIndex.lastUpdated')}
            value={status.lastUpdatedAt ? new Date(status.lastUpdatedAt).toLocaleString() : t('settings.diagnostics.localIndex.never')}
          />
          <IndexMetric
            label={t('settings.diagnostics.localIndex.errorCode')}
            value={status.lastErrorCode ?? t('settings.diagnostics.localIndex.none')}
            mono={Boolean(status.lastErrorCode)}
          />
        </div>
      ) : (
        <div className="px-4 py-4 text-xs text-[var(--color-text-tertiary)]">
          {unavailable ? t('settings.diagnostics.localIndex.unavailable') : t('common.loading')}
        </div>
      )}

      {stateMessage ? (
        <div role="status" className="border-t border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-text-tertiary)]">
          {stateMessage}
        </div>
      ) : null}
      {rebuildSucceeded ? (
        <div role="status" className="border-t border-[var(--color-border)] px-4 py-2 text-xs text-[var(--color-success)]">
          {t('settings.diagnostics.localIndex.rebuildSucceeded')}
        </div>
      ) : null}
    </section>
  )
}

function IndexMetric({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-[var(--color-text-tertiary)]">{label}</div>
      <div className={`mt-0.5 break-words text-xs font-medium text-[var(--color-text-primary)]${mono ? ' font-mono' : ''}`}>
        {value}
      </div>
    </div>
  )
}

type Translation = ReturnType<typeof useTranslation>

function localIndexStateLabel(state: LocalIndexState, t: Translation): string {
  return t(`settings.diagnostics.localIndex.state.${state}`)
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-[var(--color-border)] rounded-lg px-3 py-2">
      <div className="text-xs text-[var(--color-text-tertiary)]">{label}</div>
      <div className="text-sm font-semibold text-[var(--color-text-primary)] mt-1">{value}</div>
    </div>
  )
}

function EventRow({
  event,
  detailsLabel,
  eventIdLabel,
  copyEventIdLabel,
  eventIdCopiedLabel,
  eventIdCopyFailedLabel,
  addToast,
}: {
  event: DiagnosticEvent
  detailsLabel: string
  eventIdLabel: string
  copyEventIdLabel: string
  eventIdCopiedLabel: string
  eventIdCopyFailedLabel: string
  addToast: ReturnType<typeof useUIStore.getState>['addToast']
}) {
  const severityClass =
    event.severity === 'error'
      ? 'text-[var(--color-error)]'
      : event.severity === 'warn'
        ? 'text-[var(--color-warning)]'
        : 'text-[var(--color-text-tertiary)]'
  const detailsText = formatDetails(event.details)

  return (
    <div className="px-4 py-3 grid grid-cols-1 md:grid-cols-[120px_92px_1fr] gap-3 items-start">
      <div className="text-xs text-[var(--color-text-tertiary)] font-mono">
        {new Date(event.timestamp).toLocaleString()}
      </div>
      <div className={`text-xs font-semibold uppercase ${severityClass}`}>{event.severity}</div>
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-[var(--color-text-primary)] truncate">{event.type}</span>
          {event.sessionId && (
            <span className="text-[11px] text-[var(--color-text-tertiary)] font-mono truncate">{event.sessionId}</span>
          )}
        </div>
        <div className="text-xs text-[var(--color-text-secondary)] mt-1 break-words">{event.summary}</div>
        <button
          type="button"
          className="mt-1 inline-flex max-w-full items-center gap-1 text-[11px] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
          aria-label={`${copyEventIdLabel}: ${event.id}`}
          onClick={async () => {
            const copied = await copyTextToClipboard(event.id)
            addToast({ type: copied ? 'success' : 'error', message: copied ? eventIdCopiedLabel : eventIdCopyFailedLabel })
          }}
        >
          <span>{eventIdLabel}:</span>
          <span className="font-mono truncate">{event.id}</span>
          <span className="material-symbols-outlined text-[13px]" aria-hidden="true">content_copy</span>
        </button>
        {detailsText && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-[var(--color-text-tertiary)] select-none">
              {detailsLabel}
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2 text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
              {detailsText}
            </pre>
          </details>
        )}
      </div>
    </div>
  )
}

function formatDetails(details: unknown): string {
  if (details === null || details === undefined) return ''
  if (typeof details === 'string') return details
  try {
    return JSON.stringify(details, null, 2)
  } catch {
    return String(details)
  }
}

function formatEventForCopy(event: DiagnosticEvent): string {
  const header = `[${event.timestamp}] ${event.severity.toUpperCase()} ${event.type}${event.sessionId ? ` session=${event.sessionId}` : ''}`
  const details = formatDetails(event.details)
  if (!details) return `${header}: ${event.summary}`
  return `${header}: ${event.summary}\nDetails:\n${details}`
}
