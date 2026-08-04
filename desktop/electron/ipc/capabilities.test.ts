import { describe, expect, it } from 'vitest'
import { ELECTRON_IPC_CHANNELS } from './channels'
import {
  ELECTRON_IPC_VALIDATORS,
  isElectronIpcChannel,
  isElectronIpcChannelAllowedForPetWindow,
  validateElectronIpcPayload,
} from './capabilities'

describe('Electron IPC capabilities', () => {
  it('has a validator for every exposed invoke channel', () => {
    expect(Object.keys(ELECTRON_IPC_VALIDATORS).sort()).toEqual(
      Object.values(ELECTRON_IPC_CHANNELS).sort(),
    )
  })

  it('rejects channels outside the desktop host contract', () => {
    expect(isElectronIpcChannel(ELECTRON_IPC_CHANNELS.appGetVersion)).toBe(true)
    expect(isElectronIpcChannel(ELECTRON_IPC_CHANNELS.appGetLocalePreference)).toBe(true)
    expect(isElectronIpcChannel(ELECTRON_IPC_CHANNELS.appSetLocalePreference)).toBe(true)
    expect(isElectronIpcChannel(ELECTRON_IPC_CHANNELS.appGetPreferredSystemLanguages)).toBe(true)
    expect(isElectronIpcChannel('ipcRenderer:send-anything')).toBe(false)
  })

  it('validates structured payloads before they reach ipcRenderer.invoke', () => {
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.shellOpen, 'https://example.com')).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.shellOpen, { url: 'https://example.com' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.clipboardReadText, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.clipboardWriteText, 'paste me')).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.clipboardWriteText, { text: 'paste me' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.traceOpenWindow, '4673a448-9e2c-475e-898d-9aa0ee2d1ab7')).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.traceOpenWindow, '../escape')).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.windowClose, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.windowClose, {})).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.windowStartDragging, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.windowStartDragging, { deltaX: 4, deltaY: -2 })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, { sessionId: 1, data: 'pwd\n' })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, { sessionId: '1', data: 'pwd\n' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: 80, rows: 24, cwd: '/tmp' })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: '80', rows: 24 })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: 80, rows: 24, shell: '/bin/sh' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: Number.NaN, rows: 24 })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: 80.5, rows: 24 })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: 1_001, rows: 24 })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: 80, rows: Number.POSITIVE_INFINITY })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: 80, rows: 24, cwd: 'x'.repeat(4_097) })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, { sessionId: 0, data: 'pwd\n' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, { sessionId: 1.5, data: 'pwd\n' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, {
      sessionId: Number.MAX_SAFE_INTEGER + 1,
      data: 'pwd\n',
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, {
      sessionId: 1,
      data: 'x'.repeat(1_048_577),
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, {
      sessionId: 1,
      data: 'pwd\n',
      extra: true,
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalResize, {
      sessionId: 1,
      cols: 80,
      rows: 24,
    })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalResize, {
      sessionId: 1,
      cols: Number.NaN,
      rows: 24,
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalKill, { sessionId: -1 })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalKill, {
      sessionId: 1,
      extra: true,
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.updateCheck, { proxy: 'http://127.0.0.1:7890' })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.updateCheck, { proxy: '' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.updateCheck, { proxy: 'http://127.0.0.1:7890', extra: true })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.appSetLocalePreference, 'zh-TW')).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.appSetLocalePreference, 'fr')).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsList, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsList, {})).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsCreateFromImage, {
      slug: 'moon-cat',
      displayName: 'Moon Cat',
      description: 'A quiet companion.',
      dialogTitle: '选择透明背景的宠物图片',
      dialogFilterName: '宠物图片',
    })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsCreateFromImage, {
      slug: 'moon-cat',
      displayName: 'Moon Cat',
      description: 'A quiet companion.',
      dialogTitle: 'Bad\nTitle',
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsCreateFromAtlas, {
      slug: 'moon-cat',
      displayName: 'Moon Cat',
      description: 'A quiet companion.',
    })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsCreateFromAtlas, {
      slug: '../escape',
      displayName: 'Moon Cat',
      description: 'A quiet companion.',
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsCreateFromAtlas, {
      slug: 'moon-cat',
      displayName: 'Moon Cat',
      description: 'A quiet companion.',
      atlasPath: '/tmp/private.png',
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsOpenFolder, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsShow, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsHide, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsShowContextMenu, {
      closeLabel: '关闭宠物',
    })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsShowContextMenu, {
      closeLabel: '   ',
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsShowContextMenu, {
      closeLabel: 'x'.repeat(81),
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsShowContextMenu, {
      closeLabel: 'Close\nPet',
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsShowContextMenu, {
      closeLabel: 'Close pet',
      extra: true,
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsDragWindow, {
      phase: 'move',
      x: -1_240.5,
      y: 480,
    })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsDragWindow, {
      phase: 'move',
      x: Number.NaN,
      y: 480,
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsDragWindow, {
      phase: 'teleport',
      x: 120,
      y: 480,
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsDragWindow, {
      phase: 'end',
      x: 120,
      y: 480,
      windowId: 2,
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsSetInteractiveRegions, [
      { x: 100, y: 220, width: 144, height: 160 },
    ])).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsSetInteractiveRegions, [
      { x: -1, y: 0, width: 20, height: 20 },
    ])).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsFocusMainWindow, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsFocusMainWindow, {})).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsFocusSession, 'session-123')).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.petsFocusSession, '../escape')).toBe(false)
  })

  it('pins the reported appearance colors to literal 6-digit hex', () => {
    // Both values reach BrowserWindow.setBackgroundColor, which also accepts
    // #AARRGGBB — an 8-digit value would let a compromised renderer make the
    // window translucent (click-through, overlay spoofing). So the boundary
    // takes exactly #RRGGBB and nothing else.
    const valid = {
      isDark: true,
      background: '#0E0E0E',
      lightBackground: '#FFFFFF',
      followSystem: false,
    }
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.appearanceSetApplied, valid)).toBe(true)

    for (const invalid of [
      undefined,
      'dark',
      { isDark: true, background: '#0E0E0E', lightBackground: '#FFFFFF' },
      { isDark: true, background: '#0E0E0E', followSystem: false },
      { isDark: 'true', background: '#0E0E0E', lightBackground: '#FFFFFF', followSystem: false },
      { ...valid, background: '#0E0' },
      { ...valid, background: 'black' },
      { ...valid, background: 'rgb(0 0 0)' },
      { ...valid, background: '#800E0E0E' },
      { ...valid, lightBackground: '#80FFFFFF' },
      { ...valid, lightBackground: 'white' },
      { ...valid, extra: 1 },
    ]) {
      expect(
        validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.appearanceSetApplied, invalid),
        JSON.stringify(invalid),
      ).toBe(false)
    }
  })

  it('keeps the appearance channel away from the pet window', () => {
    // The pet window is transparent and must not repaint the main window.
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.appearanceSetApplied,
    )).toBe(false)
  })

  it('gives the pet renderer only runtime bootstrap and companion controls', () => {
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.appGetLocalePreference,
    )).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.appSetLocalePreference,
    )).toBe(false)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.appGetPreferredSystemLanguages,
    )).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.runtimeGetServerUrl,
    )).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.runtimeGetPetAccessToken,
    )).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.runtimeGetLocalAccessToken,
    )).toBe(false)
    expect(isElectronIpcChannelAllowedForPetWindow(ELECTRON_IPC_CHANNELS.petsList)).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(ELECTRON_IPC_CHANNELS.petsHide)).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.petsShowContextMenu,
    )).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.petsDragWindow,
    )).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(ELECTRON_IPC_CHANNELS.petsFocusSession)).toBe(true)
    expect(isElectronIpcChannelAllowedForPetWindow(
      ELECTRON_IPC_CHANNELS.petsFocusMainWindow,
    )).toBe(true)

    for (const forbidden of [
      ELECTRON_IPC_CHANNELS.commandInvoke,
      ELECTRON_IPC_CHANNELS.runtimeGetLocalAccessToken,
      ELECTRON_IPC_CHANNELS.shellOpen,
      ELECTRON_IPC_CHANNELS.shellOpenPath,
      ELECTRON_IPC_CHANNELS.dialogOpen,
      ELECTRON_IPC_CHANNELS.petsCreateFromImage,
      ELECTRON_IPC_CHANNELS.petsCreateFromAtlas,
      ELECTRON_IPC_CHANNELS.updateRelaunch,
      ELECTRON_IPC_CHANNELS.terminalSpawn,
      ELECTRON_IPC_CHANNELS.previewOpen,
      ELECTRON_IPC_CHANNELS.appModeSet,
      ELECTRON_IPC_CHANNELS.adaptersRestartSidecar,
    ]) {
      expect(isElectronIpcChannelAllowedForPetWindow(forbidden)).toBe(false)
    }
  })
})
