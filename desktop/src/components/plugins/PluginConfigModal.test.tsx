import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginConfigModal } from './PluginConfigModal'
import type { MediaGenProvider } from '../../api/plugins'

const mocks = vi.hoisted(() => ({
  getOptions: vi.fn(),
  saveOptions: vi.fn(),
  getMediaGenConfig: vi.fn(),
  saveMediaGenConfig: vi.fn(),
  fetchMediaGenModels: vi.fn(),
  getMediaGenProviderChoices: vi.fn(),
  addToast: vi.fn(),
}))

vi.mock('../../api/plugins', () => ({
  pluginsApi: {
    getOptions: mocks.getOptions,
    saveOptions: mocks.saveOptions,
    getMediaGenConfig: mocks.getMediaGenConfig,
    saveMediaGenConfig: mocks.saveMediaGenConfig,
    fetchMediaGenModels: mocks.fetchMediaGenModels,
    getMediaGenProviderChoices: mocks.getMediaGenProviderChoices,
  },
}))

vi.mock('../../stores/uiStore', () => {
  const store = { addToast: mocks.addToast }
  const useUIStore = (selector: (state: typeof store) => unknown) => selector(store)
  useUIStore.getState = () => store
  return { useUIStore }
})

const MEDIA_ID = 'media-gen@cc-haha-builtin'
const schema = { TOKEN: { type: 'string', title: 'Token', sensitive: true }, ENABLED: { type: 'boolean', title: 'Enabled' } }
const provider = (id: string, overrides: Partial<MediaGenProvider> = {}): MediaGenProvider => ({
  id,
  name: `Provider ${id}`,
  enabled: true,
  apiFormat: 'openai_compatible',
  baseUrl: `https://${id}.example/v1`,
  models: {},
  apiKeyConfigured: true,
  ...overrides,
})
const renderModal = (props: Partial<React.ComponentProps<typeof PluginConfigModal>> = {}) => render(
  <PluginConfigModal open pluginId={MEDIA_ID} pluginName="Media Gen" schema={{}} onClose={vi.fn()} {...props} />,
)
const saveButton = () => screen.getByRole('button', { name: /保存|save/i })
const addButton = () => screen.getByRole('button', { name: /添加.*(?:服务商|Provider)|add provider/i })
const expand = (section: HTMLElement) => fireEvent.click(within(section).getByRole('button', { name: /展开|expand/i }))
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getOptions.mockResolvedValue({ pluginId: 'ordinary@market', schema, values: { TOKEN: '********', ENABLED: true } })
  mocks.saveOptions.mockResolvedValue({ ok: true })
  mocks.getMediaGenProviderChoices.mockResolvedValue({ providers: [] })
  mocks.getMediaGenConfig.mockResolvedValue({ schemaVersion: 3, providers: [] })
  mocks.saveMediaGenConfig.mockResolvedValue({ schemaVersion: 3, providers: [] })
  mocks.fetchMediaGenModels.mockResolvedValue({ data: [{ id: 'model-a' }, { id: 'model-b', context_length: 128000 }] })
})

describe('PluginConfigModal dynamic contract', () => {
  it('uses the dedicated config GET only for the exact builtin plugin id, while ordinary plugins use options', async () => {
    const { unmount } = renderModal()
    await waitFor(() => expect(mocks.getMediaGenConfig).toHaveBeenCalledOnce())
    expect(mocks.getOptions).not.toHaveBeenCalled()
    unmount()

    renderModal({ pluginId: 'media-gen@market', pluginName: 'Other Media Gen', schema })
    await waitFor(() => expect(mocks.getOptions).toHaveBeenCalledWith('media-gen@market'))
    expect(mocks.getMediaGenConfig).toHaveBeenCalledTimes(1)
    expect(await screen.findByLabelText('Token')).toHaveAttribute('type', 'password')
  })

  it('loads existing providers collapsed by default and supports enable, reorder, remove, and add', async () => {
    mocks.getMediaGenConfig.mockResolvedValue({ schemaVersion: 3, providers: ['a', 'b', 'c', 'd', 'e'].map(id => provider(id)) })
    renderModal()
    await screen.findByText('Provider e')

    const sections = document.querySelectorAll('section')
    expect(sections).toHaveLength(5)
    expect(screen.queryByDisplayValue('Provider a')).not.toBeInTheDocument()
    expect(within(sections[0]!).getByRole('button', { name: /展开|expand/i })).toBeInTheDocument()
    fireEvent.click(within(sections[0]!).getByRole('checkbox'))
    fireEvent.click(within(sections[0]!).getByRole('button', { name: /下移|move provider down/i }))
    expect(document.querySelectorAll('section strong')[0]).toHaveTextContent('Provider b')
    fireEvent.click(within(document.querySelectorAll('section')[1]!).getByRole('button', { name: /上移|move provider up/i }))
    expect(document.querySelectorAll('section strong')[0]).toHaveTextContent('Provider a')
    fireEvent.click(within(document.querySelectorAll('section')[4]!).getByRole('button', { name: /删除|移除|remove provider/i }))
    expect(document.querySelectorAll('section')).toHaveLength(4)
    fireEvent.click(addButton())
    expect(document.querySelectorAll('section')).toHaveLength(5)
  })

  it('allows the sixteenth provider and disables adding only after reaching the limit', async () => {
    mocks.getMediaGenConfig.mockResolvedValue({ schemaVersion: 3, providers: Array.from({ length: 15 }, (_, i) => provider(String(i))) })
    renderModal()
    await screen.findByText('Provider 14')
    expect(addButton()).toBeEnabled()
    fireEvent.click(addButton())
    expect(document.querySelectorAll('section')).toHaveLength(16)
    expect(addButton()).toBeDisabled()
  })

  it('shows enabled providers as ready with valid connection, credentials, and any one model', async () => {
    mocks.getMediaGenConfig.mockResolvedValue({ schemaVersion: 3, providers: [
      provider('ready', { name: '', models: { imageGeneration: 'a' } }),
      provider('partial', { models: {} }),
      provider('disabled', { enabled: false }),
    ] })
    renderModal()
    await screen.findByText('Provider partial')
    const sections = document.querySelectorAll('section')
    expect(within(sections[0]!).getByText('P1')).toBeInTheDocument()
    expect(within(sections[0]!).getByText(/^(ready|就绪)$/i)).toBeInTheDocument()
    expect(within(sections[1]!).getByText(/^(partial|待完善)$/i)).toBeInTheDocument()
    expect(within(sections[2]!).getByText(/^(disabled|已停用)$/i)).toBeInTheDocument()
  })

  it('shows every saved provider without restricting selection', async () => {
    mocks.getMediaGenConfig.mockResolvedValue({ schemaVersion: 3, providers: [provider('draft')] })
    mocks.getMediaGenProviderChoices.mockResolvedValue({ providers: [
      { id: 'chat', name: 'Chat Compatible', baseUrl: 'https://chat.example/v1', credentialConfigured: true, compatible: true },
      { id: 'anthropic', name: 'Anthropic Only', baseUrl: 'https://anthropic.example', credentialConfigured: true, compatible: false },
      { id: 'missing-key', name: 'Missing Key', baseUrl: 'https://missing.example/v1', credentialConfigured: false, compatible: false },
    ] })
    renderModal()
    const section = await screen.findByText('Provider draft').then(input => input.closest('section')!)
    expand(section)

    fireEvent.click(within(section).getByRole('button', { name: /choose saved provider|选择.*服务商/i }))

    expect(screen.getByRole('option', { name: /Chat Compatible/i })).not.toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('option', { name: /Anthropic Only/i })).not.toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('option', { name: /Missing Key/i })).not.toHaveAttribute('aria-disabled', 'true')

    fireEvent.click(screen.getByRole('option', { name: /Missing Key/i }))
    expect(within(section).getByLabelText(/base url|基础 URL/i)).toHaveValue('https://missing.example/v1')
    expect(within(section).getByText(/^(partial|待完善)$/i)).toBeInTheDocument()
  })

  it('marks a saved provider reference ready when any one model is configured', async () => {
    mocks.getMediaGenConfig.mockResolvedValue({ schemaVersion: 3, providers: [
      provider('referenced', { apiKeyConfigured: false, models: { videoExtension: 'video-extend' } }),
    ] })
    mocks.getMediaGenProviderChoices.mockResolvedValue({ providers: [{
      id: 'saved-provider', name: 'Saved Provider', baseUrl: 'https://saved.example/v1', credentialConfigured: true, compatible: true,
    }] })
    renderModal()
    const section = await screen.findByText('Provider referenced').then(input => input.closest('section')!)
    expand(section)

    fireEvent.click(within(section).getByRole('button', { name: /choose saved provider|选择.*服务商/i }))
    fireEvent.click(await screen.findByText('Saved Provider'))

    expect(within(section).getByText(/^(ready|就绪)$/i)).toBeInTheDocument()
  })

  it('reports fetched candidate counts and preserves edited fields after a fetch error', async () => {
    mocks.getMediaGenConfig.mockResolvedValue({ schemaVersion: 3, providers: [provider('models')] })
    renderModal()
    const section = await screen.findByText('Provider models').then(input => input.closest('section')!)
    expand(section)
    fireEvent.click(within(section).getByRole('button', { name: /fetch models|获取模型|拉取模型/i }))
    expect(await within(section).findByText(/2.*(?:models|候选)/i)).toBeInTheDocument()

    fireEvent.change(within(section).getByLabelText(/base url|基础 URL/i), { target: { value: 'https://edited.example/v1' } })
    fireEvent.change(within(section).getByLabelText(/API key|API 密钥/i), { target: { value: 'edited-secret' } })
    mocks.fetchMediaGenModels.mockRejectedValueOnce(new Error('fetch exploded'))
    fireEvent.click(within(section).getByRole('button', { name: /fetch models|获取模型|拉取模型/i }))
    await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith({ type: 'error', message: 'fetch exploded' }))
    expect(within(section).getByLabelText(/base url|基础 URL/i)).toHaveValue('https://edited.example/v1')
    expect(within(section).getByLabelText(/API key|API 密钥/i)).toHaveValue('edited-secret')
  })

  it('maps configured API keys to keep by default, typed keys to replace, and explicit clearing to clear', async () => {
    mocks.getMediaGenConfig.mockResolvedValue({ schemaVersion: 3, providers: [provider('keep'), provider('replace'), provider('clear')] })
    renderModal()
    await screen.findByText('Provider keep')
    const sections = document.querySelectorAll('section')
    sections.forEach(section => expand(section as HTMLElement))
    expect(within(sections[0]!).getByLabelText(/API key|API 密钥/i)).toHaveAttribute('placeholder', expect.stringMatching(/configured|已配置/i))
    fireEvent.change(within(sections[1]!).getByLabelText(/API key|API 密钥/i), { target: { value: 'new-secret' } })
    fireEvent.click(within(sections[2]!).getByRole('button', { name: /clear key|清除.*密钥/i }))
    fireEvent.click(saveButton())
    await waitFor(() => expect(mocks.saveMediaGenConfig).toHaveBeenCalledOnce())
    const dto = mocks.saveMediaGenConfig.mock.calls[0]![0]
    expect(dto.map((item: { apiKey: unknown }) => item.apiKey)).toEqual([
      { action: 'keep' },
      { action: 'replace', value: 'new-secret' },
      { action: 'clear' },
    ])
  })

  it('fetches models for an unsaved draft with its current URL and replacement key', async () => {
    renderModal()
    fireEvent.click(await screen.findByRole('button', { name: /添加.*(?:服务商|Provider)|add provider/i }))
    const section = document.querySelector('section')!
    fireEvent.change(within(section).getByLabelText(/base url|基础 URL/i), { target: { value: 'https://draft.example/v1' } })
    fireEvent.change(within(section).getByLabelText(/API key|API 密钥/i), { target: { value: 'draft-secret' } })
    fireEvent.click(within(section).getByRole('button', { name: /fetch models|获取模型|拉取模型/i }))
    await waitFor(() => expect(mocks.fetchMediaGenModels).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://draft.example/v1', apiFormat: 'openai_compatible', apiKey: { action: 'replace', value: 'draft-secret' },
    })))
    expect(mocks.saveMediaGenConfig).not.toHaveBeenCalled()
  })

  it('applies delayed fetch results by provider id after reorder and discards them after deletion', async () => {
    const first = deferred<unknown>(); const second = deferred<unknown>()
    mocks.getMediaGenConfig.mockResolvedValue({ schemaVersion: 3, providers: [provider('a'), provider('b')] })
    mocks.fetchMediaGenModels.mockImplementation(({ providerId }: { providerId: string }) => providerId === 'a' ? first.promise : second.promise)
    renderModal()
    await screen.findByText('Provider b')
    let sections = document.querySelectorAll('section')
    sections.forEach(section => expand(section as HTMLElement))
    fireEvent.click(within(sections[0]!).getByRole('button', { name: /fetch models|获取模型|拉取模型/i }))
    fireEvent.click(within(sections[1]!).getByRole('button', { name: /fetch models|获取模型|拉取模型/i }))
    expect(within(sections[0]!).getByRole('button', { name: /fetch models|获取模型|拉取模型/i })).toBeDisabled()
    expect(within(sections[1]!).getByRole('button', { name: /fetch models|获取模型|拉取模型/i })).toBeDisabled()

    fireEvent.click(within(sections[0]!).getByRole('button', { name: /下移|move provider down/i }))
    sections = document.querySelectorAll('section')
    first.resolve({ data: [{ id: 'model-a-only' }] })
    await waitFor(() => expect(within(sections[1]!).getByText(/1.*(?:models|候选)/i)).toBeInTheDocument())
    expect(within(sections[0]!).queryByText(/1.*(?:models|候选)/i)).not.toBeInTheDocument()

    fireEvent.click(within(sections[0]!).getByRole('button', { name: /删除|移除|remove provider/i }))
    second.resolve({ data: [{ id: 'model-b-only' }] })
    await waitFor(() => expect(document.querySelectorAll('section')).toHaveLength(1))
    expect(screen.queryByText('model-b-only')).not.toBeInTheDocument()
  })

  it('computes readiness from the draft key action', async () => {
    const completeModels = { imageGeneration: 'a', imageEditing: 'b', videoGeneration: 'c', videoEditing: 'd', videoExtension: 'e' }
    mocks.getMediaGenConfig.mockResolvedValue({ schemaVersion: 3, providers: [provider('draft', { apiKeyConfigured: false, models: completeModels })] })
    renderModal()
    const section = await screen.findByText('Provider draft').then(input => input.closest('section')!)
    expand(section)
    expect(within(section).getByText(/^(partial|待完善)$/i)).toBeInTheDocument()
    fireEvent.change(within(section).getByLabelText(/API key|API 密钥/i), { target: { value: 'new-secret' } })
    expect(within(section).getByText(/^(ready|就绪)$/i)).toBeInTheDocument()
    fireEvent.click(within(section).getByRole('button', { name: /clear key|清除.*密钥/i }))
    expect(within(section).getByText(/^(partial|待完善)$/i)).toBeInTheDocument()
  })

  it('offers fetched models from the real response shape independently in all five combo inputs', async () => {
    mocks.getMediaGenConfig.mockResolvedValue({ schemaVersion: 3, providers: [provider('models')] })
    renderModal()
    const section = await screen.findByText('Provider models').then(input => input.closest('section')!)
    expand(section)
    fireEvent.click(within(section).getByRole('button', { name: /fetch models|获取模型|拉取模型/i }))
    await waitFor(() => expect(mocks.fetchMediaGenModels).toHaveBeenCalledWith({ providerId: 'models', baseUrl: 'https://models.example/v1', apiFormat: 'openai_compatible', apiKey: { action: 'keep' } }))

    const modelInputs = within(section).getAllByRole('combobox')
    expect(modelInputs).toHaveLength(5)
    for (const input of modelInputs) {
      expect(input).toHaveValue('')
      fireEvent.focus(input)
      expect(screen.getByRole('option', { name: /model-a/ })).toBeInTheDocument()
      fireEvent.change(input, { target: { value: `custom-${modelInputs.indexOf(input)}` } })
      fireEvent.keyDown(input, { key: 'Escape' })
    }
    expect(modelInputs.map(input => (input as HTMLInputElement).value)).toEqual(['custom-0', 'custom-1', 'custom-2', 'custom-3', 'custom-4'])
  })

  it('saves provider order and only contract fields with filtered models and correct secret actions', async () => {
    mocks.getMediaGenConfig.mockResolvedValue({ schemaVersion: 3, providers: [provider('first', { models: { imageGeneration: 'img', videoEditing: '' } }), provider('second')] })
    renderModal()
    await screen.findByText('Provider second')
    fireEvent.click(within(document.querySelectorAll('section')[1]!).getByRole('button', { name: /上移|move provider up/i }))
    fireEvent.click(saveButton())
    await waitFor(() => expect(mocks.saveMediaGenConfig).toHaveBeenCalledOnce())
    expect(mocks.saveMediaGenConfig.mock.calls[0]![0]).toEqual([
      { id: 'second', name: 'Provider second', enabled: true, apiFormat: 'openai_compatible', baseUrl: 'https://second.example/v1', models: {}, apiKey: { action: 'keep' } },
      { id: 'first', name: 'Provider first', enabled: true, apiFormat: 'openai_compatible', baseUrl: 'https://first.example/v1', models: { imageGeneration: 'img' }, apiKey: { action: 'keep' } },
    ])
  })

  it('keeps the modal open and reports the error when saving fails', async () => {
    mocks.getMediaGenConfig.mockResolvedValue({ schemaVersion: 3, providers: [provider('failure')] })
    mocks.saveMediaGenConfig.mockRejectedValue(new Error('save exploded'))
    const onClose = vi.fn()
    renderModal({ onClose })
    await screen.findByText('Provider failure')
    fireEvent.click(saveButton())
    await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith({ type: 'error', message: 'save exploded' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
