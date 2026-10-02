import { describe, expect, it } from 'bun:test'
import { feature } from 'bun:bundle'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandboxedTestEnvironment } from '../../../scripts/pr/test-environment.js'

const entryOrders = [
  ['PermissionUpdate', 'permissionSetup', 'Tool'],
  ['permissionSetup', 'PermissionUpdate', 'Tool'],
  ['Tool', 'PermissionUpdate', 'permissionSetup'],
  ['permissions', 'permissionSetup', 'PermissionUpdate', 'Tool'],
] as const

const moduleUrls = {
  PermissionUpdate: new URL('./PermissionUpdate.ts', import.meta.url).href,
  permissionSetup: new URL('./permissionSetup.ts', import.meta.url).href,
  Tool: new URL('../../Tool.ts', import.meta.url).href,
  permissions: new URL('./permissions.ts', import.meta.url).href,
}

describe('permission mode updates across module entry orders', () => {
  for (const order of entryOrders) {
    it(`preserves transitions and the bypass gate after ${order.join(' → ')}`, async () => {
      // A fresh process is essential: a previous test can finish loading the
      // cycle and hide an incomplete export captured during module evaluation.
      const sandboxHome = mkdtempSync(join(tmpdir(), 'permission-import-order-'))
      const source = `
        import assert from 'node:assert/strict'
        import { feature } from 'bun:bundle'
        ${order.map(name => `const ${name} = await import(${JSON.stringify(moduleUrls[name])})`).join('\n')}
        const state = await import(${JSON.stringify(new URL('../../bootstrap/state.ts', import.meta.url).href)})
        const { applyPermissionUpdate, applyPermissionUpdates } = PermissionUpdate
        const { getEmptyToolPermissionContext } = Tool
        const reset = () => {
          state.setHasExitedPlanMode(false)
          state.setNeedsPlanModeExitAttachment(false)
        }
        const planContext = available => ({
          ...getEmptyToolPermissionContext(),
          mode: 'plan',
          prePlanMode: 'default',
          isBypassPermissionsModeAvailable: available,
        })
        const setMode = mode => ({ type: 'setMode', mode, destination: 'session' })

        reset()
        const approved = applyPermissionUpdate(planContext(true), setMode('bypassPermissions'))
        assert.equal(approved.mode, 'bypassPermissions')
        assert.equal(approved.prePlanMode, undefined)
        assert.equal(state.hasExitedPlanModeInSession(), true)
        assert.equal(state.needsPlanModeExitAttachment(), true)

        reset()
        const blockedContext = planContext(false)
        assert.equal(applyPermissionUpdate(blockedContext, setMode('bypassPermissions')), blockedContext)
        const blockedBatch = applyPermissionUpdates(blockedContext, [
          setMode('bypassPermissions'),
          { type: 'addRules', rules: [{ toolName: 'Read' }], behavior: 'allow', destination: 'session' },
        ])
        assert.equal(blockedBatch.mode, 'plan')
        assert.equal(blockedBatch.prePlanMode, 'default')
        assert.deepEqual(blockedBatch.alwaysAllowRules.session, ['Read'])
        assert.equal(state.hasExitedPlanModeInSession(), false)
        assert.equal(state.needsPlanModeExitAttachment(), false)

        reset()
        const batch = applyPermissionUpdates(planContext(false), [setMode('acceptEdits')])
        assert.equal(batch.mode, 'acceptEdits')
        assert.equal(batch.prePlanMode, undefined)
        assert.equal(state.hasExitedPlanModeInSession(), true)
        assert.equal(state.needsPlanModeExitAttachment(), true)

        reset()
        const disabled = permissionSetup.createDisabledBypassPermissionsContext(approved)
        assert.equal(disabled.mode, 'default')
        assert.equal(disabled.isBypassPermissionsModeAvailable, false)
        assert.equal(state.hasExitedPlanModeInSession(), false)
        assert.equal(state.needsPlanModeExitAttachment(), false)

        if (feature('TRANSCRIPT_CLASSIFIER')) {
          const autoState = await import(${JSON.stringify(new URL('./autoModeState.ts', import.meta.url).href)})
          reset()
          state.setNeedsAutoModeExitAttachment(false)
          autoState.setAutoModeActive(true)
          const restored = applyPermissionUpdate({
            ...planContext(true),
            prePlanMode: 'auto',
            strippedDangerousRules: { session: ['Bash(python:*)'] },
          }, setMode('default'))
          assert.equal(restored.prePlanMode, undefined)
          assert.equal(restored.strippedDangerousRules, undefined)
          assert.deepEqual(restored.alwaysAllowRules.session, ['Bash(python:*)'])
          assert.equal(autoState.isAutoModeActive(), false)
          assert.equal(state.hasExitedPlanModeInSession(), true)
          assert.equal(state.needsPlanModeExitAttachment(), true)
          assert.equal(state.needsAutoModeExitAttachment(), true)

          autoState.setAutoModeCircuitBroken(true)
          assert.throws(
            () => applyPermissionUpdate(getEmptyToolPermissionContext(), setMode('auto')),
            /Cannot transition to auto mode: gate is not enabled/,
          )
          assert.equal(autoState.isAutoModeActive(), false)
        }
      `
      const featureFlags = feature('TRANSCRIPT_CLASSIFIER')
        ? ['--feature=TRANSCRIPT_CLASSIFIER']
        : []
      const child = Bun.spawn([process.execPath, '--no-env-file', ...featureFlags, '-e', source], {
        cwd: join(import.meta.dir, '../../..'),
        env: createSandboxedTestEnvironment(sandboxHome),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const timeout = setTimeout(() => child.kill(), 10_000)
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect(exitCode, stdout + stderr).toBe(0)
      } finally {
        clearTimeout(timeout)
        child.kill()
        await child.exited
        rmSync(sandboxHome, { recursive: true, force: true })
      }
    }, 15_000)
  }
})
