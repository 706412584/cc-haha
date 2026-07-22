import { Profiler } from 'react'
import { act, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PetRenderer } from './PetRenderer'
import type { BuiltinPet, CustomPet } from './types'

const builtinPet: BuiltinPet = {
  source: 'builtin',
  id: 'dada-code',
  displayName: 'Dada',
  description: 'A builder',
  descriptionKey: 'settings.pets.builtin.dada',
  imageUrl: '/dada.png',
  spriteVersionNumber: 2,
  spritesheetUrl: '/dada-atlas.webp',
  accent: '#4fd1b6',
}

const customPet: CustomPet = {
  source: 'custom',
  id: 'custom:mochi',
  displayName: 'Mochi',
  description: 'A custom pet',
  spriteVersionNumber: 2,
  dataUrl: 'data:image/webp;base64,AAAA',
}

function createReducedMotionController(initialMatches = false) {
  let matches = initialMatches
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn((type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (type === 'change') listeners.add(listener)
    }),
    removeEventListener: vi.fn((type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (type === 'change') listeners.delete(listener)
    }),
    addListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => listeners.add(listener)),
    removeListener: vi.fn((listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener)),
    dispatchEvent: vi.fn(),
  }))

  return {
    matchMedia,
    emit(nextMatches: boolean) {
      matches = nextMatches
      const event = { matches: nextMatches, media: '(prefers-reduced-motion: reduce)' } as MediaQueryListEvent
      listeners.forEach((listener) => listener(event))
    },
    getListenerCount() {
      return listeners.size
    },
  }
}

const originalMatchMedia = window.matchMedia

function advanceTimersByDurations(durations: readonly number[]) {
  for (const duration of durations) {
    act(() => vi.advanceTimersByTime(duration))
  }
}

afterEach(() => {
  vi.useRealTimers()
  if (originalMatchMedia) {
    window.matchMedia = originalMatchMedia
  } else {
    Reflect.deleteProperty(window, 'matchMedia')
  }
})

describe('PetRenderer', () => {
  it('renders built-in companions from the same exact v2 atlas grid', () => {
    render(<PetRenderer pet={builtinPet} state="waiting" size={96} motionEnabled />)

    const pet = screen.getByRole('img', { name: 'Dada' })
    expect(pet).toHaveAttribute('data-pet-source', 'builtin')
    expect(pet).toHaveAttribute('data-pet-state', 'waiting')
    expect(pet).toHaveAttribute('data-pet-motion', 'enabled')
    expect(pet).toHaveAttribute('data-pet-row', '6')
    expect(pet).toHaveAttribute('data-pet-column', '0')
    expect(pet).toHaveStyle({
      width: '96px',
      height: '104px',
      backgroundImage: 'url(/dada-atlas.webp)',
      imageRendering: 'auto',
    })
  })

  it('keeps built-in and custom companions still when motion is disabled', () => {
    vi.useFakeTimers()
    render(
      <>
        <PetRenderer pet={builtinPet} state="running" size={112} motionEnabled={false} />
        <PetRenderer pet={customPet} state="waving" size={96} motionEnabled={false} />
      </>,
    )

    const pet = screen.getByRole('img', { name: 'Dada' })
    const custom = screen.getByRole('img', { name: 'Mochi' })
    expect(pet).toHaveAttribute('data-pet-motion', 'disabled')
    expect(pet).toHaveAttribute('data-pet-column', '0')
    expect(custom).toHaveAttribute('data-pet-motion', 'disabled')

    act(() => vi.advanceTimersByTime(1_000))
    expect(custom).toHaveAttribute('data-pet-column', '0')
  })

  it('renders an exact v2 atlas cell and advances according to frame timing', () => {
    vi.useFakeTimers()
    render(<PetRenderer pet={customPet} state="waving" size={96} motionEnabled />)

    const pet = screen.getByRole('img', { name: 'Mochi' })
    expect(pet).toHaveAttribute('data-pet-row', '3')
    expect(pet).toHaveAttribute('data-pet-column', '0')
    expect(pet).toHaveAttribute('data-pet-motion', 'enabled')
    expect(pet).toHaveStyle({
      width: '96px',
      height: '104px',
      backgroundSize: '768px 1144px',
      backgroundPosition: '0px -312px',
    })

    act(() => vi.advanceTimersByTime(140))
    expect(pet).toHaveAttribute('data-pet-column', '1')
    expect(document.querySelector('[data-pet-frame-transition="previous"]')).not.toBeInTheDocument()
  })

  it('updates atlas frames without committing a React render for every frame', () => {
    vi.useFakeTimers()
    const commits: string[] = []
    render(
      <Profiler id="pet" onRender={(_id, phase) => commits.push(phase)}>
        <PetRenderer pet={customPet} state="waving" size={96} motionEnabled />
      </Profiler>,
    )

    const pet = screen.getByRole('img', { name: 'Mochi' })
    expect(commits).toHaveLength(1)
    act(() => vi.advanceTimersByTime(140))

    expect(pet).toHaveAttribute('data-pet-column', '1')
    expect(commits).toHaveLength(1)
  })

  it('changes rows immediately when the requested state changes', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <PetRenderer pet={builtinPet} state="waiting" size={96} motionEnabled />,
    )

    const pet = screen.getByRole('img', { name: 'Dada' })
    rerender(<PetRenderer pet={builtinPet} state="running" size={96} motionEnabled />)

    expect(pet).toHaveAttribute('data-pet-rendered-state', 'running')
    expect(pet).toHaveAttribute('data-pet-row', '7')
    expect(pet).toHaveAttribute('data-pet-column', '0')
  })

  it('plays an active row three times, rests, then starts another work burst', () => {
    vi.useFakeTimers()
    render(<PetRenderer pet={builtinPet} state="running" size={96} motionEnabled />)

    const pet = screen.getByRole('img', { name: 'Dada' })
    advanceTimersByDurations(Array.from(
      { length: 3 },
      () => [120, 120, 120, 120, 120, 220],
    ).flat())
    expect(pet).toHaveAttribute('data-pet-rendered-state', 'running')
    expect(pet).toHaveAttribute('data-pet-motion-state', 'idle')
    expect(pet).toHaveAttribute('data-pet-row', '0')
    expect(pet).toHaveAttribute('data-pet-column', '0')

    advanceTimersByDurations([1680, 660, 660, 840, 840, 1920])
    expect(pet).toHaveAttribute('data-pet-motion-state', 'running')
    expect(pet).toHaveAttribute('data-pet-row', '7')
    expect(pet).toHaveAttribute('data-pet-column', '0')
  })

  it('adds a calm gesture after two slow idle loops', () => {
    vi.useFakeTimers()
    render(<PetRenderer pet={builtinPet} state="idle" size={96} motionEnabled />)

    const pet = screen.getByRole('img', { name: 'Dada' })
    advanceTimersByDurations([
      1680, 660, 660, 840, 840, 1920,
      1680, 660, 660, 840, 840, 1920,
    ])

    expect(pet).toHaveAttribute('data-pet-state', 'idle')
    expect(pet).toHaveAttribute('data-pet-motion-state', 'waving')
    expect(pet).toHaveAttribute('data-pet-motion-phase', 'action')
    expect(pet).toHaveAttribute('data-pet-row', '3')
    expect(pet).toHaveAttribute('data-pet-column', '0')
  })

  it('restarts a new action at its first frame when slow idle is interrupted', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <PetRenderer pet={builtinPet} state="running" size={96} motionEnabled />,
    )
    const pet = screen.getByRole('img', { name: 'Dada' })

    advanceTimersByDurations(Array.from(
      { length: 3 },
      () => [120, 120, 120, 120, 120, 220],
    ).flat())
    rerender(<PetRenderer pet={builtinPet} state="review" size={96} motionEnabled />)
    expect(pet).toHaveAttribute('data-pet-rendered-state', 'review')
    expect(pet).toHaveAttribute('data-pet-row', '8')
    expect(pet).toHaveAttribute('data-pet-column', '0')
  })

  it('stabilizes Dada directional run frames around a shared center and baseline', () => {
    vi.useFakeTimers()
    render(<PetRenderer pet={builtinPet} state="running-right" size={192} motionEnabled />)

    const pet = screen.getByRole('img', { name: 'Dada' })
    expect(pet).toHaveStyle({ backgroundPosition: '8.5px -206px' })

    advanceTimersByDurations([120, 120, 120])
    expect(pet).toHaveAttribute('data-pet-column', '3')
    expect(pet).toHaveStyle({ backgroundPosition: '-562px -208px' })
  })

  it('renders a version-one custom image whole while CSS supplies its motion', () => {
    vi.useFakeTimers()
    const singleImagePet = {
      ...customPet,
      spriteVersionNumber: 1,
      dataUrl: 'data:image/png;base64,BBBB',
    } as unknown as CustomPet

    render(<PetRenderer pet={singleImagePet} state="running" size={96} motionEnabled />)

    const pet = screen.getByRole('img', { name: 'Mochi' })
    expect(pet).toHaveAttribute('data-pet-sprite-version', '1')
    expect(pet).not.toHaveAttribute('data-pet-row')
    expect(pet).not.toHaveAttribute('data-pet-column')
    expect(pet).toHaveStyle({
      backgroundImage: 'url(data:image/png;base64,BBBB)',
      backgroundPosition: 'center',
      backgroundSize: 'contain',
    })
    expect(pet.parentElement).toHaveClass('pet-sprite-stage--single')
    expect(pet.parentElement?.querySelector('.pet-sprite-ground-shadow')).not.toBeInTheDocument()

    act(() => vi.advanceTimersByTime(2_460))
    expect(pet).toHaveAttribute('data-pet-motion-state', 'idle')
  })

  it('uses v2 look rows only when an explicit cursor direction is provided', () => {
    render(
      <PetRenderer
        pet={customPet}
        state="idle"
        size={96}
        motionEnabled
        lookDirection={90}
      />,
    )

    const pet = screen.getByRole('img', { name: 'Mochi' })
    expect(pet).toHaveAttribute('data-pet-row', '9')
    expect(pet).toHaveAttribute('data-pet-column', '4')
  })

  it('does not follow the cursor when pet motion is disabled', () => {
    render(
      <PetRenderer
        pet={builtinPet}
        state="idle"
        size={96}
        motionEnabled={false}
        lookDirection={90}
      />,
    )

    const pet = screen.getByRole('img', { name: 'Dada' })
    expect(pet).toHaveAttribute('data-pet-motion', 'disabled')
    expect(pet).toHaveAttribute('data-pet-row', '0')
    expect(pet).toHaveAttribute('data-pet-column', '0')
  })

  it('keeps built-in and custom companions still when the system requests reduced motion', () => {
    vi.useFakeTimers()
    const controller = createReducedMotionController(true)
    window.matchMedia = controller.matchMedia as typeof window.matchMedia

    render(
      <>
        <PetRenderer pet={builtinPet} state="running" size={96} motionEnabled />
        <PetRenderer pet={customPet} state="waving" size={96} motionEnabled />
      </>,
    )

    const builtin = screen.getByRole('img', { name: 'Dada' })
    const custom = screen.getByRole('img', { name: 'Mochi' })
    expect(builtin).toHaveAttribute('data-pet-motion', 'disabled')
    expect(builtin).toHaveAttribute('data-pet-column', '0')
    expect(custom).toHaveAttribute('data-pet-motion', 'disabled')

    act(() => vi.advanceTimersByTime(1_000))
    expect(custom).toHaveAttribute('data-pet-column', '0')
  })

  it('responds to reduced-motion changes and removes its media-query listeners', () => {
    vi.useFakeTimers()
    const controller = createReducedMotionController(false)
    window.matchMedia = controller.matchMedia as typeof window.matchMedia

    const { unmount } = render(
      <>
        <PetRenderer pet={builtinPet} state="running" size={96} motionEnabled />
        <PetRenderer pet={customPet} state="waving" size={96} motionEnabled />
      </>,
    )

    const builtin = screen.getByRole('img', { name: 'Dada' })
    const custom = screen.getByRole('img', { name: 'Mochi' })
    expect(controller.getListenerCount()).toBe(2)

    act(() => vi.advanceTimersByTime(140))
    expect(custom).toHaveAttribute('data-pet-column', '1')

    act(() => controller.emit(true))
    expect(builtin).toHaveAttribute('data-pet-column', '0')
    expect(custom).toHaveAttribute('data-pet-column', '0')

    act(() => vi.advanceTimersByTime(1_000))
    expect(custom).toHaveAttribute('data-pet-column', '0')

    act(() => controller.emit(false))
    act(() => vi.advanceTimersByTime(120))
    expect(builtin).toHaveAttribute('data-pet-column', '1')
    act(() => vi.advanceTimersByTime(20))
    expect(custom).toHaveAttribute('data-pet-column', '1')

    unmount()
    expect(controller.getListenerCount()).toBe(0)
  })

  it('remains motion-capable when matchMedia is unavailable', () => {
    Reflect.deleteProperty(window, 'matchMedia')

    render(<PetRenderer pet={builtinPet} state="waiting" size={96} motionEnabled />)

    expect(screen.getByRole('img', { name: 'Dada' })).toHaveAttribute('data-pet-motion', 'enabled')
  })
})
