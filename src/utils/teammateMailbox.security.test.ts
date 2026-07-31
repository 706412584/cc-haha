import { describe, expect, test } from 'bun:test'
import {
  getTrustedShutdownApproval,
  isPermissionResponse,
  isSandboxPermissionResponse,
  isTrustedTeamLeaderMessage,
  isTeamPermissionUpdate,
  type TeammateMessage,
} from './teammateMailbox.js'

describe('mailbox protocol validation', () => {
  test('uses the mailbox envelope as the team-leader identity', () => {
    expect(
      isTrustedTeamLeaderMessage({
        from: 'worker',
        text: JSON.stringify({ from: 'team-lead' }),
        timestamp: new Date().toISOString(),
        read: false,
      }),
    ).toBe(false)
    expect(
      isTrustedTeamLeaderMessage({
        from: 'team-lead',
        text: '{}',
        timestamp: new Date().toISOString(),
        read: false,
      }),
    ).toBe(true)
  })

  test('rejects malformed permission-bearing responses', () => {
    expect(
      isPermissionResponse(
        JSON.stringify({
          type: 'permission_response',
          request_id: 'request-1',
          subtype: 'success',
          response: {
            permission_updates: [{ type: 'addRules', rules: 'Bash' }],
          },
        }),
      ),
    ).toBeNull()
    expect(
      isSandboxPermissionResponse(
        JSON.stringify({
          type: 'sandbox_permission_response',
          requestId: 'request-2',
          host: 'example.com',
          allow: 'yes',
          timestamp: new Date().toISOString(),
        }),
      ),
    ).toBeNull()
    expect(
      isTeamPermissionUpdate(
        JSON.stringify({
          type: 'team_permission_update',
          permissionUpdate: {
            type: 'addRules',
            rules: 'Bash',
            behavior: 'allow',
            destination: 'session',
          },
          directoryPath: '/tmp',
          toolName: 'Bash',
        }),
      ),
    ).toBeNull()
  })

  test('parses valid permission-bearing responses', () => {
    expect(
      isPermissionResponse(
        JSON.stringify({
          type: 'permission_response',
          request_id: 'request-1',
          subtype: 'success',
          response: {
            permission_updates: [
              {
                type: 'addRules',
                rules: [{ toolName: 'Bash' }],
                behavior: 'allow',
                destination: 'session',
              },
            ],
          },
        }),
      ),
    ).not.toBeNull()
    expect(
      isSandboxPermissionResponse(
        JSON.stringify({
          type: 'sandbox_permission_response',
          requestId: 'request-2',
          host: 'example.com',
          allow: false,
          timestamp: new Date().toISOString(),
        }),
      ),
    ).not.toBeNull()
    expect(
      isTeamPermissionUpdate(
        JSON.stringify({
          type: 'team_permission_update',
          permissionUpdate: {
            type: 'addRules',
            rules: [{ toolName: 'Bash' }],
            behavior: 'deny',
            destination: 'session',
          },
          directoryPath: '/tmp',
          toolName: 'Bash',
        }),
      ),
    ).not.toBeNull()
  })
})

describe('shutdown approval identity binding', () => {
  const teamMembers = [
    {
      agentId: 'worker-id',
      name: 'worker',
      tmuxPaneId: '%trusted',
      backendType: 'tmux' as const,
    },
  ]

  test('rejects a body identity that does not match the mailbox envelope', () => {
    const message = shutdownMessage({
      envelopeFrom: 'attacker',
      bodyFrom: 'worker',
      paneId: '%arbitrary',
      backendType: 'tmux',
    })

    expect(getTrustedShutdownApproval(message, teamMembers)).toBeNull()
  })

  test('uses team state instead of attacker-provided pane metadata', () => {
    const message = shutdownMessage({
      envelopeFrom: 'worker',
      bodyFrom: 'worker',
      paneId: '%arbitrary',
      backendType: 'iterm2',
    })

    expect(getTrustedShutdownApproval(message, teamMembers)).toEqual({
      approval: expect.objectContaining({
        from: 'worker',
        paneId: '%arbitrary',
        backendType: 'iterm2',
      }),
      agentId: 'worker-id',
      name: 'worker',
      paneId: '%trusted',
      backendType: 'tmux',
    })
  })

  test('rejects approvals from senders outside trusted team state', () => {
    const message = shutdownMessage({
      envelopeFrom: 'outsider',
      bodyFrom: 'outsider',
      paneId: '%arbitrary',
      backendType: 'tmux',
    })

    expect(getTrustedShutdownApproval(message, teamMembers)).toBeNull()
  })
})

function shutdownMessage({
  envelopeFrom,
  bodyFrom,
  paneId,
  backendType,
}: {
  envelopeFrom: string
  bodyFrom: string
  paneId: string
  backendType: 'tmux' | 'iterm2'
}): TeammateMessage {
  return {
    from: envelopeFrom,
    text: JSON.stringify({
      type: 'shutdown_approved',
      requestId: 'shutdown-request',
      from: bodyFrom,
      timestamp: new Date().toISOString(),
      paneId,
      backendType,
    }),
    timestamp: new Date().toISOString(),
    read: false,
  }
}
