/**
 * Holds completed, side-effect-free assistant blocks until a stream either
 * finishes or crosses a tool boundary. A watchdog retry can then discard the
 * failed attempt without leaving orphan thinking/text in the transcript.
 */
export class StreamAssistantCommitBuffer<T> {
  private pending: T[] = []
  private crossedSideEffectBoundary = false

  add(value: T, blockType: string): T[] {
    if (this.crossedSideEffectBoundary) return [value]

    this.pending.push(value)
    if (blockType !== 'tool_use' && blockType !== 'server_tool_use') {
      return []
    }

    this.crossedSideEffectBoundary = true
    return this.drain()
  }

  flush(): T[] {
    return this.drain()
  }

  hasCrossedSideEffectBoundary(): boolean {
    return this.crossedSideEffectBoundary
  }

  private drain(): T[] {
    const values = this.pending
    this.pending = []
    return values
  }
}
