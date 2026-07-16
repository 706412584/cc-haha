import { describe, expect, it } from 'bun:test'
import { getCoordinatorSystemPrompt } from './coordinatorMode'

describe('getCoordinatorSystemPrompt', () => {
  it('keeps worker delegation selective and bounded', () => {
    const prompt = getCoordinatorSystemPrompt()

    expect(prompt).toContain('Default to one well-scoped worker')
    expect(prompt).toContain(
      'Do not fan out simple research, planning, command execution, or ordinary tests',
    )
    expect(prompt).toContain(
      'Parallel workers require genuinely independent tasks with non-overlapping ownership',
    )
    expect(prompt).toContain(
      'Keep concurrency proportional to the work instead of maximizing worker count',
    )
    expect(prompt).toContain('Coordinator mode stays pure coordination')
    expect(prompt).toContain(
      'Do not keep an implementation task for yourself; assign file-changing work to workers',
    )
    expect(prompt).toContain(
      'Parallel kickoff still requires independent, unblocked tasks with non-overlapping file ownership',
    )
    expect(prompt).not.toContain('Parallelism is your superpower')
  })
})
