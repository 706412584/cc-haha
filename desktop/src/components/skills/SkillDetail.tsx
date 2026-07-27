import { useCallback, useEffect, useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useSkillStore } from '../../stores/skillStore'
import { useTranslation } from '../../i18n'
import { useUIStore } from '../../stores/uiStore'
import { marketApi } from '../../api/market'
import { useMarketStore } from '../../stores/marketStore'
import { SkillDetailView, type SkillDetailMetaItem } from '../market/SkillDetailView'
import type { PreviewFileContent } from '../market/FilePreview'
import { Button } from '@/components/ui/Button'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { LoadingState } from '@/components/ui/LoadingState'
import { skillsApi } from '../../api/skills'
import { api } from '../../api/client'
import { useSessionStore } from '../../stores/sessionStore'
import { MultiSelectDropdown } from '@/components/ui/MultiSelectDropdown'

export function SkillDetail() {
  const { selectedSkill, selectedSkillReturnTab, isDetailLoading, clearSelection, fetchSkills } = useSkillStore()
  const t = useTranslation()
  const [confirmUninstall, setConfirmUninstall] = useState(false)
  const [uninstalling, setUninstalling] = useState(false)

  const handleBack = useCallback(() => {
    const returnTab = selectedSkillReturnTab
    clearSelection()
    if (returnTab === 'plugins') {
      useUIStore.getState().setPendingSettingsTab('plugins')
    }
  }, [selectedSkillReturnTab, clearSelection])

  const files = selectedSkill?.files ?? []

  // The files tab shows the file as it is on disk — frontmatter included. The
  // preview splits the YAML block out and renders it as structured metadata.
  const loadFile = useCallback(
    (path: string): Promise<PreviewFileContent> => {
      const file = files.find((f) => f.path === path)
      if (!file) return Promise.reject(new Error(`File not found: ${path}`))
      return Promise.resolve({
        path: file.path,
        content: file.content,
        language: file.language,
        size: file.content.length,
        truncated: false,
      })
    },
    [files],
  )

  const meta = useMemo<SkillDetailMetaItem[]>(() => {
    if (!selectedSkill) return []
    const skillMeta = selectedSkill.meta
    const items: SkillDetailMetaItem[] = [
      { label: t('settings.skills.summary.source'), value: t(`settings.skills.source.${skillMeta.source}`) },
      { label: t('settings.skills.summary.totalFiles'), value: String(selectedSkill.files.length) },
      {
        label: t('settings.skills.summary.tokens'),
        value: t('settings.skills.tokenEstimateShort', {
          count: String(Math.ceil(skillMeta.contentLength / 4)),
        }),
      },
    ]
    if (selectedSkill.marketMeta?.installedAt) {
      items.push({
        label: t('market.install.state.installed'),
        value: new Date(selectedSkill.marketMeta.installedAt).toLocaleDateString(),
      })
    }
    // SKILL.md frontmatter used to be flattened into this sidebar, where long
    // values and list fields were unreadable. It now renders as a structured
    // panel in the overview tab instead.
    return items
  }, [selectedSkill, t])

  if (isDetailLoading) {
    return <LoadingState label={t('common.loading')} labelHidden />
  }

  if (!selectedSkill) return null

  const skillMeta = selectedSkill.meta
  const marketMeta = selectedSkill.marketMeta
  const entryFile = selectedSkill.files.find((f) => f.isEntry)
  const description = entryFile ? (entryFile.body ?? entryFile.content) : ''
  const descriptionFrontmatter = entryFile?.frontmatter

  const runUninstall = async () => {
    if (!marketMeta) return
    setUninstalling(true)
    try {
      await marketApi.uninstall(marketMeta.id)
      useUIStore.getState().addToast({
        type: 'success',
        message: t('market.uninstall.success', { name: skillMeta.displayName || skillMeta.name }),
      })
      setConfirmUninstall(false)
      clearSelection()
      void fetchSkills()
      // Keep the market list in sync when it has this skill loaded.
      const market = useMarketStore.getState()
      const detailCache = new Map(market.detailCache)
      detailCache.delete(marketMeta.id)
      useMarketStore.setState({
        detailCache,
        items: market.items.map((item) =>
          item.id === marketMeta.id
            ? { ...item, installState: 'installable', installedInfo: undefined, notInstallableReason: undefined }
            : item,
        ),
      })
    } catch (err) {
      useUIStore.getState().addToast({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setUninstalling(false)
    }
  }

  const actions = marketMeta ? (
    <Button
      variant="danger-outline"
      size="lg"
      data-testid="local-skill-uninstall-button"
      loading={uninstalling}
      icon={<Trash2 className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />}
      onClick={() => setConfirmUninstall(true)}
    >
      {uninstalling ? t('market.uninstall.uninstalling') : t('market.uninstall.action')}
    </Button>
  ) : undefined

  return (
    <>
      <SkillDetailView
        name={skillMeta.displayName || skillMeta.name}
        version={skillMeta.version}
        sourceLabel={t(`settings.skills.source.${skillMeta.source}`)}
        summary={skillMeta.description}
        installState={marketMeta ? 'installed' : undefined}
        actions={actions}
        meta={meta}
        description={description}
        overviewContent={<SkillActivationScope skillName={skillMeta.name} />}
        descriptionFrontmatter={descriptionFrontmatter}        files={selectedSkill.files.map((f) => ({
          path: f.path,
          size: f.content.length,
          language: f.language,
        }))}
        loadFile={loadFile}
        onBack={handleBack}
        backLabel={t('settings.skills.back')}
      />

      <ConfirmDialog
        open={confirmUninstall}
        onClose={() => setConfirmUninstall(false)}
        onConfirm={() => void runUninstall()}
        title={t('market.uninstall.confirmTitle')}
        body={t('market.uninstall.confirmMessage', {
          name: skillMeta.displayName || skillMeta.name,
          path: selectedSkill.skillRoot,
        })}
        confirmLabel={t('market.uninstall.action')}
        cancelLabel={t('market.installConfirm.cancel')}
        confirmVariant="danger"
        loading={uninstalling}
      />
    </>
  )
}

type ActivationScope = 'off' | 'global' | 'project'

type ProjectChoice = {
  id: string
  label: string
  projectPath: string | null
  isCurrent: boolean
}

function SkillActivationScope({ skillName }: { skillName: string }) {
  const t = useTranslation()
  const [globalSkills, setGlobalSkills] = useState<string[]>([])
  // Set of project paths where this skill is currently active. Replaces the
  // old single "selectedProjectPath" model: the skill can now be active in
  // any number of projects independently.
  const [activeProjects, setActiveProjects] = useState<Set<string>>(new Set())
  const [projects, setProjects] = useState<ProjectChoice[]>([])
  const [saving, setSaving] = useState(false)
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const cwd = activeSession?.workDir || activeSession?.projectPath || undefined

  // Load the project list (reuse the project-rules endpoint) so the user can
  // pick WHICH projects the skill applies to under 'project' scope.
  useEffect(() => {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
    api.get<{ projects: ProjectChoice[] }>(`/api/project-rules${query}`)
      .then((res) => {
        setProjects(res.projects.filter((p) => p.projectPath))
      })
      .catch(() => {})
  }, [cwd])

  // Global is a single list; load it once.
  useEffect(() => {
    skillsApi.getActiveSkills('global').then(res => setGlobalSkills(res.activeSkills)).catch(() => {})
  }, [])

  // Project state is per-project. Fan out one read per project and collect
  // those whose activeSkills contains this skill into a Set. Re-run when the
  // resolved project list changes.
  useEffect(() => {
    let cancelled = false
    const projectPaths = projects.map(p => p.projectPath).filter((p): p is string => Boolean(p))
    if (projectPaths.length === 0) {
      setActiveProjects(new Set())
      return
    }
    Promise.all(
      projectPaths.map(async (path) => {
        try {
          const res = await skillsApi.getActiveSkills('project', path)
          return { path, active: res.activeSkills.includes(skillName) }
        } catch {
          return { path, active: false }
        }
      }),
    ).then((results) => {
      if (cancelled) return
      const next = new Set<string>()
      for (const { path, active } of results) {
        if (active) next.add(path)
      }
      setActiveProjects(next)
    })
    return () => { cancelled = true }
  }, [projects, skillName])

  const isGlobal = globalSkills.includes(skillName)
  const currentScope: ActivationScope =
    activeProjects.size > 0 ? 'project'
    : isGlobal ? 'global'
    : 'off'

  const writeProjectActivation = async (projectPath: string, shouldBeActive: boolean) => {
    // Read-modify-write that single project's activeSkills, leaving every
    // other project untouched. This keeps each toggle independent — a
    // failure on one project does not corrupt the others.
    const res = await skillsApi.getActiveSkills('project', projectPath)
    const current = res.activeSkills
    const has = current.includes(skillName)
    if (shouldBeActive === has) return
    const next = shouldBeActive
      ? [...current, skillName]
      : current.filter(s => s !== skillName)
    await skillsApi.setActiveSkills(next, 'project', projectPath)
  }

  // Bulk apply for the high-level Off / Global / Project buttons.
  const handleScopeChange = async (scope: ActivationScope) => {
    setSaving(true)
    try {
      if (scope === 'off') {
        // Clear from global + every active project.
        const promises: Promise<unknown>[] = []
        if (isGlobal) {
          promises.push(skillsApi.setActiveSkills(globalSkills.filter(s => s !== skillName), 'global'))
        }
        for (const p of activeProjects) {
          promises.push(writeProjectActivation(p, false))
        }
        await Promise.all(promises)
        setGlobalSkills(g => g.filter(s => s !== skillName))
        setActiveProjects(new Set())
        return
      }

      if (scope === 'global') {
        const promises: Promise<unknown>[] = []
        if (!isGlobal) {
          promises.push(skillsApi.setActiveSkills([...globalSkills, skillName], 'global'))
        }
        // Switching to global clears project-level entries to avoid double-injection.
        for (const p of activeProjects) {
          promises.push(writeProjectActivation(p, false))
        }
        await Promise.all(promises)
        setGlobalSkills(g => (g.includes(skillName) ? g : [...g, skillName]))
        setActiveProjects(new Set())
        return
      }

      // scope === 'project': default-activate the current project. If we're
      // already in project mode, this button is a no-op and the user should
      // use the multi-select dropdown instead.
      if (activeProjects.size === 0) {
        const defaultPath =
          projects.find(p => p.isCurrent)?.projectPath ??
          projects[0]?.projectPath
        if (!defaultPath) return
        const promises: Promise<unknown>[] = []
        if (isGlobal) {
          promises.push(skillsApi.setActiveSkills(globalSkills.filter(s => s !== skillName), 'global'))
        }
        promises.push(writeProjectActivation(defaultPath, true))
        await Promise.all(promises)
        setGlobalSkills(g => g.filter(s => s !== skillName))
        setActiveProjects(new Set([defaultPath]))
      }
    } catch {
      // ignore — UI state stays in sync with what we last successfully wrote
    } finally {
      setSaving(false)
    }
  }

  // Per-project toggle from the multi-select dropdown.
  const handleToggleProject = async (projectPath: string) => {
    if (saving) return
    const wantActive = !activeProjects.has(projectPath)
    setSaving(true)
    try {
      // Activating any project also clears the global flag, since the two
      // scopes are mutually exclusive in the high-level UI summary.
      const promises: Promise<unknown>[] = [writeProjectActivation(projectPath, wantActive)]
      if (wantActive && isGlobal) {
        promises.push(skillsApi.setActiveSkills(globalSkills.filter(s => s !== skillName), 'global'))
      }
      await Promise.all(promises)
      setActiveProjects(prev => {
        const next = new Set(prev)
        if (wantActive) next.add(projectPath)
        else next.delete(projectPath)
        return next
      })
      if (wantActive && isGlobal) {
        setGlobalSkills(g => g.filter(s => s !== skillName))
      }
    } catch {
      // ignore
    } finally {
      setSaving(false)
    }
  }

  const options: { value: ActivationScope; label: string; desc: string }[] = [
    { value: 'off', label: t('settings.skills.activation.off'), desc: t('settings.skills.activation.offDesc') },
    { value: 'global', label: t('settings.skills.activation.global'), desc: t('settings.skills.activation.globalDesc') },
    { value: 'project', label: t('settings.skills.activation.project'), desc: t('settings.skills.activation.projectDesc') },
  ]

  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)]">
          bolt
        </span>
        <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
          {t('settings.skills.activation.title')}
        </h4>
        {saving && (
          <span className="material-symbols-outlined animate-spin text-sm text-[var(--color-text-muted)]">progress_activity</span>
        )}
      </div>
      <p className="text-xs text-[var(--color-text-secondary)] mb-3">
        {t('settings.skills.activation.description')}
      </p>
      <div className="flex gap-2 flex-wrap">
        {options.map(opt => {
          const selected = currentScope === opt.value
          return (
            <button
              key={opt.value}
              onClick={() => handleScopeChange(opt.value)}
              disabled={saving}
              className={`flex items-center justify-center gap-2 rounded-xl border px-4 py-2 text-sm min-w-[88px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-surface)] ${
                selected
                  ? 'border-[var(--color-brand)] bg-[var(--color-brand)] text-[var(--color-btn-primary-fg)] font-medium shadow-[var(--shadow-button-primary)]'
                  : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]'
              } disabled:opacity-50`}
              title={opt.desc}
            >
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${selected ? 'bg-[var(--color-btn-primary-fg)]' : 'bg-[var(--color-text-muted)]'}`} />
              {opt.label}
            </button>
          )
        })}
      </div>

      {/* Multi-select project picker — visible whenever there are projects to
          choose from. The skill can be active in any combination of them. */}
      {currentScope === 'project' && projects.length > 0 && (
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-[var(--color-text-tertiary)]">
            {t('settings.skills.activation.appliesTo')}
          </span>
          <MultiSelectDropdown
            values={Array.from(activeProjects)}
            onToggle={(v) => void handleToggleProject(v)}
            items={projects.map((p) => ({
              value: p.projectPath ?? '',
              label: shortenProjectPath(p.label),
              description: p.isCurrent ? t('settings.skills.activation.currentProject') : undefined,
            }))}
            width={320}
            maxHeight={320}
            trigger={
              <div className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] transition-colors max-w-[260px]">
                <span className="truncate">
                  {activeProjects.size === 0
                    ? t('settings.skills.activation.selectProjects')
                    : activeProjects.size === 1
                      ? shortenProjectPath(
                          projects.find((p) => p.projectPath === Array.from(activeProjects)[0])?.label
                          ?? Array.from(activeProjects)[0]
                          ?? '',
                        )
                      : t('settings.skills.activation.projectCount', { count: activeProjects.size })}
                </span>
                <span className="material-symbols-outlined text-[16px] text-[var(--color-text-tertiary)] flex-shrink-0">expand_more</span>
              </div>
            }
          />
          {activeProjects.size > 0 && (
            <span className="inline-flex items-center gap-1 text-xs text-[var(--color-brand)]">
              <span className="material-symbols-outlined text-[14px]" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
              {t('settings.skills.activation.active')}
            </span>
          )}
        </div>
      )}
    </section>
  )
}

function shortenProjectPath(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean)
  if (parts.length <= 2) return p
  const sep = p.includes('\\') ? '\\' : '/'
  return '…' + sep + parts.slice(-2).join(sep)
}
