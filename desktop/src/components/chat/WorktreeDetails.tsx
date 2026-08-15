import { useTranslation } from '../../i18n'
import { getFileNameFromPath } from '../../lib/composerAttachments'

export function getWorktreeDisplayName(
  slug: string | null | undefined,
  path: string | null | undefined,
): string | null {
  return slug || (path ? getFileNameFromPath(path) : null)
}

export function WorktreeDetails({ name, path, projectRoot }: {
  name: string
  path?: string | null
  /**
   * Passed only when a custom display name is standing in for the folder name.
   * The chip then shows the alias and drops its `title`, so this tooltip is the
   * one place left that still tells you which real directory it points at.
   */
  projectRoot?: string | null
}) {
  const t = useTranslation()

  return (
    <dl className="grid max-w-[280px] grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1">
      {projectRoot ? (
        <>
          <dt className="opacity-70">{t('sidebar.projectEditor.realPath')}</dt>
          <dd className="min-w-0 break-all font-mono text-[11px]">{projectRoot}</dd>
        </>
      ) : null}
      <dt className="opacity-70">{t('sidebar.worktree')}</dt>
      <dd className="min-w-0 break-all font-mono text-[11px]">{name}</dd>
      {path ? (
        <>
          <dt className="opacity-70">{t('dirPicker.directory')}</dt>
          <dd className="min-w-0 break-all font-mono text-[11px]">{path}</dd>
        </>
      ) : null}
    </dl>
  )
}
