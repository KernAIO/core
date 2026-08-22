import type { Kernel } from '@kernhq/kernel'
import nodemailer, { type Transporter } from 'nodemailer'
import type { CoreEnv } from '../env.js'

export interface MailMessage {
  to: string
  subject: string
  text: string
  html?: string
  /** workspace whose outbound provider should be used (mail module) */
  workspaceId?: string | null
}
export interface Mailer {
  send(msg: MailMessage): Promise<void>
}

/**
 * Outbound mail for the core service (verification, magic links, invitations, digests).
 * Production: prefer the mail module (`mail.send` via kernel.call) when it is hosted somewhere; fall back to SMTP_URL.
 * Development: SMTP_URL (Mailpit). No SMTP_URL → log only.
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
    if (!kernel.broker.has('mail.send') && !kernel.nats) return false
    try {
      await kernel.call('mail.send', {
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        workspaceId: msg.workspaceId ?? null,
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
        kernel.log.info({ to: msg.to, subject: msg.subject }, 'mail (no SMTP_URL configured – not sent)')
        return
      }
      await t.sendMail({
        from: env.MAIL_FROM,
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
      })
      kernel.log.debug({ to: msg.to, subject: msg.subject }, 'mail sent')
    },
  }
}

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
/** minimal transactional template */
export function renderEmail(opts: {
  title: string
  intro: string
  actionUrl?: string
  actionLabel?: string
  footer?: string
}) {
  const btn = opts.actionUrl
    ? `<p style="margin:24px 0"><a href="${escapeHtml(opts.actionUrl)}" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">${escapeHtml(opts.actionLabel ?? 'Open')}</a></p><p style="color:#71717a;font-size:12px">${escapeHtml(opts.actionUrl)}</p>`
    : ''
  const html = `<!doctype html><html><body style="font-family:Inter,system-ui,sans-serif;color:#18181b;max-width:560px;margin:0 auto;padding:24px"><h2 style="margin:0 0 12px">${escapeHtml(opts.title)}</h2><p>${escapeHtml(opts.intro)}</p>${btn}<p style="color:#71717a;font-size:12px">${escapeHtml(opts.footer ?? 'Sent by Kern')}</p></body></html>`
  const text = `${opts.title}\n\n${opts.intro}\n${opts.actionUrl ? `\n${opts.actionUrl}\n` : ''}\n${opts.footer ?? 'Sent by Kern'}`
  return { html, text }
}
