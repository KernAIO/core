# core

**Who people are, which workspaces they belong to, and what they are allowed to do.**

[![CI](https://img.shields.io/github/actions/workflow/status/KernAIO/core/ci.yml?branch=main&label=CI&style=flat-square)](https://github.com/KernAIO/core/actions/workflows/ci.yml)
[![Licence](https://img.shields.io/badge/licence-AGPL--3.0-blue?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/status-pre--1.0-orange?style=flat-square)](https://github.com/KernAIO/kern#what-works-today)
[![Last commit](https://img.shields.io/github/last-commit/KernAIO/core?style=flat-square)](https://github.com/KernAIO/core/commits/main)
[![Website](https://img.shields.io/badge/kernaio.com-1f2328?style=flat-square)](https://kernaio.com)

Every other part of [Kern](https://github.com/KernAIO/kern) asks this service those questions. It
also holds the things that do not belong to any one feature: your notification inbox, uploaded
files, search across everything, and the audit log.

It hosts feature modules too. A module only needs its own service for a runtime reason. Chat holds a
websocket per person. Mail holds open IMAP connections. Everything else runs here, including the
issue tracker.

## Run it

Goal: start core on your own machine and see its API.

You need:

- Node 24 and pnpm 10.
- A Postgres 18 database.

Most people should run the whole platform from the
[umbrella repository](https://github.com/KernAIO/kern) instead. There, `pnpm setup && pnpm infra &&
pnpm dev` starts core with everything it talks to.

### 1. Install and configure

```bash
pnpm install
cp .env.example .env
```

Set `DATABASE_URL` in `.env` to your Postgres database.

### 2. Start core

```bash
pnpm dev
```

Core creates its own database tables the first time it starts.

**Expected result:** `migrations applied`, then `core API listening` on port 4000.

### 3. Read the API

Open http://localhost:4000/api/docs.

**Expected result:** a browsable reference for every endpoint core serves.

### Migrate without starting the service

A deployment usually applies migrations before it starts anything:

```bash
pnpm db:migrate
```

**Expected result:** `migrations applied`, then `migrations complete`.

## What it exposes

| Path | What answers there |
|---|---|
| `/api/core/*` | Accounts, workspaces, members, roles, permissions, notifications, files, search |
| `/api/auth/*` | Sign-in, sign-up, sessions, passkeys, two-factor, single sign-on |
| `/api/tracker/*` | The issue tracker, which this service hosts |
| `/api/docs` | The API reference |

Every module this service hosts adds its own `/api/<module>` prefix and its own OpenAPI document at
`/api/<module>/openapi.json`.

## Things worth knowing

- **Permissions are checked twice.** Every procedure checks that the caller may do the thing. Then
  Postgres row-level security checks it again, so a mistake in the first layer does not leak another
  workspace's data.
- **A workspace can switch a module off.** Its routes then answer 403, its jobs stop, and it
  disappears from the interface.
- **Adding a module here is one line.** Add the dependency, then add it to `featureModules` in
  `src/service.ts`. The runtime does the rest: migrations, routes, permissions, jobs.
- `src/tests/hosted-modules.test.ts` uses each hosted module through this service, so a module this
  service claims to host has to actually work.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md). Licence: [AGPL-3.0](LICENSE).

---

**Kern** — one place for your team's work: issues, conversations, documents and people.
Open source, self-hosted. [kernaio.com](https://kernaio.com) · [github.com/KernAIO](https://github.com/KernAIO)
