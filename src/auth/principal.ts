import { ANONYMOUS, type MembershipSummary, type Principal } from '@kernaio/contracts'
import { type Kernel, systemPrincipal } from '@kernaio/kernel'
import { eq } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from 'jose'
import { memberships, user } from '../modules/core/schema/index.js'
import type { Auth } from './auth.js'

type UserRow = typeof user.$inferSelect
type UserLike = Pick<
  UserRow,
  'id' | 'email' | 'name' | 'locale' | 'instanceAdmin' | 'permissionVersion' | 'status'
>

export interface PrincipalResolver {
  /** Fastify hook used by the kernel HTTP server */
  resolve(req: FastifyRequest): Promise<Principal>
  /** resolve any bearer credential (session token, JWT, API key) – used by `core.users.principal` */
  fromToken(token: string): Promise<Principal>
  fromUserId(userId: string): Promise<Principal>
  fromUser(u: UserLike, kind?: Principal['kind']): Promise<Principal>
  /** drop cached memberships (null = everyone) */
  invalidate(userIds: string[] | null): void
}

const CACHE_TTL_MS = 30_000
const JWKS_TTL_MS = 5 * 60_000

export function createPrincipalResolver(opts: { kernel: Kernel; auth: Auth }): PrincipalResolver {
  const { kernel, auth } = opts
  const db = kernel.database.db
  const cache = new Map<string, { v: MembershipSummary[]; exp: number }>()
  let jwks: { set: ReturnType<typeof createLocalJWKSet>; exp: number } | null = null

  async function loadMemberships(userId: string, pv: number): Promise<MembershipSummary[]> {
    const key = `${userId}:${pv}`
    const hit = cache.get(key)
    if (hit && hit.exp > Date.now()) return hit.v
    const rows = await db
      .select({
        workspaceId: memberships.workspaceId,
        role: memberships.role,
        roleIds: memberships.roleIds,
        groupIds: memberships.groupIds,
        status: memberships.status,
      })
      .from(memberships)
      .where(eq(memberships.userId, userId))
    const v: MembershipSummary[] = rows.map((r) => ({
      workspaceId: r.workspaceId as MembershipSummary['workspaceId'],
      role: r.role as MembershipSummary['role'],
      roleIds: r.roleIds,
      groupIds: r.groupIds,
      status: r.status as MembershipSummary['status'],
    }))
    cache.set(key, { v, exp: Date.now() + CACHE_TTL_MS })
    if (cache.size > 10_000) for (const [k, e] of cache) if (e.exp < Date.now()) cache.delete(k)
    return v
  }

  async function fromUser(u: UserLike, kind: Principal['kind'] = 'user'): Promise<Principal> {
    if (u.status !== 'active') return ANONYMOUS
    return {
      kind,
      userId: u.id as Principal['userId'],
      email: u.email,
      name: u.name,
      locale: (['en', 'fa', 'ar', 'de'].includes(u.locale) ? u.locale : 'en') as Principal['locale'],
      instanceAdmin: u.instanceAdmin,
      service: null,
      memberships: await loadMemberships(u.id, u.permissionVersion),
      permissionVersion: u.permissionVersion,
    }
  }
  async function fromUserId(userId: string): Promise<Principal> {
    const [u] = await db.select().from(user).where(eq(user.id, userId)).limit(1)
    return u ? fromUser(u) : ANONYMOUS
  }
  async function getJwks() {
    if (jwks && jwks.exp > Date.now()) return jwks.set
    const set = (await auth.api.getJwks()) as JSONWebKeySet
    jwks = { set: createLocalJWKSet(set), exp: Date.now() + JWKS_TTL_MS }
    return jwks.set
  }
  async function fromJwt(token: string): Promise<Principal | null> {
    try {
      const { payload } = await jwtVerify(token, await getJwks())
      if (!payload.sub) return null
      const p = await fromUserId(payload.sub)
      if (p.kind === 'anonymous') return null
      return p
    } catch {
      jwks = null // key rotation → refetch next time
      return null
    }
  }
  async function fromApiKey(key: string): Promise<Principal | null> {
    try {
      const res = await auth.api.verifyApiKey({ body: { key } })
      if (!res.valid || !res.key) return null
      const userId =
        (res.key as { referenceId?: string; userId?: string }).referenceId ??
        (res.key as { userId?: string }).userId
      if (!userId) return null
      const p = await fromUserId(userId)
      return p.kind === 'anonymous' ? null : { ...p, kind: 'api_key' }
    } catch {
      return null
    }
  }
  async function fromSession(headers: Headers): Promise<Principal | null> {
    try {
      const s = await auth.api.getSession({ headers })
      if (!s?.user) return null
      const p = await fromUser(s.user as unknown as UserLike)
      return p.kind === 'anonymous' ? null : p
    } catch {
      return null
    }
  }
  async function fromToken(token: string): Promise<Principal> {
    const h = new Headers({ authorization: `Bearer ${token}` })
    return (
      (await fromSession(h)) ??
      (token.split('.').length === 3 ? await fromJwt(token) : null) ??
      (await fromApiKey(token)) ??
      ANONYMOUS
    )
  }

  return {
    fromToken,
    fromUserId,
    fromUser,
    invalidate(userIds) {
      if (!userIds) cache.clear()
      else for (const k of cache.keys()) if (userIds.some((u) => k.startsWith(`${u}:`))) cache.delete(k)
    },
    async resolve(req) {
      // 1. service → service
      const svc = req.headers['x-kern-service']
      if (typeof svc === 'string' && svc) {
        const name = await kernel.auth.verifyService(svc)
        if (!name) return ANONYMOUS
        // a service may act on behalf of a user it already authenticated
        const onBehalf = req.headers['x-kern-user-id']
        if (typeof onBehalf === 'string' && onBehalf) return fromUserId(onBehalf)
        return systemPrincipal(name)
      }
      const headers = toHeaders(req)
      // 2. API key header
      const apiKeyHeader = req.headers['x-api-key']
      if (typeof apiKeyHeader === 'string' && apiKeyHeader)
        return (await fromApiKey(apiKeyHeader)) ?? ANONYMOUS
      // 3. bearer: session token (bearer plugin) → JWT → API key
      const authz = req.headers.authorization
      if (typeof authz === 'string' && authz.toLowerCase().startsWith('bearer ')) {
        const token = authz.slice(7).trim()
        if (!token) return ANONYMOUS
        return fromToken(token)
      }
      // 4. cookie session
      if (req.headers.cookie) return (await fromSession(headers)) ?? ANONYMOUS
      return ANONYMOUS
    },
  }
}

export function toHeaders(req: FastifyRequest): Headers {
  const h = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    if (Array.isArray(v)) for (const x of v) h.append(k, x)
    else h.append(k, v)
  }
  return h
}
