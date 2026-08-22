import type { core } from '@kernhq/contracts'
import { coreEvents } from '@kernhq/contracts/core'
import { KernError, type Kernel, uuidv7 } from '@kernhq/kernel'
import { eq } from 'drizzle-orm'
import type { z } from 'zod'
import type { CoreDeps } from '../deps.js'
import { serFile } from '../lib/ser.js'
import { files } from '../schema/index.js'
import { type Ctx, membershipOf, requireUser } from './common.js'

const UPLOAD_URL_TTL_SEC = 900
const DOWNLOAD_URL_TTL_SEC = 3600
const THUMBNAIL_MAX_SOURCE_BYTES = 64 * 1024 * 1024
const THUMBNAIL_MIME = /^image\/(jpeg|png|webp|gif|avif|tiff|svg\+xml)$/

export async function getFileRow(kernel: Kernel, id: string) {
  const [f] = await kernel.database.db.select().from(files).where(eq(files.id, id)).limit(1)
  return f ?? null
}

/** files are addressed by id without a workspace in the URL – membership is enforced here */
async function requireFile(ctx: Ctx, id: string) {
  const f = await getFileRow(ctx.kernel, id)
  if (!f || f.status === 'deleted') throw KernError.notFound('File')
  const p = ctx.principal
  if (!p.instanceAdmin && p.kind !== 'service' && !membershipOf(p, f.workspaceId))
    throw KernError.notFound('File')
  return f
}

export async function createUpload(
  ctx: Ctx,
  deps: CoreDeps,
  input: {
    workspaceId: string
    name: string
    mimeType: string
    size: number
    attachedTo?: core.FileObject['attachedTo']
  },
): Promise<z.infer<typeof core.UploadTicket>> {
  const { kernel } = ctx
  const userId = requireUser(ctx.principal)
  if (input.size > deps.env.UPLOAD_MAX_PUT_BYTES)
    // TODO: resumable uploads (tus) for files above the single-PUT limit
    throw KernError.badRequest('File is too large for a single upload', {
      maxBytes: deps.env.UPLOAD_MAX_PUT_BYTES,
    })
  const id = uuidv7()
  const key = kernel.storage.keyFor({
    workspaceId: input.workspaceId,
    module: input.attachedTo?.module ?? 'core',
    id,
    name: input.name,
  })
  const [row] = await kernel.database.db
    .insert(files)
    .values({
      id,
      workspaceId: input.workspaceId,
      name: input.name,
      mimeType: input.mimeType,
      size: input.size,
      key,
      attachedTo: input.attachedTo ?? null,
      uploadedBy: userId,
      status: 'pending',
    })
    .returning()
  if (!row) throw new KernError('INTERNAL', 'File insert failed')
  const url = await kernel.storage.presignPut(key, {
    contentType: input.mimeType,
    contentLength: input.size,
    expiresIn: UPLOAD_URL_TTL_SEC,
  })
  return {
    file: serFile(row),
    method: 'put',
    url,
    headers: { 'content-type': input.mimeType },
    expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SEC * 1000).toISOString(),
  }
}

export async function complete(ctx: Ctx, id: string): Promise<core.FileObject> {
  const { kernel } = ctx
  const f = await requireFile(ctx, id)
  if (f.status === 'ready') return serFile(f)
  if (f.status !== 'pending') throw KernError.conflict('File is not awaiting upload', 'core.file.not_pending')
  if (
    f.uploadedBy !== ctx.principal.userId &&
    !ctx.principal.instanceAdmin &&
    ctx.principal.kind !== 'service'
  )
    throw KernError.forbidden()
  const head = await kernel.storage.head(f.key)
  if (!head)
    throw KernError.conflict('Upload not found in storage – PUT the file first', 'core.file.not_uploaded')
  const [row] = await kernel.database.db
    .update(files)
    .set({ status: 'ready', size: head.contentLength ?? f.size, updatedAt: new Date() })
    .where(eq(files.id, id))
    .returning()
  if (!row) throw KernError.notFound('File')
  if (THUMBNAIL_MIME.test(row.mimeType) && row.size <= THUMBNAIL_MAX_SOURCE_BYTES)
    await kernel.jobs
      .send('core.thumbnail', { fileId: id })
      .catch((err: Error) => kernel.log.warn({ err: err.message }, 'thumbnail enqueue failed'))
  await kernel.emit(
    coreEvents.fileReady,
    { fileId: id, workspaceId: row.workspaceId as never, mimeType: row.mimeType },
    { workspaceId: row.workspaceId, actorId: ctx.principal.userId },
  )
  await kernel.realtime.change(row.workspaceId, {
    module: 'core',
    entity: 'file',
    id,
    op: 'updated',
    patch: { status: 'ready' },
  })
  return serFile(row)
}

export async function get(ctx: Ctx, id: string): Promise<core.FileObject> {
  return serFile(await requireFile(ctx, id))
}

export async function downloadUrl(
  ctx: Ctx,
  input: { id: string; disposition: 'inline' | 'attachment'; thumbnail: boolean },
): Promise<{ url: string; expiresAt: string }> {
  const f = await requireFile(ctx, input.id)
  if (f.status !== 'ready') throw KernError.conflict('File is not ready', 'core.file.not_ready')
  const key = input.thumbnail && f.thumbnailKey ? f.thumbnailKey : f.key
  const url = await ctx.kernel.storage.presignGet(key, {
    expiresIn: DOWNLOAD_URL_TTL_SEC,
    filename: input.thumbnail && f.thumbnailKey ? undefined : f.name,
    disposition: input.disposition,
    contentType: input.thumbnail && f.thumbnailKey ? 'image/webp' : f.mimeType,
  })
  return { url, expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SEC * 1000).toISOString() }
}

export async function remove(ctx: Ctx, id: string): Promise<void> {
  const { kernel } = ctx
  const f = await requireFile(ctx, id)
  const p = ctx.principal
  if (f.uploadedBy !== p.userId && p.kind !== 'service' && !p.instanceAdmin) {
    await kernel.authz.require(p, 'core.workspace.manage', {
      kind: 'workspace',
      id: f.workspaceId,
      workspaceId: f.workspaceId,
    })
  }
  await kernel.database.db
    .update(files)
    .set({ status: 'deleted', updatedAt: new Date() })
    .where(eq(files.id, id))
  await kernel.storage.delete(f.key).catch(() => {})
  if (f.thumbnailKey) await kernel.storage.delete(f.thumbnailKey).catch(() => {})
  await kernel.realtime.change(f.workspaceId, { module: 'core', entity: 'file', id, op: 'deleted' })
}

/** worker job: render a ≤512px webp thumbnail next to the original */
export async function generateThumbnail(kernel: Kernel, fileId: string): Promise<void> {
  const f = await getFileRow(kernel, fileId)
  if (f?.status !== 'ready' || !THUMBNAIL_MIME.test(f.mimeType)) return
  const obj = await kernel.storage.get(f.key).catch(() => null)
  if (!obj) return
  const chunks: Buffer[] = []
  for await (const chunk of obj.body) chunks.push(Buffer.from(chunk as Uint8Array))
  const source = Buffer.concat(chunks)
  const { default: sharp } = await import('sharp')
  const image = sharp(source, { failOn: 'none' }).rotate()
  const meta = await image.metadata()
  const thumb = await image
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer()
  const thumbnailKey = `${f.key}.thumb.webp`
  await kernel.storage.put(thumbnailKey, thumb, 'image/webp')
  await kernel.database.db
    .update(files)
    .set({ thumbnailKey, width: meta.width ?? null, height: meta.height ?? null, updatedAt: new Date() })
    .where(eq(files.id, fileId))
  await kernel.realtime.change(f.workspaceId, {
    module: 'core',
    entity: 'file',
    id: fileId,
    op: 'updated',
    patch: { thumbnailKey },
  })
}
