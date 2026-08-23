import { coreContract } from '@kernhq/contracts'
import { authed, type Kernel, type RequestContext, requires, workspaceScoped } from '@kernhq/kernel'
import { implement } from '@orpc/server'
import type { CoreDeps } from './deps.js'
import { MODULE_ID } from './schema/base.js'
import * as activity from './services/activity.js'
import * as admin from './services/admin.js'
import type { Ctx } from './services/common.js'
import * as dashboard from './services/dashboard.js'
import * as filesSvc from './services/files.js'
import * as groups from './services/groups.js'
import * as invitations from './services/invitations.js'
import * as members from './services/members.js'
import * as modules from './services/modules.js'
import * as notifications from './services/notifications.js'
import * as roles from './services/roles.js'
import * as search from './services/search.js'
import * as updates from './services/updates.js'
import * as users from './services/users.js'
import * as workspaces from './services/workspaces.js'

const os = implement(coreContract).$context<RequestContext>()

/**
 * HTTP surface of the core module (mounted by the kernel at /api/core and /api/core/rpc).
 * Handlers stay thin: auth/permission middleware here, domain logic in `services/*`.
 */
export function createCoreRouter(kernel: Kernel, deps: CoreDeps) {
  const ctxOf = (context: RequestContext): Ctx => ({ kernel, principal: context.principal })
  const auth = os.use(authed)
  const scoped = os.use(workspaceScoped(MODULE_ID))

  return os.router({
    health: os.health.handler(async () => ({
      ok: true,
      service: kernel.service,
      version: kernel.version,
      modules: kernel.registry.all().map((m) => ({ id: m.definition.id, version: m.definition.version })),
    })),

    users: {
      me: auth.users.me.handler(async ({ context }) => users.me(ctxOf(context))),
      updateMe: auth.users.updateMe.handler(async ({ input, context }) =>
        users.updateMe(ctxOf(context), input),
      ),
      get: auth.users.get.handler(async ({ input, context }) => users.getPublic(ctxOf(context), input.id)),
      directory: auth.users.directory.handler(async ({ input, context }) =>
        users.directory(ctxOf(context), input),
      ),
    },

    workspaces: {
      list: auth.workspaces.list.handler(async ({ context }) => workspaces.list(ctxOf(context))),
      create: auth.workspaces.create.handler(async ({ input, context }) =>
        workspaces.create(ctxOf(context), input),
      ),
      get: scoped.workspaces.get.handler(async ({ input, context }) =>
        workspaces.get(ctxOf(context), input.workspaceId),
      ),
      update: scoped.workspaces.update
        .use(requires('core.workspace.manage'))
        .handler(async ({ input, context }) =>
          workspaces.update(ctxOf(context), input.workspaceId, input.patch),
        ),
      archive: scoped.workspaces.archive
        .use(requires('core.workspace.delete'))
        .handler(async ({ input, context }) => workspaces.archive(ctxOf(context), input.workspaceId)),
      myPermissions: scoped.workspaces.myPermissions.handler(async ({ input, context }) =>
        workspaces.myPermissions(ctxOf(context), input.workspaceId),
      ),

      members: {
        list: scoped.workspaces.members.list
          .use(requires('core.members.view'))
          .handler(async ({ input, context }) => members.list(ctxOf(context), input)),
        update: scoped.workspaces.members.update
          .use(requires('core.members.manage'))
          .handler(async ({ input, context }) => members.update(ctxOf(context), input)),
        remove: scoped.workspaces.members.remove
          .use(requires('core.members.manage'))
          .handler(async ({ input, context }) => {
            await members.remove(ctxOf(context), input.workspaceId, input.userId)
            return { ok: true as const }
          }),
        leave: scoped.workspaces.members.leave.handler(async ({ input, context }) => {
          await members.leave(ctxOf(context), input.workspaceId)
          return { ok: true as const }
        }),
      },

      invitations: {
        list: scoped.workspaces.invitations.list
          .use(requires('core.members.invite'))
          .handler(async ({ input, context }) => invitations.list(ctxOf(context), input.workspaceId)),
        create: scoped.workspaces.invitations.create
          .use(requires('core.members.invite'))
          .handler(async ({ input, context }) => invitations.create(ctxOf(context), deps, input)),
        revoke: scoped.workspaces.invitations.revoke
          .use(requires('core.members.invite'))
          .handler(async ({ input, context }) => {
            await invitations.revoke(ctxOf(context), input.workspaceId, input.id)
            return { ok: true as const }
          }),
        preview: os.workspaces.invitations.preview.handler(async ({ input, context }) =>
          invitations.preview(ctxOf(context), input.token),
        ),
        accept: auth.workspaces.invitations.accept.handler(async ({ input, context }) =>
          invitations.accept(ctxOf(context), input.token),
        ),
      },

      roles: {
        list: scoped.workspaces.roles.list
          .use(requires('core.members.view'))
          .handler(async ({ input, context }) => roles.list(ctxOf(context), input.workspaceId)),
        create: scoped.workspaces.roles.create
          .use(requires('core.roles.manage'))
          .handler(async ({ input, context }) => roles.create(ctxOf(context), input.workspaceId, input)),
        update: scoped.workspaces.roles.update
          .use(requires('core.roles.manage'))
          .handler(async ({ input, context }) =>
            roles.update(ctxOf(context), input.workspaceId, input.id, input.patch),
          ),
        delete: scoped.workspaces.roles.delete
          .use(requires('core.roles.manage'))
          .handler(async ({ input, context }) => {
            await roles.remove(ctxOf(context), input.workspaceId, input.id)
            return { ok: true as const }
          }),
        permissions: auth.workspaces.roles.permissions.handler(async () => roles.permissionRegistry(kernel)),
        bindings: {
          list: scoped.workspaces.roles.bindings.list
            .use(requires('core.roles.manage'))
            .handler(async ({ input, context }) =>
              roles.listBindings(ctxOf(context), input.workspaceId, {
                scopeKind: input.scopeKind,
                scopeId: input.scopeId,
              }),
            ),
          set: scoped.workspaces.roles.bindings.set
            .use(requires('core.roles.manage'))
            .handler(async ({ input, context }) =>
              roles.setBinding(ctxOf(context), input.workspaceId, input.binding),
            ),
          delete: scoped.workspaces.roles.bindings.delete
            .use(requires('core.roles.manage'))
            .handler(async ({ input, context }) => {
              await roles.deleteBinding(ctxOf(context), input.workspaceId, input.id)
              return { ok: true as const }
            }),
        },
      },

      groups: {
        list: scoped.workspaces.groups.list
          .use(requires('core.members.view'))
          .handler(async ({ input, context }) => groups.list(ctxOf(context), input.workspaceId)),
        create: scoped.workspaces.groups.create
          .use(requires('core.members.manage'))
          .handler(async ({ input, context }) => groups.create(ctxOf(context), input.workspaceId, input)),
        update: scoped.workspaces.groups.update
          .use(requires('core.members.manage'))
          .handler(async ({ input, context }) =>
            groups.update(ctxOf(context), input.workspaceId, input.id, input.patch),
          ),
        delete: scoped.workspaces.groups.delete
          .use(requires('core.members.manage'))
          .handler(async ({ input, context }) => {
            await groups.remove(ctxOf(context), input.workspaceId, input.id)
            return { ok: true as const }
          }),
        setMembers: scoped.workspaces.groups.setMembers
          .use(requires('core.members.manage'))
          .handler(async ({ input, context }) =>
            groups.setMembers(ctxOf(context), input.workspaceId, input.id, input.userIds),
          ),
        members: scoped.workspaces.groups.members
          .use(requires('core.members.view'))
          .handler(async ({ input, context }) => groups.members(ctxOf(context), input.workspaceId, input.id)),
      },

      modules: {
        list: scoped.workspaces.modules.list.handler(async ({ input, context }) =>
          modules.list(ctxOf(context), input.workspaceId),
        ),
        setEnabled: scoped.workspaces.modules.setEnabled
          .use(requires('core.modules.manage'))
          .handler(async ({ input, context }) =>
            modules.setEnabled(ctxOf(context), input.workspaceId, input.moduleId, input.enabled),
          ),
        updateSettings: scoped.workspaces.modules.updateSettings
          .use(requires('core.modules.manage'))
          .handler(async ({ input, context }) =>
            modules.updateSettings(ctxOf(context), input.workspaceId, input.moduleId, input.settings),
          ),
      },

      audit: scoped.workspaces.audit
        .use(requires('core.audit.view'))
        .handler(async ({ input, context }) => activity.list(ctxOf(context), input)),
    },

    /**
     * `get`, `save` and `reset` are membership-only: they touch the caller's own row, and every
     * widget drawn inside is gated by the procedure it calls. The `settings` group reuses
     * `core.workspace.manage` — whoever sets the workspace logo sets its home page.
     */
    dashboard: {
      get: scoped.dashboard.get.handler(async ({ input, context }) => dashboard.get(ctxOf(context), input)),
      save: scoped.dashboard.save.handler(async ({ input, context }) =>
        dashboard.save(ctxOf(context), input),
      ),
      reset: scoped.dashboard.reset.handler(async ({ input, context }) =>
        dashboard.reset(ctxOf(context), input),
      ),
      settings: {
        get: scoped.dashboard.settings.get
          .use(requires('core.workspace.manage'))
          .handler(async ({ input, context }) => dashboard.settingsGet(ctxOf(context), input)),
        set: scoped.dashboard.settings.set
          .use(requires('core.workspace.manage'))
          .handler(async ({ input, context }) => dashboard.settingsSet(ctxOf(context), input)),
        saveWorkspace: scoped.dashboard.settings.saveWorkspace
          .use(requires('core.workspace.manage'))
          .handler(async ({ input, context }) => dashboard.saveWorkspace(ctxOf(context), input)),
      },
    },

    notifications: {
      list: auth.notifications.list.handler(async ({ input, context }) =>
        notifications.list(ctxOf(context), input),
      ),
      counts: auth.notifications.counts.handler(async ({ context }) => notifications.counts(ctxOf(context))),
      markRead: auth.notifications.markRead.handler(async ({ input, context }) =>
        notifications.markRead(ctxOf(context), input),
      ),
      archive: auth.notifications.archive.handler(async ({ input, context }) =>
        notifications.archive(ctxOf(context), input.id),
      ),
      types: auth.notifications.types.handler(async () => notifications.types(kernel)),
      settings: auth.notifications.settings.handler(async ({ context }) =>
        notifications.getSettings(ctxOf(context)),
      ),
      updateSettings: auth.notifications.updateSettings.handler(async ({ input, context }) =>
        notifications.updateSettings(ctxOf(context), input),
      ),
      subscribePush: auth.notifications.subscribePush.handler(async ({ input, context }) => {
        await notifications.subscribePush(ctxOf(context), input)
        return { ok: true as const }
      }),
      unsubscribePush: auth.notifications.unsubscribePush.handler(async ({ input, context }) => {
        await notifications.unsubscribePush(ctxOf(context), input.endpoint)
        return { ok: true as const }
      }),
      vapidPublicKey: os.notifications.vapidPublicKey.handler(async ({ context }) => {
        const vapid = await notifications.getVapid(ctxOf(context), deps)
        return { publicKey: vapid?.publicKey ?? null }
      }),
    },

    files: {
      createUpload: scoped.files.createUpload
        .use(requires('core.files.upload'))
        .handler(async ({ input, context }) => filesSvc.createUpload(ctxOf(context), deps, input)),
      complete: auth.files.complete.handler(async ({ input, context }) =>
        filesSvc.complete(ctxOf(context), input.id),
      ),
      get: auth.files.get.handler(async ({ input, context }) => filesSvc.get(ctxOf(context), input.id)),
      downloadUrl: auth.files.downloadUrl.handler(async ({ input, context }) =>
        filesSvc.downloadUrl(ctxOf(context), input),
      ),
      delete: auth.files.delete.handler(async ({ input, context }) => {
        await filesSvc.remove(ctxOf(context), input.id)
        return { ok: true as const }
      }),
    },

    search: scoped.search.handler(async ({ input, context }) => search.search(ctxOf(context), input)),

    admin: {
      settings: auth.admin.settings.handler(async ({ context }) => {
        admin.requireInstanceAdmin(ctxOf(context))
        return admin.getInstanceSettings(kernel)
      }),
      updateSettings: auth.admin.updateSettings.handler(async ({ input, context }) =>
        admin.updateSettings(ctxOf(context), input),
      ),
      users: auth.admin.users.handler(async ({ input, context }) => admin.listUsers(ctxOf(context), input)),
      setUserStatus: auth.admin.setUserStatus.handler(async ({ input, context }) =>
        admin.setUserStatus(ctxOf(context), input),
      ),
      workspaces: auth.admin.workspaces.handler(async ({ input, context }) =>
        admin.listWorkspaces(ctxOf(context), input),
      ),
      modules: auth.admin.modules.handler(async ({ context }) => admin.listModules(ctxOf(context))),
      updates: {
        get: auth.admin.updates.get.handler(async ({ context }) => updates.getStatus(ctxOf(context))),
        check: auth.admin.updates.check.handler(async ({ context }) => updates.checkNow(ctxOf(context))),
        setPolicy: auth.admin.updates.setPolicy.handler(async ({ input, context }) =>
          updates.setPolicy(ctxOf(context), input),
        ),
        plan: auth.admin.updates.plan.handler(async ({ context }) => updates.getPlan(ctxOf(context))),
      },
    },
  })
}
