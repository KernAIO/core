# CLAUDE.md — Kern project rules

Rules for anyone (human or AI agent) working on Kern repositories. These apply to every repo in the KernAIO org.

## We build in the open
The repositories are **public**, so every commit is visible the moment it is pushed:
- Never commit secrets, tokens, personal data, or machine-specific paths. Use `.env` (gitignored) + `.env.example`.
- Write READMEs, docs, and issue/PR text for external contributors, not for ourselves.
- Keep commit history clean and meaningful — it is part of what people judge the project by.
- Every repo carries LICENSE, CLA.md, CODE_OF_CONDUCT.md, SECURITY.md, CONTRIBUTING.md.
- **Two licences, split at the framework boundary.** The `kernel` repo and `modules`'
  `_template` + `workflow` are **Apache-2.0** so anyone can write a closed module; the product —
  `shell`, `core`, `chat`, `mail`, `collab`, `docs`, this umbrella, the first-party modules — is
  **AGPL-3.0-only**. A new package inherits its repo's licence unless it is something a third-party
  module must import, and then it is Apache-2.0 with its own LICENSE file. Apache-2.0 packages take
  only permissive dependencies. If a module author has to import an AGPL package to get something
  done, move the API — never the licence. See `LICENSING.md` and
  `docs/adr/0005-licensing-and-the-module-boundary.md`.

## Git
- Author identity: `Navid Mirzaaghazadeh <mirzaaghazadeh@icloud.com>` (already set in each repo's local git config — plain `git commit` is correct; do not override with `-c`).
- **Do not add `Claude-Session:`, `Co-Authored-By: Claude`, "Generated with", or any AI trailer/branding to commit messages, PRs, or code comments.**
- Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, with optional scope). Imperative mood, ≤ 72-char subject.
- Push to `origin main`. Never force-push. If `git pull --rebase` complains about unstaged files that aren't yours (parallel agents share worktrees), use `git -c rebase.autoStash=true pull --rebase`.
- **Never `git add -A` or `git add .`. Stage the paths you changed, by name.** Several agents share
  these checkouts, and another one is very often part-way through a new package in the same repo.
  `git add -A` sweeps their half-finished files into your commit and pushes them — under your commit
  message, without their lockfile entry, so CI fails at install for everyone. It happened on
  2026-08-24: a contact-address fix carried two unfinished modules into `main`. Run
  `git status --porcelain` first and stage from it; if you cannot name every path you are about to
  commit, you are not ready to commit. When it does happen, do not revert the other agent's files —
  they are still working on them; tell them instead, and repair what you broke.

## Layout & workflow
- Umbrella dev workspace: `app/` with sibling repos cloned under `app/repos/<name>` (gitignored there). pnpm links all `@kernhq/*` packages via the umbrella workspace.
- Install dependencies ONLY via `app/scripts/pnpm-install-locked.sh` (serialises pnpm at the umbrella root).
- Node 24 (`nvm use 24`), pnpm 10, TypeScript ~5.9, ESM/NodeNext, Biome for lint+format (run `pnpm exec biome check --write <paths>` before committing), Vitest.
- Contracts first: changes to `@kernhq/contracts` / module contracts land (and build) before their consumers.
- Modules own their data: Postgres schema `mod_<id>`, `workspace_id` + RLS on every tenant table, cross-module access only via `kernel.call()` and events. See `modules` repo `packages/_template`.
- Ports: shell 5173 · core 4000 · chat 4100 · mail 4200 · collab 4300 · docs 4400.
- Dev DB on this machine: Homebrew Postgres 18 at `localhost:5432` (`kern`/`kern`); the compose Postgres listens on `${KERN_PG_PORT:-5432}` (5433 here).

## CI
Every service repository's CI runs the real suites, so the workflow starts the infrastructure they
need as service containers: Postgres (`pgvector/pgvector:pg18`) everywhere, Valkey for `chat`,
Mailpit for `mail`. Things learned the hard way:
- Address a service container as **127.0.0.1**, never `localhost` — a runner resolves `localhost` to
  `::1` first, where the published port is not listening, and `fetch` does not retry over IPv4.
- Do not set `registry-url` on `actions/setup-node` in an install job. It writes an `.npmrc` with a
  placeholder token, and npm answers a bad token with **404**, so public packages appear to vanish.
- A repository is built **standalone** in CI. `workspace:*` only resolves inside the umbrella
  workspace; depend on the published version instead.
- **Each repository's own `pnpm-lock.yaml` is what CI installs from, and you cannot refresh it from
  inside the umbrella.** Add a dependency to a package and the umbrella install updates the *umbrella*
  lockfile, leaving the repo's committed one stale — CI then fails every job at
  `ERR_PNPM_OUTDATED_LOCKFILE`, install-time, before a single test runs. Plain `pnpm install` in
  `repos/<name>` walks up and attaches to the umbrella; `--ignore-workspace` skips `packages/*` and
  cheerfully reports nothing to do. Clone the repo somewhere outside the workspace and run
  `pnpm install --lockfile-only` there, then copy the lockfile back.
- Skipping a test because its infrastructure is missing is fine on a laptop and dishonest in CI.
  Fail when `process.env.CI` is set.

## Writing
Documentation — READMEs, guides, runbooks, `docs/`, and any procedure someone follows — uses the
`adhd-friendly-ste-technical-writer` skill in `.claude/skills/`: goal first, one action per step,
short sentences, conditions before commands, an observable result after every important action.
It is a house style inspired by ASD-STE100, not certified compliance — do not claim otherwise.
It governs documents for readers. Code comments and commit messages keep the voice they have.

## Quality bar
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build` must pass before pushing.
- UI follows `shell/DESIGN.md` (Ink/paper design system) and must work in RTL (fa/ar) and dark mode.
- All user-facing strings go through i18n (Paraglide) — no hardcoded English in components.

## Keeping this file current
This file is how the next person — or the next agent — avoids repeating what we already worked out.
When you learn something durable, add it here **in the same commit as the change that taught you**:
- a trap that cost you time (a silent failure, a misleading error, a tool that lies about success)
- a convention you had to infer from reading several files
- a decision and the reason behind it, especially where the obvious choice is wrong
Keep it specific and short. Delete anything that stops being true — a stale note is worse than none.

---

# This repository: core (identity, workspaces, permissions)

The service every other one depends on: accounts and sessions, workspaces and membership, roles and
permission resolution, notifications, files, search, the audit log, and the admin console API. Runs on
**:4000** and mounts its module at `/api/core`, with the OpenAPI document at `/api/core/openapi.json`
and a reference UI at `/api/docs`.

**Things worth knowing**
- This service hosts **feature modules** as well as `core` — see `featureModules` in `src/service.ts`.
  A module only needs its own service when it has a runtime reason (chat holds websockets, mail holds
  IMAP connections, collab is CPU-bound CRDT merging); everything else lives here. Adding one is a
  dependency plus a line in that array: the kernel runs its migrations into `mod_<id>`, mounts its
  router at `/api/<id>`, registers its permissions and jobs, and it appears in the workspace modules
  directory enabled by default. `/api/*` already routes here in Caddy and in the app's dev proxy, so
  nothing else changes.
- A module that nothing hosts is invisible: its own tests pass, it publishes, and every call 404s.
  `src/tests/hosted-modules.test.ts` uses each hosted module through this service so that cannot
  happen quietly.
- Authentication is **Better Auth**, adapted onto our Drizzle schema in `src/modules/core/schema/auth.ts`.
  That schema must match what Better Auth expects exactly — a missing column fails at runtime, not at
  compile time. `accounts.issuer` was missing once and broke every sign-up.
- Better Auth's plugin types are nominal: if two copies of `better-auth` end up in the tree, plugins
  stop satisfying `BetterAuthPlugin` and the whole `auth.api` type degrades. The umbrella pins one copy
  through `pnpm.overrides`.
- **Which tables are row-level secured matters.** Tenant tables carry `workspace_id` and an RLS policy
  driven by `app.workspace_id`; global tables (users, workspaces, memberships, notifications, push
  subscriptions, instance settings) deliberately are not. `database.withWorkspace()` sets the setting —
  a tenant query outside it returns nothing.
- Drizzle interpolates a JavaScript array as a row constructor (`($1,$2)`), not as an array. Use
  `sql.param(values)` when a query needs a real `text[]` — search failed on every request until this
  was found.
- Broker procedures (`core.users.principal`, `core.authz.*`, `core.notifications.create` …) are how
  other services reach identity. They are service-to-service only: `requireService` rejects end users.
- **RLS only bites under a role that cannot bypass it.** Superusers (and the table owner without
  `FORCE`) ignore every policy, so a dev database owned by a superuser will happily pass a test that
  proves nothing — `src/testing/harness.ts` opens a second connection as an unprivileged role for that
  reason. Run the application as a plain role in production.
- Filtering by `kernel.manifests()` only sees modules hosted **in this process**. Core hosts nothing but
  itself, so anything that must reason about other modules (search's enabled-module filter) has to read
  `workspace_modules` instead.
- Tests boot the real service against a scratch database (`src/testing/harness.ts`) and drive the module
  router through an oRPC server-side client, so middleware runs exactly as it does over HTTP.
  `pnpm typecheck` uses `tsconfig.test.json` (tests included); `pnpm build` excludes them.
- **A partial unique index needs `targetWhere` on every upsert that aims at it.** `dashboard_layouts`
  makes `user_id is null` mean "the layout the workspace hands out", which a plain unique index
  cannot enforce — Postgres treats every NULL as distinct, so the workspace row could be inserted
  any number of times. The two partial indexes are hand-written in the migration (drizzle-kit emits
  neither form), and `onConflictDoUpdate` has to repeat the predicate or Postgres cannot tell which
  index the insert arbitrates against.
- **Not every write deserves a realtime message.** `dashboard.save` deliberately emits nothing: one
  person moving a card on their own home page must not invalidate every other member's dashboard.
  Only the workspace-wide writes announce themselves, because only those change what somebody else
  sees.
- **MCP lives in `src/mcp/`, and its tools are generated, not declared.** `catalog.ts` turns every
  hosted module's OpenAPI document into MCP tools (remote services' documents are read over HTTP);
  a module ships no MCP code. Tool calls execute as ordinary REST requests carrying the caller's
  access token, so permissions/capabilities have exactly one enforcement site. OAuth is in
  `oauth.ts` (tokens stored hashed, prefix `kmt_`/`kmr_`, PKCE S256 only); the consent screen and
  admin settings live in shell, the capability switch is `core.mcp` on the core manifest. See ADR
  0011.
- **`db:generate` diffs against the last *snapshot*, not the last migration.** `0003_dashboard` was
  hand-written with no snapshot, so the next generate re-emitted every dashboard column into the new
  file. After generating, trim the SQL to only your new statements — but keep the snapshot it wrote,
  which describes the whole schema and makes the next generate clean. Rename the generated file to
  something meaningful and update `meta/_journal.json`'s tag to match.
- **`/api/docs` is the only HTML this service serves, and it loads Scalar from a CDN.** The API's
  content policy is `default-src 'none'` — right for JSON, and fatal for that page — so the docs
  route sets its own looser header rather than the whole service loosening for one developer-facing
  page. Anything else here that starts returning HTML has to do the same.
- **`0000_init.sql` was not replay-safe, and nothing here noticed for months.** Ten
  `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` statements with no `DROP CONSTRAINT IF EXISTS` in
  front of them, so a second pass over the folder threw — and because the kernel migrates every
  hosted module at boot, that is not a degraded feature but a service that never binds :4000, taking
  tracker, quire, hr, billing and inventory down with it. Editing *any* file in `migrations/`
  triggers the replay, because drizzle keys applied migrations by content hash.
  `src/tests/migrations.test.ts` is the guard: it applies the whole folder twice to a database
  created from nothing, asserts every policy exists once, and checks the journal's timestamps rise.
  Run it before touching migrations, not after.
- **A user-facing procedure core cannot declare goes in `httpRoutes`, and says why.** The router is
  `implement(coreContract)` and `coreContract` lives in `@kernhq/contracts` — another repository —
  so a procedure added to the router alone is a *failing build*: `admin.diagnostics` walks the
  router against the contract and `src/tests/diagnostics.test.ts` asserts nothing is undeclared.
  That check is right and should stay. Export and erasure are therefore mounted as
  `src/modules/core/http-routes.ts` under the same `/api/core` prefix, which is the platform's own
  supported escape hatch — at the cost of no generated client, no OpenAPI entry, and **no
  `workspaceScoped`**, so principal, membership and permission are all written out by hand there.
  Moving them onto the contract is the follow-up; that file should shrink, never grow.
- **Sign-up is gated in exactly one place, and it is not a list of routes.** Better Auth's
  `user.validateUserInfo` runs immediately before `create-user` for every authentication method —
  email+password, social OAuth, magic link, SSO (OIDC and SAML), email OTP, SIWE, phone and the
  admin plugin — because all of them provision through `internalAdapter.createUser`. Gating the
  sign-up *paths* instead means a list that falls behind the plugin set the first time somebody adds
  a provider. Passkeys cannot create an account at all: the plugin registers a credential against a
  session that already exists. A throw inside the hook is treated as a refusal, so the gate fails
  closed. See `src/auth/signup.ts`.
- **`allowSignup` is seeded once and then belongs to the administrator.** The contract's default is
  `true`, which is right for Kern Cloud and wrong for a self-hosted instance, so `seedSignupPolicy`
  writes the value on the boot that finds no settings row and never touches an existing one —
  changing `KERN_SIGNUP` later does nothing. Unset means invite-only *only when the instance can
  bootstrap an administrator*; closing an instance that has no way to create its first account
  bricks it, and nothing in the product can recover from that.
- **A workspace needs a verified email behind it; an invitation counts as one.** `workspaces.create`
  refuses an unconfirmed address (`core.workspace.email_unverified`), which is a verification gate
  and not a sign-up gate — Kern Cloud keeps sign-up open. `invitations.accept` marks the address
  verified when `invitations.user_id` was null, and only then: that is exactly the case where the
  token could only have arrived by email. An invitation to somebody who already has an account is
  also delivered as an in-app notification carrying the token, so it proves nothing.
- **Deletion asks modules; it never reaches into `mod_<id>`.** `purgeWorkspace` and `purgeAccount`
  emit `core.workspace.purge` / `core.account.purge` and call `<module>.erase`; every module that
  does not answer is written into the request's `follow_ups` by name. Same shape for export and
  `<module>.export`. Nothing implements either yet, so today every module lands in the follow-up
  list — which is the honest report, and the list somebody works through. An archive labelled
  "export" holding only core's rows would be worse than no export at all.
- **An account purge anonymises the user row; a workspace purge deletes.** `activity_events.actor_id`,
  `files.uploaded_by` and every module's audit trail point at a user id, so hard-deleting the row
  would either cascade through other tenants' history or leave references that read as corruption.
  `status: 'deleted'` with the identifying columns emptied (and the id folded into `email`, which is
  unique, so the address can be taken again) is what erasure means for a shared record.
- **An unset variable in a compose file arrives as the empty string, not as absent.** Every shipped
  stack passes `KERN_SIGNUP: ${KERN_SIGNUP:-}` and `.env.example` ships that line empty, so zod had
  a *value* to validate: "Invalid option", thrown by `loadCoreEnv` before the service bound :4000 —
  no self-hosted instance started. `KERN_ADMIN_EMAIL`, `KERN_ADMIN_PASSWORD` and
  `BETTER_AUTH_SECRET` were one blank line from the same crash, and the fields with a `.default()`
  fail quietly instead, because a default only fires for `undefined`: `MAIL_FROM: ''` sends mail
  from nobody and `UPLOAD_MAX_PUT_BYTES: ''` coerces to 0 and refuses every upload. `src/env.ts`
  maps blank to `undefined` for the whole object at once — per field is a rule the next field has to
  remember — and `src/tests/env.test.ts` walks every key the schema declares. Any service reading
  env this way has it; `KernelEnv` still does.
- **Mail is a screen too, and it was the only one still monolingual.** Kern ships five locales and a
  right-to-left interface, and every message this service sent was hardcoded English laid out left
  to right. The copy lives in `src/auth/emails.ts`, one bundle per locale (`en ar de fa tr`), and
  three rules hold it together: the **recipient's** locale decides (Better Auth hands the user row
  to its callbacks; a magic link is looked up by address; an invitation falls back to the inviter
  and then to `KERN_DEFAULT_LOCALE`); counts and plurals go through `Intl`, so Arabic gets its six
  categories and Persian gets its own digits; and `ar`/`fa` set `dir="rtl"` on the document **and**
  the body, because a mail client renders the markup with none of our stylesheets. `tr` is in the
  bundles although `@kernhq/contracts`' `Locale` enum still stops at `de` — the shell speaks
  Turkish, so the speaker exists; `emailLocale()` narrows anything and falls back rather than
  throwing.
- **A loop that sends mail needs the try/catch inside it, not around it.** The hourly notification
  digest awaited `mailer.send` in the middle of its `for` loop, so a relay answering 550 at RCPT TO
  for one departed employee threw out of the loop: everybody the pass had not reached yet got
  nothing, their `emailedAt` stayed unset, and the same address broke the same run again an hour
  later, for ever. The failure is per recipient now and counted into the job's result
  (`{ sent, failed, abandoned }`) so a spike is visible in the log rather than only in a support
  ticket. The second half is knowing when to stop: a **permanent** refusal (SMTP 5xx, nodemailer's
  `EENVELOPE`) stamps the notifications as digested so the address is not retried hourly for ever —
  the notification is still in the person's inbox in the app — while a 4xx or a timeout is left for
  the next pass.
- **A workspace slug loses to the reverse proxy as easily as to a page.** `RESERVED_SLUGS` was
  written against `repos/shell/src/routes` alone, so `/collab*`, which Caddy has always sent to the
  collab service, was free to take: the workspace was created and then answered on nothing outside
  the container network. Both lists live in other repositories and drift in silence, so
  `src/tests/reserved-slugs.test.ts` holds the set to an enumeration of each and, when the umbrella
  workspace is checked out around us, re-derives them from the shipped Caddy configs and shell's
  routes.
