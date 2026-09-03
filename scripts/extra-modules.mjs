#!/usr/bin/env node
/**
 * Wire extra modules into this image.
 *
 *   KERN_EXTRA_MODULES="@acme/module-crm@1.2.0 @acme/module-timesheets@0.4.1" node scripts/extra-modules.mjs
 *
 * A third-party module used to need a line in `src/service.ts`, which meant forking this repository
 * to host one. Now the Dockerfile takes the same string as a build argument, installs the packages,
 * and runs this — which rewrites `src/extra-modules.ts` to import each package's `./server` default
 * export. `featureModules` spreads that list, so the kernel migrates, mounts and switches the module
 * exactly as it does a first-party one.
 *
 * The packages must already be installed: this checks that each `<name>/server` resolves and stops
 * with the package's name when one does not, because a module the build cannot find is a fork of
 * the Dockerfile away from being silently absent. With the variable empty the committed file is
 * written back unchanged.
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../src/extra-modules.ts')

const specs = (process.env.KERN_EXTRA_MODULES ?? process.argv.slice(2).join(' '))
  .split(/[\s,]+/)
  .filter(Boolean)

/** `@scope/name@1.2.0` → `@scope/name`; `name@^1` → `name`; a bare name stays as it is. */
const packageName = (spec) => {
  const at = spec.lastIndexOf('@')
  return at > 0 ? spec.slice(0, at) : spec
}

const names = [...new Set(specs.map(packageName))]
const missing = names.filter((name) => {
  try {
    import.meta.resolve(`${name}/server`)
    return false
  } catch {
    return true
  }
})
if (missing.length) {
  console.error(`extra-modules: not installed, or no "./server" entry point: ${missing.join(', ')}`)
  console.error('  pnpm add the package first — the Dockerfile does this from KERN_EXTRA_MODULES.')
  process.exit(1)
}

const imports = names.map((name, i) => `import extra${i} from '${name}/server'`)
const list = names.map((_, i) => `extra${i}`).join(', ')
const header = [
  '// Rewritten at image build by `scripts/extra-modules.mjs` from KERN_EXTRA_MODULES. Do not edit:',
  '// with the variable empty the script writes this exact file back, so a normal build changes nothing.',
  "import type { ServerModule } from '@kernhq/kernel'",
]
const body = names.length
  ? [
      ...imports,
      '',
      `/** Modules a self-hoster built into this image beside the first-party set: ${names.join(', ')}. */`,
      `export const extraModules: ServerModule[] = [${list}]`,
    ]
  : [
      '',
      '/** Modules a self-hoster built into this image beside the first-party set. Empty in the published images. */',
      'export const extraModules: ServerModule[] = []',
    ]
writeFileSync(OUT, `${[...header, ...body].join('\n')}\n`)
console.log(names.length ? `extra-modules: ${names.join(', ')}` : 'extra-modules: none')
