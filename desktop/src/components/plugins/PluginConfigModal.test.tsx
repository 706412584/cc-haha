import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PluginConfigModal } from './PluginConfigModal'

// Mock the plugins API — use vi.hoisted to make mocks available before vi.mock hoisting
const { mockGetOptions, mockSaveOptions, mockAddToast } = vi.hoisted(() => ({
  mockGetOptions: vi.fn(),
  mockSaveOptions: vi.fn(),
  mockAddToast: vi.fn(),
}))

vi.mock('../../api/plugins', () => ({
  pluginsApi: {
    getOptions: (...args: unknown[]) => mockGetOptions(...args),
    saveOptions: (...args: unknown[]) => mockSaveOptions(...args),
  },
}))

// Mock useUIStore — zustand store with selector pattern
vi.mock('../../stores/uiStore', () => {
  const store = { addToast: mockAddToast }
  const useUIStore = (selector: (s: typeof store) => unknown) => selector(store)
  useUIStore.getState = () => store
  return { useUIStore }
})

const testSchema = {
  API_KEY: {
    type: 'string',
    title: 'API Key',
    description: 'Your API key',
    required: true,
    sensitive: true,
  },
  BASE_URL: {
    type: 'string',
    title: 'Base URL',
    description: 'API endpoint',
    default: 'https://example.com',
  },
  ENABLED: {
    type: 'boolean',
    title: 'Enable feature',
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetOptions.mockResolvedValue({
    pluginId: 'test@market',
    schema: testSchema,
    values: { API_KEY: '********', BASE_URL: 'https://custom.com', ENABLED: '' },
  })
  mockSaveOptions.mockResolvedValue({ ok: true })
})

describe('PluginConfigModal', () => {
  it('renders nothing when closed', () => {
    render(
      <PluginConfigModal
        open={false}
        pluginId="test@market"
        pluginName="Test Plugin"
        schema={testSchema}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByText('配置 Test Plugin')).not.toBeInTheDocument()
  })

  it('renders title and fields when open', async () => {
    render(
      <PluginConfigModal
        open={true}
        pluginId="test@market"
        pluginName="Test Plugin"
        schema={testSchema}
        onClose={() => {}}
      />,
    )

    expect(screen.getByText('配置 Test Plugin')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByText('API Key')).toBeInTheDocument()
      expect(screen.getByText('Base URL')).toBeInTheDocument()
      expect(screen.getByText('Enable feature')).toBeInTheDocument()
    })
  })

  it('fetches options on open and populates fields', async () => {
    render(
      <PluginConfigModal
        open={true}
        pluginId="test@market"
        pluginName="Test Plugin"
        schema={testSchema}
        onClose={() => {}}
      />,
    )

    await waitFor(() => {
      expect(mockGetOptions).toHaveBeenCalledWith('test@market')
    })

    // Non-sensitive field should show the value
    await waitFor(() => {
      const baseUrlInput = screen.getByDisplayValue('https://custom.com')
      expect(baseUrlInput).toBeInTheDocument()
    })
  })

  it('renders sensitive fields as password input', async () => {
    render(
      <PluginConfigModal
        open={true}
        pluginId="test@market"
        pluginName="Test Plugin"
        schema={testSchema}
        onClose={() => {}}
      />,
    )

    await waitFor(() => {
      // Find the password input for API_KEY
      const passwordInputs = document.querySelectorAll('input[type="password"]')
      expect(passwordInputs.length).toBeGreaterThan(0)
    })
  })

  it('toggles sensitive field visibility', async () => {
    render(
      <PluginConfigModal open={true} pluginId="test@market" pluginName="Test Plugin" schema={testSchema} onClose={() => {}} />,
    )

    const showButton = await screen.findByRole('button', { name: '显示 API Key' })
    fireEvent.click(showButton)
    expect(document.querySelector('input[type="text"][value="********"]')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '隐藏 API Key' })).toBeInTheDocument()
  })

  it('renders grouped fields as sections when group metadata exists', async () => {
    const groupedSchema = {
      ...testSchema,
      API_KEY: { ...testSchema.API_KEY, group: 'Provider 1', groupDescription: 'Primary provider' },
      BASE_URL: { ...testSchema.BASE_URL, group: 'Provider 1', groupDescription: 'Primary provider' },
    }
    render(
      <PluginConfigModal open={true} pluginId="test@market" pluginName="Test Plugin" schema={groupedSchema} onClose={() => {}} />,
    )

    expect(await screen.findByText('Provider 1')).toBeInTheDocument()
    expect(screen.getByText('Primary provider')).toBeInTheDocument()
  })

  it('hides sensitive values again after closing and reopening', async () => {
    const { rerender } = render(
      <PluginConfigModal open={true} pluginId="test@market" pluginName="Test Plugin" schema={testSchema} onClose={() => {}} />,
    )
    fireEvent.click(await screen.findByRole('button', { name: '显示 API Key' }))
    expect(screen.getByRole('button', { name: '隐藏 API Key' })).toBeInTheDocument()

    rerender(<PluginConfigModal open={false} pluginId="test@market" pluginName="Test Plugin" schema={testSchema} onClose={() => {}} />)
    rerender(<PluginConfigModal open={true} pluginId="test@market" pluginName="Test Plugin" schema={testSchema} onClose={() => {}} />)

    expect(await screen.findByRole('button', { name: '显示 API Key' })).toBeInTheDocument()
    await waitFor(() => expect(document.getElementById('plugin-option-API_KEY')).toHaveAttribute('type', 'password'))
  })

  it('associates field labels and descriptions with inputs', async () => {
    render(
      <PluginConfigModal open={true} pluginId="test@market" pluginName="Test Plugin" schema={testSchema} onClose={() => {}} />,
    )
    const input = await screen.findByLabelText('Base URL')
    expect(input).toHaveAccessibleDescription('API endpoint')
  })

  it('renders secure badge for sensitive fields', async () => {
    render(
      <PluginConfigModal
        open={true}
        pluginId="test@market"
        pluginName="Test Plugin"
        schema={testSchema}
        onClose={() => {}}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('secure')).toBeInTheDocument()
    })
  })

  it('saves without masked values when user did not modify sensitive field', async () => {
    render(
      <PluginConfigModal
        open={true}
        pluginId="test@market"
        pluginName="Test Plugin"
        schema={testSchema}
        onClose={() => {}}
      />,
    )

    // Wait for fetch to complete
    await waitFor(() => {
      expect(screen.getByDisplayValue('https://custom.com')).toBeInTheDocument()
    })

    const saveButton = screen.getByText('保存')
    fireEvent.click(saveButton)

    await waitFor(() => {
      expect(mockSaveOptions).toHaveBeenCalledWith(
        'test@market',
        // Should NOT include API_KEY: '********' (masked value skipped)
        expect.objectContaining({ BASE_URL: 'https://custom.com' }),
      )
      // Verify API_KEY is not in the saved values
      const savedValues = mockSaveOptions.mock.calls[0]![1] as Record<string, string>
      expect(savedValues).not.toHaveProperty('API_KEY')
    })
  })

  it('saves modified sensitive field when user changes it', async () => {
    render(
      <PluginConfigModal
        open={true}
        pluginId="test@market"
        pluginName="Test Plugin"
        schema={testSchema}
        onClose={() => {}}
      />,
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://custom.com')).toBeInTheDocument()
    })

    // Find and modify the password input
    const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement
    fireEvent.change(passwordInput, { target: { value: 'sk-new-key' } })

    const saveButton = screen.getByText('保存')
    fireEvent.click(saveButton)

    await waitFor(() => {
      const savedValues = mockSaveOptions.mock.calls[0]![1] as Record<string, string>
      expect(savedValues.API_KEY).toBe('sk-new-key')
    })
  })

  it('calls onClose when Cancel is clicked', async () => {
    const onClose = vi.fn()
    render(
      <PluginConfigModal
        open={true}
        pluginId="test@market"
        pluginName="Test Plugin"
        schema={testSchema}
        onClose={onClose}
      />,
    )

    const cancelButton = screen.getByText('取消')
    fireEvent.click(cancelButton)

    expect(onClose).toHaveBeenCalled()
  })

  it('calls onSaved after successful save', async () => {
    const onSaved = vi.fn()
    render(
      <PluginConfigModal
        open={true}
        pluginId="test@market"
        pluginName="Test Plugin"
        schema={testSchema}
        onClose={() => {}}
        onSaved={onSaved}
      />,
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://custom.com')).toBeInTheDocument()
    })

    const saveButton = screen.getByText('保存')
    fireEvent.click(saveButton)

    await waitFor(() => {
      expect(onSaved).toHaveBeenCalled()
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: 'Test Plugin 配置已保存' }),
      )
    })
  })

  it('shows toast on save error', async () => {
    mockSaveOptions.mockRejectedValue(new Error('Network error'))

    render(
      <PluginConfigModal
        open={true}
        pluginId="test@market"
        pluginName="Test Plugin"
        schema={testSchema}
        onClose={() => {}}
      />,
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://custom.com')).toBeInTheDocument()
    })

    const saveButton = screen.getByText('保存')
    fireEvent.click(saveButton)

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'Network error' }),
      )
    })
  })

  const mediaGenSchema = {
    PROVIDER_1_NAME: {
      type: 'string',
      title: '显示名称',
      default: 'Agnes',
      group: 'Provider 1',
      groupDescription: '默认图片 provider',
    },
    PROVIDER_1_BASE_URL: {
      type: 'string',
      title: 'API Base URL',
      default: 'https://api.example.com/v1',
      group: 'Provider 1',
      groupDescription: '默认图片 provider',
    },
    PROVIDER_1_API_KEY: {
      type: 'string',
      title: 'API Key',
      required: true,
      sensitive: true,
      group: 'Provider 1',
      groupDescription: '默认图片 provider',
    },
    PROVIDER_1_MODEL: {
      type: 'string',
      title: '默认模型',
      default: 'agnes-image-2.1-flash',
      group: 'Provider 1',
      groupDescription: '默认图片 provider',
    },
    PROVIDER_2_NAME: {
      type: 'string',
      title: '显示名称',
      default: '',
      group: 'Provider 2',
      groupDescription: '可选 fallback',
    },
    PROVIDER_2_BASE_URL: {
      type: 'string',
      title: 'API Base URL',
      default: '',
      group: 'Provider 2',
      groupDescription: '可选 fallback',
    },
    PROVIDER_2_API_KEY: {
      type: 'string',
      title: 'API Key',
      sensitive: true,
      group: 'Provider 2',
      groupDescription: '可选 fallback',
    },
    PROVIDER_2_MODEL: {
      type: 'string',
      title: '默认模型',
      default: '',
      group: 'Provider 2',
      groupDescription: '可选 fallback',
    },
    PROVIDER_3_NAME: {
      type: 'string',
      title: '显示名称',
      default: '',
      group: 'Provider 3',
      groupDescription: '可选二级 fallback',
    },
    PROVIDER_3_BASE_URL: {
      type: 'string',
      title: 'API Base URL',
      default: '',
      group: 'Provider 3',
      groupDescription: '可选二级 fallback',
    },
    PROVIDER_3_API_KEY: {
      type: 'string',
      title: 'API Key',
      sensitive: true,
      group: 'Provider 3',
      groupDescription: '可选二级 fallback',
    },
    PROVIDER_3_MODEL: {
      type: 'string',
      title: '默认模型',
      default: '',
      group: 'Provider 3',
      groupDescription: '可选二级 fallback',
    },
  }

  it('renders dedicated media-gen provider panel with priority strip', async () => {
    mockGetOptions.mockResolvedValue({
      pluginId: 'media-gen@market',
      schema: mediaGenSchema,
      values: {
        PROVIDER_1_NAME: 'Agnes',
        PROVIDER_1_BASE_URL: 'https://api.example.com/v1',
        PROVIDER_1_API_KEY: '********',
        PROVIDER_1_MODEL: 'agnes-image-2.1-flash',
        PROVIDER_2_NAME: '',
        PROVIDER_2_BASE_URL: '',
        PROVIDER_2_API_KEY: '',
        PROVIDER_2_MODEL: '',
        PROVIDER_3_NAME: '',
        PROVIDER_3_BASE_URL: '',
        PROVIDER_3_API_KEY: '',
        PROVIDER_3_MODEL: '',
      },
    })

    render(
      <PluginConfigModal
        open={true}
        pluginId="media-gen@market"
        pluginName="media-gen"
        schema={mediaGenSchema}
        onClose={() => {}}
      />,
    )

    expect(await screen.findByText('配置 media-gen')).toBeInTheDocument()
    expect(screen.getByText('Provider 优先级')).toBeInTheDocument()
    expect(screen.getByText('P1 · 优先')).toBeInTheDocument()
    expect(screen.getByText('P2 · Fallback')).toBeInTheDocument()
    expect(screen.getByText('P3 · 二级')).toBeInTheDocument()
    expect(screen.getAllByText('已配置').length).toBeGreaterThan(0)
    expect(screen.getAllByText('未启用').length).toBeGreaterThan(0)

    // Optional providers collapse by default when empty
    expect(screen.getAllByText('展开配置')).toHaveLength(2)
    expect(screen.queryByLabelText('显示名称', { selector: '#plugin-option-PROVIDER_2_NAME' })).not.toBeInTheDocument()
  })

  it('expands configured optional media-gen providers and toggles collapse', async () => {
    mockGetOptions.mockResolvedValue({
      pluginId: 'media-gen@market',
      schema: mediaGenSchema,
      values: {
        PROVIDER_1_NAME: 'Agnes',
        PROVIDER_1_BASE_URL: 'https://api.example.com/v1',
        PROVIDER_1_API_KEY: '********',
        PROVIDER_1_MODEL: 'agnes-image-2.1-flash',
        PROVIDER_2_NAME: 'Grok',
        PROVIDER_2_BASE_URL: 'http://127.0.0.1:18080/v1',
        PROVIDER_2_API_KEY: '********',
        PROVIDER_2_MODEL: 'grok-imagine-image',
        PROVIDER_3_NAME: '',
        PROVIDER_3_BASE_URL: '',
        PROVIDER_3_API_KEY: '',
        PROVIDER_3_MODEL: '',
      },
    })

    render(
      <PluginConfigModal
        open={true}
        pluginId="media-gen@market"
        pluginName="media-gen"
        schema={mediaGenSchema}
        onClose={() => {}}
      />,
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('Grok')).toBeInTheDocument()
      expect(screen.getByDisplayValue('grok-imagine-image')).toBeInTheDocument()
    })

    // P2 expanded (has data), P3 still collapsed
    expect(screen.getAllByText('收起')).toHaveLength(1)
    expect(screen.getAllByText('展开配置')).toHaveLength(1)
    expect(document.getElementById('plugin-option-PROVIDER_2_NAME')).toBeInTheDocument()
    expect(document.getElementById('plugin-option-PROVIDER_3_NAME')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('展开配置'))
    expect(document.getElementById('plugin-option-PROVIDER_3_NAME')).toBeInTheDocument()
    expect(screen.getAllByText('收起')).toHaveLength(2)

    fireEvent.click(screen.getAllByText('收起')[0]!)
    expect(document.getElementById('plugin-option-PROVIDER_2_NAME')).not.toBeInTheDocument()
  })

  it('marks partial media-gen provider status when only some fields are filled', async () => {
    mockGetOptions.mockResolvedValue({
      pluginId: 'media-gen@market',
      schema: mediaGenSchema,
      values: {
        PROVIDER_1_NAME: 'Agnes',
        PROVIDER_1_BASE_URL: '',
        PROVIDER_1_API_KEY: '',
        PROVIDER_1_MODEL: 'agnes-image-2.1-flash',
        PROVIDER_2_NAME: '',
        PROVIDER_2_BASE_URL: '',
        PROVIDER_2_API_KEY: '',
        PROVIDER_2_MODEL: '',
        PROVIDER_3_NAME: '',
        PROVIDER_3_BASE_URL: '',
        PROVIDER_3_API_KEY: '',
        PROVIDER_3_MODEL: '',
      },
    })

    render(
      <PluginConfigModal
        open={true}
        pluginId="media-gen@market"
        pluginName="media-gen"
        schema={mediaGenSchema}
        onClose={() => {}}
      />,
    )

    expect((await screen.findAllByText('不完整')).length).toBeGreaterThan(0)
  })

  it('blocks media-gen save when a provider is partial', async () => {
    mockGetOptions.mockResolvedValue({
      pluginId: 'media-gen@market',
      schema: mediaGenSchema,
      values: {
        PROVIDER_1_NAME: 'Agnes',
        PROVIDER_1_BASE_URL: '',
        PROVIDER_1_API_KEY: '',
        PROVIDER_1_MODEL: 'agnes-image-2.1-flash',
        PROVIDER_2_NAME: '',
        PROVIDER_2_BASE_URL: '',
        PROVIDER_2_API_KEY: '',
        PROVIDER_2_MODEL: '',
        PROVIDER_3_NAME: '',
        PROVIDER_3_BASE_URL: '',
        PROVIDER_3_API_KEY: '',
        PROVIDER_3_MODEL: '',
      },
    })

    render(
      <PluginConfigModal
        open={true}
        pluginId="media-gen@market"
        pluginName="media-gen"
        schema={mediaGenSchema}
        onClose={() => {}}
      />,
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('Agnes')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('保存'))

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          message: 'Provider 1 配置不完整：请补齐 API Base URL、API Key 与默认模型。',
        }),
      )
    })
    expect(mockSaveOptions).not.toHaveBeenCalled()
  })

  it('blocks media-gen save when optional provider is only partially filled', async () => {
    mockGetOptions.mockResolvedValue({
      pluginId: 'media-gen@market',
      schema: mediaGenSchema,
      values: {
        PROVIDER_1_NAME: 'Agnes',
        PROVIDER_1_BASE_URL: 'https://api.example.com/v1',
        PROVIDER_1_API_KEY: '********',
        PROVIDER_1_MODEL: 'agnes-image-2.1-flash',
        PROVIDER_2_NAME: 'Grok',
        PROVIDER_2_BASE_URL: '',
        PROVIDER_2_API_KEY: '',
        PROVIDER_2_MODEL: 'grok-imagine-image',
        PROVIDER_3_NAME: '',
        PROVIDER_3_BASE_URL: '',
        PROVIDER_3_API_KEY: '',
        PROVIDER_3_MODEL: '',
      },
    })

    render(
      <PluginConfigModal
        open={true}
        pluginId="media-gen@market"
        pluginName="media-gen"
        schema={mediaGenSchema}
        onClose={() => {}}
      />,
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('Grok')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('保存'))

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          message: 'Provider 2 配置不完整：请补齐 API Base URL、API Key 与默认模型，或四个字段全部留空以禁用。',
        }),
      )
    })
    expect(mockSaveOptions).not.toHaveBeenCalled()
  })

  it('persists collapsed optional provider edits on save', async () => {
    mockGetOptions.mockResolvedValue({
      pluginId: 'media-gen@market',
      schema: mediaGenSchema,
      values: {
        PROVIDER_1_NAME: 'Agnes',
        PROVIDER_1_BASE_URL: 'https://api.example.com/v1',
        PROVIDER_1_API_KEY: '********',
        PROVIDER_1_MODEL: 'agnes-image-2.1-flash',
        PROVIDER_2_NAME: '',
        PROVIDER_2_BASE_URL: '',
        PROVIDER_2_API_KEY: '',
        PROVIDER_2_MODEL: '',
        PROVIDER_3_NAME: '',
        PROVIDER_3_BASE_URL: '',
        PROVIDER_3_API_KEY: '',
        PROVIDER_3_MODEL: '',
      },
    })

    render(
      <PluginConfigModal
        open={true}
        pluginId="media-gen@market"
        pluginName="media-gen"
        schema={mediaGenSchema}
        onClose={() => {}}
      />,
    )

    await waitFor(() => {
      expect(screen.getByDisplayValue('Agnes')).toBeInTheDocument()
    })

    fireEvent.click(screen.getAllByText('展开配置')[0]!)
    fireEvent.change(document.getElementById('plugin-option-PROVIDER_2_NAME')!, { target: { value: 'Grok' } })
    fireEvent.change(document.getElementById('plugin-option-PROVIDER_2_BASE_URL')!, {
      target: { value: 'http://127.0.0.1:18080/v1' },
    })
    fireEvent.change(document.getElementById('plugin-option-PROVIDER_2_MODEL')!, {
      target: { value: 'grok-imagine-image' },
    })
    fireEvent.change(document.getElementById('plugin-option-PROVIDER_2_API_KEY')!, {
      target: { value: 'secret-2' },
    })

    fireEvent.click(screen.getByText('收起'))
    expect(document.getElementById('plugin-option-PROVIDER_2_NAME')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('保存'))

    await waitFor(() => {
      expect(mockSaveOptions).toHaveBeenCalled()
    })
    const saved = mockSaveOptions.mock.calls[0]![1] as Record<string, string>
    expect(saved.PROVIDER_2_NAME).toBe('Grok')
    expect(saved.PROVIDER_2_BASE_URL).toBe('http://127.0.0.1:18080/v1')
    expect(saved.PROVIDER_2_MODEL).toBe('grok-imagine-image')
    expect(saved.PROVIDER_2_API_KEY).toBe('secret-2')
    expect(saved).not.toHaveProperty('PROVIDER_1_API_KEY')
  })
})
