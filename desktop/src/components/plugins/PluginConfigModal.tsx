import { useEffect, useMemo, useState } from 'react'
import { Modal } from '../shared/Modal'
import { Button } from '../shared/Button'
import { useUIStore } from '../../stores/uiStore'
import { pluginsApi } from '../../api/plugins'

type OptionSchema = {
  type: string
  title?: string
  description?: string
  required?: boolean
  sensitive?: boolean
  default?: unknown
  group?: string
  groupDescription?: string
}

type Props = {
  open: boolean
  pluginId: string
  pluginName: string
  schema: Record<string, OptionSchema>
  onClose: () => void
  onSaved?: () => void
}

type ProviderSlot = {
  index: number
  title: string
  description: string
  priority: 'primary' | 'fallback' | 'secondary'
  keys: {
    name: string
    baseUrl: string
    apiKey: string
    model: string
  }
}

function isMediaGenSchema(schema: Record<string, OptionSchema>): boolean {
  return (
    'PROVIDER_1_NAME' in schema &&
    'PROVIDER_1_BASE_URL' in schema &&
    'PROVIDER_1_API_KEY' in schema &&
    'PROVIDER_1_MODEL' in schema
  )
}

function getProviderSlots(schema: Record<string, OptionSchema>): ProviderSlot[] {
  const slots: ProviderSlot[] = []
  for (let i = 1; i <= 3; i++) {
    const name = `PROVIDER_${i}_NAME`
    const baseUrl = `PROVIDER_${i}_BASE_URL`
    const apiKey = `PROVIDER_${i}_API_KEY`
    const model = `PROVIDER_${i}_MODEL`
    if (!(name in schema) || !(baseUrl in schema) || !(apiKey in schema) || !(model in schema)) continue
    slots.push({
      index: i,
      title: schema[name]?.group || `Provider ${i}`,
      description:
        schema[name]?.groupDescription ||
        (i === 1
          ? '默认 provider，未指定时优先使用。'
          : i === 2
            ? '可选 fallback。'
            : '可选二级 fallback。'),
      priority: i === 1 ? 'primary' : i === 2 ? 'fallback' : 'secondary',
      keys: { name, baseUrl, apiKey, model },
    })
  }
  return slots
}

function providerStatus(values: Record<string, string>, keys: ProviderSlot['keys']): 'ready' | 'partial' | 'empty' {
  const fields = [values[keys.name], values[keys.baseUrl], values[keys.apiKey], values[keys.model]].map((v) => (v || '').trim())
  const filled = fields.filter(Boolean).length
  if (filled === 0) return 'empty'
  // name is display-only; baseUrl + apiKey + model is enough to run
  if (fields[1] && fields[2] && fields[3]) return 'ready'
  return 'partial'
}

function mediaGenSaveError(values: Record<string, string>, slots: ProviderSlot[]): string | null {
  for (const slot of slots) {
    const status = providerStatus(values, slot.keys)
    if (status === 'partial') {
      return slot.index === 1
        ? 'Provider 1 配置不完整：请补齐 API Base URL、API Key 与默认模型。'
        : `Provider ${slot.index} 配置不完整：请补齐 API Base URL、API Key 与默认模型，或四个字段全部留空以禁用。`
    }
  }
  return null
}

export function PluginConfigModal({
  open,
  pluginId,
  pluginName,
  schema,
  onClose,
  onSaved,
}: Props) {
  const addToast = useUIStore((s) => s.addToast)
  const [values, setValues] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [visibleSecrets, setVisibleSecrets] = useState<Set<string>>(new Set())
  const [maskedKeys, setMaskedKeys] = useState<Set<string>>(new Set())
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({ 2: true, 3: true })
  const [wasOpen, setWasOpen] = useState(false)

  const mediaGen = useMemo(() => isMediaGenSchema(schema), [schema])
  const providerSlots = useMemo(() => (mediaGen ? getProviderSlots(schema) : []), [mediaGen, schema])

  useEffect(() => {
    if (!open || wasOpen) return
    setWasOpen(true)
    setFetching(true)
    pluginsApi
      .getOptions(pluginId)
      .then((res) => {
        const merged: Record<string, string> = {}
        const masked = new Set<string>()
        for (const key of Object.keys(schema)) {
          const existing = res.values[key]
          if (schema[key]?.sensitive && existing === '********') {
            masked.add(key)
          }
          merged[key] = existing != null ? String(existing) : ''
        }
        setValues(merged)
        setMaskedKeys(masked)

        // Expand optional providers that already have data
        setCollapsed({
          2: !Object.values({
            n: merged.PROVIDER_2_NAME,
            b: merged.PROVIDER_2_BASE_URL,
            k: merged.PROVIDER_2_API_KEY,
            m: merged.PROVIDER_2_MODEL,
          }).some(Boolean),
          3: !Object.values({
            n: merged.PROVIDER_3_NAME,
            b: merged.PROVIDER_3_BASE_URL,
            k: merged.PROVIDER_3_API_KEY,
            m: merged.PROVIDER_3_MODEL,
          }).some(Boolean),
        })
      })
      .catch(() => {
        const empty: Record<string, string> = {}
        for (const key of Object.keys(schema)) empty[key] = ''
        setValues(empty)
        setMaskedKeys(new Set())
      })
      .finally(() => setFetching(false))
  }, [open, wasOpen, pluginId, schema])

  useEffect(() => {
    if (!open && wasOpen) {
      setWasOpen(false)
      setVisibleSecrets(new Set())
      setMaskedKeys(new Set())
      setValues({})
      setCollapsed({ 2: true, 3: true })
    }
  }, [open, wasOpen])

  const setField = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  const handleSave = async () => {
    if (mediaGen) {
      const error = mediaGenSaveError(values, providerSlots)
      if (error) {
        addToast({ type: 'error', message: error })
        return
      }
    }

    setLoading(true)
    try {
      const toSave: Record<string, string> = {}
      for (const [key, value] of Object.entries(values)) {
        if (maskedKeys.has(key) && value === '********') continue
        toSave[key] = value
      }
      await pluginsApi.saveOptions(pluginId, toSave)
      addToast({ type: 'success', message: `${pluginName} 配置已保存` })
      onSaved?.()
      onClose()
    } catch (err) {
      addToast({
        type: 'error',
        message: err instanceof Error ? err.message : '保存配置失败',
      })
    } finally {
      setLoading(false)
    }
  }

  const { entries, hasGroups, groups } = useMemo(() => {
    const schemaEntries = Object.entries(schema)
    const grouped = new Map<string, { name: string; description?: string; entries: typeof schemaEntries }>()
    for (const entry of schemaEntries) {
      const [, field] = entry
      const name = field.group || ''
      const group = grouped.get(name)
      if (group) group.entries.push(entry)
      else grouped.set(name, { name, description: field.groupDescription, entries: [entry] })
    }
    return {
      entries: schemaEntries,
      hasGroups: schemaEntries.some(([, field]) => field.group),
      groups: [...grouped.values()],
    }
  }, [schema])

  const renderField = ([key, field]: (typeof entries)[number], options?: { compact?: boolean; mono?: boolean }) => {
    const inputId = `plugin-option-${key}`
    const descriptionId = field.description ? `${inputId}-description` : undefined
    return (
      <div key={key} className={`flex flex-col ${options?.compact ? 'gap-1' : 'gap-1.5'}`}>
        <label htmlFor={inputId} className="text-sm font-medium text-[var(--color-text-primary)]">
          {field.title || key}
          {field.required && <span className="text-[var(--color-error)] ml-1">*</span>}
          {field.sensitive && (
            <span className="ml-2 inline-flex items-center gap-0.5 rounded-full bg-[var(--color-warning)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-warning)]">
              <span className="material-symbols-outlined text-[10px]">lock</span>
              secure
            </span>
          )}
        </label>
        {!options?.compact && field.description && (
          <p id={descriptionId} className="text-xs text-[var(--color-text-tertiary)] leading-4">
            {field.description}
          </p>
        )}
        {field.type === 'boolean' ? (
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              id={inputId}
              aria-describedby={descriptionId}
              type="checkbox"
              checked={values[key] === 'true'}
              onChange={(e) => setField(key, String(e.target.checked))}
              className="h-4 w-4 rounded border-[var(--color-border)] text-[var(--color-brand)] accent-[var(--color-brand)]"
            />
            <span className="text-sm text-[var(--color-text-secondary)]">{values[key] === 'true' ? '已启用' : '已关闭'}</span>
          </label>
        ) : field.type === 'string' && key.toLowerCase().includes('json') ? (
          <textarea
            id={inputId}
            aria-describedby={descriptionId}
            value={values[key] || ''}
            onChange={(e) => setField(key, e.target.value)}
            placeholder={field.default != null ? String(field.default) : ''}
            rows={4}
            spellCheck={false}
            className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)] focus:shadow-[var(--shadow-focus-ring)] focus:outline-none resize-y"
          />
        ) : (
          <div className="relative">
            <input
              id={inputId}
              aria-describedby={descriptionId}
              type={field.sensitive && !visibleSecrets.has(key) ? 'password' : 'text'}
              value={values[key] || ''}
              onChange={(e) => setField(key, e.target.value)}
              placeholder={field.default != null ? String(field.default) : field.type === 'directory' ? '/path/to/directory' : field.type === 'file' ? '/path/to/file' : ''}
              spellCheck={false}
              className={`w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)] focus:shadow-[var(--shadow-focus-ring)] focus:outline-none ${field.sensitive ? 'pr-10' : ''} ${options?.mono || field.type === 'directory' || field.type === 'file' ? 'font-mono' : ''}`}
            />
            {field.sensitive && (
              <button
                type="button"
                onClick={() =>
                  setVisibleSecrets((current) => {
                    const next = new Set(current)
                    if (next.has(key)) next.delete(key)
                    else next.add(key)
                    return next
                  })
                }
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)]"
                aria-label={visibleSecrets.has(key) ? `隐藏 ${field.title || key}` : `显示 ${field.title || key}`}
              >
                <span className="material-symbols-outlined text-[18px]">{visibleSecrets.has(key) ? 'visibility_off' : 'visibility'}</span>
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  const statusBadge = (status: 'ready' | 'partial' | 'empty') => {
    if (status === 'ready') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600">
          <span className="material-symbols-outlined text-[12px]">check_circle</span>
          已配置
        </span>
      )
    }
    if (status === 'partial') {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600">
          <span className="material-symbols-outlined text-[12px]">error</span>
          不完整
        </span>
      )
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-surface-hover)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-text-tertiary)]">
        <span className="material-symbols-outlined text-[12px]">radio_button_unchecked</span>
        未启用
      </span>
    )
  }

  const priorityBadge = (priority: ProviderSlot['priority']) => {
    if (priority === 'primary') {
      return <span className="rounded-md bg-[var(--color-brand)]/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-brand)]">P1 · 优先</span>
    }
    if (priority === 'fallback') {
      return <span className="rounded-md bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-600">P2 · Fallback</span>
    }
    return <span className="rounded-md bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600">P3 · 二级</span>
  }

  const renderMediaGenBody = () => (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-brand)]/10 text-[var(--color-brand)]">
            <span className="material-symbols-outlined text-[20px]">auto_awesome</span>
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Provider 优先级</h3>
            <p className="mt-1 text-xs leading-5 text-[var(--color-text-tertiary)]">
              未指定 <code className="rounded bg-[var(--color-surface)] px-1">provider_index</code> 时，图片生成按 Provider 1 → 2 → 3 回退。
              视频工具必须显式指定 provider。可选槽位四个字段都留空即可禁用。
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {providerSlots.map((slot) => {
                const status = providerStatus(values, slot.keys)
                return (
                  <div key={slot.index} className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-text-secondary)]">
                    <span className="font-semibold text-[var(--color-text-primary)]">P{slot.index}</span>
                    <span className="text-[var(--color-text-tertiary)]">{values[slot.keys.name] || slot.title}</span>
                    {statusBadge(status)}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {providerSlots.map((slot) => {
        const status = providerStatus(values, slot.keys)
        const isOptional = slot.index > 1
        const isCollapsed = isOptional && collapsed[slot.index]
        const schemaFields = {
          name: schema[slot.keys.name]!,
          baseUrl: schema[slot.keys.baseUrl]!,
          apiKey: schema[slot.keys.apiKey]!,
          model: schema[slot.keys.model]!,
        }

        return (
          <section
            key={slot.index}
            className={`rounded-xl border p-4 ${
              status === 'ready'
                ? 'border-[var(--color-brand)]/30 bg-[var(--color-surface)]'
                : status === 'partial'
                  ? 'border-amber-500/30 bg-[var(--color-surface)]'
                  : 'border-[var(--color-border)] bg-[var(--color-surface-container-low)]'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-brand)]/10 text-[var(--color-brand)]">
                  <span className="material-symbols-outlined text-[18px]">dns</span>
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">{slot.title}</h3>
                    {priorityBadge(slot.priority)}
                    {statusBadge(status)}
                  </div>
                  <p className="mt-0.5 text-xs leading-4 text-[var(--color-text-tertiary)]">{slot.description}</p>
                </div>
              </div>
              {isOptional && (
                <button
                  type="button"
                  onClick={() => setCollapsed((prev) => ({ ...prev, [slot.index]: !prev[slot.index] }))}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
                >
                  {isCollapsed ? '展开配置' : '收起'}
                  <span className="material-symbols-outlined text-[16px]">{isCollapsed ? 'expand_more' : 'expand_less'}</span>
                </button>
              )}
            </div>

            {!isCollapsed && (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {renderField([slot.keys.name, schemaFields.name], { compact: true })}
                {renderField([slot.keys.model, schemaFields.model], { compact: true, mono: true })}
                {renderField([slot.keys.baseUrl, schemaFields.baseUrl], { compact: true, mono: true })}
                {renderField([slot.keys.apiKey, schemaFields.apiKey], { compact: true })}
                <div className="sm:col-span-2 rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-3 py-2 text-[11px] leading-4 text-[var(--color-text-tertiary)]">
                  推荐模型示例：图片 <code>grok-imagine-image</code> / <code>agnes-image-2.1-flash</code>；
                  视频 <code>grok-imagine-video</code> / <code>grok-imagine-video-1.5</code>
                </div>
              </div>
            )}
          </section>
        )
      })}
    </div>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`配置 ${pluginName}`}
      width={mediaGen || hasGroups ? 720 : 520}
      footer={
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button size="sm" onClick={handleSave} loading={loading}>
            <span className="material-symbols-outlined text-[16px]">save</span>
            保存
          </Button>
        </div>
      }
    >
      {fetching ? (
        <div className="flex justify-center py-8">
          <div className="animate-spin w-5 h-5 border-2 border-[var(--color-brand)] border-t-transparent rounded-full" />
        </div>
      ) : mediaGen ? (
        renderMediaGenBody()
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-[var(--color-text-secondary)]">
            配置 <span className="font-semibold">{pluginName}</span> 的选项。敏感信息会安全存储。
          </p>
          {hasGroups
            ? groups.map((group, index) => (
                <section key={group.name || `ungrouped-${index}`} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4">
                  {group.name && (
                    <div className="mb-4 flex items-start gap-3 border-b border-[var(--color-border)] pb-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-brand)]/10 text-[var(--color-brand)]">
                        <span className="material-symbols-outlined text-[18px]">dns</span>
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">{group.name}</h3>
                        {group.description && <p className="mt-0.5 text-xs leading-4 text-[var(--color-text-tertiary)]">{group.description}</p>}
                      </div>
                    </div>
                  )}
                  <div className="flex flex-col gap-4">{group.entries.map((entry) => renderField(entry))}</div>
                </section>
              ))
            : entries.map((entry) => renderField(entry))}
        </div>
      )}
    </Modal>
  )
}
