import { useCallback, useRef } from 'react'
import { useTranslation } from '../../i18n'
import { useDismissable } from '../../hooks/useDismissable'
import { useAnchoredPosition } from '../../hooks/useAnchoredPosition'
import { copyTextToClipboard } from '../../lib/clipboard'
import { resolveAbsoluteOpenPath } from '../../lib/systemFileOpen'
import { basenameOf } from '../../lib/workspace/types'
import { useWorkspaceChatContextStore } from '../../stores/workspaceChatContextStore'
import { WorkspaceFileOpenWith } from '../workspace/WorkspaceFileOpenWith'
import { useMenuKeyboard } from './menuKeyboard'

export type WorkspaceFileTreeMenuTarget = {
  path: string
  isDirectory: boolean
  /** Row anchor for keyboard opens; the pointer position wins for right-click. */
  x: number
  y: number
  trigger: HTMLElement | null
}

export type WorkspaceFileTreeMenuProps = {
  sessionId: string
  target: WorkspaceFileTreeMenuTarget
  workDir: string | null
  onClose: () => void
}

/**
 * Right-click menu for a workspace file-tree row.
 *
 * The tree replaced the old `WorkspacePanel`, and with it went every
 * right-click affordance the panel offered: referencing a file in the chat,
 * copying its path, and opening it with an external application. The row is the
 * only place a path can be acted on without opening it first, so those actions
 * live here rather than only on the file tab.
 *
 * Directories are menu targets too — referencing a folder is how the chat gets
 * a whole subtree, and copying its path is as useful as copying a file's.
 */
export function WorkspaceFileTreeMenu({ sessionId, target, workDir, onClose }: WorkspaceFileTreeMenuProps) {
  const t = useTranslation()
  const menuRef = useRef<HTMLDivElement>(null)
  const menuPosition = useAnchoredPosition({
    open: true,
    anchorRect: { top: target.y, bottom: target.y, left: target.x, right: target.x },
    floatingRef: menuRef,
    offset: 0,
    clampHeight: true,
  })

  const closeMenu = useCallback(() => onClose(), [onClose])
  // The trigger is part of `useMenuKeyboard`'s focus contract, so it is held in
  // a stable ref rather than recreated per render — otherwise the focus-return
  // effect would see a new object each time and could fire against a stale node.
  const triggerRef = useRef<HTMLElement | null>(target.trigger)
  triggerRef.current = target.trigger
  useDismissable({ open: true, refs: [menuRef], triggerRef, onDismiss: closeMenu })
  const handleMenuKeyDown = useMenuKeyboard({
    open: true,
    menuRef,
    triggerRef,
    onClose: closeMenu,
  })

  const absolutePath = resolveAbsoluteOpenPath(target.path, workDir ?? undefined)

  const addToChat = () => {
    useWorkspaceChatContextStore.getState().addReference(sessionId, {
      kind: 'file',
      path: target.path,
      absolutePath,
      // A trailing slash marks a folder in the composer, so the model and the
      // user can both tell a subtree reference from a file reference.
      name: target.isDirectory ? `${basenameOf(target.path)}/` : basenameOf(target.path),
      isDirectory: target.isDirectory,
    })
    closeMenu()
  }

  const copyPath = (absolute: boolean) => {
    void copyTextToClipboard(absolute ? absolutePath : target.path)
    closeMenu()
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={t('workspace.files.tree')}
      data-testid="workspace-file-tree-menu"
      onKeyDown={handleMenuKeyDown}
      className="fixed z-[var(--z-dropdown)] min-w-[190px] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)] py-1.5 shadow-[var(--shadow-dropdown)]"
      style={menuPosition.style}
    >
      <MenuItem label={t('workspace.files.addToChat')} onSelect={addToChat} />
      <MenuItem label={t('workspace.files.copyPath')} onSelect={() => copyPath(false)} />
      <MenuItem label={t('workspace.files.copyAbsolutePath')} onSelect={() => copyPath(true)} />
      <div className="my-1 border-t border-[var(--color-border)]" role="separator" />
      <WorkspaceFileOpenWith
        absolutePath={absolutePath}
        sessionId={sessionId}
        {...(target.isDirectory ? {} : { workspacePath: target.path })}
        onAfterSelect={closeMenu}
      />
    </div>
  )
}

function MenuItem({ label, onSelect, disabled = false }: {
  label: string
  onSelect: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className="w-full px-3.5 py-1.5 text-left text-[12px] text-[var(--color-text-primary)] outline-none transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:text-[var(--color-text-tertiary)] disabled:hover:bg-transparent"
    >
      {label}
    </button>
  )
}
