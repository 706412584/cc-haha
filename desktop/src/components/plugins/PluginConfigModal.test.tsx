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
  addToast: vi.fn(),
}))

vi.mock('../../api/plugins', () => ({
  pluginsApi: {
    getOptions: mocks.getOptions,
    saveOptions: mocks.saveOptions,
    getMediaGenConfig: mocks.getMediaGenConfig,
    saveMediaGenConfig: mocks.saveMediaGenConfig,
    fetchMediaGenModels: mocks.fetchMediaGenModels,
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

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getOptions.mockResolvedValue({ pluginId: 'ordinary@market', schema, values: { TOKEN: '********', ENABLED: true } })
  mocks.saveOptions.mockResolvedValue({ ok: true })
  mocks.getMediaGenConfig.mockResolvedValue({ schemaVersion: 2, providers: [] })
  mocks.saveMediaGenConfig.mockResolvedValue({ schemaVersion: 2, providers: [] })
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

  it('loads more than four providers and supports collapse, enable, reorder, remove, and add', async () => {
    mocks.getMediaGenConfig.mockResolvedValue({ schemaVersion: 2, providers: ['a', 'b', 'c', 'd', 'e'].map(id => provider(id)) })
    renderModal()
    expect(await screen.findByDisplayValue('Provider e')).toBeInTheDocument()

    const sections = document.querySelectorAll('section')
    expect(sections).toHaveLength(5)
    fireEvent.click(within(sections[0]!).getByRole('button', { name: /折叠|collapse/i }))
    expect(screen.queryByDisplayValue('Provider a')).not.toBeInTheDocument()
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
    mocks.getMediaGenConfig.mockResolvedValue({ schemaVersion: 2, providers: Array.from({ length: 15 }, (_, i) => provider(String(i))) })
    renderModal()
    await screen.findByDisplayValue('Provider 14')
    expect(addButton()).toBeEnabled()
    fireEvent.click(addButton())
    expect(document.querySelectorAll('section')).toHaveLength(16)
    expect(addButton()).toBeDisabled()
  })

  it('maps configured API keys to keep by default, typed keys to replace, and explicit clearing to clear', async () => {
    mocks.getMediaGenConfig.mockResolvedValue({ schemaVersion: 2, providers: [provider('keep'), provider('replace'), provider('clear')] })
    renderModal()
    await screen.findByDisplayValue('Provider keep')
    const sections = document.querySelectorAll('section')
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

  it('offers fetched models independently in all five combo inputs, accepts custom values, and does not auto-assign purposes', async () => {
    mocks.getMediaGenConfig.mockResolvedValue({ schemaVersion: 2, providers: [provider('models')] })
    renderModal()
    const section = await screen.findByDisplayValue('Provider models').then(input => input.closest('section')!)
    fireEvent.click(within(section).getByRole('button', { name: /fetch models|获取模型|拉取模型/i }))
    await waitFor(() => expect(mocks.fetchMediaGenModels).toHaveBeenCalledWith('models'))

    const modelInputs = within(section).getAllByRole('textbox').slice(2)
    expect(modelInputs).toHaveLength(5)
    for (const input of modelInputs) {
      expect(input).toHaveValue('')
      fireEvent.focus(input)
      expect(within(section).getByRole('option', { name: /model-a/ })).toBeInTheDocument()
      fireEvent.change(input, { target: { value: `custom-${modelInputs.indexOf(input)}` } })
      fireEvent.keyDown(document, { key: 'Escape' })
    }
    expect(modelInputs.map(input => (input as HTMLInputElement).value)).toEqual(['custom-0', 'custom-1', 'custom-2', 'custom-3', 'custom-4'])
  })

  it('saves provider order and only contract fields with filtered models and correct secret actions', async () => {
    mocks.getMediaGenConfig.mockResolvedValue({ schemaVersion: 2, providers: [provider('first', { models: { imageGeneration: 'img', videoEditing: '' } }), provider('second')] })
    renderModal()
    await screen.findByDisplayValue('Provider second')
    fireEvent.click(within(document.querySelectorAll('section')[1]!).getByRole('button', { name: /上移|move provider up/i }))
    fireEvent.click(saveButton())
    await waitFor(() => expect(mocks.saveMediaGenConfig).toHaveBeenCalledOnce())
    expect(mocks.saveMediaGenConfig.mock.calls[0]![0]).toEqual([
      { id: 'second', name: 'Provider second', enabled: true, apiFormat: 'openai_compatible', baseUrl: 'https://second.example/v1', models: {}, apiKey: { action: 'keep' } },
      { id: 'first', name: 'Provider first', enabled: true, apiFormat: 'openai_compatible', baseUrl: 'https://first.example/v1', models: { imageGeneration: 'img' }, apiKey: { action: 'keep' } },
    ])
  })

  it('keeps the modal open and reports the error when saving fails', async () => {
    mocks.getMediaGenConfig.mockResolvedValue({ schemaVersion: 2, providers: [provider('failure')] })
    mocks.saveMediaGenConfig.mockRejectedValue(new Error('save exploded'))
    const onClose = vi.fn()
    renderModal({ onClose })
    await screen.findByDisplayValue('Provider failure')
    fireEvent.click(saveButton())
    await waitFor(() => expect(mocks.addToast).toHaveBeenCalledWith({ type: 'error', message: 'save exploded' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
