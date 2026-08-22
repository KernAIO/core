import type { core } from '@kernaio/contracts'
import type { Kernel } from '@kernaio/kernel'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { searchDocuments } from '../schema/index.js'
import { type Ctx, membershipOf } from './common.js'

export async function indexDocuments(kernel: Kernel, docs: core.SearchDocument[]): Promise<number> {
  let n = 0
  const byWs = new Map<string, core.SearchDocument[]>()
  for (const d of docs) byWs.set(d.workspaceId, [...(byWs.get(d.workspaceId) ?? []), d])
  for (const [workspaceId, list] of byWs) {
    await kernel.database.withWorkspace(workspaceId, async (tx) => {
      for (const d of list) {
        await tx
          .insert(searchDocuments)
          .values({
            workspaceId,
            module: d.object.module,
            objectType: d.object.type,
            objectId: d.object.id,
            title: d.title,
            body: d.body,
            url: d.url,
            icon: d.icon ?? null,
            acl: d.acl ?? null,
            attributes: d.attributes ?? {},
            updatedAt: new Date(d.updatedAt),
          })
          .onConflictDoUpdate({
            target: [
              searchDocuments.workspaceId,
              searchDocuments.module,
              searchDocuments.objectType,
              searchDocuments.objectId,
            ],
            set: {
              title: d.title,
              body: d.body,
              url: d.url,
              icon: d.icon ?? null,
              acl: d.acl ?? null,
              attributes: d.attributes ?? {},
              updatedAt: new Date(d.updatedAt),
            },
          })
        n++
      }
    })
  }
  return n
}

export async function removeDocuments(
  kernel: Kernel,
  refs: Array<{ workspaceId: string; object: core.SearchDocument['object'] }>,
): Promise<number> {
  let n = 0
  for (const r of refs) {
    const rows = await kernel.database.withWorkspace(r.workspaceId, (tx) =>
      tx
        .delete(searchDocuments)
        .where(
          and(
            eq(searchDocuments.workspaceId, r.workspaceId),
            eq(searchDocuments.module, r.object.module),
            eq(searchDocuments.objectType, r.object.type),
            eq(searchDocuments.objectId, r.object.id),
          ),
        )
        .returning({ id: searchDocuments.id }),
    )
    n += rows.length
  }
  return n
}

export async function removeWorkspaceModule(kernel: Kernel, workspaceId: string, moduleId: string) {
  await kernel.database.withWorkspace(workspaceId, (tx) =>
    tx
      .delete(searchDocuments)
      .where(and(eq(searchDocuments.workspaceId, workspaceId), eq(searchDocuments.module, moduleId))),
  )
}

/** Postgres FTS (websearch syntax, `simple` config so fa/ar work) ranked with ts_rank, plus trigram fallback on titles. */
export async function search(
  ctx: Ctx,
  input: { workspaceId: string; q: string; modules?: string[]; types?: string[]; limit: number },
): Promise<{ hits: core.SearchHit[]; tookMs: number }> {
  const started = performance.now()
  const { kernel, principal } = ctx
  const m = membershipOf(principal, input.workspaceId)
  const subjects = [principal.userId ?? '', ...(m?.groupIds ?? []), `role:${m?.role ?? 'guest'}`].filter(
    Boolean,
  )
  const q = input.q.trim()
  const conds = [eq(searchDocuments.workspaceId, input.workspaceId)]
  if (input.modules?.length) conds.push(inArray(searchDocuments.module, input.modules))
  if (input.types?.length) conds.push(inArray(searchDocuments.objectType, input.types))
  if (!principal.instanceAdmin && principal.kind !== 'service')
    conds.push(
      sql`(${searchDocuments.acl} is null or ${searchDocuments.acl} && ${sql.param(subjects)}::text[])`,
    )
  // enabled modules only
  const disabled: string[] = []
  for (const mod of kernel.manifests())
    if (!mod.core && !(await kernel.isModuleEnabled(input.workspaceId, mod.id))) disabled.push(mod.id)
  if (disabled.length) conds.push(sql`${searchDocuments.module} <> all(${sql.param(disabled)}::text[])`)

  const rank = sql<number>`ts_rank(${searchDocuments.tsv}, websearch_to_tsquery('simple', ${q}))`
  const sim = sql<number>`similarity(${searchDocuments.title}, ${q})`
  const rows = await kernel.database.withWorkspace(input.workspaceId, (tx) =>
    tx
      .select({
        d: searchDocuments,
        rank,
        sim,
        snippet: sql<string>`ts_headline('simple', coalesce(${searchDocuments.body}, ''), websearch_to_tsquery('simple', ${q}), 'MaxWords=24, MinWords=8, MaxFragments=1, StartSel=**, StopSel=**')`,
      })
      .from(searchDocuments)
      .where(
        and(
          ...conds,
          sql`(${searchDocuments.tsv} @@ websearch_to_tsquery('simple', ${q}) or ${searchDocuments.title} % ${q} or ${searchDocuments.title} ilike ${`%${q}%`})`,
        ),
      )
      .orderBy(sql`${rank} desc, ${sim} desc, ${searchDocuments.updatedAt} desc`)
      .limit(input.limit),
  )
  const hits: core.SearchHit[] = rows.map((r) => ({
    object: { module: r.d.module, type: r.d.objectType, id: r.d.objectId },
    title: r.d.title,
    snippet: r.snippet?.trim() ? r.snippet : r.d.body ? r.d.body.slice(0, 160) : null,
    url: r.d.url,
    icon: r.d.icon,
    score: Number(r.rank) + Number(r.sim) * 0.5,
    updatedAt: r.d.updatedAt.toISOString(),
  }))
  return { hits, tookMs: Math.round(performance.now() - started) }
}

/** Re-run every hosted module's `scan` indexer for a workspace (optionally one module). */
export async function reindexWorkspace(
  kernel: Kernel,
  workspaceId: string,
  moduleId?: string,
): Promise<number> {
  let n = 0
  for (const mod of kernel.registry.all()) {
    if (moduleId && mod.definition.id !== moduleId) continue
    for (const indexer of mod.search ?? []) {
      if (!indexer.scan) continue
      const batch: core.SearchDocument[] = []
      for await (const doc of indexer.scan(workspaceId, kernel)) {
        batch.push(doc)
        if (batch.length >= 200) {
          n += await indexDocuments(kernel, batch.splice(0))
        }
      }
      if (batch.length) n += await indexDocuments(kernel, batch)
    }
  }
  return n
}
