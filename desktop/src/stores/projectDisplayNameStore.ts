import { useSyncExternalStore } from 'react'
import { desktopUiPreferencesApi } from '../api/desktopUiPreferences'

export type ProjectDisplayNames = Record<string, string>

type DisplayName = string | null

type PendingMutation = {
  displayName: DisplayName
}

type Listener = () => void

const resolvedDisplayNames = new Map<string, string>()
const confirmedDisplayNames = new Map<string, string>()
const confirmedMutationRevisions = new Map<string, number>()
const pendingMutations = new Map<string, PendingMutation[]>()
const writeQueues = new Map<string, Promise<void>>()
const listeners = new Set<Listener>()

let hydrationBarrierRevision = 0
let snapshotRevision = 0

export function resolveProjectDisplayName(projectKey: string): string | null {
  return resolvedDisplayNames.get(projectKey) ?? null
}

export function subscribeProjectDisplayNameChanges(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useProjectDisplayName(projectKey: string): string | null {
  return useSyncExternalStore(
    subscribeProjectDisplayNameChanges,
    () => resolveProjectDisplayName(projectKey),
    () => resolveProjectDisplayName(projectKey),
  )
}

export function useProjectDisplayNameRevision(): number {
  return useSyncExternalStore(
    subscribeProjectDisplayNameChanges,
    () => snapshotRevision,
    () => snapshotRevision,
  )
}

export function captureProjectDisplayNameHydrationRevision(): number {
  return ++hydrationBarrierRevision
}

export function hydrateProjectDisplayNames(
  projectDisplayNames: Readonly<ProjectDisplayNames>,
  hydrationRevision: number,
): void {
  const hydratedDisplayNames = new Map(Object.entries(projectDisplayNames))
  const projectKeys = new Set<string>([
    ...resolvedDisplayNames.keys(),
    ...confirmedDisplayNames.keys(),
    ...confirmedMutationRevisions.keys(),
    ...pendingMutations.keys(),
    ...hydratedDisplayNames.keys(),
  ])

  let changed = false
  for (const projectKey of projectKeys) {
    const confirmedMutationRevision = confirmedMutationRevisions.get(projectKey)
    if (confirmedMutationRevision === undefined || confirmedMutationRevision < hydrationRevision) {
      setDisplayName(confirmedDisplayNames, projectKey, hydratedDisplayNames.get(projectKey) ?? null)
      confirmedMutationRevisions.delete(projectKey)
    }
    changed = syncResolvedDisplayName(projectKey) || changed
  }

  if (changed) notifyListeners()
}

export function setProjectDisplayName(projectKey: string, displayName: string): Promise<void> {
  return persistProjectDisplayName(projectKey, displayName)
}

export function resetProjectDisplayName(projectKey: string): Promise<void> {
  return persistProjectDisplayName(projectKey, null)
}

function persistProjectDisplayName(projectKey: string, displayName: DisplayName): Promise<void> {
  const mutation: PendingMutation = { displayName }
  const mutations = pendingMutations.get(projectKey) ?? []
  mutations.push(mutation)
  pendingMutations.set(projectKey, mutations)

  if (syncResolvedDisplayName(projectKey)) notifyListeners()

  const runMutation = async () => {
    try {
      const response = await desktopUiPreferencesApi.updateProjectDisplayName(projectKey, displayName)
      settleMutation(projectKey, mutation, response.displayName)
    } catch (error) {
      settleMutation(projectKey, mutation)
      throw error
    }
  }

  const previousWrite = writeQueues.get(projectKey)
  const request = previousWrite ? previousWrite.then(runMutation) : runMutation()
  const queuedWrite = request.catch(() => undefined)
  writeQueues.set(projectKey, queuedWrite)
  void queuedWrite.then(() => {
    if (writeQueues.get(projectKey) === queuedWrite) {
      writeQueues.delete(projectKey)
    }
  })

  return request
}

function settleMutation(
  projectKey: string,
  mutation: PendingMutation,
  confirmedDisplayName?: DisplayName,
): void {
  const mutations = pendingMutations.get(projectKey)
  const mutationIndex = mutations?.indexOf(mutation) ?? -1
  if (mutationIndex === -1 || !mutations) return

  mutations.splice(mutationIndex, 1)
  if (mutations.length === 0) {
    pendingMutations.delete(projectKey)
  }

  if (confirmedDisplayName !== undefined) {
    setDisplayName(confirmedDisplayNames, projectKey, confirmedDisplayName)
    confirmedMutationRevisions.set(projectKey, ++hydrationBarrierRevision)
  }

  if (syncResolvedDisplayName(projectKey)) notifyListeners()
}

function syncResolvedDisplayName(projectKey: string): boolean {
  const mutations = pendingMutations.get(projectKey)
  const latestMutation = mutations?.[mutations.length - 1]
  const displayName = latestMutation
    ? latestMutation.displayName
    : confirmedDisplayNames.get(projectKey) ?? null
  const currentDisplayName = resolvedDisplayNames.get(projectKey) ?? null
  if (currentDisplayName === displayName) return false

  setDisplayName(resolvedDisplayNames, projectKey, displayName)
  return true
}

function setDisplayName(target: Map<string, string>, projectKey: string, displayName: DisplayName): void {
  if (displayName === null) {
    target.delete(projectKey)
  } else {
    target.set(projectKey, displayName)
  }
}

function notifyListeners(): void {
  snapshotRevision += 1
  for (const listener of listeners) listener()
}
