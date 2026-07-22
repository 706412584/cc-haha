export class SessionActivityError extends Error {
  constructor(
    message: string,
    readonly code: 'SESSION_TURN_ACTIVE',
  ) {
    super(message)
    this.name = 'SessionActivityError'
  }
}

type SessionActivity = {
  turnActive: boolean
  transitionReserved: boolean
}

export class SessionActivityCoordinator {
  private readonly sessions = new Map<string, SessionActivity>()

  tryBeginUserTurn(sessionId: string): boolean {
    const activity = this.sessions.get(sessionId)
    if (activity?.transitionReserved || activity?.turnActive) return false

    this.sessions.set(sessionId, {
      turnActive: true,
      transitionReserved: false,
    })
    return true
  }

  endUserTurn(sessionId: string): void {
    const activity = this.sessions.get(sessionId)
    if (!activity) return
    if (activity.transitionReserved) {
      activity.turnActive = false
      return
    }
    this.sessions.delete(sessionId)
  }

  isUserTurnActive(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.turnActive === true
  }

  async withTransitionReservation<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const activity = this.sessions.get(sessionId)
    if (activity?.turnActive) {
      throw new SessionActivityError(
        `Session ${sessionId} has an active user turn.`,
        'SESSION_TURN_ACTIVE',
      )
    }
    if (activity?.transitionReserved) {
      throw new SessionActivityError(
        `Session ${sessionId} already has a provider transition in progress.`,
        'SESSION_TURN_ACTIVE',
      )
    }

    this.sessions.set(sessionId, {
      turnActive: false,
      transitionReserved: true,
    })
    try {
      return await operation()
    } finally {
      const current = this.sessions.get(sessionId)
      if (current?.turnActive) {
        current.transitionReserved = false
      } else {
        this.sessions.delete(sessionId)
      }
    }
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId)
  }
}

export const sessionActivityCoordinator = new SessionActivityCoordinator()
