import { create } from 'zustand'
import { pluginsApi } from '../api/plugins'
import type {
  PluginDetail,
  PluginListResponse,
  PluginReloadSummary,
  PluginSessionReloadSummary,
  PluginScope,
  PluginSummary,
} from '../types/plugin'

type PluginStore = {
  plugins: PluginSummary[]
  marketplaces: PluginListResponse['marketplaces']
  summary: PluginListResponse['summary'] | null
  selectedPlugin: PluginDetail | null
  selectedPluginContext: string | null
  lastReloadSummary: PluginReloadSummary | null
  lastSessionReload: PluginSessionReloadSummary | null
  refreshWarning: string | null
  isLoading: boolean
  isDetailLoading: boolean
  isApplying: boolean
  error: string | null
  fetchPlugins: (cwd?: string) => Promise<void>
  fetchPluginDetail: (id: string, cwd?: string) => Promise<void>
  reloadPlugins: (cwd?: string, sessionId?: string) => Promise<PluginReloadSummary>
  enablePlugin: (id: string, scope?: PluginScope, cwd?: string, sessionId?: string) => Promise<string>
  disablePlugin: (id: string, scope?: PluginScope, cwd?: string, sessionId?: string) => Promise<string>
  bulkEnablePlugins: (plugins: PluginActionTarget[], cwd?: string, sessionId?: string) => Promise<number>
  bulkDisablePlugins: (plugins: PluginActionTarget[], cwd?: string, sessionId?: string) => Promise<number>
  updatePlugin: (id: string, scope?: PluginScope, cwd?: string, sessionId?: string) => Promise<string>
  uninstallPlugin: (id: string, scope?: PluginScope, keepData?: boolean, cwd?: string, sessionId?: string) => Promise<string>
  clearSelection: () => void
}

export type PluginActionTarget = {
  id: string
  scope?: PluginScope
}

export const usePluginStore = create<PluginStore>((set, get) => ({
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

  fetchPlugins: async (cwd) => {
    const requestVersion = ++listRequestVersion
    set({ isLoading: true, error: null })
    try {
      const data = await pluginsApi.list(cwd)
      if (requestVersion !== listRequestVersion) return
      set({
        plugins: data.plugins,
        marketplaces: data.marketplaces,
        summary: data.summary,
        isLoading: false,
      })
    } catch (err) {
      if (requestVersion !== listRequestVersion) return
      set({
        isLoading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },

  fetchPluginDetail: async (id, cwd) => {
    const requestVersion = ++detailRequestVersion
    const context = cwd ?? ''
    set({
      selectedPlugin: null,
      selectedPluginContext: context,
      isDetailLoading: true,
      error: null,
    })
    try {
      const { detail } = await pluginsApi.detail(id, cwd)
      if (requestVersion !== detailRequestVersion) return
      set({
        selectedPlugin: detail,
        selectedPluginContext: context,
        isDetailLoading: false,
      })
    } catch (err) {
      if (requestVersion !== detailRequestVersion) return
      set({
        selectedPlugin: null,
        selectedPluginContext: null,
        isDetailLoading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },

  reloadPlugins: async (cwd, sessionId) => {
    return enqueuePluginMutation(async () => {
      try {
        const { summary, session } = await pluginsApi.reload(cwd, sessionId)
        await get().fetchPlugins(cwd)
        const selected = get().selectedPlugin
        if (selected) {
          await get().fetchPluginDetail(selected.id, cwd)
        }
        set({
          lastReloadSummary: summary,
          lastSessionReload: session ?? null,
        })
        return summary
      } catch (err) {
        throw err
      }
    }, set)
  },

  enablePlugin: async (id, scope, cwd, sessionId) => {
    return enqueuePluginMutation(
      () => runAction(
        () => pluginsApi.enable({ id, scope, cwd: mutationCwd(scope, cwd) }),
        set,
        get,
        cwd,
        sessionId,
      ),
      set,
    )
  },

  disablePlugin: async (id, scope, cwd, sessionId) => {
    return enqueuePluginMutation(
      () => runAction(
        () => pluginsApi.disable({ id, scope, cwd: mutationCwd(scope, cwd) }),
        set,
        get,
        cwd,
        sessionId,
      ),
      set,
    )
  },

  bulkEnablePlugins: async (plugins, cwd, sessionId) => {
    return enqueuePluginMutation(
      () => runBulkAction(
        plugins,
        (plugin) => pluginsApi.enable({
          ...plugin,
          cwd: mutationCwd(plugin.scope, cwd),
        }),
        set,
        get,
        cwd,
        sessionId,
      ),
      set,
    )
  },

  bulkDisablePlugins: async (plugins, cwd, sessionId) => {
    return enqueuePluginMutation(
      () => runBulkAction(
        plugins,
        (plugin) => pluginsApi.disable({
          ...plugin,
          cwd: mutationCwd(plugin.scope, cwd),
        }),
        set,
        get,
        cwd,
        sessionId,
      ),
      set,
    )
  },

  updatePlugin: async (id, scope, cwd, sessionId) => {
    return enqueuePluginMutation(
      () => runAction(
        () => pluginsApi.update({ id, scope, cwd: mutationCwd(scope, cwd) }),
        set,
        get,
        cwd,
        sessionId,
      ),
      set,
    )
  },

  uninstallPlugin: async (id, scope, keepData = false, cwd, sessionId) => {
    return enqueuePluginMutation(
      () => runAction(
        () => pluginsApi.uninstall({
          id,
          scope,
          keepData,
          cwd: mutationCwd(scope, cwd),
        }),
        set,
        get,
        cwd,
        sessionId,
        true,
      ),
      set,
    )
  },

  clearSelection: () => {
    detailRequestVersion += 1
    set({
      selectedPlugin: null,
      selectedPluginContext: null,
      isDetailLoading: false,
    })
  },
}))

let listRequestVersion = 0
let detailRequestVersion = 0
let mutationQueue: Promise<void> = Promise.resolve()
let pendingMutations = 0

function mutationCwd(scope: PluginScope | undefined, cwd: string | undefined) {
  return scope === 'project' || scope === 'local' ? cwd : undefined
}

async function enqueuePluginMutation<T>(
  mutation: () => Promise<T>,
  set: (updater: Partial<PluginStore>) => void,
): Promise<T> {
  pendingMutations += 1
  set({
    isApplying: true,
    lastSessionReload: null,
    refreshWarning: null,
  })

  const result = mutationQueue.then(mutation, mutation)
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  )

  try {
    return await result
  } finally {
    pendingMutations -= 1
    if (pendingMutations === 0) set({ isApplying: false })
  }
}

async function runAction(
  action: () => Promise<{ ok: true; message: string }>,
  set: (updater: Partial<PluginStore>) => void,
  get: () => PluginStore,
  cwd?: string,
  sessionId?: string,
  clearSelection = false,
): Promise<string> {
  const { message } = await action()

  const selected = get().selectedPlugin
  if (clearSelection) {
    detailRequestVersion += 1
    set({
      selectedPlugin: null,
      selectedPluginContext: null,
      isDetailLoading: false,
    })
  }

  try {
    const { summary, session } = await pluginsApi.reload(cwd, sessionId)
    await get().fetchPlugins(cwd)
    if (!clearSelection && selected) {
      await get().fetchPluginDetail(selected.id, cwd)
    }
    set({
      lastReloadSummary: summary,
      lastSessionReload: session ?? null,
    })
  } catch (err) {
    set({
      refreshWarning: err instanceof Error ? err.message : String(err),
    })
  }
  return message
}

async function runBulkAction(
  plugins: PluginActionTarget[],
  action: (plugin: PluginActionTarget) => Promise<{ ok: true; message: string }>,
  set: (updater: Partial<PluginStore>) => void,
  get: () => PluginStore,
  cwd?: string,
  sessionId?: string,
): Promise<number> {
  if (plugins.length === 0) return 0

  let appliedCount = 0
  try {
    for (const plugin of plugins) {
      await action(plugin)
      appliedCount += 1
    }
  } catch (err) {
    if (appliedCount > 0) {
      try {
        const { summary, session } = await pluginsApi.reload(cwd, sessionId)
        await get().fetchPlugins(cwd)
        set({
          lastReloadSummary: summary,
          lastSessionReload: session ?? null,
        })
      } catch {
        // Preserve the original mutation failure while best-effort reconciliation runs.
      }
    }
    throw err
  }

  try {
    const { summary, session } = await pluginsApi.reload(cwd, sessionId)
    await get().fetchPlugins(cwd)
    const selected = get().selectedPlugin
    if (selected) {
      await get().fetchPluginDetail(selected.id, cwd)
    }
    set({
      lastReloadSummary: summary,
      lastSessionReload: session ?? null,
    })
  } catch (err) {
    set({
      refreshWarning: err instanceof Error ? err.message : String(err),
    })
  }
  return plugins.length
}
