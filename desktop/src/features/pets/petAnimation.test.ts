import { describe, expect, it } from 'vitest'
import {
  PET_ANIMATION_DEFINITIONS,
  PET_ANIMATION_STATES,
  PET_ACTIVE_BURST_LOOPS,
  PET_ATLAS_V2,
  PET_IDLE_DURATION_MULTIPLIER,
  PET_LOOK_DIRECTIONS,
  PET_NEUTRAL_LOOK_FRAME,
  getPetAnimationDurationMs,
  getPetAnimationFrameAtElapsedMs,
  getPetAnimationFrames,
  getPetAnimationPlaybackFrames,
  getPetAnimationPlaybackLoopStartIndex,
  getPetAnimationPlaybackStep,
  getPetAnimationPlaybackTickAtElapsedMs,
  getPetLookFrame,
  getNextPetAnimationPlaybackIndex,
  quantizePetLookDirection,
  resolvePetAnimationState,
  resolvePetLookFrame,
} from './petAnimation'

describe('pet animation atlas contract', () => {
  it('uses the fixed Codex v2 atlas geometry', () => {
    expect(PET_ATLAS_V2).toEqual({
      spriteVersionNumber: 2,
      columns: 8,
      rows: 11,
      cellWidth: 192,
      cellHeight: 208,
      width: 1536,
      height: 2288,
    })
  })

  it('keeps every standard row, frame count, and duration aligned with hatch-pet', () => {
    expect(PET_ANIMATION_STATES).toEqual([
      'idle',
      'running-right',
      'running-left',
      'waving',
      'jumping',
      'failed',
      'waiting',
      'running',
      'review',
    ])

    expect(PET_ANIMATION_DEFINITIONS).toEqual({
      idle: { rowIndex: 0, frameDurationsMs: [280, 110, 110, 140, 140, 320] },
      'running-right': { rowIndex: 1, frameDurationsMs: [120, 120, 120, 120, 120, 120, 120, 220] },
      'running-left': { rowIndex: 2, frameDurationsMs: [120, 120, 120, 120, 120, 120, 120, 220] },
      waving: { rowIndex: 3, frameDurationsMs: [140, 140, 140, 280] },
      jumping: { rowIndex: 4, frameDurationsMs: [140, 140, 140, 140, 280] },
      failed: { rowIndex: 5, frameDurationsMs: [140, 140, 140, 140, 140, 140, 140, 240] },
      waiting: { rowIndex: 6, frameDurationsMs: [150, 150, 150, 150, 150, 260] },
      running: { rowIndex: 7, frameDurationsMs: [120, 120, 120, 120, 120, 220] },
      review: { rowIndex: 8, frameDurationsMs: [150, 150, 150, 150, 150, 280] },
    })
  })

  it('builds renderer-ready frame sequences from the atlas grid', () => {
    const frames = getPetAnimationFrames('idle')

    expect(frames).toHaveLength(6)
    expect(frames[0]).toEqual({
      frameIndex: 0,
      rowIndex: 0,
      columnIndex: 0,
      x: 0,
      y: 0,
      width: 192,
      height: 208,
      durationMs: 280,
    })
    expect(frames[5]).toEqual({
      frameIndex: 5,
      rowIndex: 0,
      columnIndex: 5,
      x: 960,
      y: 0,
      width: 192,
      height: 208,
      durationMs: 320,
    })
    expect(getPetAnimationDurationMs('idle')).toBe(1100)
  })

  it('selects looped and one-shot frames at exact duration boundaries', () => {
    expect(getPetAnimationFrameAtElapsedMs('waving', 0).columnIndex).toBe(0)
    expect(getPetAnimationFrameAtElapsedMs('waving', 139).columnIndex).toBe(0)
    expect(getPetAnimationFrameAtElapsedMs('waving', 140).columnIndex).toBe(1)
    expect(getPetAnimationFrameAtElapsedMs('waving', 699).columnIndex).toBe(3)
    expect(getPetAnimationFrameAtElapsedMs('waving', 700).columnIndex).toBe(0)
    expect(getPetAnimationFrameAtElapsedMs('waving', 700, { loop: false }).columnIndex).toBe(3)
    expect(getPetAnimationFrameAtElapsedMs('waving', 5000, { loop: false }).columnIndex).toBe(3)
    expect(() => getPetAnimationFrameAtElapsedMs('idle', -1)).toThrow(RangeError)
  })

  it('keeps the recorded Codex idle timing and inserts low-frequency ambient gestures', () => {
    const playback = getPetAnimationPlaybackFrames('idle')

    expect(PET_IDLE_DURATION_MULTIPLIER).toBe(6)
    expect(playback.slice(0, 12).map((frame) => frame.columnIndex)).toEqual([
      0, 1, 2, 3, 4, 5,
      0, 1, 2, 3, 4, 5,
    ])
    expect(playback.slice(0, 6).map((frame) => frame.durationMs)).toEqual([
      1680, 660, 660, 840, 840, 1920,
    ])
    expect(playback[12]).toMatchObject({
      rowIndex: 3,
      columnIndex: 0,
      durationMs: 140,
    })
    expect(getPetAnimationPlaybackFrames('idle')).toBe(playback)
    expect(getPetAnimationPlaybackLoopStartIndex('idle')).toBe(0)
    expect(getNextPetAnimationPlaybackIndex('idle', playback.length - 1)).toBe(0)
  })

  it('repeats three active cycles after each slow idle recovery loop', () => {
    const runningFrames = getPetAnimationFrames('running')
    const playback = getPetAnimationPlaybackFrames('running')
    const loopStartIndex = runningFrames.length * 3

    expect(PET_ACTIVE_BURST_LOOPS).toBe(3)
    expect(playback).toHaveLength(runningFrames.length * 3 + 6)
    expect(playback.slice(0, loopStartIndex).every((frame) => frame.rowIndex === 7)).toBe(true)
    expect(playback[loopStartIndex]).toMatchObject({
      rowIndex: 0,
      columnIndex: 0,
      durationMs: 1680,
    })
    expect(getPetAnimationPlaybackLoopStartIndex('running')).toBe(0)
    expect(getNextPetAnimationPlaybackIndex('running', playback.length - 1)).toBe(0)
    expect(getPetAnimationPlaybackStep('running', runningFrames.length - 1)).toMatchObject({
      phase: 'action',
      cycleBoundaryAfter: true,
    })
    expect(getPetAnimationPlaybackStep('running', loopStartIndex)).toMatchObject({
      phase: 'idle',
      cycleBoundaryAfter: false,
    })
    expect(() => getNextPetAnimationPlaybackIndex('idle', -1)).toThrow(RangeError)
  })

  it('selects frames from one monotonic timeline without accumulating timer drift', () => {
    expect(getPetAnimationPlaybackTickAtElapsedMs('running', 0)).toMatchObject({
      playbackIndex: 0,
      phase: 'action',
      remainingDurationMs: 120,
    })
    expect(getPetAnimationPlaybackTickAtElapsedMs('running', 125)).toMatchObject({
      playbackIndex: 1,
      phase: 'action',
      remainingDurationMs: 115,
    })

    const idleTailStartMs = getPetAnimationDurationMs('running') * PET_ACTIVE_BURST_LOOPS
    expect(getPetAnimationPlaybackTickAtElapsedMs('running', idleTailStartMs)).toMatchObject({
      playbackIndex: 18,
      phase: 'idle',
      remainingDurationMs: 1680,
    })
    expect(getPetAnimationPlaybackTickAtElapsedMs('running', idleTailStartMs + 6_600)).toMatchObject({
      playbackIndex: 0,
      phase: 'action',
      remainingDurationMs: 120,
    })
    expect(() => getPetAnimationPlaybackTickAtElapsedMs('idle', -1)).toThrow(RangeError)
  })
})

describe('pet look directions', () => {
  it('reserves row 0 column 6 as the neutral look frame', () => {
    expect(PET_NEUTRAL_LOOK_FRAME).toEqual({
      rowIndex: 0,
      columnIndex: 6,
      x: 1152,
      y: 0,
      width: 192,
      height: 208,
    })
    expect(getPetLookFrame(null)).toEqual({
      directionDegrees: null,
      ...PET_NEUTRAL_LOOK_FRAME,
    })
  })

  it('maps the 16 clockwise directions across atlas rows 9 and 10', () => {
    expect(PET_LOOK_DIRECTIONS).toEqual([
      0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5,
      180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5,
    ])
    expect(getPetLookFrame(0)).toMatchObject({ directionDegrees: 0, rowIndex: 9, columnIndex: 0 })
    expect(getPetLookFrame(157.5)).toMatchObject({ directionDegrees: 157.5, rowIndex: 9, columnIndex: 7 })
    expect(getPetLookFrame(180)).toMatchObject({ directionDegrees: 180, rowIndex: 10, columnIndex: 0 })
    expect(getPetLookFrame(337.5)).toMatchObject({ directionDegrees: 337.5, rowIndex: 10, columnIndex: 7 })
  })

  it('quantizes vectors clockwise in 22.5-degree steps with zero pointing up', () => {
    for (const direction of PET_LOOK_DIRECTIONS) {
      const radians = direction * Math.PI / 180
      const deltaX = Math.sin(radians) * 100
      const deltaY = -Math.cos(radians) * 100

      expect(quantizePetLookDirection(deltaX, deltaY)).toBe(direction)
    }

    expect(quantizePetLookDirection(0, -100)).toBe(0)
    expect(quantizePetLookDirection(100, 0)).toBe(90)
    expect(quantizePetLookDirection(0, 100)).toBe(180)
    expect(quantizePetLookDirection(-100, 0)).toBe(270)
  })

  it('uses a configurable radial deadzone and returns the neutral slot inside it', () => {
    expect(quantizePetLookDirection(0, 0)).toBeNull()
    expect(quantizePetLookDirection(3, 4, 5)).toBeNull()
    expect(resolvePetLookFrame(3, 4, 5)).toEqual({
      directionDegrees: null,
      ...PET_NEUTRAL_LOOK_FRAME,
    })
    expect(resolvePetLookFrame(6, 0, 5)).toMatchObject({
      directionDegrees: 90,
      rowIndex: 9,
      columnIndex: 4,
    })
    expect(() => quantizePetLookDirection(1, 1, -1)).toThrow(RangeError)
  })
})

describe('resolvePetAnimationState', () => {
  it.each([
    ['idle', 'idle'],
    ['thinking', 'running'],
    ['compacting', 'running'],
    ['tool_executing', 'running'],
    ['streaming', 'running'],
    ['permission_pending', 'waiting'],
  ] as const)('maps chat state %s to %s', (chatState, expected) => {
    expect(resolvePetAnimationState({ chatState })).toBe(expected)
  })

  it.each([
    ['completion', 'jumping'],
    ['error', 'failed'],
    ['interaction', 'waving'],
    ['review', 'review'],
    ['drag-left', 'running-left'],
    ['drag-right', 'running-right'],
  ] as const)('lets transient %s override the underlying chat loop with %s', (transient, expected) => {
    expect(resolvePetAnimationState({
      chatState: 'permission_pending',
      transient,
    })).toBe(expected)
  })
})
