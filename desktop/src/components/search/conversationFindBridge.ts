export type ConversationFindController = {
  search: (query: string, preferredIndex?: number) => number
  navigate: (index: number) => void
  clear: () => void
}

let activeController: ConversationFindController | null = null
let revision = 0
const listeners = new Set<() => void>()

function notifyControllerChanged() {
  revision += 1
  for (const listener of listeners) listener()
}

export function registerConversationFindController(controller: ConversationFindController) {
  activeController = controller
  notifyControllerChanged()
  return () => {
    if (activeController !== controller) return
    activeController = null
    notifyControllerChanged()
  }
}

export function getConversationFindController() {
  return activeController
}

export function getConversationFindRevision() {
  return revision
}

export function notifyConversationFindContentChanged(controller: ConversationFindController) {
  if (activeController === controller) notifyControllerChanged()
}

export function subscribeConversationFindController(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
