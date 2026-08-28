/**
 * Every migration must survive being applied twice, and the replay has to be of the SQL itself.
 *
 * `create policy` and `add constraint` have no `if not exists` at all, and `create table` /
 * `create index` do not get one by default — so a replay throws. A module migration that throws
 * takes down the **whole host service**: this one hosts tracker, quire, hr, billing and inventory,
 * so a broken replay in `mod_core` is an outage for five other modules and core never binds :4000.
 *
 * A replay is not hypothetical. Drizzle keys applied migrations by content hash, so regenerating the
 * journal — which happens whenever somebody re-runs `db:generate` — makes every file run again
 * against a schema that already has its objects.
 *
 * Calling `migrateModule` twice would prove nothing: the second call reads `__migrations`, sees the
 * work is done and returns. Only replaying the statements reaches the failure.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE_DATABASE_URL } from '../testing/harness.js'

const DB = `kern_core_migrations_${Date.now().toString(36)}`
const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations')

let admin: pg.Client
let client: pg.Client

const files = () =>
  readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

/** Apply every migration in order, the way the kernel's runner does — statement by statement. */
async function applyAll(): Promise<string[]> {
  const failures: string[] = []
  for (const file of files()) {
    const sql = readFileSync(join(DIR, file), 'utf8')
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (!statement.trim()) continue
      try {
        await client.query(statement)
      } catch (err) {
        failures.push(`${file}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  return failures
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_DATABASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB}"`)
  const url = new URL(BASE_DATABASE_URL)
  url.pathname = `/${DB}`
  client = new pg.Client({ connectionString: url.toString() })
  await client.connect()
  // A database created from nothing: whatever `0000_init.sql` needs, it has to create itself.
  await client.query('create schema if not exists mod_core')
}, 120_000)

afterAll(async () => {
  await client?.end().catch(() => undefined)
  await admin?.query(`drop database if exists "${DB}" with (force)`).catch(() => undefined)
  await admin?.end().catch(() => undefined)
}, 60_000)

const APPLY_TIMEOUT = 120_000

describe('the migrations', () => {
  it(
    'apply to a database created from nothing',
    async () => {
      expect(
        await applyAll(),
        'a migration that has only ever run against your dev database has not been tested',
      ).toEqual([])
    },
    APPLY_TIMEOUT,
  )

  it(
    'apply again without throwing, so a replay is a no-op and not a boot failure',
    async () => {
      expect(
        await applyAll(),
        'a module migration that throws takes down every module in the host service, not only its own',
      ).toEqual([])
    },
    APPLY_TIMEOUT,
  )

  it(
    'leave each policy defined once, not once per replay',
    async () => {
      await applyAll()
      const { rows } = await client.query<{ tablename: string; policyname: string; n: string }>(
        `select tablename, policyname, count(*)::text as n from pg_policies
           where schemaname = 'mod_core' group by tablename, policyname order by tablename`,
      )
      expect(rows.length, 'no policy exists at all, so this assertion proves nothing').toBeGreaterThan(0)
      for (const row of rows)
        expect(Number(row.n), `${row.tablename}.${row.policyname} exists ${row.n} times`).toBe(1)
    },
    APPLY_TIMEOUT,
  )

  it('force row-level security on every table they wrote a policy for', async () => {
    const { rows } = await client.query<{ relname: string; forced: boolean; enabled: boolean }>(
      `select c.relname, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
         from pg_class c
        where c.relnamespace = 'mod_core'::regnamespace
          and c.relkind = 'r'
          and exists (select 1 from pg_policies p
                       where p.schemaname = 'mod_core' and p.tablename = c.relname)
        order by c.relname`,
    )
    expect(rows.length, 'no table has a policy, so this assertion proves nothing').toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.enabled, `${row.relname} has RLS off`).toBe(true)
      // Without force, the table owner bypasses the policy — and the owner is the service's role.
      expect(row.forced, `${row.relname} does not force RLS`).toBe(true)
    }
  })

  it('put the export table behind a tenant policy and leave the erasure table global', async () => {
    const policied = async (table: string) => {
      const { rows } = await client.query<{ n: string }>(
        `select count(*)::text as n from pg_policies where schemaname = 'mod_core' and tablename = $1`,
        [table],
      )
      return Number(rows[0]?.n ?? 0)
    }
    // An export carries a whole workspace, so it is a tenant table like the rest.
    expect(await policied('data_exports')).toBe(1)
    /*
     * `deletion_requests` deliberately has none: an account deletion belongs to no workspace, and
     * the purge worker has to find everything due without knowing the tenant first — the same
     * reason `workspaces` and `memberships` have no policy.
     */
    expect(await policied('deletion_requests')).toBe(0)
  })

  it("give the journal's last entry a `when` above every entry before it", async () => {
    const journal = JSON.parse(readFileSync(join(DIR, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }>
    }
    /*
     * Drizzle reads the highest `created_at` already applied **once**, before its loop, then applies
     * every entry above it. An entry with a lower timestamp is therefore not applied late — it is
     * skipped permanently, silently, and only on databases that already exist. A fresh database has
     * no floor to fall below, so every developer machine and all of CI agree nothing is wrong.
     */
    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1]!
      const cur = journal.entries[i]!
      expect(cur.when, `${cur.tag} is not newer than ${prev.tag} and would never be applied`).toBeGreaterThan(
        prev.when,
      )
    }
  })
})
