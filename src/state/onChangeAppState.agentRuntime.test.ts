import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  setSessionPersistenceDisabled,
  switchSession,
} from '../bootstrap/state.js'
import { createTaskStateBase } from '../Task.js'
import type { SessionId } from '../types/ids.js'
import {
  getAgentRuntimePathForTranscript,
} from '../utils/sessionStorage.js'
import {
  enqueueAgentRuntimeWriteForTesting,
  flushAgentRuntimePersistence,
  onChangeAppState,
} from './onChangeAppState.js'
import { getDefaultAppState } from './AppStateStore.js'

describe('Agent runtime persistence scheduling', () => {
  const tempDirectories: string[] = []

  afterEach(async () => {
    setSessionPersistenceDisabled(false)
    await flushAgentRuntimePersistence()
    await Promise.all(tempDirectories.splice(0).map(directory =>
      fs.rm(directory, { recursive: true, force: true }),
    ))
  })

  test('keeps an A snapshot on A when the active session switches to B during a blocked write', async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-write-race-'))
    tempDirectories.push(project)
    const sessionA = '77777777-7777-4777-8777-777777777777' as SessionId
    const sessionB = '88888888-8888-4888-8888-888888888888' as SessionId
    const runtimeA = getAgentRuntimePathForTranscript(path.join(project, `${sessionA}.jsonl`))
    const runtimeB = getAgentRuntimePathForTranscript(path.join(project, `${sessionB}.jsonl`))
    switchSession(sessionA, project)

    let releaseWrite!: () => void
    const blocked = new Promise<void>(resolve => {
      releaseWrite = resolve
    })
    enqueueAgentRuntimeWriteForTesting(runtimeA, () => blocked)

    const oldState = getDefaultAppState()
    const task = {
      ...createTaskStateBase('agent-a', 'local_agent', 'Agent A'),
      type: 'local_agent' as const,
      status: 'completed' as const,
      agentId: 'agent-a',
      epoch: 1,
      prompt: 'Agent A',
      agentType: 'general-purpose',
      retrieved: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      isBackgrounded: true,
      pendingMessages: [],
      retain: false,
      diskLoaded: false,
    }
    onChangeAppState({
      oldState,
      newState: { ...oldState, tasks: { [task.id]: task } },
    })

    switchSession(sessionB, project)
    releaseWrite()
    await flushAgentRuntimePersistence()

    expect(JSON.parse(await fs.readFile(runtimeA, 'utf8')).tasks[0].id).toBe('agent-a')
    expect(await fs.stat(runtimeB).then(() => true, () => false)).toBe(false)
  })
})
