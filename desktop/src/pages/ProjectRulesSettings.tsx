import { useState, useEffect } from 'react'
import { useTranslation, type TranslationKey } from '../i18n'
import { Button } from '../components/shared/Button'
import { useSessionStore } from '../stores/sessionStore'
import { getDesktopHost } from '../lib/desktopHost'
import { api } from '../api/client'

type RulesFileStatus = {
  path: string
  exists: boolean
}

type ProjectRulesResponse = {
  projectFile: RulesFileStatus | null
  userFile: RulesFileStatus
}

export function ProjectRulesSettings() {
  const t = useTranslation()
  const [rules, setRules] = useState<ProjectRulesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const activeSession = sessions.find((s) => s.id === activeSessionId)
  const cwd = activeSession?.workDir || activeSession?.projectPath || undefined

  const fetchRules = async () => {
    setLoading(true)
    try {
      const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''
      const res = await api.get<ProjectRulesResponse>(`/api/project-rules${query}`)
      setRules(res)
    } catch {
      setRules(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchRules()
  }, [cwd])

  const handleOpen = async (path: string) => {
    try {
      await getDesktopHost().shell.openPath(path)
    } catch {
      // fallback: ignore
    }
  }

  const handleCreate = async (scope: 'project' | 'user') => {
    try {
      await api.post(`/api/project-rules/create`, { scope, cwd })
      await fetchRules()
    } catch {
      // ignore
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <span className="material-symbols-outlined animate-spin text-[var(--color-text-muted)]">progress_activity</span>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--color-text)]">{t('settings.projectRules.title')}</h2>
        <p className="text-sm text-[var(--color-text-muted)] mt-1">{t('settings.projectRules.description')}</p>
      </div>

      {/* Project-level CLAUDE.md */}
      {rules?.projectFile && (
        <RuleFileCard
          title={t('settings.projectRules.projectFile')}
          description={t('settings.projectRules.projectFileDesc')}
          path={rules.projectFile.path}
          exists={rules.projectFile.exists}
          onOpen={() => handleOpen(rules.projectFile!.path)}
          onCreate={() => handleCreate('project')}
          t={t}
        />
      )}

      {/* User-level CLAUDE.md */}
      {rules?.userFile && (
        <RuleFileCard
          title={t('settings.projectRules.userFile')}
          description={t('settings.projectRules.userFileDesc')}
          path={rules.userFile.path}
          exists={rules.userFile.exists}
          onOpen={() => handleOpen(rules.userFile.path)}
          onCreate={() => handleCreate('user')}
          t={t}
        />
      )}
    </div>
  )
}

function RuleFileCard({
  title,
  description,
  path,
  exists,
  onOpen,
  onCreate,
  t,
}: {
  title: string
  description: string
  path: string
  exists: boolean
  onOpen: () => void
  onCreate: () => void
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
}) {
  return (
    <div className="border border-[var(--color-border)] rounded-lg p-4">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-[var(--color-text)]">{title}</h3>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{description}</p>
          <p className="text-xs text-[var(--color-text-muted)] mt-1 font-mono truncate" title={path}>{path}</p>
        </div>
        <div className="ml-4 flex-shrink-0">
          {exists ? (
            <Button size="sm" variant="secondary" onClick={onOpen}>
              <span className="material-symbols-outlined text-base mr-1">open_in_new</span>
              {t('settings.projectRules.open')}
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-[var(--color-text-muted)]">{t('settings.projectRules.notFound')}</span>
              <Button size="sm" variant="primary" onClick={onCreate}>
                <span className="material-symbols-outlined text-base mr-1">add</span>
                {t('settings.projectRules.create')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
