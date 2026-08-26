import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startCore, type TestCore, type TestUser } from '../testing/harness.js'

/**
 * Capability switches, through the running service.
 *
 * A capability is stored under a reserved key inside the module's settings blob, and the blob is
 * validated against the module's own zod schema on every write. A zod object strips unknown keys, so
 * the obvious implementation deletes every switch on any unrelated settings edit — quietly, leaving
 * the workspace back on defaults with screens it had turned off suddenly present again. That is
 * exactly the bug these tests exist for, and nothing in a module's own suite can see it: it lives in
 * core's write path.
 */

let core: TestCore
let owner: TestUser
let workspaceId: string
/**
 * A client for the owner's *current* principal.
 *
 * `owner.api` snapshots the principal at sign-up, before the workspace exists — so it holds no
 * membership for it and every workspace-scoped call is refused. `apiOf` re-reads.
 */
let api: Awaited<ReturnType<TestCore['apiOf']>>

/** The tracker declares no capabilities, so it stands in for "a module with none". */
const MODULE = 'tracker'

beforeAll(async () => {
  core = await startCore()
  owner = await core.signUp({ name: 'Capability Owner' })
  const workspace = await owner.api.workspaces.create({
    name: 'Capabilities',
    slug: `caps-${Date.now().toString(36)}`,
  })
  workspaceId = workspace.id
  api = await core.apiOf(owner.id)
}, 180_000)

afterAll(async () => {
  await core?.stop()
})

describe('module state carries the resolved capability set', () => {
  it('reports a capability list for every module, even those declaring none', async () => {
    const modules = await api.workspaces.modules.list({ workspaceId })
    expect(modules.length).toBeGreaterThan(0)
    for (const m of modules) {
      expect(Array.isArray(m.state.capabilities), `${m.manifest.id} state.capabilities`).toBe(true)
      expect(Array.isArray(m.manifest.capabilities), `${m.manifest.id} manifest.capabilities`).toBe(true)
    }
  })

  it('is empty for a module that declares none, rather than absent', async () => {
    const modules = await api.workspaces.modules.list({ workspaceId })
    const tracker = modules.find((m) => m.manifest.id === MODULE)
    expect(tracker?.state.capabilities).toEqual([])
  })
})

describe('a settings write does not destroy the capability switches', () => {
  it('carries stored switches through an unrelated settings edit', async () => {
    // Write switches directly, the way a switchboard would.
    await api.workspaces.modules.updateSettings({
      workspaceId,
      moduleId: MODULE,
      settings: { $capabilities: { reports: true, sla: false } },
    })

    // Now an ordinary settings edit that says nothing about capabilities. Before the fix, the
    // module's zod schema stripped the reserved key here and both switches vanished.
    const after = await api.workspaces.modules.updateSettings({
      workspaceId,
      moduleId: MODULE,
      settings: { triage: { enabled: true } },
    })

    const stored = after.settings as Record<string, unknown>
    expect(stored.$capabilities, 'the reserved key survived').toEqual({ reports: true, sla: false })
  })

  it('lets a later write change them', async () => {
    const after = await api.workspaces.modules.updateSettings({
      workspaceId,
      moduleId: MODULE,
      settings: { $capabilities: { reports: false } },
    })
    expect((after.settings as Record<string, unknown>).$capabilities).toEqual({ reports: false })
  })

  it('survives the round trip through list()', async () => {
    const modules = await api.workspaces.modules.list({ workspaceId })
    const tracker = modules.find((m) => m.manifest.id === MODULE)
    expect(tracker, `${MODULE} is hosted by this service`).toBeDefined()
    const settings = tracker!.state.settings as Record<string, unknown>
    expect(settings.$capabilities).toEqual({ reports: false })
  })

  it('survives enabling and disabling the module', async () => {
    // Turning a module off and on again must not lose what the workspace configured — that is the
    // whole reversibility claim a capability makes.
    await api.workspaces.modules.setEnabled({ workspaceId, moduleId: MODULE, enabled: false })
    const back = await api.workspaces.modules.setEnabled({
      workspaceId,
      moduleId: MODULE,
      enabled: true,
    })
    expect((back.settings as Record<string, unknown>).$capabilities).toEqual({ reports: false })
  })
})

/**
 * The other half of the same trade: a write that carries only the reserved key.
 *
 * The switchboard screen sends `{ $capabilities: … }` and nothing else, because that is all it knows
 * about. Core lifted the key out and handed the remainder — `{}` — to the module's zod schema, which
 * happily turned it into every default and stored that as the whole blob. So flipping one switch
 * rewound HR's employee-number counter to 1 and started issuing numbers that already belonged to
 * somebody, on a screen that never mentions employee numbers.
 *
 * HR rather than the tracker here: it is the module with a real settings schema, and a schema full
 * of defaults is exactly what makes the damage silent.
 */
const HR = 'hr'

async function hrSettings(): Promise<Record<string, unknown>> {
  const modules = await api.workspaces.modules.list({ workspaceId })
  const hr = modules.find((m) => m.manifest.id === HR)
  expect(hr, `${HR} is hosted by this service`).toBeDefined()
  return hr!.state.settings as Record<string, unknown>
}

describe('a settings write is a patch, not a replacement', () => {
  it('leaves the employee-number counter alone when a capability is toggled', async () => {
    await api.workspaces.modules.updateSettings({
      workspaceId,
      moduleId: HR,
      settings: {
        country: 'DE',
        employeeNumberPrefix: 'K-',
        employeeNumberNext: 42,
        directoryVisibleToMembers: false,
      },
    })

    await api.workspaces.modules.updateSettings({
      workspaceId,
      moduleId: HR,
      settings: { $capabilities: { offices: true } },
    })

    const stored = await hrSettings()
    expect(stored.employeeNumberNext, 'the counter did not rewind').toBe(42)
    expect(stored.employeeNumberPrefix).toBe('K-')
    expect(stored.country).toBe('DE')
    expect(stored.directoryVisibleToMembers).toBe(false)
    expect(stored.$capabilities).toEqual({ offices: true })
  })

  it('still lets a caller change one field without naming the others', async () => {
    await api.workspaces.modules.updateSettings({
      workspaceId,
      moduleId: HR,
      settings: { employeeNumberNext: 43 },
    })

    const stored = await hrSettings()
    expect(stored.employeeNumberNext).toBe(43)
    expect(stored.employeeNumberPrefix, 'untouched fields survive the patch').toBe('K-')
    expect(stored.$capabilities, 'and so do the switches').toEqual({ offices: true })
  })

  it('clears a field when the caller sends it as null', async () => {
    await api.workspaces.modules.updateSettings({
      workspaceId,
      moduleId: HR,
      settings: { employeeNumberPrefix: null },
    })

    const stored = await hrSettings()
    // Removed, so HR's schema default takes it back over — the only way a JSON payload can say
    // "forget this", and the escape hatch that stops merging making a key immortal.
    expect(stored.employeeNumberPrefix).toBe('')
    expect(stored.employeeNumberNext, 'nothing else moved').toBe(43)
  })
})
