import { describe, expect, it } from 'bun:test'
import {
  COORDINATOR_VERIFICATION_GUIDANCE,
  getCoordinatorSystemPrompt,
} from './coordinatorMode'

describe('getCoordinatorSystemPrompt', () => {
  it('keeps worker delegation selective and bounded', () => {
    const prompt = getCoordinatorSystemPrompt()

    expect(prompt).toContain(COORDINATOR_VERIFICATION_GUIDANCE.specialist)
    expect(prompt).toContain(COORDINATOR_VERIFICATION_GUIDANCE.implementationPhase)
    expect(prompt).toContain(COORDINATOR_VERIFICATION_GUIDANCE.independentPhase)
    expect(prompt).toContain(COORDINATOR_VERIFICATION_GUIDANCE.concurrency)
    expect(prompt).toContain(COORDINATOR_VERIFICATION_GUIDANCE.heading)
    expect(prompt).toContain(COORDINATOR_VERIFICATION_GUIDANCE.decision)
    for (const rule of COORDINATOR_VERIFICATION_GUIDANCE.rules) {
      expect(prompt).toContain(rule)
    }
    expect(prompt).toContain(COORDINATOR_VERIFICATION_GUIDANCE.proof)
    expect(prompt).toContain(COORDINATOR_VERIFICATION_GUIDANCE.implementationTip)
    expect(prompt).toContain(COORDINATOR_VERIFICATION_GUIDANCE.bugInvestigation)
    expect(prompt).toContain(COORDINATOR_VERIFICATION_GUIDANCE.bugProgress)

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
    expect(prompt).toContain(
      'The coordinator decides whether verification is needed and how deep it should be',
    )
    expect(prompt).toContain(
      'Always inspect the integrated final diff for unintended scope or leftovers',
    )
    expect(prompt).toContain(
      'Simple, localized, low-risk changes may otherwise stop after LSP diagnostics, type checks, or the lightest relevant static check',
    )
    expect(prompt).toContain(
      'Investigating the bug with one well-scoped worker',
    )
    expect(prompt).not.toContain('Research auth tests')
    expect(prompt).toContain(
      'Do not launch a verification worker unless the user explicitly requests independent verification',
    )
    expect(prompt).toContain(
      'A bug report, high-risk change, cross-boundary change, broad refactor, unresolved uncertainty, or PR-ready status is not authorization',
    )
    expect(prompt).toContain(
      'If the approved task or plan has no verification step, do not add one at the end',
    )
    expect(prompt).not.toContain(
      'a separate verification worker is the second layer',
    )
    expect(prompt).not.toContain(
      'Use after non-trivial implementation lands',
    )
    expect(prompt).not.toContain('Parallelism is your superpower')
  })

  it('keeps terminal workers terminal unless the user explicitly resumes one', () => {
    const prompt = getCoordinatorSystemPrompt()

    expect(prompt).toContain(
      'Before ending the user conversation',
    )
    expect(prompt).toContain(
      'completed, failed, stopped, killed, or cancelled',
    )
    expect(prompt).toContain('explicitly asks to resume')
    expect(prompt).not.toContain('Continue workers whose work is complete')
    expect(prompt).not.toContain('Stopped workers can be continued')
    expect(prompt).not.toContain('Continue the same worker with SendMessage')
    expect(prompt).not.toContain(
      'Research explored exactly the files that need editing | **Continue**',
    )
    expect(prompt).not.toContain(
      'Correcting a failure or extending recent work | **Continue**',
    )
    expect(prompt).not.toContain('worker finished research, now give it')
    expect(prompt).not.toContain('worker just reported test failures')
  })

  it('treats empty mutation outcomes as lifecycle-only and requires re-delegation', () => {
    const prompt = getCoordinatorSystemPrompt()

    expect(prompt).toContain('completed (no file edits)')
    expect(prompt).toContain('<outcome>')
    expect(prompt).toContain('<file_edits>N</file_edits>')
    expect(prompt).toContain(
      'status=completed` is lifecycle only — if the task was expected to modify files and summary/outcome shows no file edits, return the work to pending and re-delegate or verify',
    )
  })
})
