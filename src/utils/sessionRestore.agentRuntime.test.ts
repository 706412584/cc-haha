import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  setSessionPersistenceDisabled,
  switchSession,
} from '../bootstrap/state.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import {
  flushAgentRuntimePersistence,
  onChangeAppState,
} from '../state/onChangeAppState.js'
import { createStore } from '../state/store.js'
import type { SessionId } from '../types/ids.js'
import {
  restoreSessionStateFromLog,
  switchSessionAndRestoreStateFromLog,
} from './sessionRestore.js'

function runtimeSnapshot(taskId: string): string {
  return JSON.stringify({
    version: 1,
    nextSequence: 1,
    tasks: [{
      id: taskId,
      epoch: 1,
      status: 'completed',
      description: taskId,
      prompt: taskId,
      agentType: 'general-purpose',
      startTime: 1,
    }],
    inbox: [],
  })
}

async function writeRuntime(transcriptPath: string, taskId: string): Promise<void> {
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true })
  await fs.writeFile(
    transcriptPath.replace(/\.jsonl$/, '.agent-runtime.json'),
    runtimeSnapshot(taskId),
  )
}

async function readRuntimeTaskIds(transcriptPath: string): Promise<string[]> {
  const snapshot = JSON.parse(await fs.readFile(
    transcriptPath.replace(/\.jsonl$/, '.agent-runtime.json'),
    'utf8',
  )) as { tasks: Array<{ id: string }> }
  return snapshot.tasks.map(task => task.id)
}

describe('Agent runtime session restore targeting', () => {
  const tempDirectories: string[] = []

  afterEach(async () => {
    setSessionPersistenceDisabled(false)
    await Promise.all(tempDirectories.splice(0).map(directory =>
      fs.rm(directory, { recursive: true, force: true }),
    ))
  })

  test('restores B while A is still the current session', async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-resume-same-'))
    tempDirectories.push(project)
    const sessionA = '11111111-1111-4111-8111-111111111111' as SessionId
    const sessionB = '22222222-2222-4222-8222-222222222222' as SessionId
    const transcriptA = path.join(project, `${sessionA}.jsonl`)
    const transcriptB = path.join(project, `${sessionB}.jsonl`)
    await writeRuntime(transcriptA, 'agent-from-a')
    await writeRuntime(transcriptB, 'agent-from-b')
    switchSession(sessionA, project)
    const store = createStore(getDefaultAppState(), onChangeAppState)
    await restoreSessionStateFromLog({}, store.setState, {
      sessionId: sessionA,
      transcriptPath: transcriptA,
      forkSession: false,
    })
    await flushAgentRuntimePersistence()
    expect(Object.keys(store.getState().tasks)).toEqual(['agent-from-a'])

    await switchSessionAndRestoreStateFromLog({}, store.setState, {
      sessionId: sessionB,
      transcriptPath: transcriptB,
      forkSession: false,
    })
    await flushAgentRuntimePersistence()

    expect(Object.keys(store.getState().tasks)).toEqual(['agent-from-b'])
    expect(await readRuntimeTaskIds(transcriptA)).toEqual(['agent-from-a'])
    expect(await readRuntimeTaskIds(transcriptB)).toEqual(['agent-from-b'])
  })

  test('restores a target runtime from another project', async () => {
    const projectA = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-resume-project-a-'))
    const projectB = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-resume-project-b-'))
    tempDirectories.push(projectA, projectB)
    const sessionA = '33333333-3333-4333-8333-333333333333' as SessionId
    const sessionB = '44444444-4444-4444-8444-444444444444' as SessionId
    await writeRuntime(path.join(projectA, `${sessionA}.jsonl`), 'agent-project-a')
    const transcriptB = path.join(projectB, `${sessionB}.jsonl`)
    await writeRuntime(transcriptB, 'agent-project-b')
    const transcriptA = path.join(projectA, `${sessionA}.jsonl`)
    switchSession(sessionA, projectA)
    const store = createStore(getDefaultAppState(), onChangeAppState)
    await restoreSessionStateFromLog({}, store.setState, {
      sessionId: sessionA,
      transcriptPath: transcriptA,
      forkSession: false,
    })
    await flushAgentRuntimePersistence()

    await switchSessionAndRestoreStateFromLog({}, store.setState, {
      sessionId: sessionB,
      transcriptPath: transcriptB,
      forkSession: false,
    })
    await flushAgentRuntimePersistence()

    expect(Object.keys(store.getState().tasks)).toEqual(['agent-project-b'])
    expect(await readRuntimeTaskIds(transcriptA)).toEqual(['agent-project-a'])
    expect(await readRuntimeTaskIds(transcriptB)).toEqual(['agent-project-b'])
  })

  test('does not read or write a runtime sidecar when persistence is disabled', async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-resume-disabled-'))
    tempDirectories.push(project)
    const session = '99999999-9999-4999-8999-999999999999' as SessionId
    const transcript = path.join(project, `${session}.jsonl`)
    const runtimePath = transcript.replace(/\.jsonl$/, '.agent-runtime.json')
    await writeRuntime(transcript, 'agent-private')
    switchSession(session, project)
    setSessionPersistenceDisabled(true)
    const store = createStore(getDefaultAppState(), onChangeAppState)

    await restoreSessionStateFromLog({}, store.setState, {
      sessionId: session,
      transcriptPath: transcript,
      forkSession: false,
    })

    expect(store.getState().tasks).toEqual({})
    await fs.rm(runtimePath, { force: true })
    store.setState(prev => ({
      ...prev,
      nextAgentCompletionSequence: prev.nextAgentCompletionSequence + 1,
    }))
    await flushAgentRuntimePersistence()
    expect(await fs.stat(runtimePath).then(() => true, () => false)).toBe(false)
  })

  test('does not inherit the source runtime when forking', async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-resume-fork-'))
    tempDirectories.push(project)
    const sourceSession = '55555555-5555-4555-8555-555555555555' as SessionId
    const forkSession = '66666666-6666-4666-8666-666666666666' as SessionId
    const sourceTranscript = path.join(project, `${sourceSession}.jsonl`)
    const forkTranscript = path.join(project, `${forkSession}.jsonl`)
    await writeRuntime(sourceTranscript, 'agent-source')
    switchSession(sourceSession, project)
    const store = createStore(getDefaultAppState(), onChangeAppState)
    await restoreSessionStateFromLog({}, store.setState, {
      sessionId: sourceSession,
      transcriptPath: sourceTranscript,
      forkSession: false,
    })
    await flushAgentRuntimePersistence()

    await switchSessionAndRestoreStateFromLog({}, store.setState, {
      sessionId: forkSession,
      transcriptPath: forkTranscript,
      forkSession: true,
    })
    await flushAgentRuntimePersistence()

    expect(store.getState().tasks).toEqual({})
    expect(await readRuntimeTaskIds(sourceTranscript)).toEqual(['agent-source'])
    expect(await readRuntimeTaskIds(forkTranscript)).toEqual([])
  })
})
