import { expect, test } from 'bun:test'
import { stopServerRuntimeForShutdown } from '../index.js'
import { conversationService } from '../services/conversationService.js'
import { cronScheduler } from '../services/cronScheduler.js'
import { teamWatcher } from '../services/teamWatcher.js'
import { localIndexCoordinator } from '../services/localIndex/coordinator.js'
import { searchContentCoordinator } from '../services/localIndex/searchContentCoordinator.js'

test('server shutdown stops background schedulers before waiting for CLI sessions', async () => {
  const calls: string[] = []
  const originalTeamStop = teamWatcher.stop.bind(teamWatcher)
  const originalCronStop = cronScheduler.stop.bind(cronScheduler)
  const originalGetActiveSessions = conversationService.getActiveSessions.bind(conversationService)
  const originalStopAllSessionsAndWait = conversationService.stopAllSessionsAndWait.bind(conversationService)
  const originalLocalIndexStop = localIndexCoordinator.stop.bind(localIndexCoordinator)
  const originalSearchContentStop = searchContentCoordinator.stop.bind(searchContentCoordinator)

  try {
    teamWatcher.stop = (() => {
      calls.push('teamWatcher.stop')
    }) as typeof teamWatcher.stop
    cronScheduler.stop = (() => {
      calls.push('cronScheduler.stop')
    }) as typeof cronScheduler.stop
    conversationService.getActiveSessions = (() => ['active-session']) as typeof conversationService.getActiveSessions
    conversationService.stopAllSessionsAndWait = (async () => {
      calls.push('conversationService.stopAllSessionsAndWait')
    }) as typeof conversationService.stopAllSessionsAndWait
    localIndexCoordinator.stop = (async () => {
      calls.push('localIndexCoordinator.stop')
    }) as typeof localIndexCoordinator.stop
    searchContentCoordinator.stop = (async () => {
      calls.push('searchContentCoordinator.stop')
    }) as typeof searchContentCoordinator.stop

    await stopServerRuntimeForShutdown({ waitForCli: true })

    expect(calls).toEqual([
      'teamWatcher.stop',
      'cronScheduler.stop',
      'localIndexCoordinator.stop',
      'searchContentCoordinator.stop',
      'conversationService.stopAllSessionsAndWait',
    ])
  } finally {
    teamWatcher.stop = originalTeamStop
    cronScheduler.stop = originalCronStop
    conversationService.getActiveSessions = originalGetActiveSessions
    conversationService.stopAllSessionsAndWait = originalStopAllSessionsAndWait
    localIndexCoordinator.stop = originalLocalIndexStop
    searchContentCoordinator.stop = originalSearchContentStop
  }
})
