import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase, createLogger, createMaintenance, moduleSchemaName } from '@kernhq/kernel'
import { featureModules } from './service.js'
import './env.js'

/**
 * Migrations outside a boot.
 *
 * The service migrates on start-up, which is right for a single Compose host and wrong for a rolled
 * deployment: several replicas would come up against a schema that is still moving. So an upgrade
 * runs this first, on its own, and only rolls the images once it has finished.
 *
 *   node dist/migrate.js               apply every pending migration
 *   node dist/migrate.js --check       report what is pending and apply nothing
 *   node dist/migrate.js --maintenance on|off
 *
 * `--check` is what makes an upgrade refusable: it answers before anything has been touched.
 */

const url = process.env.DATABASE_URL
if (!url) throw new Error('DATABASE_URL is required')

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const optionValue = (name: string) => {
  const inline = args.find((a) => a.startsWith(`--${name}=`))
  if (inline) return inline.split('=')[1]
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const log = createLogger('core-migrate')
const database = createDatabase({ url, log })

/** Every module this service hosts, so `mod_tracker` is not left behind by `mod_core`. */
const folders: Array<{ id: string; folder: string }> = [
  { id: 'core', folder: join(dirname(fileURLToPath(import.meta.url)), '../migrations') },
  ...featureModules
    .filter((m) => m.migrationsFolder)
    .map((m) => ({ id: m.definition.id, folder: m.migrationsFolder as string })),
]

interface JournalEntry {
  tag: string
}

/** Migrations drizzle has not applied yet, in the order it would apply them. */
async function pendingFor(moduleId: string, folder: string): Promise<string[]> {
  const journalPath = join(folder, 'meta', '_journal.json')
  if (!existsSync(journalPath)) return []
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: JournalEntry[] }
  const schema = moduleSchemaName(moduleId)
  let applied = 0
  try {
    const res = await database.db.execute(`select count(*)::int as n from "${schema}"."__migrations"`)
    applied = (res.rows[0] as { n: number } | undefined)?.n ?? 0
  } catch (err) {
    // A module that has never been migrated has neither schema nor bookkeeping table, and that is
    // the answer "everything is pending". Anything else — an unreachable database, a rejected
    // password — must not be reported as that: the dry run is what an upgrade trusts before it
    // touches anything, and "all clear, 5 migrations to apply" would be a lie it acts on.
    const code =
      (err as { cause?: { code?: string }; code?: string }).cause?.code ?? (err as { code?: string }).code
    // 42P01 undefined_table · 3F000 invalid_schema_name
    if (code !== '42P01' && code !== '3F000') throw err
    applied = 0
  }
  return journal.entries.slice(applied).map((e) => e.tag)
}

const maintenance = optionValue('maintenance')
if (maintenance) {
  if (maintenance !== 'on' && maintenance !== 'off')
    throw new Error(`--maintenance takes "on" or "off", not "${maintenance}"`)
  const m = createMaintenance({ database, log })
  await m.ensure()
  if (maintenance === 'on') await m.begin('Kern is being upgraded', process.env.KERN_VERSION ?? null)
  else await m.end()
  await database.close()
  process.exit(0)
}

if (flag('check')) {
  const pending = await Promise.all(
    folders.map(async (f) => ({ id: f.id, tags: await pendingFor(f.id, f.folder) })),
  )
  const total = pending.reduce((n, p) => n + p.tags.length, 0)
  for (const p of pending)
    if (p.tags.length) log.info({ module: p.id, pending: p.tags }, 'migrations pending')
  console.log(JSON.stringify({ ok: true, total, modules: pending }, null, 2))
  await database.close()
  process.exit(0)
}

for (const f of folders) await database.migrateModule(f.id, f.folder)
await database.close()
log.info({ modules: folders.map((f) => f.id) }, 'migrations complete')
