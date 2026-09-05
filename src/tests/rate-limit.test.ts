/**
 * Better Auth's per-IP limiter is only per IP if it can work out the IP.
 *
 * Behind more than one proxy — Kern Cloud is Cloudflare → Coolify → Caddy → core — `X-Forwarded-For`
 * carries several entries, and Better Auth refuses to believe a multi-entry header unless it is told
 * which hops to trust. With nothing configured it resolved *no* address, fell back to a single
 * shared key, and applied the sign-in rule to the whole instance at once: three sign-ins per ten
 * seconds for everybody, so ordinary people were refused sign-in because somebody else had signed
 * in. `advanced.ipAddress.trustedProxies` is what makes the bucket per person again.
 *
 * This drives the real handler, because the limiter runs in the router's `onRequest` and a direct
 * `auth.api.*` call never reaches it.
 */
import { describe, expect, it } from 'vitest'
import { PRIVATE_PROXY_RANGES, RATE_LIMIT, trustedProxies } from '../auth/auth.js'
import type { CoreEnv } from '../env.js'
import { startCore, type TestCore } from '../testing/harness.js'

describe('trusted proxies', () => {
  it('trusts the private ranges the shipped Caddyfile trusts', () => {
    const proxies = trustedProxies({} as CoreEnv)
    expect(proxies).toEqual([...PRIVATE_PROXY_RANGES])
    // the ranges Caddy's `private_ranges` shorthand covers
    for (const cidr of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', '::1/128'])
      expect(proxies).toContain(cidr)
  })

  it('adds the public proxies an operator names, without repeating one', () => {
    const proxies = trustedProxies({
      KERN_TRUSTED_PROXIES: ' 173.245.48.0/20 , 2400:cb00::/32 ,10.0.0.0/8, ',
    } as CoreEnv)
    expect(proxies).toContain('173.245.48.0/20')
    expect(proxies).toContain('2400:cb00::/32')
    expect(proxies.filter((p) => p === '10.0.0.0/8')).toHaveLength(1)
  })

  it('sets its own limits rather than inheriting Better Auth’s 3-per-10-seconds', () => {
    expect(RATE_LIMIT.rules['/sign-in/*']).toEqual({ window: 60, max: 10 })
    // an exact path has to be listed above the wildcard that also matches it, because Better Auth
    // takes the first key that matches
    const keys = Object.keys(RATE_LIMIT.rules)
    expect(keys.indexOf('/sign-in/magic-link')).toBeLessThan(keys.indexOf('/sign-in/*'))
  })
})

describe('sign-in rate limit', () => {
  let core: TestCore

  const signIn = (core: TestCore, forwardedFor: string) => {
    const base = core.service.deps.env.BETTER_AUTH_URL ?? core.kernel.env.CORE_URL
    return core.service.deps.auth.handler(
      new Request(`${base.replace(/\/$/, '')}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
        body: JSON.stringify({ email: 'nobody@example.test', password: 'not-the-password' }),
      }),
    )
  }

  it('gives two clients behind the same proxy chain two buckets', async () => {
    core = await startCore()
    try {
      // one office and one home address, both arriving through Caddy (private) as the last hop
      const officeChain = '198.51.100.11, 10.42.0.7'
      const homeChain = '203.0.113.22, 10.42.0.7'

      const limit = RATE_LIMIT.rules['/sign-in/*'].max
      const statuses: number[] = []
      for (let i = 0; i < limit; i++) statuses.push((await signIn(core, officeChain)).status)
      // every attempt was refused for the *right* reason: wrong credentials, not the limiter
      expect(
        statuses.every((s) => s !== 429),
        `statuses: ${statuses.join(',')}`,
      ).toBe(true)
      expect(statuses.every((s) => s === 401 || s === 400 || s === 403)).toBe(true)

      // the office has now used its allowance
      expect((await signIn(core, officeChain)).status).toBe(429)

      // and the person at home, one hop behind the same proxy, is unaffected — this is the whole
      // point: without `trustedProxies` both chains resolve to no IP and share one bucket
      expect((await signIn(core, homeChain)).status).not.toBe(429)
    } finally {
      await core?.stop()
    }
  })
})
