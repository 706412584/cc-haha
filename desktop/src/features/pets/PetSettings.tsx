import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  FolderOpen,
  Grid3X3,
  ImageIcon,
  Plus,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import {
  desktopUiPreferencesApi,
  type DesktopPetPreferences,
} from '../../api/desktopUiPreferences'
import actionSheetGuideEn from '../../assets/pets/action-sheet-guide.en.png'
import actionSheetGuideZh from '../../assets/pets/action-sheet-guide.zh.png'
import { useSettingsStore } from '../../stores/settingsStore'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { LoadingState } from '@/components/ui/LoadingState'
import { Switch } from '@/components/ui/Switch'
import { Modal } from '@/components/ui/Modal'
import { useTranslation, type TranslationKey } from '../../i18n'
import { getDesktopHost } from '../../lib/desktopHost'
import { BUILTIN_PETS } from './builtinPets'
import { PetRenderer } from './PetRenderer'
import { importPetFromActionSheet } from './petSheetImport'
import type { CustomPet, PetDescriptor } from './types'

const PET_SIZE_MIN = 96
const PET_SIZE_MAX = 192
const PET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * `guided` and `atlas` share the same import pipeline; they differ only in whether
 * the walkthrough is shown first.
 */
type PetCreationMethod = 'image' | 'guided' | 'atlas'

const PET_CREATE_ERROR_KEYS: Record<string, TranslationKey> = {
  'invalid-id': 'settings.pets.createError.invalidId',
  'duplicate-id': 'settings.pets.createError.duplicateId',
  'unsupported-image-format': 'settings.pets.createError.unsupportedFormat',
  'image-too-large': 'settings.pets.createError.imageTooLarge',
  'total-image-bytes-exceeded': 'settings.pets.createError.imageTooLarge',
  'decode-budget-exceeded': 'settings.pets.createError.imageTooLarge',
  'invalid-image': 'settings.pets.createError.invalidImage',
  'opaque-background': 'settings.pets.createError.opaqueBackground',
  'missing-image': 'settings.pets.createError.invalidImage',
  'symlink-image': 'settings.pets.createError.invalidImage',
  'invalid-renderer': 'settings.pets.createError.invalidImage',
  'invalid-sprite-version': 'settings.pets.createError.invalidImage',
  'invalid-manifest-version': 'settings.pets.createError.invalidImage',
  'root-invalid': 'settings.pets.createError.storage',
  'directory-changed': 'settings.pets.createError.storage',
  'io-error': 'settings.pets.createError.storage',
}

function petCreateErrorKey(method: PetCreationMethod, code: string): TranslationKey {
  if (code === 'invalid-image-dimensions') {
    return method === 'image'
      ? 'settings.pets.createError.imageDimensions'
      : 'settings.pets.createError.atlasDimensions'
  }
  return PET_CREATE_ERROR_KEYS[code] ?? 'settings.pets.createError'
}

export function PetSettings() {
  const t = useTranslation()
  const desktopAvailable = getDesktopHost().isDesktop
  const [preferences, setPreferences] = useState<DesktopPetPreferences | null>(null)
  const preferencesRef = useRef<DesktopPetPreferences | null>(null)
  const preferenceRevisionRef = useRef(0)
  const windowSyncRevisionRef = useRef(0)
  const [customPets, setCustomPets] = useState<CustomPet[]>([])
  const [invalidPetCount, setInvalidPetCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [createMethod, setCreateMethod] = useState<PetCreationMethod | null>(null)
  const [createForm, setCreateForm] = useState({ slug: '', displayName: '', description: '' })
  const [walkthroughVisible, setWalkthroughVisible] = useState(false)
  const [promptCopied, setPromptCopied] = useState(false)
  const [guideExpanded, setGuideExpanded] = useState(false)
  const locale = useSettingsStore((s) => s.locale)
  const actionSheetGuide = locale === 'zh' || locale === 'zh-TW'
    ? actionSheetGuideZh
    : actionSheetGuideEn

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    setSaveError(null)

    try {
      const host = getDesktopHost()
      const [preferencesResult, petsResult] = await Promise.all([
        desktopUiPreferencesApi.getPreferences(),
        host.isDesktop ? host.pets.list() : Promise.resolve({ pets: [], errors: [] }),
      ])
      const nextPreferences = preferencesResult.preferences.pet
      preferencesRef.current = nextPreferences
      setPreferences(nextPreferences)
      setCustomPets(petsResult.pets.map((pet) => ({ source: 'custom' as const, ...pet })))
      setInvalidPetCount(petsResult.errors.length)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    const refreshPreferences = () => {
      const revision = preferenceRevisionRef.current
      void desktopUiPreferencesApi.getPreferences()
        .then((result) => {
          if (cancelled || revision !== preferenceRevisionRef.current) return
          preferencesRef.current = result.preferences.pet
          setPreferences(result.preferences.pet)
        })
        .catch(() => {})
    }

    window.addEventListener('focus', refreshPreferences)
    if (getDesktopHost().isDesktop) {
      void getDesktopHost().pets.onVisibilityChanged(refreshPreferences)
        .then((stop) => {
          if (cancelled) stop()
          else unlisten = stop
        })
        .catch(() => {})
    }
    return () => {
      cancelled = true
      window.removeEventListener('focus', refreshPreferences)
      unlisten?.()
    }
  }, [])

  const updatePreferences = useCallback(async (
    patch: Partial<DesktopPetPreferences>,
    syncWindow = false,
  ) => {
    const current = preferencesRef.current
    if (!current) return

    const preferenceRevision = ++preferenceRevisionRef.current
    const next = { ...current, ...patch }
    const windowSyncRevision = syncWindow ? ++windowSyncRevisionRef.current : null
    preferencesRef.current = next
    setPreferences(next)
    setSaveError(null)

    let savedPet: DesktopPetPreferences
    try {
      const result = await desktopUiPreferencesApi.updatePetPreferences(patch)
      savedPet = 'preferences' in result ? result.preferences.pet : result.pet
    } catch {
      const latest = preferencesRef.current
      if (latest) {
        const rolledBack = { ...latest }
        for (const key of Object.keys(patch) as Array<keyof DesktopPetPreferences>) {
          if (Object.is(latest[key], next[key])) {
            Object.assign(rolledBack, { [key]: current[key] })
          }
        }
        preferencesRef.current = rolledBack
        setPreferences(rolledBack)
      }
      setSaveError(t('settings.pets.saveError'))
      return
    }

    if (syncWindow && windowSyncRevision === windowSyncRevisionRef.current) {
      try {
        const host = getDesktopHost()
        if (savedPet.enabled) await host.pets.show()
        else await host.pets.hide()
      } catch {
        if (preferenceRevision !== preferenceRevisionRef.current) return
        const latest = preferencesRef.current
        if (latest) {
          const rolledBack = { ...latest }
          const rollbackPatch: Partial<DesktopPetPreferences> = {}
          for (const key of Object.keys(patch) as Array<keyof DesktopPetPreferences>) {
            if (!Object.is(latest[key], next[key])) continue
            Object.assign(rolledBack, { [key]: current[key] })
            Object.assign(rollbackPatch, { [key]: current[key] })
          }
          preferencesRef.current = rolledBack
          setPreferences(rolledBack)
          if (Object.keys(rollbackPatch).length > 0) {
            await desktopUiPreferencesApi.updatePetPreferences(rollbackPatch).catch(() => undefined)
          }
          const host = getDesktopHost()
          if (rolledBack.enabled) await host.pets.show().catch(() => undefined)
          else await host.pets.hide().catch(() => undefined)
        }
        setSaveError(t('settings.pets.saveError'))
      }
    }
  }, [t])

  const handleOpenFolder = async () => {
    setSaveError(null)
    try {
      await getDesktopHost().pets.openFolder()
    } catch {
      setSaveError(t('settings.pets.openFolderError'))
    }
  }

  const createFormValid = PET_ID_PATTERN.test(createForm.slug)
    && createForm.slug.length <= 73
    && createForm.displayName.trim().length > 0
    && createForm.description.trim().length > 0

  const resetCreateDialog = () => {
    setCreateOpen(false)
    setCreateMethod(null)
    setCreateError(null)
    setCreateForm({ slug: '', displayName: '', description: '' })
    setWalkthroughVisible(false)
    setPromptCopied(false)
    setGuideExpanded(false)
  }

  const selectCreateMethod = (method: PetCreationMethod) => {
    setCreateMethod(method)
    setCreateError(null)
    setWalkthroughVisible(method === 'guided')
  }

  const handleCopyPrompt = async () => {
    try {
      await getDesktopHost().clipboard.writeText(t('settings.pets.guide.prompt'))
      setPromptCopied(true)
      window.setTimeout(() => setPromptCopied(false), 2000)
    } catch {
      setCreateError(t('settings.pets.guide.copyFailed'))
    }
  }

  const handleSaveGuide = async () => {
    try {
      const response = await fetch(actionSheetGuide)
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'pet-action-sheet-guide.png'
      link.click()
      URL.revokeObjectURL(url)
    } catch {
      setCreateError(t('settings.pets.guide.saveFailed'))
    }
  }

  const handleCreate = async () => {
    if (!createMethod || !createFormValid || createBusy || !preferences) return
    setCreateBusy(true)
    setCreateError(null)
    setSaveError(null)

    const host = getDesktopHost()
    let created: { id: string } | { errorCode: string } | null
    try {
      const input = {
        slug: createForm.slug,
        displayName: createForm.displayName.trim(),
        description: createForm.description.trim(),
        dialogTitle: createMethod === 'image'
          ? t('settings.pets.dialog.imageTitle')
          : t('settings.pets.dialog.atlasTitle'),
        dialogFilterName: createMethod === 'image'
          ? t('settings.pets.dialog.imageFilter')
          : t('settings.pets.dialog.atlasFilter'),
      }
      if (createMethod === 'image') {
        created = await host.pets.createFromImage(input)
      } else {
        // Normalizes an action sheet of any size into the v2 grid before install.
        const outcome = await importPetFromActionSheet(host, input)
        created = outcome.status === 'cancelled'
          ? null
          : outcome.status === 'created'
            ? { id: outcome.id }
            : { errorCode: outcome.errorCode }
      }
    } catch {
      setCreateError(t('settings.pets.createError'))
      setCreateBusy(false)
      return
    }

    if (!created) {
      setCreateBusy(false)
      return
    }

    if ('errorCode' in created) {
      setCreateError(t(petCreateErrorKey(createMethod, created.errorCode)))
      setCreateBusy(false)
      return
    }

    resetCreateDialog()

    try {
      const petsResult = await host.pets.list()
      setCustomPets(petsResult.pets.map((pet) => ({ source: 'custom' as const, ...pet })))
      setInvalidPetCount(petsResult.errors.length)
    } catch {
      setSaveError(t('settings.pets.loadError'))
    }

    try {
      const result = await desktopUiPreferencesApi.updatePetPreferences({ selectedPetId: created.id })
      const nextPreferences = 'preferences' in result ? result.preferences.pet : result.pet
      preferencesRef.current = nextPreferences
      setPreferences(nextPreferences)
      if (nextPreferences.enabled) await host.pets.show()
    } catch {
      setSaveError(t('settings.pets.saveError'))
    } finally {
      setCreateBusy(false)
    }
  }

  const pets: readonly PetDescriptor[] = [...BUILTIN_PETS, ...customPets]

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 pb-8">
      <header>
        <h1 className="text-[24px] font-semibold leading-tight text-[var(--color-text-primary)]" style={{ fontFamily: 'var(--font-headline)' }}>{t('settings.pets.title')}</h1>
        <p className="mt-1.5 text-[13.5px] leading-6 text-[var(--color-text-secondary)]">{t('settings.pets.subtitle')}</p>
      </header>

      {loading ? (
        <LoadingState label={t('settings.pets.loading')} variant="dashed" size="md" />
      ) : loadError || !preferences ? (
        <ErrorState
          title={t('settings.pets.loadError')}
          onRetry={() => void load()}
          retryLabel={t('settings.pets.retry')}
          size="md"
        />
      ) : (
        <>
          <Card as="section" radius="lg" padding="lg">
            <ToggleRow
              label={t('settings.pets.enableTitle')}
              description={t('settings.pets.enableDescription')}
              checked={preferences.enabled}
              disabled={!desktopAvailable}
              onChange={(checked) => void updatePreferences({ enabled: checked }, true)}
            />
          </Card>

          <PetCatalog
            title={t('settings.pets.builtInTitle')}
            pets={pets.filter((pet) => pet.source === 'builtin')}
            selectedPetId={preferences.selectedPetId}
            selectedLabel={t('settings.pets.selected')}
            selectLabel={t('settings.pets.select')}
            onSelect={(id) => void updatePreferences({ selectedPetId: id }, preferences.enabled && desktopAvailable)}
          />

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-[var(--color-text-primary)]" style={{ fontFamily: 'var(--font-headline)' }}>{t('settings.pets.customTitle')}</h2>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Plus size={14} aria-hidden="true" />}
                  disabled={!desktopAvailable}
                  onClick={() => {
                    setCreateError(null)
                    setCreateMethod(null)
                    setCreateForm({ slug: '', displayName: '', description: '' })
                    setCreateOpen(true)
                  }}
                >
                  {t('settings.pets.create')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<RefreshCw size={14} aria-hidden="true" />}
                  onClick={() => void load()}
                >
                  {t('settings.pets.refresh')}
                </Button>
              </div>
            </div>
            {customPets.length > 0 ? (
              <PetCatalog
                pets={customPets}
                selectedPetId={preferences.selectedPetId}
                selectedLabel={t('settings.pets.selected')}
                selectLabel={t('settings.pets.select')}
                onSelect={(id) => void updatePreferences({ selectedPetId: id }, preferences.enabled && desktopAvailable)}
              />
            ) : (
              <EmptyState description={t('settings.pets.customEmpty')} variant="dashed" size="md" />
            )}
            {invalidPetCount > 0 && (
              <p role="status" className="text-xs text-[var(--color-warning)]">
                {t('settings.pets.invalidCustom', { count: invalidPetCount })}
              </p>
            )}
          </section>

          <Card as="section" radius="lg" padding="lg" className="space-y-4">
            <h2 className="text-base font-semibold text-[var(--color-text-primary)]" style={{ fontFamily: 'var(--font-headline)' }}>{t('settings.pets.appearanceTitle')}</h2>
            <label className="block">
              <span className="flex items-center justify-between gap-3 text-sm font-medium text-[var(--color-text-primary)]">
                <span>{t('settings.pets.size')}</span>
                <output htmlFor="pet-size">{preferences.size}px</output>
              </span>
              <span className="mt-0.5 block text-xs text-[var(--color-text-secondary)]">{t('settings.pets.sizeDescription')}</span>
              <input
                id="pet-size"
                aria-label={t('settings.pets.size')}
                className="mt-3 w-full accent-[var(--color-brand)]"
                type="range"
                min={PET_SIZE_MIN}
                max={PET_SIZE_MAX}
                step={8}
                value={preferences.size}
                onChange={(event) => void updatePreferences({ size: Number(event.target.value) })}
              />
            </label>
            <div className="border-t border-[var(--color-border-separator)] pt-4">
              <ToggleRow
                label={t('settings.pets.motion')}
                description={t('settings.pets.motionDescription')}
                checked={preferences.motionEnabled}
                onChange={(checked) => void updatePreferences({ motionEnabled: checked })}
              />
            </div>
            <div className="border-t border-[var(--color-border-separator)] pt-4">
              <ToggleRow
                label={t('settings.pets.showTaskPanel')}
                description={t('settings.pets.showTaskPanelDescription')}
                checked={preferences.showTaskPanel}
                onChange={(checked) => void updatePreferences({ showTaskPanel: checked })}
              />
            </div>
          </Card>

          <Card as="section" radius="lg" padding="lg" className="flex items-center justify-between gap-5">
            <div className="min-w-0">
              <h2 className="text-sm font-medium text-[var(--color-text-primary)]" style={{ fontFamily: 'var(--font-headline)' }}>{t('settings.pets.folderTitle')}</h2>
              <p className="mt-1 break-all font-mono text-xs text-[var(--color-text-secondary)]">
                {t('settings.pets.folderDescription')}
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              icon={<FolderOpen size={15} aria-hidden="true" />}
              disabled={!desktopAvailable}
              onClick={() => void handleOpenFolder()}
            >
              {t('settings.pets.openFolder')}
            </Button>
          </Card>
        </>
      )}

      {saveError && <p role="alert" className="text-sm text-[var(--color-error)]">{saveError}</p>}

      <Modal
        open={createOpen}
        width={640}
        title={t('settings.pets.createTitle')}
        onClose={() => {
          if (!createBusy) resetCreateDialog()
        }}
        footer={(
          <>
            <Button variant="secondary" disabled={createBusy} onClick={resetCreateDialog}>
              {t('settings.pets.createCancel')}
            </Button>
            {walkthroughVisible ? (
              <Button onClick={() => setWalkthroughVisible(false)}>
                {t('settings.pets.guide.continue')}
              </Button>
            ) : createMethod && (
              <Button
                loading={createBusy}
                disabled={!createFormValid}
                onClick={() => void handleCreate()}
              >
                {createMethod === 'image'
                  ? t('settings.pets.createImageSubmit')
                  : t('settings.pets.createAtlasSubmit')}
              </Button>
            )}
          </>
        )}
      >
        {createMethod === null ? (
          <div className="space-y-3">
            <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
              {t('settings.pets.createMethodIntro')}
            </p>
            <CreationMethodCard
              icon={<ImageIcon size={20} aria-hidden="true" />}
              title={t('settings.pets.createImageTitle')}
              description={t('settings.pets.createImageDescription')}
              detail={t('settings.pets.createImageDetail')}
              badge={t('settings.pets.createImageBadge')}
              onClick={() => selectCreateMethod('image')}
            />
            <CreationMethodCard
              icon={<Sparkles size={20} aria-hidden="true" />}
              title={t('settings.pets.createAiTitle')}
              description={t('settings.pets.createAiDescription')}
              detail={t('settings.pets.createAiDetail')}
              badge={t('settings.pets.createRecommended')}
              onClick={() => selectCreateMethod('guided')}
            />
            <CreationMethodCard
              icon={<Grid3X3 size={20} aria-hidden="true" />}
              title={t('settings.pets.createAtlasTitle')}
              description={t('settings.pets.createAtlasDescription')}
              detail={t('settings.pets.createAtlasDetail')}
              onClick={() => selectCreateMethod('atlas')}
            />
          </div>
        ) : walkthroughVisible ? (
          <div className="space-y-4">
            <Button
              variant="link"
              size="sm"
              icon={<ArrowLeft size={15} aria-hidden="true" />}
              onClick={() => {
                setCreateMethod(null)
                setCreateError(null)
                setWalkthroughVisible(false)
              }}
            >
              {t('settings.pets.createBack')}
            </Button>

            <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
              {t('settings.pets.guide.intro')}
            </p>

            <GuideStep index={1} title={t('settings.pets.guide.step1Title')}>
              <p className="text-xs leading-5 text-[var(--color-text-secondary)]">
                {t('settings.pets.guide.step1Body')}
              </p>
              <div className="mt-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]">
                <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap px-3 py-2.5 text-[11.5px] leading-5 text-[var(--color-text-primary)]" style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>
                  {t('settings.pets.guide.prompt')}
                </pre>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={promptCopied
                    ? <Check size={14} aria-hidden="true" />
                    : <Copy size={14} aria-hidden="true" />}
                  onClick={() => void handleCopyPrompt()}
                >
                  {promptCopied
                    ? t('settings.pets.guide.promptCopied')
                    : t('settings.pets.guide.promptCopy')}
                </Button>
              </div>
              <p className="mt-2 text-[11px] leading-4 text-[var(--color-text-tertiary)]">
                {t('settings.pets.guide.step1Tools')}
              </p>
            </GuideStep>

            <GuideStep index={2} title={t('settings.pets.guide.step2Title')}>
              <p className="text-xs leading-5 text-[var(--color-text-secondary)]">
                {t('settings.pets.guide.step2Body')}
              </p>
              <ul className="mt-2 space-y-1">
                {([
                  'settings.pets.guide.check1',
                  'settings.pets.guide.check2',
                  'settings.pets.guide.check3',
                ] as const).map((key) => (
                  <li key={key} className="flex items-start gap-1.5 text-xs leading-5 text-[var(--color-text-secondary)]">
                    <Check size={13} className="mt-0.5 flex-none text-[var(--color-brand)]" aria-hidden="true" />
                    <span>{t(key)}</span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="mt-2.5 block w-full overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]"
                onClick={() => setGuideExpanded((current) => !current)}
                aria-label={t('settings.pets.guide.templateAlt')}
              >
                <img
                  src={actionSheetGuide}
                  alt={t('settings.pets.guide.templateAlt')}
                  className={guideExpanded ? 'w-full' : 'h-40 w-full object-cover object-top'}
                />
              </button>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Download size={14} aria-hidden="true" />}
                  onClick={() => void handleSaveGuide()}
                >
                  {t('settings.pets.guide.saveTemplate')}
                </Button>
                <span className="text-[11px] leading-4 text-[var(--color-text-tertiary)]">
                  {guideExpanded
                    ? t('settings.pets.guide.templateCollapse')
                    : t('settings.pets.guide.templateExpand')}
                </span>
              </div>
            </GuideStep>

            <GuideStep index={3} title={t('settings.pets.guide.step3Title')}>
              <p className="text-xs leading-5 text-[var(--color-text-secondary)]">
                {t('settings.pets.guide.step3Body')}
              </p>
            </GuideStep>
          </div>
        ) : (
          <div className="space-y-4">
            <Button
              variant="link"
              size="sm"
              icon={<ArrowLeft size={15} aria-hidden="true" />}
              disabled={createBusy}
              onClick={() => {
                if (createMethod === 'guided') {
                  setWalkthroughVisible(true)
                  setCreateError(null)
                  return
                }
                setCreateMethod(null)
                setCreateError(null)
              }}
            >
              {createMethod === 'guided'
                ? t('settings.pets.guide.backToSteps')
                : t('settings.pets.createBack')}
            </Button>
            <div className="rounded-[var(--radius-lg)] bg-[var(--color-surface-hover)] px-3.5 py-3">
              <h3 className="text-sm font-semibold text-[var(--color-text-primary)]" style={{ fontFamily: 'var(--font-headline)' }}>
                {createMethod === 'image' ? t('settings.pets.createImageTitle')
                  : createMethod === 'guided' ? t('settings.pets.createAiTitle')
                    : t('settings.pets.createAtlasTitle')}
              </h3>
              <p className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)]">
                {createMethod === 'image'
                  ? t('settings.pets.createImageHint')
                  : t('settings.pets.createAtlasHint')}
              </p>
            </div>
            <label className="block space-y-1.5 text-sm text-[var(--color-text-primary)]">
              <span className="font-medium">{t('settings.pets.createId')}</span>
              <input
                className="w-full rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 outline-none focus:border-[var(--color-border-focus)]"
                aria-label={t('settings.pets.createId')}
                value={createForm.slug}
                maxLength={73}
                placeholder="moon-cat"
                onChange={(event) => setCreateForm((current) => ({ ...current, slug: event.target.value }))}
              />
              <span className="block text-xs text-[var(--color-text-secondary)]">{t('settings.pets.createIdHint')}</span>
            </label>
            <label className="block space-y-1.5 text-sm text-[var(--color-text-primary)]">
              <span className="font-medium">{t('settings.pets.createName')}</span>
              <input
                className="w-full rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 outline-none focus:border-[var(--color-border-focus)]"
                aria-label={t('settings.pets.createName')}
                value={createForm.displayName}
                maxLength={80}
                onChange={(event) => setCreateForm((current) => ({ ...current, displayName: event.target.value }))}
              />
            </label>
            <label className="block space-y-1.5 text-sm text-[var(--color-text-primary)]">
              <span className="font-medium">{t('settings.pets.createDescription')}</span>
              <textarea
                className="min-h-24 w-full resize-y rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 outline-none focus:border-[var(--color-border-focus)]"
                aria-label={t('settings.pets.createDescription')}
                value={createForm.description}
                maxLength={500}
                onChange={(event) => setCreateForm((current) => ({ ...current, description: event.target.value }))}
              />
            </label>
            {createError && <p role="alert" className="text-sm text-[var(--color-error)]">{createError}</p>}
          </div>
        )}
      </Modal>
    </div>
  )
}

function GuideStep({
  index,
  title,
  children,
}: {
  index: number
  title: string
  children: ReactNode
}) {
  return (
    <section className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5">
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-[var(--color-brand)] text-[11px] font-semibold text-[var(--color-on-primary)]">
          {index}
        </span>
        <h4
          className="text-sm font-semibold text-[var(--color-text-primary)]"
          style={{ fontFamily: 'var(--font-headline)' }}
        >
          {title}
        </h4>
      </div>
      <div className="mt-2">{children}</div>
    </section>
  )
}

function CreationMethodCard({
  icon,
  title,
  description,
  detail,
  badge,
  disabled = false,
  onClick,
}: {
  icon: ReactNode
  title: string
  description: string
  detail: string
  badge?: string
  disabled?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      className="group flex w-full items-start gap-3 rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left transition-[border-color,background-color,transform] enabled:hover:-translate-y-0.5 enabled:hover:border-[var(--color-primary-fixed-dim)] enabled:hover:bg-[var(--color-surface-hover)] motion-reduce:transition-none motion-reduce:enabled:hover:translate-y-0 enabled:active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-55"
      disabled={disabled}
      onClick={onClick}
    >
      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-brand-soft)] text-[var(--color-brand)]">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</span>
          {badge && <Badge tone="brand" size="sm">{badge}</Badge>}
        </span>
        <span className="mt-1 block text-xs leading-5 text-[var(--color-text-secondary)]">{description}</span>
        <span className="mt-1 block text-[11px] leading-4 text-[var(--color-text-tertiary)]">{detail}</span>
      </span>
    </button>
  )
}

function PetCatalog({
  title,
  pets,
  selectedPetId,
  selectedLabel,
  selectLabel,
  onSelect,
}: {
  title?: string
  pets: readonly PetDescriptor[]
  selectedPetId: string
  selectedLabel: string
  selectLabel: string
  onSelect: (id: string) => void
}) {
  const t = useTranslation()
  return (
    <section className="space-y-3">
      {title && <h2 className="text-base font-semibold text-[var(--color-text-primary)]" style={{ fontFamily: 'var(--font-headline)' }}>{title}</h2>}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {pets.map((pet) => {
          const selected = pet.id === selectedPetId
          return (
            <article
              key={pet.id}
              className={`flex items-center gap-4 rounded-[var(--radius-xl)] p-4 transition-[background-color,border-color] duration-150 ease-out ${
                selected
                  ? 'border-[1.5px] border-[var(--color-primary-fixed-dim)] bg-[var(--color-surface-hover)]'
                  : 'border border-[var(--color-border)] bg-[var(--color-surface)]'
              }`}
            >
              <PetPreview pet={pet} />
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-[var(--color-text-primary)]" style={{ fontFamily: 'var(--font-headline)' }}>{pet.displayName}</h3>
                <p className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)]">
                  {pet.source === 'builtin' ? t(pet.descriptionKey) : pet.description}
                </p>
              </div>
              <Button
                variant={selected ? 'ghost' : 'secondary'}
                size="sm"
                disabled={selected}
                aria-pressed={selected}
                onClick={() => onSelect(pet.id)}
              >
                {selected ? selectedLabel : selectLabel}
              </Button>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function PetPreview({ pet }: { pet: PetDescriptor }) {
  return (
    <div
      className="flex h-16 w-16 flex-none items-center justify-center rounded-[var(--radius-2xl)]"
      style={{ backgroundColor: pet.source === 'builtin' ? `${pet.accent}18` : undefined }}
    >
      <PetRenderer pet={pet} state="idle" size={54} motionEnabled={false} />
    </div>
  )
}

function ToggleRow({
  label,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <Switch
      label={label}
      description={description}
      checked={checked}
      disabled={disabled}
      onChange={onChange}
    />
  )
}
