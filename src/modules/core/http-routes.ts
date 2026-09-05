/**
 * The reachable surface of export and erasure.
 *
 * **Why these are `httpRoutes` and not oRPC procedures.** Everything a Kern client calls belongs in
 * the module's router, where it gets typing, the OpenAPI document, the SDK and every middleware for
 * free — and that is where these belong too. They are not there because the router is
 * `implement(coreContract)`, and `coreContract` lives in `@kernhq/contracts`, which is a package in
 * another repository: adding a procedure to it is a contracts-first change that has to land and
 * publish before core can consume it. Rather than ship the engine with nothing able to reach it,
 * the routes are mounted here, under the same prefix, with the checks written out by hand.
 *
 * That is a deliberate, temporary shape and it costs three things a contract procedure would have
 * given: no generated client, no entry in `/api/core/openapi.json`, and no `workspaceScoped`. So
 * everything `workspaceScoped` would have done is done explicitly below — resolve the principal,
 * refuse anonymous, check membership unless the caller is an instance admin or a service, then check
 * the permission. **Moving these into `coreContract` is the follow-up**, and when it happens this
 * file goes away rather than growing.
 *
 * Note what is deliberately *not* gated on the workspace being usable: an export and a deletion both
 * stay available to an archived or suspended workspace. Withholding the service for an unpaid
 * invoice is one thing; refusing to let a customer take their data out or have it erased because
 * their card expired is another, and it is the reading of "read-only" that the billing module's own
 * copy already promises against.
 */
import type { Principal } from '@kernhq/contracts'
import { httpStatusFor, KernError, type Kernel, type ModuleHttpRoute } from '@kernhq/kernel'
import { eq } from 'drizzle-orm'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { toHeaders } from '../../auth/principal.js'
import type { CoreDeps } from './deps.js'
import { user as userTable } from './schema/index.js'
import * as deletion from './services/deletion.js'
import * as exportsSvc from './services/exports.js'

const WorkspaceBody = z.object({ workspaceId: z.uuid(), reason: z.string().max(500).optional() })
const ReasonBody = z.object({ reason: z.string().max(500).optional() })

/** Everything `workspaceScoped` does, written out, because a raw route gets none of it. */
async function scope(
  kernel: Kernel,
  deps: CoreDeps,
  request: FastifyRequest,
  workspaceId: string,
  permission: string,
): Promise<Principal> {
  const principal = await deps.principals.resolve(request)
  if (principal.kind === 'anonymous') throw KernError.unauthorized()
  if (!principal.instanceAdmin && principal.kind !== 'service')
    kernel.authz.requireMember(principal, workspaceId)
  await kernel.authz.require(principal, permission, {
    kind: 'workspace',
    id: workspaceId,
    workspaceId,
  })
  return principal
}

async function authed(deps: CoreDeps, request: FastifyRequest): Promise<Principal> {
  const principal = await deps.principals.resolve(request)
  if (principal.kind === 'anonymous' || !principal.userId) throw KernError.unauthorized()
  return principal
}

/** Who a request speaks for on the undo path, and whether their account is already closed. */
interface Closable {
  userId: string
  instanceAdmin: boolean
  /** the account is suspended with an open deletion request: only the undo routes accept this */
  closed: boolean
}

/**
 * The one place a **closed** account still authenticates, and only to read or cancel its own
 * closure.
 *
 * Closing an account suspends the user row and deletes every session, and `principal.ts` answers
 * ANONYMOUS for any non-active user on every credential path there is — cookie, bearer, JWT, API
 * key, MCP token. So `authed()` refused the cancel route with a 401 for the whole of the grace
 * period, and the 30-day undo the terms and the privacy policy both promise could not be reached by
 * the person it was promised to. On a self-hosted instance whose only administrator closed their own
 * account, nobody could reach it at all.
 *
 * The narrowing that makes this safe is deliberate and worth stating:
 *
 * - **Sessions only.** Better Auth knows nothing of `users.status`, so a closed account can still
 *   sign in and be handed a session; that session is what is read here. An API key, a JWT and an MCP
 *   token all resolve through `fromUserId` and stay anonymous — a machine credential must not be
 *   able to undo a closure.
 * - **Suspended, not deleted.** Once the purge has run the row is anonymised and there is nothing to
 *   restore; `'deleted'` is refused like any other status.
 * - **An open request has to exist.** An account suspended by an administrator for some other reason
 *   is not a closure, and does not get an authenticated door here.
 */
async function authedOrClosed(kernel: Kernel, deps: CoreDeps, request: FastifyRequest): Promise<Closable> {
  const principal = await deps.principals.resolve(request)
  if (principal.kind !== 'anonymous' && principal.userId)
    return { userId: principal.userId, instanceAdmin: principal.instanceAdmin, closed: false }

  const session = await deps.auth.api.getSession({ headers: toHeaders(request) }).catch(() => null)
  const sessionUserId = session?.user?.id
  if (!sessionUserId) throw KernError.unauthorized()

  const [row] = await kernel.database.db
    .select({ id: userTable.id, status: userTable.status, instanceAdmin: userTable.instanceAdmin })
    .from(userTable)
    .where(eq(userTable.id, sessionUserId))
    .limit(1)
  if (row?.status !== 'suspended') throw KernError.unauthorized()
  if (!(await deletion.pending(kernel, 'account', row.id))) throw KernError.unauthorized()
  return { userId: row.id, instanceAdmin: row.instanceAdmin, closed: true }
}

/**
 * Answer a `KernError` the way the oRPC handler would, so a client sees one error vocabulary across
 * both surfaces. Anything else is a 500 with nothing of the internals in it.
 */
function fail(kernel: Kernel, reply: FastifyReply, err: unknown) {
  if (err instanceof KernError)
    return reply
      .status(httpStatusFor(err.code))
      .send({ code: err.code, message: err.message, reason: err.reason, details: err.details })
  kernel.log.error({ err }, 'unhandled error in a core http route')
  return reply.status(500).send({ code: 'INTERNAL', message: 'Internal error' })
}

const parse = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> => {
  const r = schema.safeParse(value ?? {})
  if (!r.success)
    throw KernError.badRequest('Invalid request body', { issues: r.error.issues.map((i) => i.message) })
  return r.data
}

export function coreHttpRoutes(deps: CoreDeps): ModuleHttpRoute[] {
  const route = (
    method: ModuleHttpRoute['method'],
    path: string,
    handler: (ctx: {
      kernel: Kernel
      request: FastifyRequest
      reply: FastifyReply
      body: unknown
    }) => Promise<unknown>,
  ): ModuleHttpRoute => ({
    method,
    path,
    handler: async (ctx) => {
      try {
        return await handler(ctx as never)
      } catch (err) {
        return fail(ctx.kernel, ctx.reply, err)
      }
    },
  })

  return [
    // ---------------------------------------------------------------- export
    route('POST', '/exports', async ({ kernel, request, reply, body }) => {
      const input = parse(WorkspaceBody, body)
      const principal = await scope(kernel, deps, request, input.workspaceId, 'core.export.run')
      const record = await exportsSvc.request(kernel, {
        workspaceId: input.workspaceId,
        requestedBy: principal.userId ?? kernel.system.userId ?? input.workspaceId,
      })
      return reply.status(202).send(record)
    }),
    route('GET', '/exports', async ({ kernel, request }) => {
      const workspaceId = parse(z.object({ workspaceId: z.uuid() }), request.query).workspaceId
      await scope(kernel, deps, request, workspaceId, 'core.export.run')
      return { items: await exportsSvc.list(kernel, workspaceId) }
    }),
    route('GET', '/exports/:id', async ({ kernel, request }) => {
      const { workspaceId } = parse(z.object({ workspaceId: z.uuid() }), request.query)
      const { id } = request.params as { id: string }
      await scope(kernel, deps, request, workspaceId, 'core.export.run')
      return exportsSvc.get(kernel, workspaceId, id)
    }),
    /**
     * A short-lived presigned URL rather than a redirect: the caller may be a script following a
     * poll loop, and handing it the URL lets it decide when to spend the ninety seconds of download
     * rather than having the API do it inside this request.
     */
    route('GET', '/exports/:id/download', async ({ kernel, request }) => {
      const { workspaceId } = parse(z.object({ workspaceId: z.uuid() }), request.query)
      const { id } = request.params as { id: string }
      await scope(kernel, deps, request, workspaceId, 'core.export.run')
      return exportsSvc.downloadUrl(kernel, workspaceId, id)
    }),

    // -------------------------------------------------------- workspace erasure
    route('POST', '/workspaces/:workspaceId/deletion', async ({ kernel, request, reply, body }) => {
      const { workspaceId } = request.params as { workspaceId: string }
      const input = parse(ReasonBody, body)
      const principal = await scope(kernel, deps, request, workspaceId, 'core.workspace.delete')
      const record = await deletion.scheduleWorkspaceDeletion(kernel, {
        workspaceId,
        requestedBy: principal.userId ?? workspaceId,
        reason: input.reason ?? null,
      })
      return reply.status(202).send(record)
    }),
    route('GET', '/workspaces/:workspaceId/deletion', async ({ kernel, request }) => {
      const { workspaceId } = request.params as { workspaceId: string }
      await scope(kernel, deps, request, workspaceId, 'core.workspace.delete')
      const record = await deletion.pending(kernel, 'workspace', workspaceId)
      if (!record) throw KernError.notFound('Scheduled deletion')
      return record
    }),
    route('DELETE', '/workspaces/:workspaceId/deletion', async ({ kernel, request }) => {
      const { workspaceId } = request.params as { workspaceId: string }
      const principal = await scope(kernel, deps, request, workspaceId, 'core.workspace.delete')
      return deletion.cancelWorkspaceDeletion(kernel, {
        workspaceId,
        actorId: principal.userId ?? workspaceId,
      })
    }),

    // ---------------------------------------------------------- account erasure
    /**
     * Closing your own account needs no permission key and never will: a permission is something a
     * workspace grants you over its data, and this is your own account. It is `userId`-scoped
     * instead — you may close yours, and an instance admin may close somebody's on request, which
     * is what a support desk actually receives.
     */
    route('POST', '/account/deletion', async ({ kernel, request, reply, body }) => {
      const principal = await authed(deps, request)
      const input = parse(ReasonBody.extend({ userId: z.uuid().optional() }), body)
      const userId = input.userId ?? principal.userId!
      if (userId !== principal.userId && !principal.instanceAdmin) throw KernError.forbidden()
      const record = await deletion.scheduleAccountDeletion(kernel, {
        userId,
        requestedBy: principal.userId!,
        reason: input.reason ?? null,
      })
      return reply.status(202).send(record)
    }),
    /**
     * Readable and cancellable **by the closed account itself**, which is the whole point of a
     * window you are told you can change your mind in. `userId` is for an instance admin acting on
     * a support request, the same asymmetry `POST` already has.
     */
    route('GET', '/account/deletion', async ({ kernel, request }) => {
      const caller = await authedOrClosed(kernel, deps, request)
      const { userId } = parse(z.object({ userId: z.uuid().optional() }), request.query)
      const subject = userId ?? caller.userId
      // a closed account speaks for itself and nobody else, admin or not
      if (subject !== caller.userId && (caller.closed || !caller.instanceAdmin)) throw KernError.forbidden()
      const record = await deletion.pending(kernel, 'account', subject)
      if (!record) throw KernError.notFound('Scheduled deletion')
      return record
    }),
    route('DELETE', '/account/deletion', async ({ kernel, request, body }) => {
      const caller = await authedOrClosed(kernel, deps, request)
      const input = parse(z.object({ userId: z.uuid().optional() }), body)
      const subject = input.userId ?? caller.userId
      // a closed account speaks for itself and nobody else, admin or not
      if (subject !== caller.userId && (caller.closed || !caller.instanceAdmin)) throw KernError.forbidden()
      return deletion.cancelAccountDeletion(kernel, { userId: subject, actorId: caller.userId })
    }),
  ]
}
