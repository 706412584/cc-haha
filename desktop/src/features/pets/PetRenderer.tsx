import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import {
  PET_ATLAS_V2,
  getPetAnimationPlaybackStep,
  getPetAnimationPlaybackTickAtElapsedMs,
  getPetLookFrame,
  type PetAnimationState,
  type PetAtlasFrame,
  type PetLookDirection,
} from './petAnimation'
import type { PetDescriptor } from './types'

type PetRendererProps = {
  pet: PetDescriptor
  state: PetAnimationState
  size: number
  motionEnabled: boolean
  lookDirection?: PetLookDirection | null
  className?: string
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function getPrefersReducedMotion() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false

  try {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches
  } catch {
    return false
  }
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(getPrefersReducedMotion)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return

    let mediaQuery: MediaQueryList
    try {
      mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY)
    } catch {
      return
    }

    const handleChange = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches)
    }

    setPrefersReducedMotion(mediaQuery.matches)
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange)
    } else {
      mediaQuery.addListener(handleChange)
    }

    return () => {
      if (typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', handleChange)
      } else {
        mediaQuery.removeListener(handleChange)
      }
    }
  }, [])

  return prefersReducedMotion
}

type AtlasVisual = Readonly<{
  atlasUrl: string
  frame: PetAtlasFrame
  offsetX: number
  offsetY: number
}>

const DADA_FRAME_CENTER_OFFSETS_X = {
  1: [8.5, 6.5, 7, 14, 13.5, 7, 3, -1.5],
  2: [-3.5, 3, 2.5, 3, 5, -2, -4.5, -7.5],
} as const

const DADA_FRAME_BASELINE_OFFSETS_Y = {
  1: [2, 3, 3, 0, 3, 0, 0, 0],
  2: [-6, 1, -1, 0, 0, 0, 0, 0],
} as const

function getDadaFrameOffset(
  frame: PetAtlasFrame,
  size: number,
  height: number,
): Pick<AtlasVisual, 'offsetX' | 'offsetY'> {
  const rowOffsets = DADA_FRAME_CENTER_OFFSETS_X[
    frame.rowIndex as keyof typeof DADA_FRAME_CENTER_OFFSETS_X
  ]
  const baselineOffsets = DADA_FRAME_BASELINE_OFFSETS_Y[
    frame.rowIndex as keyof typeof DADA_FRAME_BASELINE_OFFSETS_Y
  ]
  return {
    offsetX: (rowOffsets?.[frame.columnIndex] ?? 0) * size / PET_ATLAS_V2.cellWidth,
    offsetY: (baselineOffsets?.[frame.columnIndex] ?? 0) * height / PET_ATLAS_V2.cellHeight,
  }
}

function getPetFrameOffset(
  petId: string,
  frame: PetAtlasFrame,
  size: number,
  height: number,
): Pick<AtlasVisual, 'offsetX' | 'offsetY'> {
  return petId === 'dada-code'
    ? getDadaFrameOffset(frame, size, height)
    : { offsetX: 0, offsetY: 0 }
}

function getAtlasBackgroundStyle({
  atlasUrl,
  frame,
  offsetX,
  offsetY,
  size,
  height,
  pixelated,
}: AtlasVisual & {
  size: number
  height: number
  pixelated: boolean
}): CSSProperties {
  return {
    backgroundImage: `url(${JSON.stringify(atlasUrl)})`,
    backgroundRepeat: 'no-repeat',
    backgroundSize: `${size * PET_ATLAS_V2.columns}px ${height * PET_ATLAS_V2.rows}px`,
    backgroundPosition: getAtlasBackgroundPosition(frame, offsetX, offsetY, size, height),
    imageRendering: pixelated ? 'pixelated' : 'auto',
  }
}

function getAtlasBackgroundPosition(
  frame: PetAtlasFrame,
  offsetX: number,
  offsetY: number,
  size: number,
  height: number,
) {
  return `${-frame.columnIndex * size + offsetX}px ${-frame.rowIndex * height + offsetY}px`
}

type PetPlaybackVisual = Readonly<{
  frame: PetAtlasFrame
  motionState: PetAnimationState
  phase: 'action' | 'idle' | 'gaze'
}>

function getInitialPetPlaybackVisual(
  requestedState: PetAnimationState,
  motionEnabled: boolean,
  lookDirection: PetLookDirection | null | undefined,
): PetPlaybackVisual {
  if (motionEnabled && requestedState === 'idle' && lookDirection !== undefined) {
    return {
      frame: getPetLookFrame(lookDirection),
      motionState: 'idle',
      phase: 'gaze',
    }
  }

  const step = getPetAnimationPlaybackStep(requestedState, 0)
  return {
    frame: step.frame,
    motionState: step.motionState,
    phase: step.phase,
  }
}

function usePetPlayback({
  requestedState,
  motionEnabled,
  lookDirection,
  usesAtlas,
  petId,
  size,
  height,
  spriteRef,
  stageRef,
}: {
  requestedState: PetAnimationState
  motionEnabled: boolean
  lookDirection: PetLookDirection | null | undefined
  usesAtlas: boolean
  petId: string
  size: number
  height: number
  spriteRef: React.RefObject<HTMLDivElement>
  stageRef: React.RefObject<HTMLDivElement>
}) {
  useLayoutEffect(() => {
    const sprite = spriteRef.current
    const stage = stageRef.current
    if (!sprite || !stage) return

    const applyVisual = ({ frame, motionState, phase }: PetPlaybackVisual) => {
      sprite.dataset.petMotionState = motionState
      sprite.dataset.petMotionPhase = phase
      stage.dataset.petMotionState = motionState
      if (!usesAtlas) return

      const { offsetX, offsetY } = getPetFrameOffset(petId, frame, size, height)
      sprite.dataset.petRow = String(frame.rowIndex)
      sprite.dataset.petColumn = String(frame.columnIndex)
      sprite.style.backgroundPosition = getAtlasBackgroundPosition(
        frame,
        offsetX,
        offsetY,
        size,
        height,
      )
    }

    const initialVisual = getInitialPetPlaybackVisual(requestedState, motionEnabled, lookDirection)
    applyVisual(initialVisual)
    if (!motionEnabled || (requestedState === 'idle' && lookDirection !== undefined)) return

    const startedAt = performance.now()
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const updateFrame = () => {
      if (cancelled) return
      const tick = getPetAnimationPlaybackTickAtElapsedMs(
        requestedState,
        Math.max(0, performance.now() - startedAt),
      )
      applyVisual({
        frame: tick.frame,
        motionState: tick.motionState,
        phase: tick.phase,
      })
      timer = setTimeout(updateFrame, Math.max(1, Math.ceil(tick.remainingDurationMs)))
    }

    updateFrame()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [height, lookDirection, motionEnabled, petId, requestedState, size, spriteRef, stageRef, usesAtlas])
}

export function PetRenderer({
  pet,
  state,
  size,
  motionEnabled,
  lookDirection,
  className = '',
}: PetRendererProps) {
  const prefersReducedMotion = usePrefersReducedMotion()
  const effectiveMotionEnabled = motionEnabled && !prefersReducedMotion
  const atlasUrl = pet.source === 'custom' ? pet.dataUrl : pet.spritesheetUrl
  const usesAtlas = Number(pet.spriteVersionNumber) >= PET_ATLAS_V2.spriteVersionNumber
  const height = size * PET_ATLAS_V2.cellHeight / PET_ATLAS_V2.cellWidth
  const spriteRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const playback = getInitialPetPlaybackVisual(
    state,
    effectiveMotionEnabled,
    lookDirection,
  )
  usePetPlayback({
    requestedState: state,
    motionEnabled: effectiveMotionEnabled,
    lookDirection,
    usesAtlas,
    petId: pet.id,
    size,
    height,
    spriteRef,
    stageRef,
  })
  const pixelated = pet.source === 'custom' && usesAtlas
  const frameOffset = getPetFrameOffset(pet.id, playback.frame, size, height)
  const currentVisual = {
    atlasUrl,
    frame: playback.frame,
    ...frameOffset,
  }
  const style: CSSProperties = usesAtlas ? {
    width: size,
    height,
    ...getAtlasBackgroundStyle({ ...currentVisual, size, height, pixelated }),
  } : {
    width: size,
    height,
    backgroundImage: `url(${JSON.stringify(atlasUrl)})`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'center',
    backgroundSize: 'contain',
    imageRendering: 'auto',
  }

  return (
    <div
      ref={stageRef}
      className={`pet-sprite-stage shrink-0 ${usesAtlas ? 'pet-sprite-stage--atlas' : 'pet-sprite-stage--single'} ${className}`}
      data-pet-motion={effectiveMotionEnabled ? 'enabled' : 'disabled'}
      data-pet-motion-state={playback.motionState}
      style={{ width: size, height }}
    >
      <div
        ref={spriteRef}
        role="img"
        aria-label={pet.displayName}
        className="pet-sprite"
        data-pet-source={pet.source}
        data-pet-state={state}
        data-pet-rendered-state={state}
        data-pet-motion-state={playback.motionState}
        data-pet-motion-phase={playback.phase}
        data-pet-motion={effectiveMotionEnabled ? 'enabled' : 'disabled'}
        data-pet-sprite-version={pet.spriteVersionNumber}
        data-pet-row={usesAtlas ? playback.frame.rowIndex : undefined}
        data-pet-column={usesAtlas ? playback.frame.columnIndex : undefined}
        style={style}
      />
    </div>
  )
}
