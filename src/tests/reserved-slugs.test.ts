/**
 * A workspace slug shares one namespace with the app's own pages and with every path the reverse
 * proxy answers, and losing to either produces a workspace that exists and cannot be opened.
 *
 * Nothing here fails when a route is added, because a route is added in another repository:
 * `collab` had been a Caddy route for as long as the collab service existed and was never reserved,
 * so `POST /api/core/workspaces {slug: "collab"}` succeeded and returned a workspace that answered
 * on nothing but the container network.
 *
 * The floor below is the enumeration, and it runs everywhere — CI clones this repository alone. The
 * second half reads the real files when the umbrella workspace happens to be checked out around us,
 * which is where drift actually appears first. It is skipped rather than failed when they are
 * absent: a sibling repository is not infrastructure this repository is entitled to.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RESERVED_SLUGS, validateSlug } from '../modules/core/services/workspaces.js'

/**
 * Top-level paths `selfhost/Caddyfile` sends to a service instead of to the app. `mcp` and
 * `.well-known` are the MCP transport and the OAuth metadata documents an AI client fetches from
 * the site root; `kern` is the storage bucket, which is why `S3_BUCKET` cannot be renamed freely.
 */
const PROXY_PREFIXES = ['api', 'ws', 'collab', 'kern', 'mcp', '.well-known']
/** Literal top-level segments of `repos/shell/src/routes` (route groups looked through). */
const SHELL_ROUTES = [
  'onboarding',
  'workspaces',
  'forgot',
  'reset',
  'sign-in',
  'sign-up',
  'two-factor',
  'p',
  'authorize',
  'request',
]

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const umbrella = resolve(repoRoot, '../..')

/**
 * Every path prefix a Caddy config routes somewhere of its own.
 *
 * Line-based on purpose: the same directives live inside a heredoc in the Coolify and cloud compose
 * files, which have no Caddyfile to mount beside them, so one scanner reads all three.
 */
function caddyPrefixes(source: string): string[] {
  const found = new Set<string>()
  for (const line of source.split('\n')) {
    const directive = /^\s*(?:@\w+\s+path|path|route|handle|handle_path)\s+(.+)$/.exec(line)
    if (!directive?.[1]) continue
    for (const token of directive[1].split(/\s+/)) {
      if (!token.startsWith('/')) continue
      const segment = token.slice(1).split('/')[0]?.replace(/\*+$/, '')
      if (segment) found.add(segment)
    }
  }
  return [...found]
}

/** Literal top-level URL segments of a SvelteKit routes directory. */
function shellRoutes(dir: string): string[] {
  const found = new Set<string>()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    // `(app)` is a route group: it names no segment, so look through it.
    if (entry.name.startsWith('(') && entry.name.endsWith(')')) {
      for (const nested of shellRoutes(resolve(dir, entry.name))) found.add(nested)
      continue
    }
    // `[ws]` is the workspace slug itself, and `+…`/`.…` are not routes.
    if (/^[[+.]/.test(entry.name)) continue
    found.add(entry.name)
  }
  return [...found]
}

describe('reserved workspace slugs', () => {
  it('covers every path the reverse proxy owns', () => {
    for (const prefix of PROXY_PREFIXES)
      expect(RESERVED_SLUGS.has(prefix), `/${prefix} is proxied away from the app`).toBe(true)
  })

  it('covers every top-level page in the app', () => {
    for (const route of SHELL_ROUTES)
      expect(RESERVED_SLUGS.has(route), `/${route} is a page in shell`).toBe(true)
  })

  it('refuses a reserved slug rather than creating a workspace nobody can open', () => {
    expect(() => validateSlug('collab')).toThrow(/reserved/i)
    expect(() => validateSlug('workspaces')).toThrow(/reserved/i)
    // and still accepts an ordinary one
    expect(() => validateSlug('acme-eu')).not.toThrow()
  })

  const caddyFiles = [
    resolve(umbrella, 'selfhost/Caddyfile'),
    resolve(umbrella, 'selfhost/coolify/docker-compose.yml'),
    resolve(umbrella, 'cloud/docker-compose.yml'),
  ].filter((f) => existsSync(f))

  it.skipIf(caddyFiles.length === 0)('matches the shipped Caddy configs on disk', () => {
    for (const file of caddyFiles)
      for (const prefix of caddyPrefixes(readFileSync(file, 'utf8')))
        expect(RESERVED_SLUGS.has(prefix), `${file} routes /${prefix} elsewhere`).toBe(true)
  })

  const routesDir = resolve(umbrella, 'repos/shell/src/routes')
  it.skipIf(!existsSync(routesDir))('matches the shell routes on disk', () => {
    for (const route of shellRoutes(routesDir))
      expect(RESERVED_SLUGS.has(route), `shell serves /${route}`).toBe(true)
  })
})
