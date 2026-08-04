export type AgentMessage =
  | { type: 'ready' }
  | { type: 'navigated'; url: string; title: string }
  | { type: 'error'; message: string }
  | { type: 'selection'; payload: unknown }   // M5 填充结构
  | { type: 'screenshot'; dataUrl: string; kind: 'full' | 'viewport' | 'element' } // M4
  | { type: 'picker-exited'; reason?: 'cancel-current' | 'host' | 'invalid-target' }

export type PickerCopy = {
  cancel: string
  send: string
  queueAndContinue: string
  add: string
  descriptionPlaceholder: string
}

export type HostMessage =
  | { type: 'enter-picker'; mode?: 'single' | 'batch'; label?: number; copy?: PickerCopy }
  | { type: 'exit-picker' }
  | { type: 'undo-selection'; itemId: string }
  | { type: 'clear-selection-draft' }
  | { type: 'commit-selection-draft' }
  | { type: 'capture'; kind: 'full' | 'viewport' | 'element' }

const MAX_COPY_LENGTH = 80

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPickerCopy(value: unknown): value is PickerCopy {
  if (!isRecord(value)) return false
  return ['cancel', 'send', 'queueAndContinue', 'add', 'descriptionPlaceholder']
    .every((key) => typeof value[key] === 'string' && value[key].length <= MAX_COPY_LENGTH)
}

export function serializeAgentMessage(msg: AgentMessage): string {
  return JSON.stringify({ v: 1, ...msg })
}

export function parseHostMessage(raw: string): HostMessage | null {
  try {
    const obj = JSON.parse(raw) as unknown
    if (!isRecord(obj) || obj.v !== 1 || typeof obj.type !== 'string') return null

    if (obj.type === 'enter-picker') {
      if (obj.mode !== undefined && obj.mode !== 'single' && obj.mode !== 'batch') return null
      if (obj.label !== undefined && (!Number.isInteger(obj.label) || Number(obj.label) < 1 || Number(obj.label) > 99)) return null
      if (obj.copy !== undefined && !isPickerCopy(obj.copy)) return null
      return {
        type: 'enter-picker',
        ...(obj.mode ? { mode: obj.mode } : {}),
        ...(typeof obj.label === 'number' ? { label: obj.label } : {}),
        ...(obj.copy ? { copy: obj.copy } : {}),
      }
    }
    if (obj.type === 'exit-picker' || obj.type === 'clear-selection-draft' || obj.type === 'commit-selection-draft') {
      return { type: obj.type }
    }
    if (obj.type === 'undo-selection') {
      return typeof obj.itemId === 'string' && obj.itemId.length > 0 && obj.itemId.length <= 128
        ? { type: 'undo-selection', itemId: obj.itemId }
        : null
    }
    if (obj.type === 'capture') {
      return obj.kind === 'full' || obj.kind === 'viewport' || obj.kind === 'element'
        ? { type: 'capture', kind: obj.kind }
        : null
    }
    return null
  } catch {
    return null
  }
}
