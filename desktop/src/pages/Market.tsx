import { useState, type ReactNode } from 'react'
import { useTranslation } from '../i18n'
import { marketOwnerOf, marketSkillKey, useMarketStore } from '../stores/marketStore'
import { useSkillStore } from '../stores/skillStore'
import { useUIStore } from '../stores/uiStore'
import { InstallConfirmDialog } from '../components/market/InstallConfirmDialog'
import { MarketHome } from '../components/market/MarketHome'
import { MarketSkillDetail } from '../components/market/MarketSkillDetail'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import type { NormalizedSkill } from '../types/market'

export function Market({ featured }: { featured?: ReactNode } = {}) {
  const t = useTranslation()
  const selectedId = useMarketStore((s) => s.selectedId)
  const installingIds = useMarketStore((s) => s.installingIds)
  const detailCache = useMarketStore((s) => s.detailCache)
  const [confirmInstall, setConfirmInstall] = useState<NormalizedSkill | null>(null)
  /** The ClawHub owner the pending install is pinned to (slugs are not unique there). */
  const [confirmOwner, setConfirmOwner] = useState<string | undefined>(undefined)
  const [confirmUninstall, setConfirmUninstall] = useState<NormalizedSkill | null>(null)

  /** `owner` narrows a ClawHub id to the card that was clicked; without it the first match wins. */
  const findSkill = (id: string, owner?: string): NormalizedSkill | null => {
    const state = useMarketStore.getState()
    const matches = (skill: NormalizedSkill) => skill.id === id && (!owner || marketOwnerOf(skill) === owner)
    if (state.detail && matches(state.detail)) return state.detail
    return state.items.find(matches) ?? state.detailCache.get(marketSkillKey(id, owner)) ?? null
  }

  const requestInstall = (id: string, owner?: string) => {
    const skill = findSkill(id, owner)
    if (!skill) return
    setConfirmOwner(owner)
    setConfirmInstall(skill)
  }

  const requestUninstall = (id: string) => {
    const skill = findSkill(id)
    if (skill) setConfirmUninstall(skill)
  }

  const runInstall = async () => {
    const skill = confirmInstall
    if (!skill) return
    const ok = await useMarketStore.getState().install(skill.id, confirmOwner)
    setConfirmInstall(null)
    if (ok) {
      useUIStore.getState().addToast({
        type: 'success',
        message: t('market.installSuccess', { name: skill.name }),
      })
      // Keep the Settings → Skills browser in sync.
      void useSkillStore.getState().fetchSkills()
    } else {
      const error = useMarketStore.getState().installError
      if (error) {
        useUIStore.getState().addToast({
          type: 'error',
          message:
            error.kind === 'generic'
              ? t('market.installError.generic', { message: error.message })
              : t(`market.installError.${error.kind}`),
        })
      }
    }
  }

  const runUninstall = async () => {
    const skill = confirmUninstall
    if (!skill) return
    const ok = await useMarketStore.getState().uninstall(skill.id)
    setConfirmUninstall(null)
    if (ok) {
      useUIStore.getState().addToast({
        type: 'success',
        message: t('market.uninstall.success', { name: skill.name }),
      })
      void useSkillStore.getState().fetchSkills()
    } else {
      const error = useMarketStore.getState().installError
      if (error) {
        useUIStore.getState().addToast({ type: 'error', message: error.message })
      }
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--color-surface)]">
      {selectedId ? (
        <MarketSkillDetail onRequestInstall={requestInstall} onRequestUninstall={requestUninstall} />
      ) : (
        <MarketHome onRequestInstall={requestInstall} featured={featured} />
      )}

      <InstallConfirmDialog
        skill={confirmInstall}
        detail={confirmInstall ? detailCache.get(marketSkillKey(confirmInstall.id, confirmOwner)) : null}
        open={confirmInstall !== null}
        installing={confirmInstall !== null && installingIds.has(confirmInstall.id)}
        onConfirm={() => void runInstall()}
        onClose={() => setConfirmInstall(null)}
      />

      <ConfirmDialog
        open={confirmUninstall !== null}
        onClose={() => setConfirmUninstall(null)}
        onConfirm={() => void runUninstall()}
        title={t('market.uninstall.confirmTitle')}
        body={
          confirmUninstall
            ? t('market.uninstall.confirmMessage', {
                name: confirmUninstall.name,
                path: `~/.claude/skills/${confirmUninstall.slug}/`,
              })
            : ''
        }
        confirmLabel={t('market.uninstall.action')}
        cancelLabel={t('market.installConfirm.cancel')}
        confirmVariant="danger"
        loading={confirmUninstall !== null && installingIds.has(confirmUninstall.id)}
      />
    </div>
  )
}
