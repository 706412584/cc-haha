import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  Bot,
  Box,
  Boxes,
  Bolt,
  Braces,
  Check,
  CircleAlert,
  Folder,
  Hammer,
  Layers,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  Shield,
  Terminal,
  Trash2,
  User,
  Wrench,
} from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { TranslationKey } from '../../i18n'
import type { ModelInfo } from '../../types/settings'
import type {
  AgentDefinition,
  AgentMutationInput,
  AgentScope,
  AgentSource,
} from '../../api/agents'
import { useAgentStore } from '../../stores/agentStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { getSessionBrowsablePath } from '../../lib/sessionWorkspace'
import { useUIStore } from '../../stores/uiStore'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { LoadingState } from '@/components/ui/LoadingState'
import { DirectoryPicker } from '@/components/composite/DirectoryPicker'
import { IconButton } from '@/components/ui/IconButton'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { SearchField } from '@/components/ui/SearchField'
import { SelectField } from '@/components/ui/SelectField'
import { SettingsPageHeader } from '@/components/settings/SettingsSection'
import { ModelSelector } from '@/components/controls/ModelSelector'

const AGENT_COLORS: Record<string, string> = {
  red: '#ef4444',
  orange: '#f97316',
  yellow: '#eab308',
  green: '#22c55e',
  blue: '#3b82f6',
  purple: '#a855f7',
  pink: '#ec4899',
  cyan: '#06b6d4',
}

const AGENT_SOURCE_ORDER: AgentSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'policySettings',
  'plugin',
  'flagSettings',
  'built-in',
]

const BUILT_IN_MODELS = ['haiku', 'sonnet', 'opus', 'fable'] as const
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
/**
 * "Use whatever this build ships" in the built-in override modal, submitted as
 * `null`. Distinct from `inherit`, which is itself a persistable choice.
 */
const DEFAULT_CHOICE = '__default__'
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/
type ToolAccessMode = 'inherit' | 'none' | 'custom'
type ToolCategory = 'readSearch' | 'modify' | 'execute' | 'workflow' | 'other'

const TOOL_CATEGORY_ORDER: ToolCategory[] = ['readSearch', 'modify', 'execute', 'workflow', 'other']
const TOOL_METADATA: Record<string, { category: ToolCategory; description: TranslationKey }> = {
  Read: { category: 'readSearch', description: 'settings.agents.form.toolDescription.Read' },
  Glob: { category: 'readSearch', description: 'settings.agents.form.toolDescription.Glob' },
  Grep: { category: 'readSearch', description: 'settings.agents.form.toolDescription.Grep' },
  WebFetch: { category: 'readSearch', description: 'settings.agents.form.toolDescription.WebFetch' },
  WebSearch: { category: 'readSearch', description: 'settings.agents.form.toolDescription.WebSearch' },
  Edit: { category: 'modify', description: 'settings.agents.form.toolDescription.Edit' },
  Write: { category: 'modify', description: 'settings.agents.form.toolDescription.Write' },
  NotebookEdit: { category: 'modify', description: 'settings.agents.form.toolDescription.NotebookEdit' },
  Bash: { category: 'execute', description: 'settings.agents.form.toolDescription.Bash' },
  PowerShell: { category: 'execute', description: 'settings.agents.form.toolDescription.PowerShell' },
  TodoWrite: { category: 'workflow', description: 'settings.agents.form.toolDescription.TodoWrite' },
  Skill: { category: 'workflow', description: 'settings.agents.form.toolDescription.Skill' },
  ToolSearch: { category: 'workflow', description: 'settings.agents.form.toolDescription.ToolSearch' },
  EnterWorktree: { category: 'workflow', description: 'settings.agents.form.toolDescription.EnterWorktree' },
  ExitWorktree: { category: 'workflow', description: 'settings.agents.form.toolDescription.ExitWorktree' },
  StructuredOutput: { category: 'workflow', description: 'settings.agents.form.toolDescription.StructuredOutput' },
}

function getAgentProjectPath(agent?: AgentDefinition): string | undefined {
  if (agent?.source !== 'projectSettings' || !agent.baseDir) return undefined
  const normalized = agent.baseDir.replace(/\\/g, '/').replace(/\/+$/, '')
  const suffix = '/.claude/agents'
  if (!normalized.toLowerCase().endsWith(suffix)) return undefined
  const projectPath = normalized.slice(0, -suffix.length)
  if (!projectPath) return '/'
  return /^[A-Za-z]:$/.test(projectPath) ? `${projectPath}/` : projectPath
}

export function AgentManager() {
  const {
    activeAgents,
    allAgents,
    isLoading,
    error,
    mutationWarning,
    selectedAgent,
    selectedAgentReturnTab,
    fetchAgents,
    retryMutationRefresh,
    selectAgent,
  } = useAgentStore()
  const sessions = useSessionStore((state) => state.sessions)
  const activeSessionId = useSessionStore((state) => state.activeSessionId)
  const t = useTranslation()
  const [formState, setFormState] = useState<{ mode: 'create' | 'edit'; agent?: AgentDefinition } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AgentDefinition | null>(null)
  const [overrideTarget, setOverrideTarget] = useState<AgentDefinition | null>(null)

  const activeSession = sessions.find((session) => session.id === activeSessionId)
  const currentWorkDir = getSessionBrowsablePath(activeSession)
  const [agentContextPath, setAgentContextPath] = useState<string | undefined>(currentWorkDir)
  const contextSessionId = (
    activeSession && getSessionBrowsablePath(activeSession) === agentContextPath
      ? activeSession
      : sessions.find(
          (session) => getSessionBrowsablePath(session) === agentContextPath,
        )
  )?.id

  useEffect(() => {
    setAgentContextPath(currentWorkDir)
    void fetchAgents(currentWorkDir)
  }, [fetchAgents, currentWorkDir])

  const groupedAgents = useMemo(() => {
    const groups: Partial<Record<AgentSource, AgentDefinition[]>> = {}
    for (const agent of allAgents) {
      ;(groups[agent.source] ??= []).push(agent)
    }
    return groups
  }, [allAgents])

  const sourceCount = AGENT_SOURCE_ORDER.filter((source) => (groupedAgents[source] ?? []).length > 0).length
  const handleAgentBack = () => {
    const returnTab = selectedAgentReturnTab
    selectAgent(null)
    if (returnTab === 'plugins') useUIStore.getState().setPendingSettingsTab('plugins')
  }

  return (
    <div className="w-full min-w-0">
      {mutationWarning && (
        <div
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-xl)] border border-[var(--color-warning)] bg-[var(--color-warning-container)] px-4 py-3"
          role="status"
        >
          <div className="flex min-w-0 items-start gap-2">
            <CircleAlert size={17} className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-[var(--color-text-primary)]">
                {t('settings.agents.refreshWarning')}
              </p>
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw size={14} />}
            onClick={() => void retryMutationRefresh(
              agentContextPath,
              contextSessionId,
            )}
          >
            {t('common.retry')}
          </Button>
        </div>
      )}
      {selectedAgent ? (
        <AgentDetailView
          agent={selectedAgent}
          onBack={handleAgentBack}
          onEdit={() => setFormState({ mode: 'edit', agent: selectedAgent })}
          onDelete={() => setDeleteTarget(selectedAgent)}
          onOverride={() => setOverrideTarget(selectedAgent)}
        />
      ) : (
        <>
          <SettingsPageHeader
            title={t('settings.agents.title')}
            description={t('settings.agents.description')}
            action={(
              <Button icon={<Plus size={16} />} onClick={() => setFormState({ mode: 'create' })}>
                {t('settings.agents.create')}
              </Button>
            )}
          />

          {isLoading && allAgents.length === 0 ? (
            <LoadingState label={t('common.loading')} labelHidden size="md" />
          ) : error ? (
            <ErrorState
              title={t('settings.agents.loadError')}
              onRetry={() => void fetchAgents(agentContextPath)}
              retryLabel={t('common.retry')}
              size="lg"
            />
          ) : allAgents.length === 0 ? (
            <EmptyState
              icon={<Bot size={20} />}
              title={t('settings.agents.empty')}
              description={t('settings.agents.emptyHint')}
              size="md"
            />
          ) : (
            <div className="flex min-w-0 flex-col gap-6">
              <section className="overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
                <div className="grid min-w-0 gap-4 px-5 py-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(400px,1fr)] xl:items-end">
                  <div className="min-w-0">
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-tertiary)]">
                      {t('settings.agents.browserEyebrow')}
                    </div>
                    <div className="mb-2 flex items-center gap-3">
                      <Bot size={22} className="text-[var(--color-brand)]" />
                      <h3 className="text-lg font-semibold text-[var(--color-text-primary)]" style={{ fontFamily: 'var(--font-headline)' }}>
                        {t('settings.agents.browserTitle')}
                      </h3>
                    </div>
                  </div>
                  {/* Column count follows the track width, not the viewport: `sm:grid-cols-3`
                      kept forcing three columns into a 320px column and clipped the CJK labels. */}
                  <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(116px,1fr))] gap-3">
                    <SummaryCard label={t('settings.agents.summary.totalAgents')} value={String(allAgents.length)} icon={<Bot size={14} />} />
                    <SummaryCard label={t('settings.agents.summary.activeAgents')} value={String(activeAgents.length)} icon={<Bolt size={14} />} />
                    <SummaryCard label={t('settings.agents.summary.sources')} value={String(sourceCount)} icon={<Layers size={14} />} />
                  </div>
                </div>
              </section>

              <div className={`grid gap-4 ${sourceCount >= 2 ? 'xl:grid-cols-2' : ''}`}>
                {AGENT_SOURCE_ORDER.map((source) => {
                  const group = groupedAgents[source]
                  if (!group?.length) return null
                  const sourceLabel = t(`settings.agents.source.${source}`)
                  return (
                    <section key={source} className="min-w-0 overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--color-border)] bg-[var(--color-surface)]">
                      <div className="border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-5 py-4">
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full ${getAgentSourceAccentClass(source)}`}>
                            {getAgentSourceIcon(source)}
                          </span>
                          <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">{sourceLabel}</h4>
                          <span className="text-xs text-[var(--color-text-tertiary)]">{group.length}</span>
                        </div>
                        <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">
                          {t('settings.agents.groupHint', { source: sourceLabel, count: String(group.length) })}
                        </p>
                      </div>
                      <div className="flex flex-col p-2">
                        {group.map((agent, index) => (
                          // A row is a div, not a button: the actions on the
                          // right have to be siblings of the primary control,
                          // never nested inside it.
                          <div
                            key={`${agent.source}-${agent.agentType}-${agent.target ?? agent.baseDir ?? index}`}
                            className="group flex items-start gap-1 rounded-[var(--radius-xl)] border border-transparent px-3 py-3 transition-all hover:border-[var(--color-border-focus)] hover:bg-[var(--color-surface-hover)]"
                          >
                            <button
                              type="button"
                              onClick={() => selectAgent(agent, 'agents')}
                              className="min-w-0 flex-1 rounded-[var(--radius-lg)] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]"
                            >
                            <div className="flex items-start gap-3">
                              <Bot size={18} className="mt-0.5 shrink-0" style={{ color: getAgentDotColor(agent.color) }} />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="break-all font-mono text-[13px] font-semibold text-[var(--color-text-primary)]">{agent.agentType}</span>
                                  {agent.modelDisplay && <MetaPill>{agent.modelDisplay}</MetaPill>}
                                  {agent.effort !== undefined && <MetaPill>{agent.effort}</MetaPill>}
                                  <MetaPill>{sourceLabel}</MetaPill>
                                  <Badge
                                    tone={agent.isActive ? 'success' : 'neutral'}
                                    size="md"
                                    bordered
                                    className="uppercase tracking-[0.12em]"
                                  >
                                    {agent.isActive ? t('settings.agents.status.active') : t('settings.agents.status.available')}
                                  </Badge>
                                  {agent.overriddenBy && (
                                    <MetaPill>{t('settings.agents.overriddenBy', { source: t(`settings.agents.source.${agent.overriddenBy}`) })}</MetaPill>
                                  )}
                                </div>
                                <div className="mt-1 break-words text-xs leading-5 text-[var(--color-text-secondary)] [&_.prose]:text-xs [&_.prose]:leading-5 [&_.prose]:text-[var(--color-text-secondary)]">
                                  <MarkdownRenderer content={agent.description || t('settings.agents.noDescription')} />
                                </div>
                                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-text-tertiary)]">
                                  <span>{agent.tools === undefined
                                    ? t('settings.agents.noTools')
                                    : agent.tools.length === 0
                                      ? t('settings.agents.disabledTools')
                                      : t('settings.agents.toolCount', { count: String(agent.tools.length) })}</span>
                                  {(agent.target || agent.baseDir) && <span className="break-all font-mono">{agent.target || agent.baseDir}</span>}
                                </div>
                              </div>
                            </div>
                            </button>
                            <AgentRowActions
                              agent={agent}
                              onEdit={() => setFormState({ mode: 'edit', agent })}
                              onDelete={() => setDeleteTarget(agent)}
                              onOverride={() => setOverrideTarget(agent)}
                            />
                          </div>
                        ))}
                      </div>
                    </section>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}

      {formState && (
        <AgentFormModal
          mode={formState.mode}
          agent={formState.agent}
          cwd={agentContextPath}
          sessionId={contextSessionId}
          onProjectContextChange={setAgentContextPath}
          onClose={() => setFormState(null)}
        />
      )}
      <AgentDeleteDialog
        agent={deleteTarget}
        cwd={agentContextPath}
        sessionId={contextSessionId}
        onClose={() => setDeleteTarget(null)}
      />
      {overrideTarget && (
        <BuiltInAgentOverrideModal
          agent={overrideTarget}
          cwd={agentContextPath}
          sessionId={contextSessionId}
          onClose={() => setOverrideTarget(null)}
        />
      )}
    </div>
  )
}

function AgentDetailView({
  agent,
  onBack,
  onEdit,
  onDelete,
  onOverride,
}: {
  agent: AgentDefinition
  onBack: () => void
  onEdit: () => void
  onDelete: () => void
  onOverride: () => void
}) {
  const t = useTranslation()
  const sourceLabel = t(`settings.agents.source.${agent.source}`)
  const editable = isEditableAgent(agent)
  const inherited = t('settings.agents.detail.inherit')

  return (
    <div className="flex h-full min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" size="sm" icon={<ArrowLeft size={16} />} onClick={onBack}>
          {t('settings.agents.backToList')}
        </Button>
        {editable ? (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" icon={<Pencil size={14} />} onClick={onEdit}>
              {t('settings.agents.edit')}
            </Button>
            <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={onDelete}>
              {t('settings.agents.delete')}
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {agent.overridable && (
              <Button variant="secondary" size="sm" icon={<Bolt size={14} />} onClick={onOverride}>
                {t('settings.agents.override')}
              </Button>
            )}
            {/* Kept alongside the button: the prompt and tools really are fixed,
                and only the model and effort are not. */}
            <MetaPill><LockKeyhole size={11} /> {t('settings.agents.readOnly')}</MetaPill>
          </div>
        )}
      </div>

      <section className="overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
        <div className="grid gap-4 px-5 py-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(340px,1fr)] lg:items-start">
          <div className="min-w-0">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-tertiary)]">{t('settings.agents.entryEyebrow')}</div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: getAgentDotColor(agent.color) }} />
              <h3 className="break-all text-[22px] font-semibold leading-tight text-[var(--color-text-primary)]" style={{ fontFamily: 'var(--font-headline)' }}>{agent.agentType}</h3>
              <MetaPill>{sourceLabel}</MetaPill>
              <MetaPill>{agent.isActive ? t('settings.agents.status.active') : t('settings.agents.status.available')}</MetaPill>
              {agent.overriddenBy && (
                <MetaPill>{t('settings.agents.overriddenByShort', { source: t(`settings.agents.source.${agent.overriddenBy}`) })}</MetaPill>
              )}
            </div>
            <div className="max-w-4xl text-sm leading-6 text-[var(--color-text-secondary)]">
              <MarkdownRenderer content={agent.description || t('settings.agents.noDescription')} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <DetailStat label={t('settings.agents.detail.configuredModel')} value={agent.model || inherited} icon={<Braces size={14} />} />
            <DetailStat label={t('settings.agents.detail.configuredEffort')} value={agent.effort === undefined ? inherited : String(agent.effort)} icon={<Hammer size={14} />} />
            <DetailStat
              label={t('settings.agents.summary.tools')}
              value={agent.tools === undefined
                ? t('settings.agents.noTools')
                : agent.tools.length === 0
                  ? t('settings.agents.disabledTools')
                  : t('settings.agents.toolCount', { count: String(agent.tools.length) })}
              icon={<Wrench size={14} />}
            />
            <p className="col-span-2 text-xs leading-5 text-[var(--color-text-tertiary)]">
              {t('settings.agents.detail.effortHint')}
            </p>
          </div>
        </div>
      </section>

      {agent.tools && agent.tools.length > 0 && (
        <section className="rounded-[var(--radius-2xl)] border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4">
          <div className="mb-3 flex items-center gap-2">
            <Wrench size={18} className="text-[var(--color-text-tertiary)]" />
            <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">{t('settings.agents.tools')}</h4>
          </div>
          <div className="flex flex-wrap gap-2">{agent.tools.map((tool) => <MetaPill key={tool}>{tool}</MetaPill>)}</div>
        </section>
      )}

      <section className="flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3">
            <div className="min-w-0">
              <div className="break-all font-mono text-xs text-[var(--color-text-secondary)]">{agent.target || agent.baseDir || sourceLabel}</div>
              <div className="mt-1 text-[11px] text-[var(--color-text-tertiary)]">{t('settings.agents.promptHint')}</div>
            </div>
            <MetaPill>{t('settings.agents.systemPrompt')}</MetaPill>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--color-surface-container-lowest)]">
            {agent.systemPrompt ? (
              <div className="px-6 py-5 lg:px-8">
                <MarkdownRenderer content={agent.systemPrompt} variant="document" className="mx-auto max-w-[72ch]" />
              </div>
            ) : (
              <div className="px-6 py-10 text-center text-sm text-[var(--color-text-tertiary)]">{t('settings.agents.noSystemPrompt')}</div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

function AgentFormModal({
  mode,
  agent,
  cwd,
  sessionId,
  onProjectContextChange,
  onClose,
}: {
  mode: 'create' | 'edit'
  agent?: AgentDefinition
  cwd?: string
  sessionId?: string
  onProjectContextChange: (path: string) => void
  onClose: () => void
}) {
  const t = useTranslation()
  const createAgent = useAgentStore((state) => state.createAgent)
  const updateAgent = useAgentStore((state) => state.updateAgent)
  const isMutating = useAgentStore((state) => state.isMutating)
  const availableTools = useAgentStore((state) => state.availableTools)
  const sessions = useSessionStore((state) => state.sessions)
  const initialScope = agent?.source === 'projectSettings' ? 'project' : 'user'
  const initialModel = agent?.model || 'inherit'
  const [scope, setScope] = useState<AgentScope>(initialScope)
  const [projectPath, setProjectPath] = useState(
    initialScope === 'project' ? getAgentProjectPath(agent) || cwd || '' : cwd || '',
  )
  const [name, setName] = useState(agent?.agentType || '')
  const [description, setDescription] = useState(agent?.description || '')
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt || '')
  const [modelChoice, setModelChoice] = useState(initialModel)
  const initialEffort = agent?.effort === undefined ? 'inherit' : String(agent.effort)
  const hasLegacyEffort = initialEffort !== 'inherit' && !EFFORTS.includes(initialEffort as typeof EFFORTS[number])
  const [effort, setEffort] = useState(initialEffort)
  const initialToolAccess: ToolAccessMode = agent?.tools === undefined
    ? 'inherit'
    : agent.tools.length === 0
      ? 'none'
      : 'custom'
  const [toolAccess, setToolAccess] = useState<ToolAccessMode>(initialToolAccess)
  const initialTools = agent?.tools ?? []
  const [selectedBuiltInTools, setSelectedBuiltInTools] = useState(
    initialTools.filter(tool => availableTools.includes(tool)),
  )
  const [customTools, setCustomTools] = useState(
    initialTools.filter(tool => !availableTools.includes(tool)).join(', '),
  )
  const [toolsDirty, setToolsDirty] = useState(false)
  const parsedTools = useMemo(
    () => [...new Set([...selectedBuiltInTools, ...parseTools(customTools)])],
    [customTools, selectedBuiltInTools],
  )
  const [color, setColor] = useState(agent?.color || '')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [submitError, setSubmitError] = useState<string | null>(null)

  const handleSubmit = async () => {
    const nextErrors: Record<string, string> = {}
    const trimmedName = name.trim()
    if (!NAME_PATTERN.test(trimmedName)) nextErrors.name = t('settings.agents.form.nameError')
    if (!description.trim()) nextErrors.description = t('settings.agents.form.descriptionRequired')
    if (mode === 'create' && !systemPrompt.trim()) nextErrors.systemPrompt = t('settings.agents.form.systemPromptRequired')
    if (toolAccess === 'custom' && parsedTools.length === 0) nextErrors.tools = t('settings.agents.form.toolsCustomRequired')
    if (scope === 'project' && !projectPath) nextErrors.scope = t('settings.agents.form.projectUnavailable')
    setFieldErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return

    const toolSelectionIsUnchanged = mode === 'edit' &&
      toolAccess === initialToolAccess &&
      (toolAccess !== 'custom' || !toolsDirty)
    const targetCwd = scope === 'project' ? projectPath : cwd
    const input: AgentMutationInput = {
      scope,
      ...(targetCwd ? { cwd: targetCwd } : {}),
      ...(mode === 'edit' && agent?.target ? { target: agent.target } : {}),
      name: trimmedName,
      description: description.trim(),
      systemPrompt: systemPrompt.trim(),
      ...(mode === 'edit'
        ? { model: modelChoice === 'inherit' ? null : modelChoice }
        : modelChoice === 'inherit' ? {} : { model: modelChoice }),
      ...(mode === 'edit'
        ? { effort: effort === 'inherit' ? null : typeof agent?.effort === 'number' && effort === initialEffort ? agent.effort : effort }
        : effort === 'inherit' ? {} : { effort }),
      ...(mode === 'edit'
        ? {
            tools: toolSelectionIsUnchanged
              ? agent?.tools ?? null
              : toolAccess === 'inherit'
                ? null
                : toolAccess === 'none'
                  ? []
                  : parsedTools,
          }
        : toolAccess === 'inherit' ? {} : { tools: toolAccess === 'none' ? [] : parsedTools }),
      ...(mode === 'edit' ? { color: color || null } : color ? { color } : {}),
    }

    setSubmitError(null)
    try {
      const targetSessionId = scope === 'project'
        ? sessions.find((session) => getSessionBrowsablePath(session) === projectPath)?.id
        : sessionId
      if (mode === 'edit' && agent) {
        await updateAgent(agent.agentType, input, targetSessionId)
      } else {
        await createAgent(input, targetSessionId)
      }
      if (scope === 'project' && targetCwd) onProjectContextChange(targetCwd)
      onClose()
    } catch {
      setSubmitError(t('settings.agents.form.saveError'))
    }
  }

  return (
    <Modal
      open
      onClose={isMutating ? () => {} : onClose}
      title={mode === 'edit' ? t('settings.agents.editTitle') : t('settings.agents.createTitle')}
      width={680}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={isMutating}>{t('common.cancel')}</Button>
          <Button onClick={() => void handleSubmit()} loading={isMutating}>{t('common.save')}</Button>
        </>
      )}
    >
      <div className="grid gap-4">
        <Field label={t('settings.agents.form.scope')} error={fieldErrors.scope} required>
          <div className="grid grid-cols-2 gap-2" role="group" aria-label={t('settings.agents.form.scope')}>
            {([
              { value: 'user' as const, label: t('settings.agents.form.scopeUser'), icon: <User size={16} /> },
              { value: 'project' as const, label: t('settings.agents.form.scopeProject'), icon: <Folder size={16} /> },
            ]).map((option) => {
              const selected = scope === option.value
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={selected}
                  disabled={mode === 'edit'}
                  onClick={() => setScope(option.value)}
                  className={`flex min-h-16 items-center gap-3 rounded-[var(--radius-lg)] border px-4 py-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                    selected
                      ? 'border-[var(--color-border-focus)] bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
                      : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                  }`}
                >
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                    selected ? 'bg-[var(--color-primary-fixed)] text-[var(--color-brand)]' : 'bg-[var(--color-surface-container-high)]'
                  }`}>
                    {option.icon}
                  </span>
                  <span className="text-sm font-semibold">{option.label}</span>
                </button>
              )
            })}
          </div>
          {scope === 'project' && (
            <div className="mt-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--color-text-primary)]">
                    {projectPath
                      ? t('settings.agents.form.projectTarget', { path: projectPath })
                      : t('settings.agents.form.projectUnavailable')}
                  </p>
                </div>
                {mode === 'create' && (
                  <DirectoryPicker value={projectPath} onChange={setProjectPath} />
                )}
              </div>
            </div>
          )}
        </Field>

        <Input
          label={t('settings.agents.form.name')}
          required
          value={name}
          disabled={mode === 'edit'}
          error={fieldErrors.name}
          placeholder={t('settings.agents.form.namePlaceholder')}
          onChange={(event) => setName(event.target.value)}
        />
        <Input
          label={t('settings.agents.form.description')}
          required
          value={description}
          error={fieldErrors.description}
          placeholder={t('settings.agents.form.descriptionPlaceholder')}
          onChange={(event) => setDescription(event.target.value)}
        />

        <Field
          label={t('settings.agents.form.systemPrompt')}
          error={fieldErrors.systemPrompt}
          required={mode === 'create'}
        >
          <textarea
            aria-label={t('settings.agents.form.systemPrompt')}
            value={systemPrompt}
            rows={7}
            placeholder={t('settings.agents.form.systemPromptPlaceholder')}
            onChange={(event) => setSystemPrompt(event.target.value)}
            className={`${textAreaClassName} ${fieldErrors.systemPrompt ? 'border-[var(--color-error)]' : ''}`}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('settings.agents.form.model')}>
            <AgentModelSelector
              label={t('settings.agents.form.model')}
              value={modelChoice}
              onChange={setModelChoice}
            />
          </Field>
          <Field label={t('settings.agents.form.effort')}>
            <AgentSelect
              label={t('settings.agents.form.effort')}
              value={effort}
              onChange={setEffort}
              items={[
                { value: 'inherit', label: t('settings.agents.form.inherit') },
                ...(hasLegacyEffort ? [{ value: initialEffort, label: initialEffort }] : []),
                ...EFFORTS.map((value) => ({ value, label: value })),
              ]}
            />
          </Field>
        </div>

        <p className="-mt-2 text-xs leading-5 text-[var(--color-text-tertiary)]">
          {t('settings.agents.form.modelProviderHint')}
        </p>

        <Field label={t('settings.agents.form.tools')}>
          <AgentSelect<ToolAccessMode>
            label={t('settings.agents.form.tools')}
            value={toolAccess}
            onChange={setToolAccess}
            items={[
              { value: 'inherit', label: t('settings.agents.form.toolsInherit') },
              { value: 'none', label: t('settings.agents.form.toolsNone') },
              { value: 'custom', label: t('settings.agents.form.toolsCustom') },
            ]}
          />
        </Field>
        <p className="-mt-3 text-xs text-[var(--color-text-tertiary)]">
          {toolAccess === 'inherit'
            ? t('settings.agents.form.toolsInheritHint')
            : toolAccess === 'none'
              ? t('settings.agents.form.toolsNoneHint')
              : t('settings.agents.form.toolsHint')}
        </p>
        {toolAccess === 'custom' && (
          <ToolPicker
            availableTools={availableTools}
            selectedTools={selectedBuiltInTools}
            customTools={customTools}
            error={fieldErrors.tools}
            onSelectedToolsChange={(nextTools) => {
              setSelectedBuiltInTools(nextTools)
              setToolsDirty(true)
            }}
            onCustomToolsChange={(value) => {
              setCustomTools(value)
              setToolsDirty(true)
            }}
          />
        )}

        <Field label={t('settings.agents.form.color')}>
          <AgentSelect
            label={t('settings.agents.form.color')}
            value={color}
            onChange={setColor}
            items={[
              { value: '', label: t('settings.agents.form.noColor') },
              ...Object.keys(AGENT_COLORS).map((value) => ({
                value,
                label: value,
              })),
            ]}
          />
        </Field>

        {submitError && <ErrorState title={submitError} size="sm" />}
      </div>
    </Modal>
  )
}

function ToolPicker({
  availableTools,
  selectedTools,
  customTools,
  error,
  onSelectedToolsChange,
  onCustomToolsChange,
}: {
  availableTools: string[]
  selectedTools: string[]
  customTools: string
  error?: string
  onSelectedToolsChange: (tools: string[]) => void
  onCustomToolsChange: (value: string) => void
}) {
  const t = useTranslation()
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const visibleTools = availableTools.filter((tool) => {
    if (!normalizedQuery) return true
    const metadata = TOOL_METADATA[tool]
    const description = t(metadata?.description ?? 'settings.agents.form.toolDescription.generic')
    const category = t(`settings.agents.form.toolCategory.${metadata?.category ?? 'other'}`)
    return `${tool} ${description} ${category}`.toLowerCase().includes(normalizedQuery)
  })
  const groupedTools = TOOL_CATEGORY_ORDER.map((category) => ({
    category,
    tools: visibleTools.filter(tool => (TOOL_METADATA[tool]?.category ?? 'other') === category),
  })).filter(group => group.tools.length > 0)

  const toggleTool = (tool: string) => {
    onSelectedToolsChange(
      selectedTools.includes(tool)
        ? selectedTools.filter(selectedTool => selectedTool !== tool)
        : [...selectedTools, tool],
    )
  }

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-[var(--color-text-primary)]">
            {t('settings.agents.form.builtInTools')}
          </p>
          <p className="mt-0.5 text-xs text-[var(--color-text-tertiary)]">
            {t('settings.agents.form.builtInToolsHint')}
          </p>
        </div>
        <Badge tone="brand" size="md">
          {t('settings.agents.form.toolsSelectedCount', { count: selectedTools.length })}
        </Badge>
      </div>

      {availableTools.length > 0 ? (
        <>
          <SearchField
            value={query}
            onChange={setQuery}
            label={t('settings.agents.form.toolsSearch')}
            // Without this the clear button falls back to the field's own name,
            // so both carry the same accessible label.
            clearLabel={t('common.clearSearch')}
            placeholder={t('settings.agents.form.toolsSearchPlaceholder')}
            size="md"
            containerClassName="mb-3"
          />
          <div className="max-h-64 space-y-3 overflow-y-auto pr-1">
            {groupedTools.map(({ category, tools }) => (
              <section key={category} aria-label={t(`settings.agents.form.toolCategory.${category}`)}>
                <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-tertiary)]">
                  {t(`settings.agents.form.toolCategory.${category}`)}
                </h4>
                <div className="grid gap-2 sm:grid-cols-2">
                  {tools.map((tool) => {
                    const selected = selectedTools.includes(tool)
                    const description = t(TOOL_METADATA[tool]?.description ?? 'settings.agents.form.toolDescription.generic')
                    return (
                      <button
                        key={tool}
                        type="button"
                        role="checkbox"
                        aria-checked={selected}
                        aria-label={`${tool} — ${description}`}
                        onClick={() => toggleTool(tool)}
                        className={`flex min-h-14 items-start gap-2.5 rounded-[var(--radius-md)] border px-3 py-2.5 text-left transition-colors ${
                          selected
                            ? 'border-[var(--color-border-focus)] bg-[var(--color-surface-selected)]'
                            : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)]'
                        }`}
                      >
                        <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                          selected
                            ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-white'
                            : 'border-[var(--color-outline)] bg-[var(--color-surface)]'
                        }`}>
                          {selected && <Check size={12} strokeWidth={3} />}
                        </span>
                        <span className="min-w-0">
                          <span className="block font-mono text-xs font-semibold text-[var(--color-text-primary)]">{tool}</span>
                          <span className="mt-0.5 block text-[11px] leading-4 text-[var(--color-text-tertiary)]">{description}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </section>
            ))}
            {groupedTools.length === 0 && (
              <p className="py-5 text-center text-xs text-[var(--color-text-tertiary)]">
                {t('settings.agents.form.toolsNoResults')}
              </p>
            )}
          </div>
        </>
      ) : (
        <EmptyState description={t('settings.agents.form.toolsUnavailable')} variant="dashed" size="sm" />
      )}

      <div className="mt-3 border-t border-[var(--color-border)] pt-3">
        <Input
          label={t('settings.agents.form.toolsCustomLabel')}
          value={customTools}
          error={error}
          placeholder={t('settings.agents.form.toolsPlaceholder')}
          onChange={(event) => onCustomToolsChange(event.target.value)}
        />
        <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">
          {t('settings.agents.form.toolsCustomHint')}
        </p>
      </div>
    </div>
  )
}

function AgentDeleteDialog({
  agent,
  cwd,
  sessionId,
  onClose,
}: {
  agent: AgentDefinition | null
  cwd?: string
  sessionId?: string
  onClose: () => void
}) {
  const t = useTranslation()
  const deleteAgent = useAgentStore((state) => state.deleteAgent)
  const isMutating = useAgentStore((state) => state.isMutating)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const scope = agent ? getEditableScope(agent) : null

  useEffect(() => {
    setDeleteError(null)
  }, [agent])

  const handleDelete = async () => {
    if (!agent || !scope) return
    setDeleteError(null)
    try {
      await deleteAgent(agent.agentType, scope, cwd, agent.target, sessionId)
      onClose()
    } catch {
      setDeleteError(t('settings.agents.deleteError'))
    }
  }

  return (
    <ConfirmDialog
      open={Boolean(agent)}
      onClose={isMutating ? () => {} : onClose}
      onConfirm={handleDelete}
      title={t('settings.agents.deleteTitle')}
      body={(
        <div className="space-y-3">
          <p>{t('settings.agents.deleteBody', { name: agent?.agentType || '' })}</p>
          {agent?.target && (
            <p className="break-all font-mono text-xs text-[var(--color-text-tertiary)]">
              {t('settings.agents.deleteTarget', { target: agent.target })}
            </p>
          )}
          {deleteError && <p role="alert" className="text-sm text-[var(--color-error)]">{deleteError}</p>}
        </div>
      )}
      confirmLabel={t('settings.agents.deleteConfirm')}
      cancelLabel={t('common.cancel')}
      loading={isMutating}
    />
  )
}

/**
 * Model/effort editor for a built-in agent.
 *
 * Deliberately not `AgentFormModal` with a flag. That component exists to build
 * an `AgentMutationInput` whose name, description and system prompt are all
 * required, and none of those apply here; threading a variant through its
 * render branches and its payload-construction chain would put the riskiest
 * code in this file on a second, unrelated path.
 */
function BuiltInAgentOverrideModal({
  agent,
  cwd,
  sessionId,
  onClose,
}: {
  agent: AgentDefinition
  cwd?: string
  sessionId?: string
  onClose: () => void
}) {
  const t = useTranslation()
  const setAgentOverride = useAgentStore((state) => state.setAgentOverride)
  const clearAgentOverride = useAgentStore((state) => state.clearAgentOverride)
  const isMutating = useAgentStore((state) => state.isMutating)

  const defaultModel = agent.defaults?.model
  const defaultEffort = agent.defaults?.effort
  const overrideSource = agent.override?.source
  // A managed or project-level override cannot be edited from the user file
  // this modal writes to, so saying so beats a write that silently loses.
  const isManaged = overrideSource !== undefined && overrideSource !== 'userSettings'

  const initialModel = agent.override?.model
  const initialEffort = agent.override?.effort
  const [modelChoice, setModelChoice] = useState(
    initialModel ?? DEFAULT_CHOICE,
  )
  const [effort, setEffort] = useState(
    initialEffort === undefined ? DEFAULT_CHOICE : String(initialEffort),
  )
  const [submitError, setSubmitError] = useState<string | null>(null)

  const describeDefault = (value: string | number | undefined) =>
    value === undefined
      ? t('settings.agents.overrideDefaultNone')
      : t('settings.agents.overrideDefault', { value: String(value) })

  const handleSave = async () => {
    setSubmitError(null)
    try {
      await setAgentOverride(
        agent.agentType,
        {
          ...(cwd ? { cwd } : {}),
          // `null` clears the override so the shipped default applies again.
          // Never send the default's literal value: that would freeze today's
          // default into the user's settings file forever.
          model:
            modelChoice === DEFAULT_CHOICE
              ? null
              : modelChoice,
          effort: effort === DEFAULT_CHOICE ? null : effort,
        },
        sessionId,
      )
      onClose()
    } catch {
      setSubmitError(t('settings.agents.overrideSaveError'))
    }
  }

  const handleReset = async () => {
    setSubmitError(null)
    try {
      await clearAgentOverride(agent.agentType, cwd, sessionId)
      onClose()
    } catch {
      setSubmitError(t('settings.agents.overrideResetError'))
    }
  }

  return (
    <Modal
      open
      onClose={isMutating ? () => {} : onClose}
      title={t('settings.agents.overrideTitle')}
      width={520}
      footer={(
        <>
          {agent.override && !isManaged && (
            <Button variant="ghost" onClick={() => void handleReset()} disabled={isMutating}>
              {t('settings.agents.overrideReset')}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose} disabled={isMutating}>{t('common.cancel')}</Button>
          <Button onClick={() => void handleSave()} disabled={isMutating || isManaged}>
            {t('common.save')}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-all font-mono text-sm font-semibold text-[var(--color-text-primary)]">
            {agent.agentType}
          </span>
          <MetaPill>{t('settings.agents.source.built-in')}</MetaPill>
          {agent.override && <MetaPill>{t('settings.agents.overrideBadge')}</MetaPill>}
        </div>

        {agent.overriddenBy && (
          // Editing a built-in that a same-named user agent shadows would look
          // like it worked and change nothing at spawn time.
          <p role="status" className="rounded-[var(--radius-lg)] bg-[var(--color-warning-container)] px-3 py-2 text-xs leading-5 text-[var(--color-text-primary)]">
            {t('settings.agents.overrideShadowed', {
              source: t(`settings.agents.source.${agent.overriddenBy}`),
            })}
          </p>
        )}
        {isManaged && (
          <p role="status" className="rounded-[var(--radius-lg)] bg-[var(--color-surface-container-low)] px-3 py-2 text-xs leading-5 text-[var(--color-text-secondary)]">
            {t('settings.agents.overrideManaged', {
              source: t(`settings.agents.source.${overrideSource}`),
            })}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('settings.agents.form.model')}>
            <AgentModelSelector
              label={t('settings.agents.form.model')}
              value={modelChoice}
              onChange={setModelChoice}
              disabled={isManaged}
              defaultLabel={describeDefault(defaultModel)}
            />
          </Field>
          <Field label={t('settings.agents.form.effort')}>
            <AgentSelect
              label={t('settings.agents.form.effort')}
              value={effort}
              onChange={setEffort}
              disabled={isManaged}
              items={[
                // No "inherit" entry: effort has no such value, omitting it is
                // what inherits.
                { value: DEFAULT_CHOICE, label: describeDefault(defaultEffort) },
                ...EFFORTS.map((value) => ({ value, label: value })),
              ]}
            />
          </Field>
        </div>

        <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">
          {t('settings.agents.overrideHint')}
        </p>
        <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">
          {t('settings.agents.form.modelProviderHint')}
        </p>
        <p className="text-xs leading-5 text-[var(--color-text-tertiary)]">
          {t('settings.agents.overrideScopeHint')}
        </p>
        {submitError && <p role="alert" className="text-sm text-[var(--color-error)]">{submitError}</p>}
      </div>
    </Modal>
  )
}

/**
 * The per-row actions, rendered as a sibling of the row's primary button.
 *
 * Hidden until the row is hovered, but `focus-within` is not optional: without
 * it a keyboard user tabs onto a control they cannot see. The fade lives on
 * this wrapper rather than on the buttons because IconButton already sets
 * `transition-colors`, and a second transition utility on the same element
 * resolves by stylesheet order instead of by intent.
 */
function AgentRowActions({
  agent,
  onEdit,
  onDelete,
  onOverride,
}: {
  agent: AgentDefinition
  onEdit: () => void
  onDelete: () => void
  onOverride: () => void
}) {
  const t = useTranslation()
  const editable = isEditableAgent(agent)
  const overridable = agent.overridable === true

  if (!editable && !overridable) return null

  return (
    <span
      // Marked for the touch stylesheet: hover-only affordances are
      // permanently invisible on a touchscreen.
      data-agent-row-actions
      className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100"
    >
      {editable ? (
        <>
          <IconButton
            size="sm"
            tone="muted"
            icon={<Pencil size={14} />}
            label={t('settings.agents.rowEdit', { name: agent.agentType })}
            onClick={onEdit}
          />
          <IconButton
            size="sm"
            tone="muted"
            // A delete icon that sits red at rest reads as an error state.
            hoverTone="danger"
            icon={<Trash2 size={14} />}
            label={t('settings.agents.rowDelete', { name: agent.agentType })}
            onClick={onDelete}
          />
        </>
      ) : (
        // Built-ins get model/effort only — their file is never rewritten, so
        // there is deliberately no delete here.
        <IconButton
          size="sm"
          tone="muted"
          icon={<Bolt size={14} />}
          label={t('settings.agents.rowOverride', { name: agent.agentType })}
          onClick={onOverride}
        />
      )}
    </span>
  )
}

function isEditableAgent(agent: AgentDefinition) {
  return agent.editable === true && getEditableScope(agent) !== null
}

function getEditableScope(agent: AgentDefinition): AgentScope | null {
  if (agent.source === 'userSettings') return 'user'
  if (agent.source === 'projectSettings') return 'project'
  return null
}

function parseTools(value: string) {
  const parsed: string[] = []
  let current = ''
  let parenDepth = 0

  const pushCurrent = () => {
    const tool = current.trim()
    if (tool) parsed.push(tool)
    current = ''
  }

  for (const char of value) {
    if (char === '(') {
      parenDepth += 1
      current += char
    } else if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1)
      current += char
    } else if ((char === ',' || char === ' ') && parenDepth === 0) {
      pushCurrent()
    } else {
      current += char
    }
  }
  pushCurrent()

  return [...new Set(parsed)]
}

function getAgentDotColor(color?: string) {
  return color && AGENT_COLORS[color] ? AGENT_COLORS[color] : 'var(--color-text-tertiary)'
}

function getAgentSourceIcon(source: AgentSource) {
  const iconProps = { size: 16 }
  switch (source) {
    case 'userSettings': return <User {...iconProps} />
    case 'projectSettings': return <Folder {...iconProps} />
    case 'localSettings': return <LockKeyhole {...iconProps} />
    case 'policySettings': return <Shield {...iconProps} />
    case 'plugin': return <Boxes {...iconProps} />
    case 'flagSettings': return <Terminal {...iconProps} />
    case 'built-in': return <Box {...iconProps} />
  }
}

function getAgentSourceAccentClass(source: AgentSource) {
  switch (source) {
    case 'userSettings': return 'bg-[var(--color-primary-fixed)] text-[var(--color-brand)]'
    case 'projectSettings': return 'bg-[var(--color-success-container)] text-[var(--color-success)]'
    case 'localSettings': return 'bg-[var(--color-info-container)] text-[var(--color-info)]'
    case 'policySettings': return 'bg-[var(--color-warning-container)] text-[var(--color-on-warning-container)]'
    case 'plugin': return 'bg-[var(--color-warning-container)] text-[var(--color-on-warning-container)]'
    case 'flagSettings': return 'bg-[var(--color-error-container)] text-[var(--color-on-error-container)]'
    case 'built-in': return 'bg-[var(--color-surface-container-high)] text-[var(--color-text-tertiary)]'
  }
}

function AgentModelSelector({
  label,
  value,
  onChange,
  disabled,
  defaultLabel,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  defaultLabel?: string
}) {
  const t = useTranslation()
  const availableModels = useSettingsStore((state) => state.availableModels)
  const models = useMemo(() => {
    const choices: ModelInfo[] = []
    const seen = new Set<string>()
    const add = (model: ModelInfo) => {
      if (seen.has(model.id)) return
      seen.add(model.id)
      choices.push(model)
    }

    if (defaultLabel) {
      add({
        id: DEFAULT_CHOICE,
        name: defaultLabel,
        description: t('settings.agents.form.modelDefaultDescription'),
        context: '',
      })
    }
    add({
      id: 'inherit',
      name: t('settings.agents.form.inherit'),
      description: t('settings.agents.form.modelInheritDescription'),
      context: '',
    })
    for (const alias of BUILT_IN_MODELS) {
      add({
        id: alias,
        name: alias,
        description: t('settings.agents.form.modelAliasDescription'),
        context: '',
      })
    }

    if (!seen.has(value) && value) {
      add({
        id: value,
        name: value,
        description: t('settings.agents.form.modelUnavailableDescription'),
        context: '',
      })
    }
    availableModels.forEach(add)
    return choices
  }, [availableModels, defaultLabel, t, value])

  return (
    <ModelSelector
      value={value}
      onChange={onChange}
      models={models}
      ariaLabel={label}
      appearance="field"
      disabled={disabled}
      fluid
    />
  )
}

function AgentSelect<T extends string>({
  label,
  items,
  value,
  onChange,
  disabled,
}: {
  label: string
  items: Array<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
  disabled?: boolean
}) {
  return (
    <SelectField<T>
      label={label}
      labelHidden
      options={items.map(({ value: optionValue, label: optionLabel }) => ({
        value: optionValue,
        label: optionLabel,
      }))}
      value={value}
      onChange={onChange}
      disabled={disabled}
      size="lg"
    />
  )
}

function Field({ label, error, required, children }: { label: string; error?: string; required?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium text-[var(--color-text-primary)]">
        {label}{required && <span className="ml-0.5 text-[var(--color-error)]">*</span>}
      </span>
      {children}
      {error && <p className="text-xs text-[var(--color-error)]">{error}</p>}
    </div>
  )
}

/**
 * The agent metadata chip.
 *
 * `bordered` is what makes this expressible as a `Badge`: these pills carry
 * both a fill and a hairline border, and they sit on three different
 * backgrounds (`--color-surface` cards, `--color-surface-container-low`
 * headers, and the bare page). A plain `outline` badge would collapse into the
 * card on the first of those.
 */
function MetaPill({ children }: { children: ReactNode }) {
  return (
    <Badge tone="neutral" size="md" bordered className="uppercase tracking-[0.12em]">
      {children}
    </Badge>
  )
}

function SummaryCard({ label, value, icon, className = '' }: { label: string; value: string; icon: ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3 ${className}`}>
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">{icon}<span className="truncate">{label}</span></div>
      <div className="mt-2 truncate text-lg font-semibold text-[var(--color-text-primary)]">{value}</div>
    </div>
  )
}

function DetailStat({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-[var(--color-text-tertiary)]">{icon}<span>{label}</span></div>
      <div className="mt-2 break-all text-base font-semibold text-[var(--color-text-primary)]">{value}</div>
    </div>
  )
}

const textAreaClassName = 'min-h-32 resize-y rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)] focus:shadow-[var(--shadow-focus-ring)]'
