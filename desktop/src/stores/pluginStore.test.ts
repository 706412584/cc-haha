import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePluginStore } from './pluginStore'
import { pluginsApi } from '../api/plugins'

vi.mock('../api/plugins', () => ({
  pluginsApi: {
    list: vi.fn(),
    detail: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    update: vi.fn(),
    uninstall: vi.fn(),
    reload: vi.fn(),
  },
}))

const mockedPluginsApi = vi.mocked(pluginsApi)

describe('pluginStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedPluginsApi.list.mockResolvedValue({
      plugins: [],
      marketplaces: [],
      summary: { total: 0, enabled: 0, errorCount: 0, marketplaceCount: 0 },
    })
    mockedPluginsApi.reload.mockResolvedValue({
      ok: true,
      summary: {
        enabled: 1,
        disabled: 0,
        skills: 1,
        agents: 0,
        hooks: 0,
        mcpServers: 0,
        lspServers: 0,
        errors: 0,
      },
      session: {
        applied: true,
        commands: 1,
        agents: 0,
        plugins: 1,
        mcpServers: 0,
        errors: 0,
      },
    })
    usePluginStore.setState({
      plugins: [],
      marketplaces: [],
      summary: null,
      selectedPlugin: null,
      selectedPluginContext: null,
      lastReloadSummary: null,
      lastSessionReload: null,
      refreshWarning: null,
      isLoading: false,
      isDetailLoading: false,
      isApplying: false,
      error: null,
    })
  })

  it('reloads the active CLI session after enabling a plugin', async () => {
    mockedPluginsApi.enable.mockResolvedValue({
      ok: true,
      message: 'enabled',
    })

    const message = await usePluginStore
      .getState()
      .enablePlugin('draw@test', 'user', '/workspace/project', 'session-1')

    expect(message).toBe('enabled')
    expect(mockedPluginsApi.enable).toHaveBeenCalledWith({
      id: 'draw@test',
      scope: 'user',
      cwd: undefined,
    })
    expect(mockedPluginsApi.reload).toHaveBeenCalledWith(
      '/workspace/project',
      'session-1',
    )
    expect(usePluginStore.getState().lastReloadSummary).toEqual({
      enabled: 1,
      disabled: 0,
      skills: 1,
      agents: 0,
      hooks: 0,
      mcpServers: 0,
      lspServers: 0,
      errors: 0,
    })
  })

  it('reloads and refreshes once after bulk enabling plugins', async () => {
    mockedPluginsApi.enable.mockResolvedValue({
      ok: true,
      message: 'enabled',
    })

    const changed = await usePluginStore.getState().bulkEnablePlugins(
      [
        { id: 'draw@test', scope: 'user' },
        { id: 'review@test', scope: 'project' },
      ],
      '/workspace/project',
      'session-1',
    )

    expect(changed).toBe(2)
    expect(mockedPluginsApi.enable).toHaveBeenCalledTimes(2)
    expect(mockedPluginsApi.enable).toHaveBeenNthCalledWith(1, {
      id: 'draw@test',
      scope: 'user',
      cwd: undefined,
    })
    expect(mockedPluginsApi.enable).toHaveBeenNthCalledWith(2, {
      id: 'review@test',
      scope: 'project',
      cwd: '/workspace/project',
    })
    expect(mockedPluginsApi.reload).toHaveBeenCalledTimes(1)
    expect(mockedPluginsApi.reload).toHaveBeenCalledWith(
      '/workspace/project',
      'session-1',
    )
    expect(mockedPluginsApi.list).toHaveBeenCalledTimes(1)
    expect(mockedPluginsApi.list).toHaveBeenCalledWith('/workspace/project')
  })

  it('reloads and refreshes once after bulk disabling plugins', async () => {
    mockedPluginsApi.disable.mockResolvedValue({
      ok: true,
      message: 'disabled',
    })

    const changed = await usePluginStore.getState().bulkDisablePlugins(
      [
        { id: 'github@test', scope: 'user' },
        { id: 'review@test', scope: 'project' },
      ],
      '/workspace/project',
      'session-1',
    )

    expect(changed).toBe(2)
    expect(mockedPluginsApi.disable).toHaveBeenCalledTimes(2)
    expect(mockedPluginsApi.disable).toHaveBeenNthCalledWith(1, {
      id: 'github@test',
      scope: 'user',
      cwd: undefined,
    })
    expect(mockedPluginsApi.disable).toHaveBeenNthCalledWith(2, {
      id: 'review@test',
      scope: 'project',
      cwd: '/workspace/project',
    })
    expect(mockedPluginsApi.reload).toHaveBeenCalledTimes(1)
    expect(mockedPluginsApi.reload).toHaveBeenCalledWith(
      '/workspace/project',
      'session-1',
    )
    expect(mockedPluginsApi.list).toHaveBeenCalledTimes(1)
    expect(mockedPluginsApi.list).toHaveBeenCalledWith('/workspace/project')
  })

  it('ignores stale plugin lists after the active project changes', async () => {
    let resolveFirst!: (value: Awaited<ReturnType<typeof pluginsApi.list>>) => void
    let resolveSecond!: (value: Awaited<ReturnType<typeof pluginsApi.list>>) => void
    mockedPluginsApi.list
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirst = resolve
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveSecond = resolve
      }))

    const first = usePluginStore.getState().fetchPlugins('/workspace/first')
    const second = usePluginStore.getState().fetchPlugins('/workspace/second')

    resolveSecond({
      plugins: [pluginSummary('second@test')],
      marketplaces: [],
      summary: { total: 1, enabled: 0, errorCount: 0, marketplaceCount: 0 },
    })
    await second
    resolveFirst({
      plugins: [pluginSummary('first@test')],
      marketplaces: [],
      summary: { total: 1, enabled: 0, errorCount: 0, marketplaceCount: 0 },
    })
    await first

    expect(usePluginStore.getState().plugins.map((plugin) => plugin.id)).toEqual([
      'second@test',
    ])
  })

  it('owns plugin detail by project context and invalidates an in-flight detail on clear', async () => {
    let resolveDetail!: (value: Awaited<ReturnType<typeof pluginsApi.detail>>) => void
    mockedPluginsApi.detail.mockImplementationOnce(() => new Promise((resolve) => {
      resolveDetail = resolve
    }))

    const request = usePluginStore
      .getState()
      .fetchPluginDetail('draw@test', '/workspace/first')
    expect(usePluginStore.getState().selectedPluginContext).toBe('/workspace/first')

    usePluginStore.getState().clearSelection()
    resolveDetail({ detail: pluginDetail('draw@test') })
    await request

    expect(usePluginStore.getState().selectedPlugin).toBeNull()
    expect(usePluginStore.getState().selectedPluginContext).toBeNull()
  })

  it('stores a current plugin detail and exposes a current detail failure', async () => {
    mockedPluginsApi.detail.mockResolvedValueOnce({
      detail: pluginDetail('draw@test'),
    })

    await usePluginStore
      .getState()
      .fetchPluginDetail('draw@test', '/workspace/project')

    expect(usePluginStore.getState()).toEqual(
      expect.objectContaining({
        selectedPlugin: expect.objectContaining({ id: 'draw@test' }),
        selectedPluginContext: '/workspace/project',
        isDetailLoading: false,
      }),
    )

    mockedPluginsApi.detail.mockRejectedValueOnce(new Error('detail unavailable'))
    await usePluginStore
      .getState()
      .fetchPluginDetail('review@test', '/workspace/project')

    expect(usePluginStore.getState()).toEqual(
      expect.objectContaining({
        selectedPlugin: null,
        selectedPluginContext: null,
        isDetailLoading: false,
        error: 'detail unavailable',
      }),
    )
  })

  it('reloads the list and current detail before publishing the reload result', async () => {
    usePluginStore.setState({
      selectedPlugin: pluginDetail('draw@test'),
      selectedPluginContext: '/workspace/project',
    })
    mockedPluginsApi.detail.mockResolvedValue({
      detail: pluginDetail('draw@test'),
    })

    const summary = await usePluginStore
      .getState()
      .reloadPlugins('/workspace/project', 'session-1')

    expect(summary).toEqual(expect.objectContaining({ enabled: 1, skills: 1 }))
    expect(mockedPluginsApi.list).toHaveBeenCalledWith('/workspace/project')
    expect(mockedPluginsApi.detail).toHaveBeenCalledWith(
      'draw@test',
      '/workspace/project',
    )
    expect(usePluginStore.getState().lastSessionReload).toEqual(
      expect.objectContaining({ applied: true, plugins: 1 }),
    )
  })

  it('serializes plugin mutations and preserves the session reload outcome', async () => {
    let resolveEnable!: (value: { ok: true; message: string }) => void
    mockedPluginsApi.enable.mockImplementationOnce(() => new Promise((resolve) => {
      resolveEnable = resolve
    }))
    mockedPluginsApi.disable.mockResolvedValue({ ok: true, message: 'disabled' })
    mockedPluginsApi.reload.mockResolvedValue({
      ok: true,
      summary: {
        enabled: 0,
        disabled: 1,
        skills: 0,
        agents: 0,
        hooks: 0,
        mcpServers: 0,
        lspServers: 0,
        errors: 0,
      },
      session: {
        applied: false,
        reason: 'not_running',
        commands: 0,
        agents: 0,
        plugins: 0,
        mcpServers: 0,
        errors: 0,
      },
    })

    const enable = usePluginStore
      .getState()
      .enablePlugin('draw@test', 'user', '/workspace/project', 'session-1')
    const disable = usePluginStore
      .getState()
      .disablePlugin('draw@test', 'user', '/workspace/project', 'session-1')

    await Promise.resolve()
    expect(mockedPluginsApi.enable).toHaveBeenCalledTimes(1)
    expect(mockedPluginsApi.disable).not.toHaveBeenCalled()

    resolveEnable({ ok: true, message: 'enabled' })
    await enable
    await disable

    expect(mockedPluginsApi.disable).toHaveBeenCalledTimes(1)
    expect(usePluginStore.getState().lastSessionReload).toEqual(
      expect.objectContaining({ applied: false, reason: 'not_running' }),
    )
    expect(usePluginStore.getState().isApplying).toBe(false)
  })

  it('reconciles the list after a partially successful bulk mutation', async () => {
    mockedPluginsApi.enable
      .mockResolvedValueOnce({ ok: true, message: 'enabled draw' })
      .mockRejectedValueOnce(new Error('review failed'))

    await expect(
      usePluginStore.getState().bulkEnablePlugins(
        [
          { id: 'draw@test', scope: 'user' },
          { id: 'review@test', scope: 'project' },
        ],
        '/workspace/project',
        'session-1',
      ),
    ).rejects.toThrow('review failed')

    expect(mockedPluginsApi.reload).toHaveBeenCalledTimes(1)
    expect(mockedPluginsApi.list).toHaveBeenCalledWith('/workspace/project')
    expect(usePluginStore.getState().isApplying).toBe(false)
  })

  it('reports a refresh warning without misreporting a successful mutation as failed', async () => {
    mockedPluginsApi.uninstall.mockResolvedValue({
      ok: true,
      message: 'uninstalled',
    })
    mockedPluginsApi.reload.mockRejectedValueOnce(new Error('runtime refresh failed'))
    usePluginStore.setState({
      selectedPlugin: pluginDetail('draw@test'),
      selectedPluginContext: '/workspace/project',
    })

    await expect(
      usePluginStore
        .getState()
        .uninstallPlugin('draw@test', 'user', false, '/workspace/project', 'session-1'),
    ).resolves.toBe('uninstalled')

    expect(usePluginStore.getState().selectedPlugin).toBeNull()
    expect(usePluginStore.getState().refreshWarning).toBe('runtime refresh failed')
  })
})

function pluginSummary(id: string) {
  const [name, marketplace] = id.split('@')
  return {
    id,
    name: name!,
    marketplace: marketplace!,
    scope: 'user' as const,
    enabled: false,
    hasErrors: false,
    isBuiltin: false,
    componentCounts: {
      commands: 0,
      agents: 0,
      skills: 0,
      hooks: 0,
      mcpServers: 0,
      lspServers: 0,
    },
    errors: [],
  }
}

function pluginDetail(id: string) {
  return {
    ...pluginSummary(id),
    capabilities: {
      commands: [],
      agents: [],
      skills: [],
      hooks: [],
      mcpServers: [],
      lspServers: [],
    },
    commandEntries: [],
    agentEntries: [],
    hookEntries: [],
    skillEntries: [],
    mcpServerEntries: [],
  }
}
