import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mayRenderInline, safeContentType } from '../modules/core/services/files.js'
import { startCore, type TestCore, type TestUser } from '../testing/harness.js'

/**
 * What a download URL tells the browser to do with an uploaded file.
 *
 * `files.createUpload` is an ordinary member permission and every shipped stack serves object
 * storage from the **same origin as the app**, so the content type a member declares used to decide
 * whether their bytes ran as a document on that origin: nothing validated it, and it was signed
 * back into the presigned GET as `response-content-type` with the caller's own choice of
 * `inline`. Any member could store a page and hand the link to any signed-in colleague.
 *
 * These assertions read the signed query string, because that is what the browser actually
 * receives — `response-content-type` and `response-content-disposition` are the whole fix, and a
 * unit test of the helpers alone would not have caught the download path still passing `f.mimeType`.
 */

let core: TestCore
let owner: TestUser
let api: Awaited<ReturnType<TestCore['apiOf']>>
let workspaceId: string

beforeAll(async () => {
  core = await startCore()
  owner = await core.signUp({ name: 'File Owner' })
  const ws = await owner.api.workspaces.create({ name: 'Files', slug: `files-${Date.now().toString(36)}` })
  workspaceId = ws.id
  // re-read: `owner.api` is bound to the principal from before the workspace existed
  api = await core.apiOf(owner.id)
}, 180_000)

afterAll(async () => {
  await core?.stop()
})

/** The response overrides S3 was asked to apply, read out of the signed URL. */
function responseOverrides(url: string): { type: string | null; disposition: string | null } {
  const q = new URL(url).searchParams
  return {
    type: q.get('response-content-type'),
    disposition: q.get('response-content-disposition'),
  }
}

async function upload(name: string, mimeType: string) {
  const ticket = await api.files.createUpload({ workspaceId, name, mimeType, size: 64 })
  return ticket
}

describe('the content type of an uploaded file', () => {
  it('neutralises a type the browser would run, at the ticket', async () => {
    const ticket = await upload('payload.html', 'text/html')
    // the row and the header the client is told to send agree
    expect(ticket.file.mimeType).toBe('text/plain; charset=utf-8')
    expect(ticket.headers['content-type']).toBe('text/plain; charset=utf-8')
  })

  /**
   * A presigned PUT does **not** bind the content type, and it is worth knowing rather than
   * assuming: `X-Amz-SignedHeaders` on the URL the kernel signs is `content-length;host`, so the
   * uploader can send whatever `content-type` it likes and the stored object will carry it. That is
   * why the neutralisation cannot live at the upload alone — `downloadUrl` overriding
   * `response-content-type` on every single GET is what actually holds, and the end-to-end test
   * below is what proves the override wins over the stored value.
   */
  it('does not bind the content type into the upload signature', async () => {
    const ticket = await upload('payload.html', 'text/html')
    expect(new URL(ticket.url).searchParams.get('X-Amz-SignedHeaders')).not.toContain('content-type')
  })

  it('leaves an ordinary type alone', async () => {
    const ticket = await upload('photo.png', 'image/png')
    expect(ticket.file.mimeType).toBe('image/png')
  })

  it('keeps svg as svg, because rewriting it would break every <img>', async () => {
    const ticket = await upload('logo.svg', 'image/svg+xml')
    expect(ticket.file.mimeType).toBe('image/svg+xml')
  })
})

describe('the download url', () => {
  /** Mark a pending file ready without object storage: the URL is signed, nothing is transferred. */
  const markReady = async (id: string) => {
    const { sql } = await import('drizzle-orm')
    await core.kernel.database.db.execute(sql`update mod_core.files set status = 'ready' where id = ${id}`)
  }

  it('serves stored html as text and refuses to render it in place', async () => {
    const ticket = await upload('payload.html', 'text/html')
    await markReady(ticket.file.id)
    const { url } = await api.files.downloadUrl({
      id: ticket.file.id,
      disposition: 'inline',
      thumbnail: false,
    })
    const { type, disposition } = responseOverrides(url)
    expect(type).toBe('text/plain; charset=utf-8')
    expect(type).not.toContain('html')
    // text/plain cannot become a document that runs script, so it is allowed to render
    expect(disposition?.startsWith('inline')).toBe(true)
  })

  it('downloads an svg rather than letting it become a document', async () => {
    const ticket = await upload('logo.svg', 'image/svg+xml')
    await markReady(ticket.file.id)
    const { url } = await api.files.downloadUrl({
      id: ticket.file.id,
      disposition: 'inline',
      thumbnail: false,
    })
    const { type, disposition } = responseOverrides(url)
    // the type stays, so <img src> still renders it; the disposition stops a navigation
    expect(type).toBe('image/svg+xml')
    expect(disposition?.startsWith('attachment')).toBe(true)
  })

  /**
   * A row written before the upload path neutralised anything. The repair has to reach it, or every
   * file already in a running instance's bucket keeps the defect it was stored with.
   */
  it('repairs a row that was stored as html before this existed', async () => {
    const ticket = await upload('legacy.html', 'text/plain')
    const { sql } = await import('drizzle-orm')
    await core.kernel.database.db.execute(
      sql`update mod_core.files set status = 'ready', mime_type = 'text/html' where id = ${ticket.file.id}`,
    )
    const { url } = await api.files.downloadUrl({
      id: ticket.file.id,
      disposition: 'inline',
      thumbnail: false,
    })
    expect(responseOverrides(url).type).toBe('text/plain; charset=utf-8')
  })

  it('renders an image in place when that is what was asked for', async () => {
    const ticket = await upload('photo.png', 'image/png')
    await markReady(ticket.file.id)
    const { url } = await api.files.downloadUrl({
      id: ticket.file.id,
      disposition: 'inline',
      thumbnail: false,
    })
    const { type, disposition } = responseOverrides(url)
    expect(type).toBe('image/png')
    expect(disposition?.startsWith('inline')).toBe(true)
  })

  it('always names a disposition, so nothing falls back to the object’s own', async () => {
    const ticket = await upload(
      'sheet.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    await markReady(ticket.file.id)
    for (const disposition of ['inline', 'attachment'] as const) {
      const { url } = await api.files.downloadUrl({ id: ticket.file.id, disposition, thumbnail: false })
      // an unknown type is never rendered in place, whichever disposition was asked for
      expect(responseOverrides(url).disposition?.startsWith('attachment')).toBe(true)
    }
  })
})

/**
 * The whole path, against real object storage: store a page, ask for it back, read the headers a
 * browser would obey.
 *
 * The assertions above read the signed query string, which is the *request* Kern makes of the
 * store. This one reads the *response*, because a signed parameter the store ignores would look
 * identical in the URL and be worth nothing — which is the same shape as the MCP executor that
 * substituted a placeholder no module's path template contained.
 */
describe('an html upload, stored and fetched back', () => {
  const storage = process.env.S3_ENDPOINT ?? 'http://localhost:9000'
  let reachable = false

  beforeAll(async () => {
    reachable = await fetch(`${storage}/minio/health/live`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.ok)
      .catch(() => false)
    // A laptop with no MinIO is the ordinary case; CI runs one, so there it is a failure.
    if (!reachable && process.env.CI) throw new Error(`object storage is not reachable at ${storage}`)
  })

  it('answers text/plain and attachment for a page a member uploaded', async () => {
    if (!reachable) return
    const body = '<script>alert(document.domain)</script>'
    const ticket = await api.files.createUpload({
      workspaceId,
      name: 'invoice.html',
      mimeType: 'text/html',
      size: Buffer.byteLength(body),
    })
    // the uploader lies on the wire, which a presigned PUT permits: the object is stored as html
    const put = await fetch(ticket.url, {
      method: 'PUT',
      headers: { 'content-type': 'text/html' },
      body,
    })
    expect(put.status, await put.text().catch(() => '')).toBe(200)
    await api.files.complete({ id: ticket.file.id })

    const { url } = await api.files.downloadUrl({
      id: ticket.file.id,
      disposition: 'inline',
      thumbnail: false,
    })
    const res = await fetch(url)
    expect(res.status).toBe(200)
    // what the browser is actually told, by the store, on the app's own origin
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('content-disposition')).toMatch(/^inline/)
    // the bytes are untouched — nothing was censored, only the instruction to run them
    expect(await res.text()).toBe(body)
  })

  it('answers attachment for an svg, so it cannot become a document', async () => {
    if (!reachable) return
    const body = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    const ticket = await api.files.createUpload({
      workspaceId,
      name: 'logo.svg',
      mimeType: 'image/svg+xml',
      size: Buffer.byteLength(body),
    })
    const put = await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body })
    expect(put.status).toBe(200)
    await api.files.complete({ id: ticket.file.id })
    const { url } = await api.files.downloadUrl({
      id: ticket.file.id,
      disposition: 'inline',
      thumbnail: false,
    })
    const res = await fetch(url)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/)
  })
})

describe('the rules themselves', () => {
  it('names every type a browser runs as a document', () => {
    for (const t of [
      'text/html',
      'text/html; charset=utf-8',
      'application/xhtml+xml',
      'text/xml',
      'application/xml',
      'application/xslt+xml',
      'text/javascript',
      'application/javascript',
      'application/x-javascript',
      'application/ecmascript',
    ])
      expect(safeContentType(t), t).toBe('text/plain; charset=utf-8')
  })

  it('lets nothing but harmless media render in place', () => {
    for (const t of ['image/png', 'image/jpeg', 'video/mp4', 'audio/mpeg', 'text/plain; charset=utf-8'])
      expect(mayRenderInline(t), t).toBe(true)
    for (const t of ['image/svg+xml', 'application/pdf', 'text/html', 'application/octet-stream', 'text/csv'])
      expect(mayRenderInline(t), t).toBe(false)
  })
})
