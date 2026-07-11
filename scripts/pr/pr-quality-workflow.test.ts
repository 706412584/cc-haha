import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

type WorkflowJob = {
  needs?: string | string[]
  steps?: Array<{ name?: string; run?: string }>
}

function workflowJobs(workflow: string) {
  return (parse(workflow) as { jobs: Record<string, WorkflowJob> }).jobs
}

describe('PR quality workflow', () => {
  test('builds scope before routing independent quality jobs', () => {
    const workflow = readFileSync('.github/workflows/pr-quality.yml', 'utf8')

    expect(workflow).toContain('scope-plan:')
    expect(workflow).toContain('--plan-only')
    expect(workflow).toContain("if: needs.scope-plan.outputs.desktop_checks == 'true'")
    expect(workflow).toContain("if: needs.scope-plan.outputs.server_checks == 'true'")
    expect(workflow).toContain("if: needs.scope-plan.outputs.provider_contract_checks == 'true'")
    expect(workflow).toContain("if: needs.scope-plan.outputs.chat_contract_checks == 'true'")
    expect(workflow).toContain("if: needs.scope-plan.outputs.persistence_checks == 'true'")
    expect(workflow).toContain("if: needs.scope-plan.outputs.adapter_checks == 'true'")
    expect(workflow).toContain("if: needs.scope-plan.outputs.desktop_native_checks == 'true'")
    expect(workflow).toContain("if: needs.scope-plan.outputs.docs_checks == 'true'")
    expect(workflow).toContain("if: needs.scope-plan.outputs.coverage_checks == 'true'")
  })

  test('installs frozen dependencies before policy regressions without blocking product routing', () => {
    const workflow = readFileSync('.github/workflows/pr-quality.yml', 'utf8')
    const jobs = workflowJobs(workflow)
    const policySteps = jobs['policy-enforcement'].steps ?? []
    const installIndex = policySteps.findIndex((step) => step.name === 'Install root dependencies')
    const regressionIndex = policySteps.findIndex((step) => step.name === 'Run policy regression tests')

    expect(jobs['policy-enforcement'].needs).toBe('scope-plan')
    expect(installIndex).toBeGreaterThanOrEqual(0)
    expect(installIndex).toBeLessThan(regressionIndex)
    for (const jobId of [
      'desktop-checks',
      'server-checks',
      'provider-contract-checks',
      'chat-contract-checks',
      'adapter-checks',
      'desktop-native-checks',
      'persistence-checks',
      'docs-checks',
      'coverage-checks',
    ]) {
      expect(jobs[jobId].needs).toBe('scope-plan')
    }
    expect(workflow).toContain('bun-version: 1.3.12')
  })

  test('keeps coverage artifacts observable in CI', () => {
    const workflow = readFileSync('.github/workflows/pr-quality.yml', 'utf8')

    expect(workflow).toContain('COVERAGE_BASE_REF: origin/${{ github.base_ref }}')
    expect(workflow).toContain('cat "$latest_report" >> "$GITHUB_STEP_SUMMARY"')
    expect(workflow).toContain('uses: actions/upload-artifact@v4')
    expect(workflow).toContain('path: artifacts/coverage/')
    expect(workflow).toContain('retention-days: 14')
  })

  test('keeps required PR checks deterministic and secret-free', () => {
    const workflow = readFileSync('.github/workflows/pr-quality.yml', 'utf8')

    expect(workflow).not.toContain('--allow-live')
    expect(workflow).not.toContain('QUALITY_GATE_PROVIDER_API_KEY')
    expect(workflow).not.toContain('secrets.')
    expect(workflow).not.toContain('pull_request_target')
    expect(workflow.match(/uses: actions\/checkout@v4/g)?.length).toBeGreaterThan(0)
    expect(workflow.match(/persist-credentials: false/g)?.length).toBe(
      workflow.match(/uses: actions\/checkout@v4/g)?.length,
    )
  })

  test('exposes a single required gate job for branch protection', () => {
    const workflow = readFileSync('.github/workflows/pr-quality.yml', 'utf8')

    expect(workflow).toContain('pr-quality-gate:')
    expect(workflow).toContain('name: pr-quality-gate')
    expect(workflow).toContain('if: always()')
    expect(workflow).toContain('require_success "scope-plan" "${{ needs.scope-plan.result }}"')
    expect(workflow).toContain('require_success "policy-enforcement" "${{ needs.policy-enforcement.result }}"')
    expect(workflow).toContain('require_selected "provider-contract-checks"')
    expect(workflow).toContain('require_selected "chat-contract-checks"')
    expect(workflow).toContain('require_selected "coverage-checks"')
  })
})
