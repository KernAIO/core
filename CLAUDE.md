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
  `app`, `core`, `chat`, `mail`, `collab`, `docs`, this umbrella, the first-party modules — is
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

## Layout & workflow
- Umbrella dev workspace: `kern/` with sibling repos cloned under `kern/repos/<name>` (gitignored there). pnpm links all `@kernhq/*` packages via the umbrella workspace.
- Install dependencies ONLY via `kern/scripts/pnpm-install-locked.sh` (serialises pnpm at the umbrella root).
- Node 24 (`nvm use 24`), pnpm 10, TypeScript ~5.9, ESM/NodeNext, Biome for lint+format (run `pnpm exec biome check --write <paths>` before committing), Vitest.
- Contracts first: changes to `@kernhq/contracts` / module contracts land (and build) before their consumers.
- Modules own their data: Postgres schema `mod_<id>`, `workspace_id` + RLS on every tenant table, cross-module access only via `kernel.call()` and events. See `modules` repo `packages/_template`.
- Ports: app 5173 · core 4000 · chat 4100 · mail 4200 · collab 4300 · docs 4400.
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
- UI follows `app/DESIGN.md` (Ink/paper design system) and must work in RTL (fa/ar) and dark mode.
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
- **`/api/docs` is the only HTML this service serves, and it loads Scalar from a CDN.** The API's
  content policy is `default-src 'none'` — right for JSON, and fatal for that page — so the docs
  route sets its own looser header rather than the whole service loosening for one developer-facing
  page. Anything else here that starts returning HTML has to do the same.
