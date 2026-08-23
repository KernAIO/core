import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startCore, type TestCore } from '../testing/harness.js'

let core: TestCore
beforeAll(async () => {
  core = await startCore()
}, 120_000)
afterAll(async () => core?.stop())

describe('module diagnostics', () => {
  it('reports every hosted module, and finds nothing wrong with them', async () => {
    const admin = await core.signUp({ name: 'Admin' })
    await core.promoteToInstanceAdmin(admin.id)
    const api = await core.apiOf(admin.id)
    const reports = await api.admin.diagnostics()

    expect(reports.map((r) => r.id).sort()).toEqual(core.kernel.registry.ids().sort())

    for (const report of reports) {
      // The whole point: this is the check every module's own test does, run live.
      expect(report.missing, `${report.id} declares procedures it does not implement`).toEqual([])
      expect(report.undeclared, `${report.id} implements procedures it never declared`).toEqual([])
      expect(report.problems, `${report.id} has problems`).toEqual([])
      expect(report.procedures.length).toBeGreaterThan(0)
    }
  })

  it('names exactly the procedures reachable without signing in', async () => {
    const admin = await core.signUp({ name: 'Auditor' })
    await core.promoteToInstanceAdmin(admin.id)
    const api = await core.apiOf(admin.id)
    const reports = await api.admin.diagnostics()

    /*
     * These are public on purpose: a health check, a push key, an invitation preview, a plan
     * catalogue and an intake form. Anything else appearing here is a procedure that lost its gate,
     * which is exactly the kind of mistake nothing else would notice.
     */
    const publicProcedures = reports.flatMap((r) => r.public.map((p) => `${r.id}.${p}`)).sort()
    expect(publicProcedures).toEqual([
      // the plan catalogue a marketing site renders prices from
      'billing.plans.public',
      'core.health',
      // a browser needs this before it has a session
      'core.notifications.vapidPublicKey',
      // opened from an email, before the reader has an account
      'core.workspaces.invitations.preview',
      // the public intake form, reached by token
      'tracker.intake.form',
      'tracker.intake.submit',
    ])
  })

  it('is instance-admin only', async () => {
    const nobody = await core.signUp({ name: 'Nobody' })
    await expect(nobody.api.admin.diagnostics()).rejects.toThrow()
  })
})
