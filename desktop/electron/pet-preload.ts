import { contextBridge, ipcRenderer } from 'electron'
import {
  isElectronIpcChannelAllowedForPetWindow,
  validateElectronIpcPayload,
} from './ipc/capabilities'
import { ELECTRON_IPC_CHANNELS, type ElectronIpcChannel } from './ipc/channels'
import type { DesktopHost } from '../src/lib/desktopHost/types'

function invoke<T>(channel: ElectronIpcChannel, payload?: unknown): Promise<T> {
  if (!isElectronIpcChannelAllowedForPetWindow(channel)) {
    return Promise.reject(new Error(`Electron IPC channel ${channel} is not available to the pet window`))
  }
  if (!validateElectronIpcPayload(channel, payload)) {
    return Promise.reject(new Error(`Invalid Electron IPC payload for ${channel}`))
  }
  return ipcRenderer.invoke(channel, payload) as Promise<T>
}

const petHost = {
  kind: 'electron',
  isDesktop: true,
  capabilities: {
    appMode: false,
    clipboard: false,
    dialogs: false,
    notifications: false,
    previewWebview: false,
    shell: false,
    terminal: false,
    updates: false,
    windowControls: false,
    zoom: false,
  },
  runtime: {
    getServerUrl: () => invoke<string>(ELECTRON_IPC_CHANNELS.runtimeGetServerUrl),
    // Keep the shared renderer bootstrap contract while returning only the
    // server-enforced companion capability, never the desktop master token.
    getLocalAccessToken: () => invoke<string | null>(ELECTRON_IPC_CHANNELS.runtimeGetPetAccessToken),
  },
  pets: {
    list: () => invoke(ELECTRON_IPC_CHANNELS.petsList),
    hide: () => invoke<void>(ELECTRON_IPC_CHANNELS.petsHide),
    showContextMenu: (closeLabel: string) =>
      invoke<boolean>(ELECTRON_IPC_CHANNELS.petsShowContextMenu, { closeLabel }),
    dragWindow: (payload: { phase: 'start' | 'move' | 'end', x: number, y: number }) =>
      invoke<void>(ELECTRON_IPC_CHANNELS.petsDragWindow, payload),
    setIgnoreMouseEvents: (ignore: boolean) =>
      invoke<void>(ELECTRON_IPC_CHANNELS.petsSetIgnoreMouseEvents, ignore),
    setInteractiveRegions: (regions: Array<{ x: number, y: number, width: number, height: number }>) =>
      invoke<void>(ELECTRON_IPC_CHANNELS.petsSetInteractiveRegions, regions),
    focusMainWindow: () => invoke<void>(ELECTRON_IPC_CHANNELS.petsFocusMainWindow),
    focusSession: (sessionId: string) =>
      invoke<void>(ELECTRON_IPC_CHANNELS.petsFocusSession, sessionId),
  },
} as unknown as DesktopHost

contextBridge.exposeInMainWorld('desktopHost', petHost)
