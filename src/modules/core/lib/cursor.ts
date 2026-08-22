import { KernError } from '@kernalo/kernel'

/** Opaque cursor = base64url(JSON [sortKey, id]). */
export function encodeCursor(sortKey: string | number | null, id: string): string {
  return Buffer.from(JSON.stringify([sortKey, id]), 'utf8').toString('base64url')
}
export function decodeCursor(
  cursor: string | undefined | null,
): { sortKey: string | number | null; id: string } | null {
  if (!cursor) return null
  try {
    const [sortKey, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [
      string | number | null,
      string,
    ]
    if (typeof id !== 'string') throw new Error('bad cursor')
    return { sortKey, id }
  } catch {
    throw KernError.badRequest('Invalid cursor')
  }
}

/** Take `limit + 1` rows, return the page and the cursor for the next one. */
export function paginate<T>(
  rows: T[],
  limit: number,
  cursorOf: (row: T) => string,
): { items: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const last = items[items.length - 1]
  return { items, nextCursor: hasMore && last ? cursorOf(last) : null }
}
