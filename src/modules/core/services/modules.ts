import { type ModuleManifest, resolveCapabilities, type WorkspaceModuleState } from '@kernhq/contracts'
import { coreEvents } from '@kernhq/contracts/core'
import { CAPABILITIES_KEY, KernError, type Kernel, SECRET_FIELD_NAMES } from '@kernhq/kernel'
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
  // Empty because core genuinely does not know: this module is hosted by another service, and its
  // capability definitions live there. Not a placeholder — an honest "no information".
  capabilities: [],
  events: [],
  objectTypes: [],
  defaultHost: 'unknown',
})

/**
 * The capability ids on for a workspace, from the settings blob this service already has.
 *
 * Resolved here rather than through `kernel.capabilities()` for two reasons: that would be a broker
 * round trip back into core for every module on every call, and the settings row is already in hand.
 * It is the same `resolveCapabilities` the server enforcement uses, so the two cannot drift.
 */
function enabledCapabilities(
  kernel: Kernel,
  moduleId: string,
  settings: Record<string, unknown> | null | undefined,
): string[] {
  const stored = settings?.[CAPABILITIES_KEY]
  const flags = typeof stored === 'object' && stored !== null ? (stored as Record<string, boolean>) : null
  const defs = kernel.registry.capabilities(moduleId)
  if (defs.length) return [...resolveCapabilities(defs, flags)]
  /**
   * A module hosted by another service. Core cannot apply the dependency closure without its
   * definitions, so the stored flags are passed through as they are.
   *
   * Deliberately not `[]`: that would hide every capability-gated screen of a module the workspace
   * has actually switched on, silently and completely. Passing the flags through can only be wrong
   * in the narrow case where an administrator enabled something whose dependency is off — and the
   * hosting service's `requiresCapability` refuses that anyway, since it holds the definitions.
   * Core stops being the authority here; it is only relaying what was stored.
   */
  return flags
    ? Object.entries(flags)
        .filter(([, on]) => on)
        .map(([id]) => id)
    : []
}

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
        capabilities: enabledCapabilities(kernel, manifest.id, s?.settings),
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
          capabilities: enabledCapabilities(kernel, r.moduleId, r.settings),
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
  if (enabled && !(await kernel.entitlements.allowsModule(workspaceId, moduleId))) {
    const { planName } = await kernel.entitlements.of(workspaceId)
    throw new KernError(
      'CONFLICT',
      planName
        ? `"${moduleId}" is not included in the ${planName} plan`
        : `"${moduleId}" is not included in this workspace's plan`,
      { module: moduleId, plan: planName },
      'billing.modules.not_included',
    )
  }
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
  return {
    moduleId,
    enabled: row!.enabled,
    settings: row!.settings,
    installedVersion: row!.installedVersion,
    capabilities: enabledCapabilities(kernel, moduleId, row!.settings),
  }
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

  /**
   * Capability switches are the platform's, not the module's, and they live under a reserved key in
   * the same blob. They have to be lifted out before the module's schema sees them.
   *
   * A zod object strips unknown keys by default, so parsing the blob whole **deletes every
   * capability flag** — quietly, on any settings write, leaving the workspace back on defaults and
   * a screen it had switched off suddenly present again. Splitting here is what makes "reserved"
   * actually true rather than a naming convention.
   */
  const { [CAPABILITIES_KEY]: incomingCapabilities, ...incoming } = settings
  const existing = await kernel.database.withWorkspace(workspaceId, (tx) =>
    tx
      .select({ settings: workspaceModules.settings })
      .from(workspaceModules)
      .where(and(eq(workspaceModules.workspaceId, workspaceId), eq(workspaceModules.moduleId, moduleId)))
      .limit(1),
  )
  const { [CAPABILITIES_KEY]: storedCapabilities, ...storedSettings } = existing[0]?.settings ?? {}

  /**
   * A write is a patch over what is stored, not a replacement of it.
   *
   * The same courtesy the capability key already gets, owed in the other direction. A caller that
   * sends only `$capabilities` has an empty remainder, and a zod object full of defaults turns `{}`
   * into every default — so flipping a switch on the capabilities screen used to write HR's whole
   * settings blob back to factory values. The visible damage was `employeeNumberNext` rewinding to
   * 1 and the next hires being issued numbers that already belonged to somebody, from a screen that
   * never mentions employee numbers.
   *
   * Shallow, on purpose. A nested value is one thing the module owns whole (`triage: { … }`), and a
   * deep merge would make every nested key immortal — the trap this fix is avoiding, one level down.
   *
   * **A caller clears a key by sending it as `null`**, which removes it and lets the schema's
   * default take back over; omitting it means "I have nothing to say about this", which is the only
   * reading that makes a partial write safe. JSON has no other way to spell "forget this", so a
   * module that genuinely wants a stored `null` cannot have one — a nullable field with no default
   * would fail this parse loudly rather than corrupt anything, and none exists today.
   */
  const moduleSettings: Record<string, unknown> = { ...storedSettings }
  for (const [key, v] of Object.entries(incoming)) {
    if (v === null) delete moduleSettings[key]
    else moduleSettings[key] = v
  }

  // validate against the module's zod settings schema when hosted here (remote modules: JSON schema TODO – ajv)
  let value: Record<string, unknown> = moduleSettings
  if (mod?.definition.settings) {
    const parsed = mod.definition.settings.safeParse(moduleSettings)
    if (!parsed.success)
      throw KernError.badRequest('Invalid module settings', { issues: parsed.error.issues })
    value = parsed.data as Record<string, unknown>
  }

  // The caller's switches win when supplied; otherwise what was already stored is carried forward,
  // so an unrelated settings edit cannot turn a workspace's features off as a side effect.
  const capabilities = incomingCapabilities ?? storedCapabilities
  if (capabilities !== undefined) value = { ...value, [CAPABILITIES_KEY]: capabilities }
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
