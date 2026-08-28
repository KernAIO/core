import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startCore, type TestCore, type TestUser } from '../testing/harness.js'

/**
 * Limits, enforced by core and decided by a module core does not import.
 *
 * The important half of this suite is the beginning and the end: a workspace with no plan is
 * unlimited, and a workspace whose plan is taken away is unlimited again. That is what every
 * self-hosted Kern does on every request, and a regression there would not fail loudly — it would
 * quietly start refusing invitations on installations that never bought anything.
 */

let core: TestCore
let owner: TestUser
/** Two workspaces: one that never has a plan, one that gets one. Bytes uploaded into the free
 * workspace must not count against the limited one — which is exactly the mistake this split
 * prevents in the test itself. */
let freeWs: string
let workspaceId: string

/** Billing's shape, narrowed to what this test uses; core does not depend on its types. */
type BillingApi = {
  plans: {
    upsert(input: Record<string, unknown>): Promise<{ id: string; slug: string }>
  }
  admin: {
    setPlan(input: Record<string, unknown>): Promise<{ status: string }>
  }
}

const LIMITS = {
  seats: 2,
  storageBytes: 1000,
  modules: ['core', 'billing'],
  sso: false,
  auditRetentionDays: null,
  apiRateLimit: null,
}

async function billing(): Promise<BillingApi> {
  return core.moduleApi('billing', await core.principalOf(owner.id)) as BillingApi
}

/** Put the workspace on a plan with the limits above. */
async function applyPlan() {
  const api = await billing()
  const plan = await api.plans.upsert({
    slug: 'test-team',
    name: 'Test Team',
    description: '',
    priceMinor: 800,
    currency: 'usd',
    interval: 'month',
    perSeat: true,
    trialDays: 0,
    limits: LIMITS,
    stripePriceId: null,
    highlights: [],
    published: true,
    order: 10,
  })
  await api.admin.setPlan({ workspaceId, planId: plan.id })
}

beforeAll(async () => {
  core = await startCore()
  owner = await core.signUp({ name: 'Plan Owner' })
  const stamp = Date.now().toString(36)
  freeWs = (await owner.api.workspaces.create({ name: 'Free', slug: `free-${stamp}` })).id
  workspaceId = (await owner.api.workspaces.create({ name: 'Limits', slug: `limits-${stamp}` })).id
  await core.promoteToInstanceAdmin(owner.id)
  owner.api = await core.apiOf(owner.id)
}, 180_000)

afterAll(async () => {
  await core?.stop()
})

describe('with nothing billing', () => {
  it('invites without a seat limit', async () => {
    const [inv] = await owner.api.workspaces.invitations.create({
      workspaceId: freeWs,
      invites: [{ email: `free-${Date.now().toString(36)}@example.test`, role: 'member' }],
    })
    expect(inv?.email).toContain('@example.test')
  })

  it('issues an upload ticket without a storage limit', async () => {
    const ticket = await owner.api.files.createUpload({
      workspaceId: freeWs,
      name: 'big.bin',
      mimeType: 'application/octet-stream',
      size: 5_000_000,
    })
    expect(ticket.url).toContain('http')
  })
})

describe('with a plan', () => {
  beforeAll(async () => {
    await applyPlan()
  })

  it('refuses the invitation that would exceed the seats, and names the limit', async () => {
    // the owner holds one seat, and the free-plan invite above is still pending rather than accepted
    const err = await owner.api.workspaces.invitations
      .create({
        workspaceId,
        invites: [
          { email: `a-${Date.now().toString(36)}@example.test`, role: 'member' },
          { email: `b-${Date.now().toString(36)}@example.test`, role: 'member' },
          { email: `c-${Date.now().toString(36)}@example.test`, role: 'member' },
        ],
      })
      .catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/2 seats/)
  })

  it('does not charge a seat for a guest', async () => {
    const [inv] = await owner.api.workspaces.invitations.create({
      workspaceId,
      invites: [
        {
          email: `guest-${Date.now().toString(36)}@example.test`,
          role: 'guest',
          guestScopes: [],
        },
      ],
    })
    expect(inv?.role).toBe('guest')
  })

  it('refuses an upload past the storage limit before the ticket is issued', async () => {
    const err = await owner.api.files
      .createUpload({
        workspaceId,
        name: 'too-big.bin',
        mimeType: 'application/octet-stream',
        size: 2000,
      })
      .catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/storageBytes|plan/i)
  })

  it('allows an upload that fits', async () => {
    const ticket = await owner.api.files.createUpload({
      workspaceId,
      name: 'small.bin',
      mimeType: 'application/octet-stream',
      size: 100,
    })
    expect(ticket.file.size).toBe(100)
  })

  it('refuses to enable a module the plan does not include', async () => {
    const err = await owner.api.workspaces.modules
      .setEnabled({ workspaceId, moduleId: 'tracker', enabled: true })
      .catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/Test Team/)
  })
})

describe('when the plan is taken away', () => {
  it('is unlimited again, without anything being reconfigured', async () => {
    const api = await billing()
    await api.admin.setPlan({ workspaceId, planId: null })
    const ticket = await owner.api.files.createUpload({
      workspaceId,
      name: 'unlimited.bin',
      mimeType: 'application/octet-stream',
      size: 9_000_000,
    })
    expect(ticket.file.size).toBe(9_000_000)
    await expect(
      owner.api.workspaces.modules.setEnabled({ workspaceId, moduleId: 'tracker', enabled: true }),
    ).resolves.toBeTruthy()
  })
})
