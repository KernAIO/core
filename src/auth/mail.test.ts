import type { Kernel } from '@kernhq/kernel'
import { describe, expect, it, vi } from 'vitest'
import type { CoreEnv } from '../env.js'
import { createMailer, MailNotConfiguredError, reportMailReadiness } from './mail.js'

/**
 * The shape core hands the mail module, pinned.
 *
 * `mail.send` is validated against the mail module's `SendMailInput` on the other side of the
 * broker: `to` is an array and instance-level mail omits `workspaceId`. Core sent a string and
 * `null`, so every call failed validation, logged "falling back to SMTP", and sent through
 * nodemailer instead — invisible in development, where the fallback is what runs anyway, and found
 * on the cloud by reading the log of a magic-link request.
 */
function fakeKernel(call: (name: string, input: unknown) => Promise<unknown>): Kernel {
  return {
    broker: { has: () => true },
    nats: null,
    call,
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  } as unknown as Kernel
}

const env = {
  NODE_ENV: 'production',
  SMTP_URL: undefined,
  MAIL_FROM: 'Kern <no-reply@example.test>',
} as unknown as CoreEnv

describe('core → mail module', () => {
  it('sends `to` as a list and leaves `workspaceId` out for instance-level mail', async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = []
    const mailer = createMailer(
      fakeKernel(async (name, input) => {
        calls.push({ name, input: input as Record<string, unknown> })
        return { deliveryId: 'x', status: 'queued' }
      }),
      env,
    )
    await mailer.send({ to: 'new@example.test', subject: 'Sign in', text: 'link' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe('mail.send')
    expect(calls[0]!.input.to).toEqual(['new@example.test'])
    expect('workspaceId' in calls[0]!.input).toBe(false)
  })

  it('names the workspace when the mail belongs to one', async () => {
    const calls: Array<Record<string, unknown>> = []
    const mailer = createMailer(
      fakeKernel(async (_name, input) => {
        calls.push(input as Record<string, unknown>)
        return {}
      }),
      env,
    )
    await mailer.send({ to: 'a@example.test', subject: 'Invitation', text: 'hi', workspaceId: 'ws-1' })
    expect(calls[0]!.workspaceId).toBe('ws-1')
  })

  it('carries the recipient’s language as Content-Language', async () => {
    const calls: Array<Record<string, unknown>> = []
    const mailer = createMailer(
      fakeKernel(async (_name, input) => {
        calls.push(input as Record<string, unknown>)
        return {}
      }),
      env,
    )
    await mailer.send({ to: 'a@example.test', subject: 'تأیید', text: 'x', locale: 'fa' })
    expect(calls[0]!.headers).toEqual({ 'Content-Language': 'fa' })
  })

  /**
   * With no relay at all the mailer used to log the message and return, so a fresh self-hosted
   * instance showed "Check your inbox — we sent a sign-in link" for a message that was never sent.
   * In production that is now a failure the caller can show; in development it stays a log line,
   * because a laptop with no Mailpit running is the ordinary case and not a broken instance.
   */
  it('refuses to report success when nothing can send, in production', async () => {
    const kernel = fakeKernel(async () => {
      throw new Error('Input validation failed')
    })
    const mailer = createMailer(kernel, env)
    await expect(mailer.send({ to: 'a@example.test', subject: 's', text: 't' })).rejects.toBeInstanceOf(
      MailNotConfiguredError,
    )
    expect(kernel.log.warn).toHaveBeenCalled()
    expect(kernel.log.error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('not sent'))
  })

  it('still only logs outside production', async () => {
    const kernel = fakeKernel(async () => ({}))
    const dev = { ...env, NODE_ENV: 'development' } as unknown as CoreEnv
    const mailer = createMailer(kernel, dev)
    await mailer.send({ to: 'a@example.test', subject: 's', text: 't' })
    expect(kernel.log.info).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('not sent'))
  })
})

describe('mail readiness', () => {
  it('is an error in production and a warning on a laptop', () => {
    const unreachable = () =>
      ({
        broker: { has: () => false },
        nats: null,
        log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      }) as unknown as Kernel

    const prod = unreachable()
    reportMailReadiness(prod, env)
    expect(prod.log.error).toHaveBeenCalled()

    const dev = unreachable()
    reportMailReadiness(dev, { ...env, NODE_ENV: 'development' } as unknown as CoreEnv)
    expect(dev.log.error).not.toHaveBeenCalled()
    expect(dev.log.warn).toHaveBeenCalled()

    // configured: nothing to say
    const configured = unreachable()
    reportMailReadiness(configured, { ...env, SMTP_URL: 'smtp://localhost:1025' } as unknown as CoreEnv)
    expect(configured.log.error).not.toHaveBeenCalled()
    expect(configured.log.warn).not.toHaveBeenCalled()
  })
})
