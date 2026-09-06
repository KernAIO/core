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
  admin settings live in shell, the capability switch is `core.mcp` on the core manifest. The
  design lives in `src/mcp/catalog.ts` and `src/mcp/oauth.ts`; there is no ADR for it.
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
- **"Sent" has to mean sent.** With no `SMTP_URL` and no mail module reachable, the mailer logged
  the message and returned normally — so every "Check your inbox, we sent you a link" screen on a
  fresh self-hosted instance was a lie and the person waited for a message that did not exist. In
  **production** that is now a `MailNotConfiguredError`; outside production it stays a log line,
  because a laptop with no Mailpit running is the ordinary case and the test harness depends on it.
  Two things the fix cannot reach, and both are worth knowing: Better Auth runs
  `sendVerificationEmail` through `runInBackgroundOrAwait`, which **swallows** the throw and logs
  it, so a sign-up still answers 200 and the shell still says "check your inbox" — only the magic
  link and the password reset surface the failure (as a 503 with `MAIL_NOT_CONFIGURED`, converted in
  `createAuth`). Refusing to *boot* would be worse than either: an instance without a relay is
  reachable and useful, and Kern Cloud itself has run that way. `reportMailReadiness` says so once,
  loudly, at boot.
- **A per-IP rate limiter that cannot resolve an IP is one bucket for the whole instance.** Better
  Auth refuses to believe an `X-Forwarded-For` with more than one entry unless it is told which hops
  to trust — which is right, since the leftmost entry is whatever the client typed — and then falls
  back to a single shared key. Kern Cloud is Cloudflare → Coolify → Caddy → core, so *every* request
  shared that key and Better Auth's own default of 3 sign-ins per 10 seconds applied to everybody at
  once: ordinary people refused sign-in because somebody else signed in. `advanced.ipAddress.
  trustedProxies` (the private ranges the shipped Caddyfile already trusts, plus
  `KERN_TRUSTED_PROXIES`) is what makes the bucket per person again, and `rateLimit` now carries
  Kern's numbers instead of the library's. Two traps worth knowing: a **public** proxy in front
  (Cloudflare) is not in the private ranges and has to be named, or everyone behind one edge shares
  a bucket; and `customRules` matches the *first* key that matches, so an exact path has to be
  listed above the wildcard covering it. The limiter runs in the router's `onRequest`, so a direct
  `auth.api.*` call never reaches it — a test that proves anything has to drive `auth.handler`.
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
- **A guest saw every project, and the obvious repair would not have changed that.** `guestScopes`
  is validated on the invitation, written onto the invitation and the membership and serialised
  back — and **no authorization code in the organisation reads it**, while `tracker` gives `guest`
  five project-scoped defaults and `quire` three space-scoped ones. So the role a customer picks for
  an external contractor read and edited every project in the workspace, under a shell string that
  says "Sees only what they are explicitly given". Writing a project-scoped `role_binding` per
  `guestScope` — the repair everyone reaches for — grants what was already granted and restrains
  nothing: `Authz.can()` consults narrow-scope bindings only when the **caller** asks at a narrow
  scope, falls through to `effective()` when it finds none, and `requires()` (what every module's
  list procedure uses) always asks at workspace scope. Trace the call path before trusting the
  mechanism.
  What does bite is the other half of the same machinery: `effective()` applies **workspace-scoped**
  bindings and honours `deny`. `bindingsFor` therefore prepends one synthetic
  `builtin_role:guest / workspace / deny` binding carrying every permission whose `scope` is not
  `workspace`, minus whatever the member's custom roles grant — `effective()` adds custom-role keys
  *before* it applies bindings, so a blanket deny would silently undo an administrator's explicit
  grant. A guest with a project binding still reads that project, because the chain `can()` walks
  excludes workspace. Prepended, not appended: the last word on a key wins, so a stored
  workspace-scoped allow still beats the floor.
  Two things this deliberately does not do. It does not let a scoped guest **list** — `requires()`
  asks at workspace scope, so `tracker.projects.list` refuses a guest whatever bindings it holds;
  making that work means every module listing at workspace scope and filtering per project, which is
  a change in the modules and not here. And it does not touch the modules' `defaultRoles`, which
  still *declare* the guest access the floor removes — `module-tracker` and `module-quire` should
  drop `guest` from their project/space-scoped permissions so the declaration and the behaviour
  agree. Fail-closed first: an under-powered guest is a disappointment, a leaky one is a breach.
- **A presigned PUT does not bind the content type, so the upload is the wrong place to enforce
  one.** `X-Amz-SignedHeaders` on the URL the kernel signs is `content-length;host` — `content-type`
  is not in it — so the uploader sends whatever it likes and the object carries it: a ticket issued
  for `text/plain` produced an object `mc stat` reports as `text/html`. Enforcement therefore lives
  on the **download**, where `presignGet` sets `response-content-type` on every single GET, and the
  row is re-checked there rather than trusted, so rows written before the rule are repaired without
  a migration. The rule itself is two halves: a type a browser runs as a document (html, xhtml,
  xml, xslt, javascript) is served as `text/plain`, and `inline` is honoured only for types that
  cannot become one — raster images, audio, video, plain text. SVG keeps its type and is forced to
  `attachment`, because `Content-Disposition` does not affect a subresource load: `<img src>` still
  renders it, and only a *navigation* is stopped. This mattered because `files.createUpload` is an
  ordinary member permission and every shipped stack serves object storage from the app's own
  origin. The residual is at the edge, not here: anything that serves the object **without** Kern's
  override still hands over the uploader's type, so the `/s3` route in the shipped Caddyfiles wants
  `X-Content-Type-Options: nosniff`. Verify this class by fetching the URL and reading the response
  headers — a signed parameter the store ignores looks identical in the URL and is worth nothing.
- **A closed account is anonymous on the one route that reopens it.** Closing suspends the user row
  and deletes every session, and `principal.ts` answers ANONYMOUS for any non-active user on every
  credential path — so `DELETE /api/core/account/deletion` went through `authed()` and answered 401
  to the only person entitled to call it, for the whole of the 30-day window the terms and the
  privacy policy promise. Nothing failed; the promise was simply unreachable, and it was invisible
  from the service functions, which were always callable and always worked. `authedOrClosed` is the
  single exception, narrowed three ways: a Better Auth **session** only (Better Auth knows nothing
  of `users.status`, so signing in again works — while an API key, a JWT or an MCP token stays
  anonymous, because a machine credential must not reopen an account), `suspended` and not
  `deleted`, and only with an open request against the row. Closure is also refused for the last
  *active* instance admin: on a self-hosted instance that is the door locking from the inside, with
  `KERN_ADMIN_EMAIL` at boot or SQL as the only way back. Any promise made in the terms deserves a
  test that drives the HTTP route, not the function beneath it.
- **`auth.api.getSession` does not answer "is there a session"; it answers "is there any credential
  here Better Auth will make one from".** The fix above read the first sentence and shipped the
  second: `authedOrClosed` called it with the whole request, and the api-key plugin's
  `enableSessionForAPIKeys` hook manufactured a session out of the `x-api-key` header before
  `/get-session` looked anything up — session id = the key's id, no row in `sessions`, and no
  glance at `users.status`. So the machine credential the comment three lines above ruled out
  reopened its own closed account: `DELETE /api/core/account/deletion` carrying only `x-api-key`
  answered **200** and set the row back to `active`, with a **read**-scoped key as readily as a
  writing one — while `principals.resolve()` was correctly answering ANONYMOUS for the very same
  request. A guard is only as narrow as the question it asks a library. `principals.sessionUserId`
  asks the right one: the session must name a **live row this instance issued**, matched on `token`
  (`sessions.id` is a `uuid` column, and a made-up id need not be one — a query that throws is a
  500 where a refusal belongs). `sessionHeaders()` is the second barrier: anything asking Better
  Auth about a session hands it `cookie` and `authorization` and nothing else, because handing it
  every header is handing it every credential.
- **`enableSessionForAPIKeys` was on, and it made every read-only API key a full account takeover.**
  The option reads like "let a key authenticate", which is not what it does and not what Kern needs
  it for — `fromApiKey` calls `verifyApiKey` itself and narrows the result to one workspace and to
  the key's `read`/`read_write` scope. What it does is register that manufacturing hook on **every**
  Better Auth endpoint. Measured with a read-scoped key over HTTP: `GET /api/auth/list-sessions`
  answered 200 with the owner's live session token **in plaintext**, and the `bearer` plugin accepts
  that token as a whole interactive session — so `PATCH /api/core/users/me` was 401 for the key and
  200 for the token the key had just handed over. `update-user` renamed the account,
  `api-key/create` minted another key with no capability or audience check, and both still worked
  after the account was closed. Off now, with `api-keys.test.ts` holding it there. The general
  shape: when a plugin option is about *how a credential is recognised*, read what it registers,
  not what it is called — and check the endpoints you did not write, because the library ships more
  of them than the product does.
- **A key minted through `POST /api/auth/api-key/create` is inert, and that is luck rather than a
  gate.** The raw Better Auth endpoint is mounted under `/api/auth/*` like every other, so a member
  with a session can create a key without passing `apiKeys.create`'s capability and audience checks.
  It authenticates nothing — `readApiKeyMetadata` returns null for a key with no `workspaceId`, so
  `fromApiKey` refuses it, and with `enableSessionForAPIKeys` off it is no longer a session either —
  but it is a row in `api_keys` that the workspace's own key list does not show. Blocking the path
  in the `before` hook is not free: core's own `apiKeys.create` calls `auth.api.createApiKey`, which
  arrives at the same `ctx.path`, so the hook has to tell a request-bound call from a server-side
  one (the same question the impersonation block already answers).
- **Do not pass `template` on `mail.send` from here — it would undo the localisation.** The mail
  module ships five branded MJML templates named exactly as core's messages (`magic-link`,
  `reset-password`, `verify-email`, `invitation`, `notification-digest`), and `SendMailInput` takes
  `template: { name, data }`, so wiring them up looks like a one-line win. It is not:
  `buildMessage` assigns `html = rendered.html` **unconditionally** (module-mail
  `src/server/send.ts`), and `renderTemplate` has no locale parameter and one file per name —
  rendering `magic-link` returns "Sign in to Kern" inside `<html lang="und" dir="auto">` whoever it
  is for. Measured by rendering it, not by reading it. So an Arabic or Persian recipient would get
  the branded English body instead of the `dir="rtl"` one `emails.ts` builds, which is exactly the
  defect that file was written to fix. Core keeps sending its own `text`/`html` (localised,
  unbranded) until the mail module can render a template in a locale — `renderTemplate(name, data,
  { locale })` over `<name>.<locale>.mjml`, and `buildMessage` leaving a caller's `html` alone.
