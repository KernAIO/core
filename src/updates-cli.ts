import { createKernel } from '@kernhq/kernel'
import { createDepsRef } from './modules/core/deps.js'
import { createCoreModule } from './modules/core/index.js'
import * as notifications from './modules/core/services/notifications.js'
import * as updates from './modules/core/services/updates.js'
import { featureModules } from './service.js'
import './env.js'

/**
 * The bridge between the panel and the thing on the host that actually upgrades Kern.
 *
 *   node dist/updates-cli.js plan                     may I upgrade, and to what (JSON on stdout)
 *   node dist/updates-cli.js record <version> ok
 *   node dist/updates-cli.js record <version> failed "what went wrong"
 *
 * An admin sets the policy in the interface; the host asks `plan` before it touches anything and
 * obeys the answer. Putting the decision here rather than in the shell script is what stops the
 * panel promising one thing while a cron job at 03:00 does another.
 *
 * This boots the kernel without starting an HTTP server or any workers: it reads settings, may
 * fetch the release feed, and exits.
 */

const [command, ...rest] = process.argv.slice(2)

const kernel = await createKernel({
  service: 'core-updates',
  modules: [createCoreModule(createDepsRef()), ...featureModules],
  role: 'api',
})

/** A CLI on the host is the instance itself, so it acts as the system rather than as a person. */
const ctx = { kernel, principal: kernel.system }

try {
  if (command === 'plan') {
    console.log(JSON.stringify(await updates.getPlan(ctx), null, 2))
  } else if (command === 'record') {
    const [version, outcome, error] = rest
    if (!version || (outcome !== 'ok' && outcome !== 'failed'))
      throw new Error('usage: record <version> ok|failed [message]')

    const attempt = await updates.recordAttempt(kernel, {
      version,
      ok: outcome === 'ok',
      error: error ?? null,
    })

    // Either outcome is worth an admin's attention: one is "your instance moved while you slept",
    // the other is "it tried and stopped, and will not try again until you look".
    for (const userId of await updates.instanceAdminIds(kernel)) {
      await notifications.createNotification(ctx, createDepsRef(), {
        userId: userId as never,
        workspaceId: null,
        module: 'core',
        type: 'core.system',
        title: attempt.ok
          ? `Kern updated itself to ${attempt.version}`
          : `Kern could not update itself to ${attempt.version}`,
        body: attempt.ok
          ? 'The upgrade was applied inside your update window.'
          : `${attempt.error ?? 'The upgrade failed.'} It will not be retried automatically.`,
        object: null,
        url: '/admin/updates',
        actorId: null,
        data: { version: attempt.version, ok: attempt.ok },
        groupKey: `auto-update:${attempt.version}`,
      })
    }
    console.log(JSON.stringify(attempt))
  } else {
    throw new Error(`unknown command "${command ?? ''}" — expected plan or record`)
  }
} finally {
  await kernel.stop()
}
