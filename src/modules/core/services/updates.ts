import { createPublicKey, verify as verifySignature } from 'node:crypto'
import type { core } from '@kernhq/contracts'
import { ReleaseFeed, UpdatePolicy } from '@kernhq/contracts/core'
import { KernError, type Kernel } from '@kernhq/kernel'
import { eq } from 'drizzle-orm'
import { gt as semverGt, lt as semverLt, valid as semverValid } from 'semver'
import { user } from '../schema/index.js'
import {
  clearInstanceSetting,
  getInstanceSetting,
  requireInstanceAdmin,
  setInstanceSetting,
} from './admin.js'
import type { Ctx } from './common.js'

/**
 * Telling an admin that a newer Kern exists.
 *
 * Kern is released as one platform: an upgrade moves every service image and every module together,
 * so there is nothing to install per module. What an admin needs instead is to know a release
 * happened, what it changes in the modules they use, whether anything stops them taking it, and the
 * command that applies it. That is all this does — it never touches the instance itself.
 *
 * The check is a plain GET for a static signed file. It sends nothing about the instance: no
 * identifier, no version, no query string, and it can be switched off entirely for an air-gapped
 * install. An unsigned or badly signed feed is treated as no feed at all.
 */

const POLICY_KEY = 'updates.policy'
const FEED_KEY = 'updates.feed'
const CACHE_KEY = 'updates.latest'
const SEEN_KEY = 'updates.announced'
const ATTEMPT_KEY = 'updates.lastAttempt'

/**
 * The newest stable release of the umbrella repository always serves this asset, so the default
 * needs no version in it and no separate hosting.
 */
export const DEFAULT_FEED_URL = 'https://github.com/KernAIO/kern/releases/latest/download/releases.json'

/**
 * Ed25519 public key (SPKI, base64) the release workflow signs the feed with. An instance that
 * publishes its own feed points `KERN_UPDATE_FEED_KEY` at its own key instead.
 */
const DEFAULT_FEED_PUBLIC_KEY = 'MCowBQYDK2VwAyEAfDg+pS7N//DcMo9Q1Nba0a0vBwkMI2APRC6IkBQ4MIY='

/** What the feed URL actually serves: exact signed bytes, plus the signature over those bytes. */
interface SignedDocument {
  payload: string
  signature: string
}

interface CachedFeed {
  checkedAt: string
  lastError: string | null
  releases: core.ReleaseEntry[]
}

async function policyOf(kernel: Kernel): Promise<core.UpdatePolicy> {
  const stored = await getInstanceSetting<Partial<core.UpdatePolicy>>(kernel, POLICY_KEY)
  // parse rather than spread: a policy written by an older version is filled in with the defaults
  // this one expects, instead of reaching the window check as undefined
  return UpdatePolicy.parse(stored ?? {})
}
async function feedUrlOf(kernel: Kernel): Promise<string> {
  return (await getInstanceSetting<string>(kernel, FEED_KEY)) ?? DEFAULT_FEED_URL
}

function publicKey(): string {
  return process.env.KERN_UPDATE_FEED_KEY ?? DEFAULT_FEED_PUBLIC_KEY
}

/**
 * Verify over the *bytes* that were signed rather than over a re-serialised object: re-encoding
 * JSON is not guaranteed to reproduce the same bytes, and a signature that only usually verifies is
 * worse than none.
 */
function verifiedPayload(doc: SignedDocument, keyBase64: string): unknown {
  const payload = Buffer.from(doc.payload, 'base64')
  const key = createPublicKey({
    key: Buffer.from(keyBase64, 'base64'),
    format: 'der',
    type: 'spki',
  })
  if (!verifySignature(null, payload, key, Buffer.from(doc.signature, 'base64')))
    throw new Error('signature does not match the release feed')
  return JSON.parse(payload.toString('utf8'))
}

/** Read the feed and cache what it said. Never throws: a failed check is reported, not fatal. */
export async function fetchFeed(kernel: Kernel): Promise<CachedFeed> {
  const checkedAt = new Date().toISOString()
  const key = publicKey()
  if (!key) {
    const cached = (await getInstanceSetting<CachedFeed>(kernel, CACHE_KEY)) ?? {
      checkedAt,
      lastError: null,
      releases: [],
    }
    return { ...cached, checkedAt, lastError: 'No release feed signing key is configured' }
  }
  try {
    const url = await feedUrlOf(kernel)
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { accept: 'application/json', 'user-agent': `Kern/${kernel.version}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`release feed answered ${res.status}`)
    const feed = ReleaseFeed.parse(verifiedPayload((await res.json()) as SignedDocument, key))
    const value: CachedFeed = {
      checkedAt,
      lastError: null,
      releases: feed.releases.filter((r) => r.channel === 'stable'),
    }
    await setInstanceSetting(kernel, CACHE_KEY, value)
    return value
  } catch (err) {
    const lastError = err instanceof Error ? err.message : String(err)
    const previous = await getInstanceSetting<CachedFeed>(kernel, CACHE_KEY)
    const value: CachedFeed = { checkedAt, lastError, releases: previous?.releases ?? [] }
    await setInstanceSetting(kernel, CACHE_KEY, value)
    kernel.log.warn({ err: lastError }, 'release feed check failed')
    return value
  }
}

/** The newest stable release in the feed, by semver rather than by position. */
function newest(releases: core.ReleaseEntry[]): core.ReleaseEntry | null {
  return releases.reduce<core.ReleaseEntry | null>((best, r) => {
    if (!semverValid(r.version)) return best
    return !best || semverGt(r.version, best.version) ? r : best
  }, null)
}

function moduleDiff(
  current: Array<{ id: string; version: string }>,
  next: Record<string, string>,
): core.ModuleVersionChange[] {
  const ids = [...new Set([...current.map((m) => m.id), ...Object.keys(next)])].sort()
  return ids.map((moduleId) => {
    const from = current.find((m) => m.id === moduleId)?.version ?? null
    const to = next[moduleId] ?? null
    const kind = !from ? 'added' : !to ? 'removed' : from === to ? 'unchanged' : 'changed'
    return { moduleId, from, to, kind }
  })
}

function blockersFor(currentVersion: string, release: core.ReleaseEntry): core.UpdateBlocker[] {
  const blockers: core.UpdateBlocker[] = []
  if (!semverValid(currentVersion))
    blockers.push({
      code: 'unknown_current_version',
      message:
        `This build reports "${currentVersion}", which is not a released version, so it cannot be ` +
        'compared with the feed. Upgrade a released instance instead.',
    })
  else if (release.minPreviousVersion && semverLt(currentVersion, release.minPreviousVersion))
    blockers.push({
      code: 'version_skip',
      message:
        `Kern ${release.version} can only be applied from ${release.minPreviousVersion} or newer. ` +
        `Upgrade to ${release.minPreviousVersion} first.`,
      details: { from: currentVersion, minPreviousVersion: release.minPreviousVersion },
    })
  const missing = release.requiredEnv.filter((name) => !process.env[name])
  if (missing.length)
    blockers.push({
      code: 'missing_env',
      message: `Set ${missing.join(', ')} in your .env before upgrading.`,
      details: { missing },
    })
  return blockers
}

function commandFor(release: core.ReleaseEntry): string {
  return `cd ~/kern && ./kern-upgrade.sh ${release.version}`
}

/**
 * Building an `Intl.DateTimeFormat` costs far more than using one, and the same zone is asked about
 * repeatedly. Keeping them costs a handful of objects; not keeping them cost 72ms of CPU on every
 * load of the updates screen, because the window scan built one per candidate minute.
 */
const clocks = new Map<string, Intl.DateTimeFormat>()
function clockFor(timezone: string): Intl.DateTimeFormat {
  let clock = clocks.get(timezone)
  if (!clock) {
    clock = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    clocks.set(timezone, clock)
  }
  return clock
}

/** Minutes since midnight, read in the policy's own zone rather than the server's. */
function minutesOfDayIn(timezone: string, at: Date): number {
  const parts = clockFor(timezone).formatToParts(at)
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
  return hour * 60 + minute
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/**
 * Is `at` inside the policy's window? A window that ends before it starts (22:00–02:00) is the one
 * somebody actually wants for an overnight upgrade, so it wraps past midnight rather than being
 * treated as empty.
 */
export function insideWindow(policy: core.UpdatePolicy, at: Date): boolean {
  let now: number
  try {
    now = minutesOfDayIn(policy.timezone, at)
  } catch {
    // an unknown zone must not silently become "always" — treat it as never, and the panel shows
    // the plan's reason
    return false
  }
  const start = toMinutes(policy.window.start)
  const end = toMinutes(policy.window.end)
  if (start === end) return false
  return start < end ? now >= start && now < end : now >= start || now < end
}

/**
 * The next moment the window opens, so the panel can say when rather than only whether.
 *
 * Worked out arithmetically rather than by trying every minute of the coming week. A daylight-saving
 * change in between can move the answer by an hour; that is acceptable for a line that reads "next
 * attempt", because the gate itself is `insideWindow` evaluated at the time, not this estimate.
 */
function nextWindowStart(policy: core.UpdatePolicy, at: Date): string | null {
  let now: number
  try {
    now = minutesOfDayIn(policy.timezone, at)
  } catch {
    return null
  }
  const start = toMinutes(policy.window.start)
  const end = toMinutes(policy.window.end)
  if (start === end) return null // an empty window never opens
  if (insideWindow(policy, at)) return at.toISOString()
  const until = start > now ? start - now : 1440 - now + start
  return new Date(at.getTime() + until * 60_000).toISOString()
}

async function buildStatus(kernel: Kernel, cached: CachedFeed | null): Promise<core.UpdateStatus> {
  const policy = await policyOf(kernel)
  const current = {
    version: kernel.version,
    modules: kernel.registry.all().map((m) => ({ id: m.definition.id, version: m.definition.version })),
  }
  const latest = cached ? newest(cached.releases) : null
  const available =
    latest !== null &&
    semverValid(kernel.version) !== null &&
    semverValid(latest.version) !== null &&
    semverGt(latest.version, kernel.version)

  const blockers = latest && available ? blockersFor(kernel.version, latest) : []
  const lastAttempt = await getInstanceSetting<core.AutoUpdateAttempt>(kernel, ATTEMPT_KEY)
  const now = new Date()
  return {
    policy,
    lastAttempt,
    nextAttemptAt: policy.mode === 'auto' ? nextWindowStart(policy, now) : null,
    plan: decide({ policy, latest, available, blockers, lastAttempt, now }),
    checkedAt: cached?.checkedAt ?? null,
    lastError: cached?.lastError ?? null,
    current,
    latest,
    updateAvailable: available,
    moduleChanges: latest && available ? moduleDiff(current.modules, latest.modules) : [],
    blockers,
    command: latest && available && blockers.length === 0 ? commandFor(latest) : null,
  }
}

/**
 * May this instance upgrade itself right now, and to what.
 *
 * It lives here rather than in the shell script so the panel and the thing that actually upgrades
 * cannot disagree about the answer — the script asks for this and obeys it.
 */
function decide(input: {
  policy: core.UpdatePolicy
  latest: core.ReleaseEntry | null
  available: boolean
  blockers: core.UpdateBlocker[]
  lastAttempt: core.AutoUpdateAttempt | null
  now: Date
}): core.UpdatePlan {
  const { policy, latest, available, blockers, lastAttempt, now } = input
  const no = (reason: string): core.UpdatePlan => ({ shouldUpgrade: false, version: null, reason, policy })

  if (policy.mode !== 'auto')
    return no(`Automatic updates are ${policy.mode === 'off' ? 'off' : 'set to notify only'}`)
  if (!latest || !available) return no('This instance is on the newest release')
  if (blockers.length) return no(`Blocked: ${blockers.map((b) => b.message).join(' ')}`)

  // A failed automatic upgrade gets a person, not another attempt at 03:00 tomorrow. Retrying the
  // release that just broke is how a nightly job turns one bad night into a week of them.
  if (lastAttempt && !lastAttempt.ok && lastAttempt.version === latest.version)
    return no(`The last automatic upgrade to ${latest.version} failed; apply it by hand to see why`)

  const ageHours = (now.getTime() - new Date(latest.publishedAt).getTime()) / 3_600_000
  if (ageHours < policy.minReleaseAgeHours)
    return no(
      `Kern ${latest.version} is ${Math.floor(ageHours)}h old; this instance waits ${policy.minReleaseAgeHours}h`,
    )

  if (!insideWindow(policy, now))
    return no(`Outside the update window (${policy.window.start}–${policy.window.end} ${policy.timezone})`)

  return {
    shouldUpgrade: true,
    version: latest.version,
    reason: `Kern ${latest.version} is ready to apply`,
    policy,
  }
}

export async function getStatus(ctx: Ctx): Promise<core.UpdateStatus> {
  requireInstanceAdmin(ctx)
  if ((await policyOf(ctx.kernel)).mode === 'off') return buildStatus(ctx.kernel, null)
  return buildStatus(ctx.kernel, await getInstanceSetting<CachedFeed>(ctx.kernel, CACHE_KEY))
}

export async function checkNow(ctx: Ctx): Promise<core.UpdateStatus> {
  requireInstanceAdmin(ctx)
  if ((await policyOf(ctx.kernel)).mode === 'off')
    throw KernError.conflict('Update checks are switched off for this instance', 'core.updates.off')
  return buildStatus(ctx.kernel, await fetchFeed(ctx.kernel))
}

export async function setPolicy(ctx: Ctx, patch: Partial<core.UpdatePolicy>): Promise<core.UpdateStatus> {
  requireInstanceAdmin(ctx)
  const next = UpdatePolicy.parse({ ...(await policyOf(ctx.kernel)), ...patch })
  // an unknown zone would silently mean "never inside the window", so refuse it here where somebody
  // is looking at the answer
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: next.timezone })
  } catch {
    throw KernError.badRequest(`"${next.timezone}" is not a time zone this system knows`)
  }
  await setInstanceSetting(ctx.kernel, POLICY_KEY, next)

  // A failed automatic upgrade holds the instance back until a person has looked at it. Turning
  // automatic updates on is that person saying they have — otherwise the hold has no exit except
  // upgrading by hand, and an admin who fixed the cause has no way to say so.
  if (patch.mode === 'auto') {
    const attempt = await getInstanceSetting<core.AutoUpdateAttempt>(ctx.kernel, ATTEMPT_KEY)
    if (attempt && !attempt.ok) await clearInstanceSetting(ctx.kernel, ATTEMPT_KEY)
  }

  if (next.mode === 'off') return buildStatus(ctx.kernel, null)
  return buildStatus(ctx.kernel, await fetchFeed(ctx.kernel))
}

/** What the host's timer asks before it upgrades anything. */
export async function getPlan(ctx: Ctx): Promise<core.UpdatePlan> {
  requireInstanceAdmin(ctx)
  const policy = await policyOf(ctx.kernel)
  if (policy.mode === 'off')
    return { shouldUpgrade: false, version: null, reason: 'Automatic updates are off', policy }
  return (await buildStatus(ctx.kernel, await fetchFeed(ctx.kernel))).plan as core.UpdatePlan
}

/**
 * Record what an automatic upgrade did. A failure is told to the admins rather than retried: the
 * next run reads this and stands down until a person has looked.
 */
export async function recordAttempt(
  kernel: Kernel,
  attempt: { version: string; ok: boolean; error?: string | null },
): Promise<core.AutoUpdateAttempt> {
  const value: core.AutoUpdateAttempt = {
    version: attempt.version,
    at: new Date().toISOString(),
    ok: attempt.ok,
    error: attempt.error ?? null,
  }
  await setInstanceSetting(kernel, ATTEMPT_KEY, value)
  kernel.log[attempt.ok ? 'info' : 'error'](
    { version: value.version, err: value.error },
    attempt.ok ? 'automatic upgrade applied' : 'automatic upgrade failed',
  )
  return value
}

export async function instanceAdminIds(kernel: Kernel): Promise<string[]> {
  const rows = await kernel.database.db.select({ id: user.id }).from(user).where(eq(user.instanceAdmin, true))
  return rows.map((r) => r.id)
}

/**
 * The scheduled check. Returns who to tell about what, and only the first time a release is seen —
 * an admin who never opens the updates screen would otherwise not find out at all, and one who has
 * already been told does not want it again every six hours.
 */
export async function runScheduledCheck(
  kernel: Kernel,
): Promise<{ release: core.ReleaseEntry; adminIds: string[] } | null> {
  if ((await policyOf(kernel)).mode === 'off') return null
  const status = await buildStatus(kernel, await fetchFeed(kernel))
  if (!status.updateAvailable || !status.latest) return null

  if ((await getInstanceSetting<string>(kernel, SEEN_KEY)) === status.latest.version) return null
  await setInstanceSetting(kernel, SEEN_KEY, status.latest.version)

  return { release: status.latest, adminIds: await instanceAdminIds(kernel) }
}
