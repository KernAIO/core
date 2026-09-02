import { generateKeyPairSync, sign as signBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { core as contracts } from '@kernhq/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clearInstanceSetting, setInstanceSetting } from '../modules/core/services/admin.js'
import { fetchFeed, insideWindow } from '../modules/core/services/updates.js'
import { startCore, type TestCore, type TestUser } from '../testing/harness.js'

/**
 * What an admin is told about a newer Kern.
 *
 * Kern is released as one platform, so this screen is the only place a per-module version change is
 * ever visible: an upgrade moves every module at once, and "tracker goes 0.1.3 → 0.2.0" is the part
 * an admin actually cares about. The check itself is a plain GET for a signed static file, so the
 * feed is seeded here directly rather than reached over the network — what is worth proving is the
 * comparison, the blockers, and that none of it is visible to somebody who is not an instance admin.
 */

let core: TestCore
let admin: TestUser
let member: TestUser

const release = (over: Record<string, unknown> = {}) => ({
  version: '9.9.9',
  channel: 'stable' as const,
  publishedAt: '2026-08-22T00:00:00.000Z',
  notesUrl: 'https://github.com/KernAIO/app/releases/tag/v9.9.9',
  services: { core: '9.9.9', app: '9.9.9' },
  modules: { core: '9.9.9', tracker: '9.9.9' },
  minPreviousVersion: null,
  schemaChanges: 'additive' as const,
  requiredEnv: [] as string[],
  ...over,
})

/** Stand in for a completed check, so the status is computed from a known feed. */
async function seedFeed(releases: Array<ReturnType<typeof release>>) {
  await setInstanceSetting(core.kernel, 'updates.latest', {
    checkedAt: '2026-08-22T00:00:00.000Z',
    lastError: null,
    releases,
  })
}

beforeAll(async () => {
  core = await startCore()
  admin = await core.signUp({ name: 'Instance Admin' })
  member = await core.signUp({ name: 'Ordinary Member' })
  await core.promoteToInstanceAdmin(admin.id)
  admin = { ...admin, api: await core.apiOf(admin.id) }
}, 180_000)

afterAll(async () => {
  await core?.stop()
})

describe('platform updates', () => {
  it('reports what this instance runs, module by module', async () => {
    await seedFeed([])
    const status = await admin.api.admin.updates.get()

    expect(status.current.version).toBe(core.kernel.version)
    const ids = status.current.modules.map((m) => m.id)
    expect(ids).toContain('core')
    expect(ids).toContain('tracker')
    // every module reports the version of the package it ships in, never a literal somebody typed
    for (const m of status.current.modules) expect(m.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(status.updateAvailable).toBe(false)
  })

  it('offers a newer release and says what it does to each module', async () => {
    await seedFeed([release()])
    const status = await admin.api.admin.updates.get()

    expect(status.updateAvailable).toBe(true)
    expect(status.latest?.version).toBe('9.9.9')
    expect(status.command).toContain('9.9.9')

    const tracker = status.moduleChanges.find((c) => c.moduleId === 'tracker')
    expect(tracker?.kind).toBe('changed')
    expect(tracker?.to).toBe('9.9.9')
    expect(tracker?.from).toBe(status.current.modules.find((m) => m.id === 'tracker')?.version)
  })

  it('picks the newest release by version, not by position in the feed', async () => {
    await seedFeed([release({ version: '9.9.9' }), release({ version: '9.10.0' })])
    expect((await admin.api.admin.updates.get()).latest?.version).toBe('9.10.0')
  })

  it('refuses to offer a release this instance is too far behind to take', async () => {
    await seedFeed([release({ minPreviousVersion: '9.0.0' })])
    const status = await admin.api.admin.updates.get()

    expect(status.updateAvailable).toBe(true)
    expect(status.blockers.map((b) => b.code)).toContain('version_skip')
    // there is an update, but no command: applying it from here is not a supported jump
    expect(status.command).toBeNull()
  })

  it('names the environment variables a release needs before it can be applied', async () => {
    await seedFeed([release({ requiredEnv: ['KERN_SOMETHING_NEW'] })])
    const status = await admin.api.admin.updates.get()

    expect(status.blockers.map((b) => b.code)).toContain('missing_env')
    expect(status.blockers.find((b) => b.code === 'missing_env')?.message).toContain('KERN_SOMETHING_NEW')
    expect(status.command).toBeNull()
  })

  it('checks nothing and offers nothing once an admin switches updates off', async () => {
    await seedFeed([release()])
    const off = await admin.api.admin.updates.setPolicy({ mode: 'off' })
    expect(off.policy.mode).toBe('off')
    expect(off.updateAvailable).toBe(false)
    expect(off.latest).toBeNull()
    expect(off.nextAttemptAt).toBeNull()

    // switching it back on reads the feed again, and a check that fails is reported rather than
    // silently reporting the instance as current. The real feed is signed and reachable now, so
    // point this instance at a feed that is not — the default URL answered a genuine feed from CI
    // the day the signing key was configured, and this asserted on the network instead of the code.
    await setInstanceSetting(core.kernel, 'updates.feed', 'http://127.0.0.1:9/releases.json')
    try {
      const on = await admin.api.admin.updates.setPolicy({ mode: 'notify' })
      expect(on.policy.mode).toBe('notify')
      expect(on.lastError).toBeTruthy()
    } finally {
      await clearInstanceSetting(core.kernel, 'updates.feed')
    }
    await seedFeed([release()])
  })

  it('is not readable by an ordinary member', async () => {
    await expect(member.api.admin.updates.get()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

/**
 * The feed is fetched over the public internet from a static file, so its signature is the only
 * thing standing between an instance and somebody else's idea of what it should upgrade to. A
 * signature that verifies most of the time is worse than none, because it reads as protection.
 */
describe('the release feed signature', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')

  let server: Server
  let body = ''

  /** Serve exactly the bytes the generator would write. */
  const serve = (feedObject: unknown, tamper?: (payload: string) => string) => {
    const payload = Buffer.from(JSON.stringify(feedObject), 'utf8')
    const signature = signBytes(null, payload, privateKey).toString('base64')
    const served = tamper ? Buffer.from(tamper(payload.toString('utf8')), 'utf8') : payload
    body = JSON.stringify({ payload: served.toString('base64'), signature })
  }

  const feedWith = (version: string) => ({
    schema: 1,
    generatedAt: '2026-08-22T00:00:00.000Z',
    releases: [
      {
        version,
        channel: 'stable',
        publishedAt: '2026-08-22T00:00:00.000Z',
        notesUrl: null,
        services: { core: version },
        modules: { core: version },
        minPreviousVersion: null,
        schemaChanges: 'additive',
        requiredEnv: [],
      },
    ],
  })

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(body)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    process.env.KERN_UPDATE_FEED_KEY = publicBase64
    await setInstanceSetting(core.kernel, 'updates.feed', `http://127.0.0.1:${port}/releases.json`)
  })

  afterAll(async () => {
    process.env.KERN_UPDATE_FEED_KEY = undefined
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('accepts a feed signed with the key it trusts', async () => {
    serve(feedWith('9.9.9'))
    const result = await fetchFeed(core.kernel)
    expect(result.lastError).toBeNull()
    expect(result.releases.map((r) => r.version)).toEqual(['9.9.9'])
  })

  it('rejects a feed whose contents were changed after signing', async () => {
    serve(feedWith('9.9.9'), (payload) => payload.replace('9.9.9', '9.9.10'))
    const result = await fetchFeed(core.kernel)
    expect(result.lastError).toContain('signature')
    expect(result.releases.map((r) => r.version)).not.toContain('9.9.10')
  })

  it('rejects a feed signed with some other key', async () => {
    const other = generateKeyPairSync('ed25519')
    const payload = Buffer.from(JSON.stringify(feedWith('9.9.9')), 'utf8')
    body = JSON.stringify({
      payload: payload.toString('base64'),
      signature: signBytes(null, payload, other.privateKey).toString('base64'),
    })
    expect((await fetchFeed(core.kernel)).lastError).toContain('signature')
  })

  it('keeps the last good answer when a check fails, rather than forgetting it', async () => {
    serve(feedWith('9.9.9'))
    await fetchFeed(core.kernel)
    body = 'not json at all'
    const result = await fetchFeed(core.kernel)
    expect(result.lastError).toBeTruthy()
    expect(result.releases.map((r) => r.version)).toEqual(['9.9.9'])
  })
})

/**
 * What the interface sees while an upgrade is applying.
 *
 * Migrations run with services still up, so without this the app shows a wall of failed requests
 * and an admin cannot tell an upgrade from an outage. Health and readiness have to keep answering
 * through it, because they are how the upgrade itself knows when a service is back.
 */
describe('maintenance mode', () => {
  afterAll(async () => {
    await core.kernel.maintenance.end()
  })

  it('answers 503 with Retry-After on the API, and keeps health answerable', async () => {
    const app = core.service.app
    expect(app, 'the test service runs an HTTP server').toBeTruthy()

    const before = await app!.inject({ method: 'GET', url: '/api/core/health' })
    expect(before.statusCode).toBe(200)

    await core.kernel.maintenance.begin('Kern is being upgraded', '9.9.9')

    const during = await app!.inject({ method: 'GET', url: '/api/core/health' })
    expect(during.statusCode).toBe(503)
    expect(during.headers['retry-after']).toBe('15')
    expect(during.json()).toMatchObject({ code: 'MAINTENANCE', message: 'Kern is being upgraded' })

    // the two the upgrade polls stay open, or it can never tell that the service came back
    expect((await app!.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200)
    expect((await app!.inject({ method: 'GET', url: '/api/ready' })).statusCode).toBe(200)

    await core.kernel.maintenance.end()
    expect((await app!.inject({ method: 'GET', url: '/api/core/health' })).statusCode).toBe(200)
  })
})

/**
 * When an instance is allowed to upgrade itself.
 *
 * This is the only code in Kern that changes the software people are running without anybody
 * present, so every reason it declines matters as much as the one time it agrees. The decision is
 * computed here rather than in the shell script on purpose: what the panel shows and what happens
 * at 03:00 have to be the same answer.
 */
describe('insideWindow', () => {
  const policy = (over: Partial<contracts.UpdatePolicy> = {}): contracts.UpdatePolicy => ({
    mode: 'auto',
    window: { start: '03:00', end: '05:00' },
    timezone: 'UTC',
    minReleaseAgeHours: 72,
    ...over,
  })
  const at = (iso: string) => new Date(iso)

  it('is open between start and end', () => {
    expect(insideWindow(policy(), at('2026-08-22T03:30:00Z'))).toBe(true)
    expect(insideWindow(policy(), at('2026-08-22T02:59:00Z'))).toBe(false)
    expect(insideWindow(policy(), at('2026-08-22T05:00:00Z'))).toBe(false)
  })

  it('wraps past midnight, which is the window people actually want', () => {
    const overnight = policy({ window: { start: '22:00', end: '02:00' } })
    expect(insideWindow(overnight, at('2026-08-22T23:30:00Z'))).toBe(true)
    expect(insideWindow(overnight, at('2026-08-22T01:30:00Z'))).toBe(true)
    expect(insideWindow(overnight, at('2026-08-22T12:00:00Z'))).toBe(false)
  })

  it('reads the window in its own zone, not the server’s', () => {
    const istanbul = policy({ timezone: 'Europe/Istanbul' })
    // 00:30 UTC is 03:30 in Istanbul
    expect(insideWindow(istanbul, at('2026-08-22T00:30:00Z'))).toBe(true)
    expect(insideWindow(istanbul, at('2026-08-22T03:30:00Z'))).toBe(false)
  })

  it('treats an empty window as closed rather than as always', () => {
    expect(
      insideWindow(policy({ window: { start: '03:00', end: '03:00' } }), at('2026-08-22T03:00:00Z')),
    ).toBe(false)
  })

  it('treats a zone it cannot read as closed, never as open', () => {
    expect(insideWindow(policy({ timezone: 'Mars/Olympus_Mons' }), at('2026-08-22T03:30:00Z'))).toBe(false)
  })
})

describe('the automatic upgrade decision', () => {
  /** A window that is open right now, in UTC, whatever time the suite runs at. */
  const openNow = () => {
    const now = new Date()
    const start = `${String(now.getUTCHours()).padStart(2, '0')}:00`
    const end = `${String((now.getUTCHours() + 1) % 24).padStart(2, '0')}:00`
    return { start, end }
  }
  /** A window that is closed right now: the hour after next. */
  const closedNow = () => {
    const h = (new Date().getUTCHours() + 2) % 24
    return { start: `${String(h).padStart(2, '0')}:00`, end: `${String((h + 1) % 24).padStart(2, '0')}:00` }
  }
  const old = () => new Date(Date.now() - 30 * 24 * 3_600_000).toISOString()

  beforeAll(async () => {
    await clearInstanceSetting(core.kernel, 'updates.lastAttempt')
  })

  it('declines while the mode is notify, however ready everything else is', async () => {
    await seedFeed([release({ publishedAt: old() })])
    const status = await admin.api.admin.updates.setPolicy({ mode: 'notify' })
    expect(status.plan?.shouldUpgrade).toBe(false)
    expect(status.plan?.reason).toContain('notify')
  })

  it('agrees when the mode is auto, the window is open and the release has settled', async () => {
    await seedFeed([release({ publishedAt: old() })])
    const status = await admin.api.admin.updates.setPolicy({
      mode: 'auto',
      window: openNow(),
      timezone: 'UTC',
      minReleaseAgeHours: 1,
    })
    expect(status.plan).toMatchObject({ shouldUpgrade: true, version: '9.9.9' })
    expect(status.nextAttemptAt).toBeTruthy()
  })

  it('waits out a release that is younger than the policy allows', async () => {
    await seedFeed([release({ publishedAt: new Date().toISOString() })])
    const status = await admin.api.admin.updates.setPolicy({
      mode: 'auto',
      window: openNow(),
      minReleaseAgeHours: 72,
    })
    expect(status.plan?.shouldUpgrade).toBe(false)
    expect(status.plan?.reason).toContain('72h')
  })

  it('stays out of the working day when the window is closed', async () => {
    await seedFeed([release({ publishedAt: old() })])
    const status = await admin.api.admin.updates.setPolicy({
      mode: 'auto',
      window: closedNow(),
      minReleaseAgeHours: 1,
    })
    expect(status.plan?.shouldUpgrade).toBe(false)
    expect(status.plan?.reason).toContain('Outside the update window')
  })

  it('will not upgrade to a version that stops it, however open the window is', async () => {
    await seedFeed([release({ publishedAt: old(), minPreviousVersion: '9.0.0' })])
    const status = await admin.api.admin.updates.setPolicy({
      mode: 'auto',
      window: openNow(),
      minReleaseAgeHours: 1,
    })
    expect(status.plan?.shouldUpgrade).toBe(false)
    expect(status.plan?.reason).toContain('Blocked')
  })

  it('stands down after a failure instead of retrying the release that broke', async () => {
    await seedFeed([release({ publishedAt: old() })])
    // arm it first, then let a failure land: setting the policy is itself the admin's "try again"
    await admin.api.admin.updates.setPolicy({ mode: 'auto', window: openNow(), minReleaseAgeHours: 1 })
    await setInstanceSetting(core.kernel, 'updates.lastAttempt', {
      version: '9.9.9',
      at: new Date().toISOString(),
      ok: false,
      error: 'core did not become ready',
    })
    const status = await admin.api.admin.updates.get()
    expect(status.plan?.shouldUpgrade).toBe(false)
    expect(status.plan?.reason).toContain('failed')
    expect(status.lastAttempt?.ok).toBe(false)

    // turning automatic updates on again is the admin saying they have looked, so the hold lifts
    const rearmed = await admin.api.admin.updates.setPolicy({
      mode: 'auto',
      window: openNow(),
      minReleaseAgeHours: 1,
    })
    expect(rearmed.lastAttempt).toBeNull()
    expect(rearmed.plan?.shouldUpgrade).toBe(true)
  })

  it('refuses a time zone it cannot read rather than never opening the window', async () => {
    await expect(
      admin.api.admin.updates.setPolicy({ mode: 'auto', timezone: 'Mars/Olympus_Mons' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('is not settable by an ordinary member', async () => {
    await expect(member.api.admin.updates.setPolicy({ mode: 'off' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })
})
