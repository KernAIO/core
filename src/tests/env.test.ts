/**
 * An unset variable in a shipped compose file arrives as the empty string, not as absent.
 *
 * `docker-compose.yml` passes `KERN_SIGNUP: ${KERN_SIGNUP:-}` and `.env.example` ships that line
 * empty, so every self-hosted instance handed core `KERN_SIGNUP: ''`, zod answered "Invalid
 * option", and `loadCoreEnv` threw before the service bound :4000. The same shape was waiting in
 * `KERN_ADMIN_EMAIL`, `KERN_ADMIN_PASSWORD` and `BETTER_AUTH_SECRET`, and quieter versions of it in
 * every field with a `.default()` — a default only fires for `undefined`.
 *
 * So the rule is the whole object at once, and this walks the whole object to prove it: every key
 * the schema declares, blank, must parse. A field added later is covered without anybody
 * remembering to come back here.
 */
import { describe, expect, it } from 'vitest'
import { CoreEnv, CoreEnvFields, loadCoreEnv } from '../env.js'

const KEYS = Object.keys(CoreEnvFields.shape)
const blank = (value: string) => Object.fromEntries(KEYS.map((k) => [k, value]))

describe('core environment', () => {
  it('declares the keys the shipped compose files pass', () => {
    // Named so a rename is visible here rather than only on somebody's server.
    for (const key of ['KERN_SIGNUP', 'KERN_ADMIN_EMAIL', 'KERN_ADMIN_PASSWORD', 'BETTER_AUTH_SECRET'])
      expect(KEYS).toContain(key)
  })

  it('treats an empty value as unset, for every key it has', () => {
    const parsed = CoreEnv.safeParse(blank(''))
    const issues = parsed.success
      ? ''
      : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')
    expect(issues, 'a blank environment must load').toBe('')
  })

  it('treats a whitespace-only value as unset too', () => {
    expect(CoreEnv.safeParse(blank('   ')).success).toBe(true)
  })

  it('applies defaults rather than keeping the empty string', () => {
    const env = CoreEnv.parse(blank(''))
    expect(env.NODE_ENV).toBe('development')
    expect(env.MAIL_FROM).toBe('Kern <no-reply@localhost>')
    expect(env.KERN_ADMIN_NAME).toBe('Admin')
    // `Number('')` is 0, so this one loaded fine and refused every upload.
    expect(env.UPLOAD_MAX_PUT_BYTES).toBe(500 * 1024 * 1024)
    expect(env.KERN_SIGNUP).toBeUndefined()
    expect(env.KERN_ADMIN_EMAIL).toBeUndefined()
    expect(env.PASSKEY_RP_ID).toBeUndefined()
  })

  it('loads a process environment whose optional keys are all empty', () => {
    const env = loadCoreEnv(blank(''))
    expect(env.KERN_SIGNUP).toBeUndefined()
    expect(env.BETTER_AUTH_SECRET).toBeUndefined()
  })

  it('still validates a value that is actually there', () => {
    expect(CoreEnv.safeParse({ ...blank(''), KERN_SIGNUP: 'invite' }).success).toBe(true)
    expect(CoreEnv.safeParse({ ...blank(''), KERN_SIGNUP: 'maybe' }).success).toBe(false)
    expect(CoreEnv.safeParse({ ...blank(''), KERN_ADMIN_EMAIL: 'nobody' }).success).toBe(false)
    expect(CoreEnv.safeParse({ ...blank(''), BETTER_AUTH_SECRET: 'short' }).success).toBe(false)
    expect(() => loadCoreEnv({ ...blank(''), KERN_SIGNUP: 'maybe' })).toThrow(/KERN_SIGNUP/)
  })
})
