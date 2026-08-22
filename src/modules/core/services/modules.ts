import type { ModuleManifest, WorkspaceModuleState } from '@kernalo/contracts'
import { coreEvents } from '@kernalo/contracts/core'
import { KernError, type Kernel, SECRET_FIELD_NAMES } from '@kernalo/kernel'
import { and, eq } from 'drizzle-orm'
import { integrations, workspaceModules } from '../schema/index.js'
import type { Ctx } from './common.js'

const stubManifest = (id: string): ModuleManifest => ({
  id,
  name: id,
  version: '0.0.0',
  core: false,
  dependsOn: [],
  permissions: [],
  events: [],
  objectTypes: [],
  defaultHost: 'unknown',
})

async function stateRows(kernel: Kernel, workspaceId: string) {
  return kernel.database.withWorkspace(workspaceId, (tx) =>
    tx.select().from(workspaceModules).where(eq(workspaceModules.workspaceId, workspaceId)),
  )
}

export async function list(ctx: Ctx, workspaceId: string) {
  const { kernel } = ctx
  const rows = await stateRows(kernel, workspaceId)
  const byId = new Map(rows.map((r) => [r.moduleId, r]))
  const manifests = kernel.manifests()
  const known = new Set(manifests.map((m) => m.id))
  const out: Array<{ manifest: ModuleManifest; state: WorkspaceModuleState }> = manifests.map((manifest) => {
    const s = byId.get(manifest.id)
    return {
      manifest,
      state: {
        moduleId: manifest.id,
        enabled: manifest.core ? true : (s?.enabled ?? true),
        settings: s?.settings ?? {},
        installedVersion: s?.installedVersion ?? manifest.version,
      },
    }
  })
  // modules hosted by other services that have state here
  for (const r of rows)
    if (!known.has(r.moduleId))
      out.push({
        manifest: stubManifest(r.moduleId),
        state: {
          moduleId: r.moduleId,
          enabled: r.enabled,
          settings: r.settings,
          installedVersion: r.installedVersion,
        },
      })
  return out
}

export async function isEnabled(kernel: Kernel, workspaceId: string, moduleId: string): Promise<boolean> {
  const mod = kernel.registry.get(moduleId)
  if (mod?.definition.core) return true
  const [row] = await kernel.database.withWorkspace(workspaceId, (tx) =>
    tx
      .select({ enabled: workspaceModules.enabled })
      .from(workspaceModules)
      .where(and(eq(workspaceModules.workspaceId, workspaceId), eq(workspaceModules.moduleId, moduleId)))
      .limit(1),
  )
  return row?.enabled ?? true // enabled by default
}

export async function setEnabled(ctx: Ctx, workspaceId: string, moduleId: string, enabled: boolean) {
  const { kernel } = ctx
  const mod = kernel.registry.get(moduleId)
  const manifest = kernel.manifests().find((m) => m.id === moduleId)
  if (manifest?.core) throw KernError.conflict('Core modules are always enabled', 'core.module.core')
  if (enabled && manifest) {
    for (const dep of manifest.dependsOn)
      if (!(await isEnabled(kernel, workspaceId, dep)))
        throw KernError.conflict(
          `Module "${moduleId}" depends on "${dep}" which is disabled`,
          'core.module.dependency',
        )
  }
  if (!enabled) {
    const dependents = kernel.manifests().filter((m) => m.dependsOn.includes(moduleId) && !m.core)
    for (const d of dependents)
      if (await isEnabled(kernel, workspaceId, d.id))
        throw KernError.conflict(
          `Module "${d.id}" depends on "${moduleId}" – disable it first`,
          'core.module.dependents',
        )
  }
  const [row] = await kernel.database.withWorkspace(workspaceId, (tx) =>
    tx
      .insert(workspaceModules)
      .values({
        workspaceId,
        moduleId,
        enabled,
        installedVersion: manifest?.version ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [workspaceModules.workspaceId, workspaceModules.moduleId],
        set: { enabled, installedVersion: manifest?.version ?? null, updatedAt: new Date() },
      })
      .returning(),
  )
  kernel.settings.invalidate(workspaceId, moduleId)
  await kernel.emit(
    coreEvents.moduleEnabled,
    { workspaceId: workspaceId as never, moduleId, enabled },
    { workspaceId, actorId: ctx.principal.userId },
  )
  if (enabled) await mod?.onWorkspaceEnabled?.(workspaceId, kernel)
  else await mod?.onWorkspaceDisabled?.(workspaceId, kernel)
  await kernel.realtime.change(workspaceId, {
    module: 'core',
    entity: 'module',
    id: workspaceId,
    op: 'updated',
    patch: { moduleId, enabled },
  })
  return { moduleId, enabled: row!.enabled, settings: row!.settings, installedVersion: row!.installedVersion }
}

export async function getModuleSettings(
  kernel: Kernel,
  workspaceId: string,
  moduleId: string,
): Promise<Record<string, unknown>> {
  const [row] = await kernel.database.withWorkspace(workspaceId, (tx) =>
    tx
      .select({ settings: workspaceModules.settings })
      .from(workspaceModules)
      .where(and(eq(workspaceModules.workspaceId, workspaceId), eq(workspaceModules.moduleId, moduleId)))
      .limit(1),
  )
  return row?.settings ?? {}
}

export async function setModuleSettings(
  kernel: Kernel,
  workspaceId: string,
  moduleId: string,
  settings: Record<string, unknown>,
  actorId: string | null,
) {
  const mod = kernel.registry.get(moduleId)
  // validate against the module's zod settings schema when hosted here (remote modules: JSON schema TODO – ajv)
  let value = settings
  if (mod?.definition.settings) {
    const parsed = mod.definition.settings.safeParse(settings)
    if (!parsed.success)
      throw KernError.badRequest('Invalid module settings', { issues: parsed.error.issues })
    value = parsed.data as Record<string, unknown>
  }
  const [row] = await kernel.database.withWorkspace(workspaceId, (tx) =>
    tx
      .insert(workspaceModules)
      .values({
        workspaceId,
        moduleId,
        enabled: true,
        settings: value,
        installedVersion: mod?.definition.version ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [workspaceModules.workspaceId, workspaceModules.moduleId],
        set: { settings: value, updatedAt: new Date() },
      })
      .returning(),
  )
  kernel.settings.invalidate(workspaceId, moduleId)
  await kernel.emit(
    coreEvents.moduleSettingsUpdated,
    { workspaceId: workspaceId as never, moduleId },
    { workspaceId, actorId },
  )
  await kernel.realtime.change(workspaceId, {
    module: 'core',
    entity: 'module',
    id: workspaceId,
    op: 'updated',
    patch: { moduleId },
  })
  return { moduleId, enabled: row!.enabled, settings: row!.settings, installedVersion: row!.installedVersion }
}

export async function updateSettings(
  ctx: Ctx,
  workspaceId: string,
  moduleId: string,
  settings: Record<string, unknown>,
) {
  return setModuleSettings(ctx.kernel, workspaceId, moduleId, settings, ctx.principal.userId)
}

// ---------- integrations (encrypted per-workspace config: smtp, ai, livekit, …) ----------
export async function getIntegration(
  kernel: Kernel,
  workspaceId: string,
  kind: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await kernel.database.withWorkspace(workspaceId, (tx) =>
    tx
      .select()
      .from(integrations)
      .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.kind, kind)))
      .limit(1),
  )
  if (!row) return null
  return kernel.secrets.decryptFields(row.config, SECRET_FIELD_NAMES, `${workspaceId}:${kind}`)
}
export async function setIntegration(
  kernel: Kernel,
  workspaceId: string,
  kind: string,
  config: Record<string, unknown> | null,
  actorId: string | null,
): Promise<void> {
  await kernel.database.withWorkspace(workspaceId, async (tx) => {
    if (config === null) {
      await tx
        .delete(integrations)
        .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.kind, kind)))
      return
    }
    const enc = kernel.secrets.encryptFields(config, SECRET_FIELD_NAMES, `${workspaceId}:${kind}`)
    await tx
      .insert(integrations)
      .values({ workspaceId, kind, config: enc, updatedBy: actorId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [integrations.workspaceId, integrations.kind],
        set: { config: enc, updatedBy: actorId, updatedAt: new Date() },
      })
  })
}
