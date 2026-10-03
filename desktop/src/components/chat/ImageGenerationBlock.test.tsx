import '@testing-library/jest-dom'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { browserHost } from '../../lib/desktopHost/browserHost'
import { useSettingsStore } from '../../stores/settingsStore'
import { ToolCallBlock } from './ToolCallBlock'

const result = JSON.stringify({
  type: 'image_generation_result',
  providerId: 'grok-official',
  providerKind: 'grok_oauth',
  model: 'grok-imagine-image-quality',
  prompt: 'two foxes',
  durationMs: 1200,
  images: [
    { path: '/tmp/generated-one.jpg', mimeType: 'image/jpeg' },
    { path: '/tmp/generated-two.jpg', mimeType: 'image/jpeg' },
  ],
})

describe('ImageGenerationBlock · opening the original', () => {
  const openPath = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    openPath.mockClear()
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: { ...browserHost.capabilities, shell: true },
      shell: { ...browserHost.shell, openPath },
    }
  })
  afterEach(() => {
    Reflect.deleteProperty(window, 'desktopHost')
  })

  it('hands the generated file on show in the viewer to the system app, and the next one after moving on', async () => {
    render(<ToolCallBlock toolName="ImageGen" input={{ prompt: 'two foxes', count: 2 }} result={{ content: result, isError: false }} />)

    fireEvent.click(screen.getAllByRole('img')[0]!.closest('button')!)
    fireEvent.click(screen.getByRole('button', { name: 'Open in system app' }))
    await waitFor(() => expect(openPath).toHaveBeenLastCalledWith('/tmp/generated-one.jpg'))

    fireEvent.click(screen.getByRole('button', { name: 'Next image' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open in system app' }))
    await waitFor(() => expect(openPath).toHaveBeenLastCalledWith('/tmp/generated-two.jpg'))
  })
})
