import { expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AppState } from '../../state/AppState.js'
import * as sdk from '../sdkEventQueue.js'
import * as diskOutput from '../task/diskOutput.js'
import * as framework from '../task/framework.js'
import * as tracing from '../telemetry/perfettoTracing.js'
import { killInProcessTeammate } from './spawnInProcess.js'
import * as teamHelpers from './teamHelpers.js'

async function withKillFixture(run: (fixture: {
  setAppState: (update: (state: AppState) => AppState) => void
  getState: () => AppState
  abortController: AbortController
  remove: ReturnType<typeof spyOn<typeof teamHelpers, 'removeMemberByAgentId'>>
  terminated: ReturnType<typeof spyOn<typeof sdk, 'emitTaskTerminatedSdk'>>
  evictOutput: ReturnType<typeof spyOn<typeof diskOutput, 'evictTaskOutput'>>
  unregister: ReturnType<typeof spyOn<typeof tracing, 'unregisterAgent'>>
  timer: ReturnType<typeof spyOn<typeof globalThis, 'setTimeout'>>
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'cc-haha-kill-teammate-'))
  const originalHome = process.env.HOME
  const originalConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.HOME = directory
  process.env.CLAUDE_CONFIG_DIR = join(directory, 'claude')
  const abortController = new AbortController()
  let state = {
    tasks: {
      worker: {
        id: 'worker',
        type: 'in_process_teammate',
        status: 'running',
        identity: { teamName: 'fixture', agentId: 'worker@fixture' },
        description: 'fixture teammate',
        toolUseId: 'fixture-tool',
        abortController,
      },
    },
    teamContext: { teammates: { 'worker@fixture': {} } },
  } as unknown as AppState
  const remove = spyOn(teamHelpers, 'removeMemberByAgentId').mockResolvedValue(true)
  const terminated = spyOn(sdk, 'emitTaskTerminatedSdk').mockImplementation(() => {})
  const evictOutput = spyOn(diskOutput, 'evictTaskOutput').mockResolvedValue(undefined)
  const unregister = spyOn(tracing, 'unregisterAgent').mockImplementation(() => {})
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(
    (() => 0 as unknown as ReturnType<typeof setTimeout>) as typeof setTimeout,
  )
  try {
    await run({
      setAppState: update => { state = update(state) },
      getState: () => state,
      abortController,
      remove,
      terminated,
      evictOutput,
      unregister,
      timer,
    })
  } finally {
    for (const mock of [remove, terminated, evictOutput, unregister, timer]) mock.mockRestore()
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfig
    await rm(directory, { recursive: true, force: true })
  }
}

for (const failureCode of [undefined, 'ELOCKED', 'EPERM']) {
  test(`killing a teammate finalizes exactly once when removal ${failureCode ?? 'succeeds'}`, async () => {
    await withKillFixture(async fixture => {
      const failure = Object.assign(new Error('fixture removal failure'), { code: failureCode })
      if (failureCode) fixture.remove.mockRejectedValue(failure)
      const kill = killInProcessTeammate('worker', fixture.setAppState)
      if (failureCode) await expect(kill).rejects.toBe(failure)
      else expect(await kill).toBe(true)

      expect(fixture.abortController.signal.aborted).toBe(true)
      expect(fixture.getState().tasks.worker).toMatchObject({ status: 'killed', notified: true })
      expect(fixture.getState().teamContext?.teammates).toEqual({})
      expect(fixture.remove).toHaveBeenCalledWith('fixture', 'worker@fixture')
      expect(fixture.terminated).toHaveBeenCalledWith('worker', 'stopped', {
        toolUseId: 'fixture-tool', summary: 'fixture teammate', ownerAgentId: 'worker@fixture',
      })
      expect(fixture.evictOutput).toHaveBeenCalledWith('worker')
      expect(fixture.unregister).toHaveBeenCalledWith('worker@fixture')
      expect(fixture.timer).toHaveBeenCalledWith(expect.any(Function), framework.STOPPED_DISPLAY_MS)

      // A repeated stop must neither retry persistence nor duplicate finalizers.
      expect(await killInProcessTeammate('worker', fixture.setAppState)).toBe(false)
      expect(await killInProcessTeammate('missing', fixture.setAppState)).toBe(false)
      for (const mock of [fixture.remove, fixture.terminated, fixture.evictOutput, fixture.unregister, fixture.timer]) {
        expect(mock).toHaveBeenCalledTimes(1)
      }
    })
  })
}
