import type { Kernel } from '@kernhq/kernel'
import nodemailer, { type Transporter } from 'nodemailer'
import type { CoreEnv } from '../env.js'
import type { EmailLocale } from './emails.js'

export interface MailMessage {
  to: string
  subject: string
  text: string
  html?: string
  /** the recipient's language — decides the copy, and travels as `Content-Language` */
  locale?: EmailLocale
  /** workspace whose outbound provider should be used (mail module) */
  workspaceId?: string | null
}
export interface Mailer {
  send(msg: MailMessage): Promise<void>
}

/**
 * Nothing on this instance can deliver mail.
 *
 * Thrown rather than logged, because the alternative is a product that lies: with no `SMTP_URL` and
 * no mail module the mailer used to log the message and return normally, so "Check your inbox — we
 * sent a sign-in link" appeared on a fresh self-hosted instance and the person waited for a message
 * that was never sent. A caller that can show the failure (magic link, password reset) now shows
 * it; a caller that cannot (Better Auth's sign-up hook runs the send as a background task and
 * swallows what it throws) at least leaves an error in the log naming the missing configuration.
 */
export class MailNotConfiguredError extends Error {
  readonly code = 'core.mail.not_configured'
  constructor() {
    super(
      'No outbound mail is configured: set SMTP_URL, or host the mail module so `mail.send` can be reached.',
    )
    this.name = 'MailNotConfiguredError'
  }
}

/** Whether `mail.send` can be reached — locally in this process, or over NATS. */
const mailModuleReachable = (kernel: Kernel): boolean => kernel.broker.has('mail.send') || !!kernel.nats

/**
 * Says once, at boot, that this instance cannot send mail.
 *
 * Every account on a Kern instance starts with an email — a verification link, an invitation — so
 * an instance without a relay is broken in a way that only shows up one sign-up at a time. The
 * check runs after `kernel.start()`, because whether `mail.send` is reachable is not known before
 * the modules are registered and NATS is connected.
 */
export function reportMailReadiness(kernel: Kernel, env: CoreEnv): void {
  if (env.SMTP_URL || mailModuleReachable(kernel)) return
  const message =
    'no outbound mail is configured — verification links, sign-in links, invitations and digests cannot be delivered'
  if (env.NODE_ENV === 'production') kernel.log.error({ fix: 'set SMTP_URL' }, message)
  else kernel.log.warn({ fix: 'set SMTP_URL' }, `${message} (development: mail is logged instead)`)
}

/**
 * Outbound mail for the core service (verification, magic links, invitations, digests).
 * Production: prefer the mail module (`mail.send` via kernel.call) when it is hosted somewhere; fall back to SMTP_URL.
 * Development: SMTP_URL (Mailpit). No SMTP_URL → log only, and only outside production.
 */
export function createMailer(kernel: Kernel, env: CoreEnv): Mailer {
  let transport: Transporter | null = null
  const smtp = () => {
    if (!env.SMTP_URL) return null
    transport ??= nodemailer.createTransport(env.SMTP_URL)
    return transport
  }
  const viaModule = async (msg: MailMessage) => {
    if (env.NODE_ENV !== 'production') return false
    if (!mailModuleReachable(kernel)) return false
    try {
      // The mail contract's `SendMailInput`: `to` is a list, and instance-level mail *omits*
      // `workspaceId` rather than passing null. Both were wrong here, so every call failed
      // validation and every sign-in link went out through the SMTP fallback below — which on an
      // instance whose mail is configured per workspace in the mail module means it did not go.
      await kernel.call('mail.send', {
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        ...(msg.locale ? { headers: { 'Content-Language': msg.locale } } : {}),
        ...(msg.workspaceId ? { workspaceId: msg.workspaceId } : {}),
      })
      return true
    } catch (err) {
      kernel.log.warn(
        { err: (err as Error).message },
        'mail.send via mail module failed; falling back to SMTP',
      )
      return false
    }
  }
  return {
    async send(msg) {
      if (await viaModule(msg)) return
      const t = smtp()
      if (!t) {
        // Outside production this is the ordinary development path (no Mailpit running, nothing to
        // send to); in production it is the instance telling a person their mail arrived when it
        // did not, so it is an error the caller has to handle.
        if (env.NODE_ENV === 'production') {
          kernel.log.error({ to: msg.to, subject: msg.subject }, 'mail not sent: no transport configured')
          throw new MailNotConfiguredError()
        }
        kernel.log.info({ to: msg.to, subject: msg.subject }, 'mail (no SMTP_URL configured – not sent)')
        return
      }
      await t.sendMail({
        from: env.MAIL_FROM,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        ...(msg.locale ? { headers: { 'Content-Language': msg.locale } } : {}),
      })
      kernel.log.debug({ to: msg.to, subject: msg.subject }, 'mail sent')
    },
  }
}
