import { ANONYMOUS, type MembershipSummary, type Principal } from '@kernhq/contracts'
import { type Kernel, systemPrincipal } from '@kernhq/kernel'
import { eq } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from 'jose'
import type { McpOauth } from '../mcp/oauth.js'
import { MODULE_ID } from '../modules/core/schema/base.js'
import { memberships, session as sessionTable, user } from '../modules/core/schema/index.js'
import { audienceAllows, CAPABILITY_AUDIENCE_KEY } from '../modules/core/services/capability-audience.js'
import { getModuleSettings } from '../modules/core/services/modules.js'
import type { Auth } from './auth.js'

const READ_METHODS = new Set(['GET', 'HEAD'])

interface ApiKeyMetadata {
  workspaceId: string
  scope: 'read' | 'read_write'
}
function readApiKeyMetadata(raw: unknown): ApiKeyMetadata | null {
  const v =
    typeof raw === 'string'
      ? (() => {
          try {
            return JSON.parse(raw) as Record<string, unknown>
          } catch {
            return null
          }
        })()
      : (raw as Record<string, unknown> | null)
  if (!v || typeof v.workspaceId !== 'string') return null
  return { workspaceId: v.workspaceId, scope: v.scope === 'read_write' ? 'read_write' : 'read' }
}

type UserRow = typeof user.$inferSelect
type UserLike = Pick<
  UserRow,
  'id' | 'email' | 'name' | 'locale' | 'instanceAdmin' | 'permissionVersion' | 'status'
>

/**
 * What an MCP token is being asked to authorise: the module the request targets, and whether it
 * writes. Everything else here needs no such context — a session, a JWT and an API key mean the
 * same thing whatever they are pointed at — so this travels only with an MCP token.
 */
export interface McpNeed {
  module: string
  write: boolean
}

export interface PrincipalResolver {
  /** Fastify hook used by the kernel HTTP server */
  resolve(req: FastifyRequest): Promise<Principal>
  /**
   * resolve any bearer credential (session token, JWT, API key) – used by `core.users.principal`.
   *
   * `need` is what an **MCP** token is held to, and it is required for one to authenticate anything
   * at all: see `mcpPrincipal`. A caller that omits it gets ANONYMOUS for a `kmt_` token, which is
   * the fail-closed half of the boundary that `chat`, `mail` and `collab` sit behind.
   */
  fromToken(token: string, need?: McpNeed): Promise<Principal>
  fromUserId(userId: string): Promise<Principal>
  fromUser(u: UserLike, kind?: Principal['kind']): Promise<Principal>
  /**
   * The user behind a **genuine interactive session** on this request — one this instance issued
   * and still holds a row for — whatever that user's status is. Null for every other credential.
   *
   * This exists for the one route that has to authenticate a *suspended* user (the undo on a closed
   * account, in `http-routes.ts`), where `resolve` correctly answers ANONYMOUS and the question
   * underneath is "did a person sign in, or is this a machine credential?". Asking Better Auth
   * directly does not answer it: see `sessionRow` for what `getSession` really means.
   */
  sessionUserId(req: FastifyRequest): Promise<string | null>
  /** drop cached memberships (null = everyone) */
  invalidate(userIds: string[] | null): void
}

const CACHE_TTL_MS = 30_000
const JWKS_TTL_MS = 5 * 60_000

export function createPrincipalResolver(opts: {
  kernel: Kernel
  auth: Auth
  mcp?: McpOauth
}): PrincipalResolver {
  const { kernel, auth, mcp } = opts
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
  /**
   * A personal API key acts for the user who created it, in the one workspace it was created for —
   * the same narrowing `fromMcpToken` does for an MCP connection, and for the same reason: a key
   * granted `read` in one workspace must not turn out to be able to read (or write) a workspace it
   * never named, however many others its owner belongs to.
   *
   * The capability and its audience are re-checked on every use rather than once at creation, so
   * switching `api_keys` off — or narrowing its audience, or removing this person from an allowed
   * group — revokes every key it governs immediately, with no separate cleanup step.
   */
  async function fromApiKey(key: string): Promise<Principal | null> {
    try {
      const res = await auth.api.verifyApiKey({ body: { key } })
      if (!res.valid || !res.key) return null
      const raw = res.key as { referenceId?: string; userId?: string; metadata?: unknown }
      const userId = raw.referenceId ?? raw.userId
      if (!userId) return null
      const meta = readApiKeyMetadata(raw.metadata)
      if (!meta) return null // a key predating this scheme, or one this resolver cannot interpret, authenticates nobody
      const p = await fromUserId(userId)
      if (p.kind === 'anonymous') return null
      const membership = p.memberships.find(
        (m) => m.workspaceId === meta.workspaceId && m.status === 'active',
      )
      if (!membership) return null
      const caps = await kernel.capabilities(meta.workspaceId, MODULE_ID)
      if (!caps.has('api_keys')) return null
      const settings = await getModuleSettings(kernel, meta.workspaceId, MODULE_ID)
      if (!audienceAllows(settings[CAPABILITY_AUDIENCE_KEY], 'api_keys', membership.groupIds)) return null
      return { ...p, kind: 'api_key', memberships: [membership], apiKeyScope: meta.scope }
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

  /**
   * The session row behind a request, or null — which is a stricter question than `getSession`.
   *
   * `auth.api.getSession` answers "is there **any** credential in these headers Better Auth is
   * willing to turn into a session?", and that is not the same thing. The api-key plugin ran with
   * `enableSessionForAPIKeys` when this was written, which registers a `before` hook on
   * `/get-session`: given an `x-api-key` header it validates the key, loads its owner and returns a
   * session object it made up on the spot — `session.id` is the API key's id, `session.token` is
   * the key itself, and no row in `sessions` was ever involved. It does not read `users.status`
   * either. So a guard written to admit only a person who signed in admitted any credential Better
   * Auth would manufacture one from, and `DELETE /api/core/account/deletion` carrying nothing but
   * `x-api-key` reopened its own closed account — with a **read**-scoped key as readily as a
   * writing one.
   *
   * That option is off now (`auth.ts` says why, and it was doing far worse elsewhere), which is a
   * reason to keep this check rather than to drop it: the option is one line away from coming back,
   * plugins are added, and a guard that depends on a library's configuration staying a particular
   * way is not a guard.
   *
   * Hence two barriers rather than a fix at the call site. Better Auth is handed only the two
   * headers a session actually travels in, so it never sees a credential that is not one; and the
   * session it returns has to name a live row this instance issued, so anything manufactured is
   * refused however it arrived and whichever plugin made it. The row is matched on `token`, not on
   * `id`: `sessions.id` is a `uuid` column and a made-up id need not be one, and a query that
   * throws would be a 500 where a refusal belongs.
   */
  async function sessionRow(req: FastifyRequest): Promise<{ userId: string } | null> {
    const s = await auth.api.getSession({ headers: sessionHeaders(req) }).catch(() => null)
    const claimed = s?.session as { id?: string; token?: string } | undefined
    if (!s?.user?.id || !claimed?.token || !claimed.id) return null
    const [row] = await db
      .select({ id: sessionTable.id, userId: sessionTable.userId, expiresAt: sessionTable.expiresAt })
      .from(sessionTable)
      .where(eq(sessionTable.token, claimed.token))
      .limit(1)
    if (!row || row.id !== claimed.id || row.userId !== s.user.id) return null
    if (row.expiresAt.getTime() <= Date.now()) return null
    return { userId: row.userId }
  }
  /**
   * An MCP access token (`kmt_…`) acts for the user who consented — but only inside the one
   * workspace the consent named. Filtering the memberships here is what enforces that boundary
   * everywhere at once: every downstream membership check sees a principal that belongs to no other
   * workspace, however broad the user's own roles are.
   *
   * The scopes travel back with it so `resolve` can hold the request to them. They are not on the
   * `Principal` because `Principal` is `@kernhq/contracts`, and a field there is a platform change;
   * the enforcement site is one function away instead.
   */
  async function fromMcpToken(
    tokenValue: string,
  ): Promise<{ principal: Principal; scopes: string[] } | null> {
    const token = await mcp?.verifyAccessToken(tokenValue)
    if (!token) return null
    const p = await fromUserId(token.userId)
    if (p.kind === 'anonymous') return null
    const scoped = p.memberships.filter((m) => m.workspaceId === token.workspaceId && m.status === 'active')
    if (scoped.length === 0) return null
    return { principal: { ...p, kind: 'user', memberships: scoped }, scopes: token.scopes }
  }

  /** `/api/<prefix>/…` → the module hosted here under that prefix, or null for anything else. */
  function moduleForPath(pathname: string): string | null {
    const prefix = /^\/api\/([^/]+)/.exec(pathname)?.[1]
    if (!prefix) return null
    for (const mod of kernel.registry.all())
      if ((mod.definition.apiPrefix ?? mod.definition.id) === prefix) return mod.definition.id
    return null
  }
  async function fromToken(token: string, need?: McpNeed): Promise<Principal> {
    if (token.startsWith('kmt_')) return mcpPrincipal(token, need ?? null)
    const h = new Headers({ authorization: `Bearer ${token}` })
    return (
      (await fromSession(h)) ??
      (token.split('.').length === 3 ? await fromJwt(token) : null) ??
      (await fromApiKey(token)) ??
      ANONYMOUS
    )
  }

  /**
   * An MCP token authenticates only for what its consent screen said, and only over the module APIs.
   *
   * The scopes a person ticks are `<module>:read` and `<module>:write`, and `/mcp` has always held
   * tool calls to them — but nothing held the *token* to them. It resolved into the user's full
   * principal, so an AI client granted read-only access to one module could `POST /api/tracker`,
   * `/api/hr`, `/api/quire`, `/api/billing` and `/api/inventory` with everything its owner may do.
   * The consent screen was describing something that was never enforced.
   *
   * Out of scope is `ANONYMOUS`, not `forbidden`, for the same reason a read-only API key is
   * (below): the credential simply does not authenticate this request, which is what every other
   * unusable credential here produces. A path that is not a module API — Better Auth, `/api/health`,
   * `/mcp` itself, which verifies its own bearer — authenticates nobody at all: an MCP token is a
   * key to module data and to nothing else.
   *
   * **The check has to take the need as an argument, because core is not the only host.** It first
   * shipped reading `FastifyRequest` inside `resolve`, which meant it covered exactly the modules
   * core serves and nothing else: `chat`, `mail` and `collab` resolve the very same token through
   * `core.users.principal`, that broker call passed the token alone, and so an MCP token became a
   * *full* principal there — a read-only one could write. Not a private matter between services,
   * either: the shipped Caddyfiles route `/api/chat/*`, `/api/mail/*` and `/collab*` to those
   * services **from the edge**, so the token holder reaches them directly. `resolve` now derives
   * the need from its own request and every other host states it, which is why `fromToken` refuses
   * a `kmt_` token that arrives without one.
   */
  async function mcpPrincipal(token: string, need: McpNeed | null): Promise<Principal> {
    const out = await fromMcpToken(token)
    if (!out) return ANONYMOUS
    // No need supplied → nothing to hold the token to → it authenticates nothing. See `fromToken`.
    if (!need) return ANONYMOUS
    return out.scopes.includes(`${need.module}:${need.write ? 'write' : 'read'}`) ? out.principal : ANONYMOUS
  }

  /** The need a request made against *this* service expresses, or null if it is not a module API. */
  function needForRequest(req: FastifyRequest): McpNeed | null {
    const moduleId = moduleForPath((req.url ?? '').split('?')[0] ?? '')
    return moduleId ? { module: moduleId, write: !READ_METHODS.has(req.method) } : null
  }

  return {
    fromToken,
    fromUserId,
    fromUser,
    async sessionUserId(req) {
      return (await sessionRow(req))?.userId ?? null
    },
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
      const p = await (async () => {
        // 2. API key header
        const apiKeyHeader = req.headers['x-api-key']
        if (typeof apiKeyHeader === 'string' && apiKeyHeader)
          return (await fromApiKey(apiKeyHeader)) ?? ANONYMOUS
        // 3. bearer: session token (bearer plugin) → JWT → API key
        const authz = req.headers.authorization
        if (typeof authz === 'string' && authz.toLowerCase().startsWith('bearer ')) {
          const token = authz.slice(7).trim()
          if (!token) return ANONYMOUS
          if (token.startsWith('kmt_')) return mcpPrincipal(token, needForRequest(req))
          return fromToken(token)
        }
        // 4. cookie session — `sessionHeaders`, not `headers`: Better Auth must not be handed a
        // credential that is not a session and asked to find one. See `sessionRow`.
        if (req.headers.cookie) return (await fromSession(sessionHeaders(req))) ?? ANONYMOUS
        return ANONYMOUS
      })()
      /**
       * A `read` key authenticates nothing for a mutating request — not "authenticated but
       * forbidden", but the same ANONYMOUS every other bad credential produces here. The scope was
       * the one thing this person chose when they made the key; enforcing it anywhere looser would
       * make that choice decorative.
       */
      if (p.kind === 'api_key' && p.apiKeyScope === 'read' && !READ_METHODS.has(req.method)) return ANONYMOUS
      return p
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

/**
 * The two headers a Better Auth **session** travels in, and nothing else.
 *
 * Anything asking Better Auth about a session gets these rather than the whole request. Handing it
 * every header is handing it every credential — `x-api-key` above all, which its api-key plugin
 * turns into a session before `/get-session` looks anything up. `authorization` stays because the
 * `bearer` plugin is how a client without a cookie jar carries the same session token; a token in
 * it that is not a session simply matches nothing.
 */
export function sessionHeaders(req: FastifyRequest): Headers {
  const h = new Headers()
  for (const name of ['cookie', 'authorization'] as const) {
    const v = req.headers[name]
    if (typeof v === 'string' && v) h.append(name, v)
  }
  return h
}
