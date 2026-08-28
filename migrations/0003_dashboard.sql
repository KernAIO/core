-- The workspace dashboard: what somebody has on their home page, and how much of that the workspace
-- decides for them. New tables only, so the image before this one reads the database unchanged.
create table if not exists "mod_core"."dashboard_layouts" (
  "id" uuid primary key default uuidv7(),
  "workspace_id" uuid not null,
  "user_id" uuid,
  "surface" text not null default 'home',
  "items" jsonb not null default '[]'::jsonb,
  "preset_id" text,
  "updated_by" uuid,
  "updated_at" timestamp with time zone not null default now()
);--> statement-breakpoint

create table if not exists "mod_core"."dashboard_settings" (
  "workspace_id" uuid not null,
  "surface" text not null default 'home',
  "policy" text not null default 'default',
  "default_preset_id" text not null default 'my-work',
  "updated_by" uuid,
  "updated_at" timestamp with time zone not null default now(),
  constraint "dashboard_settings_pk" primary key ("workspace_id", "surface")
);--> statement-breakpoint

create index if not exists "dashboard_layouts_ws_user_idx"
  on "mod_core"."dashboard_layouts" ("workspace_id", "user_id");--> statement-breakpoint

-- Two partial indexes rather than one. A plain unique index treats every NULL as distinct, so
-- `(workspace_id, user_id, surface)` would let the workspace row — the one with a null user_id — be
-- inserted any number of times. Postgres 18 could express this as `nulls not distinct`, but the pair
-- states what it is for, and drizzle-kit emits neither, so the SQL is hand-written either way.
create unique index if not exists "dashboard_layouts_ws_surface_default_uq"
  on "mod_core"."dashboard_layouts" ("workspace_id", "surface") where "user_id" is null;--> statement-breakpoint
create unique index if not exists "dashboard_layouts_ws_user_surface_uq"
  on "mod_core"."dashboard_layouts" ("workspace_id", "user_id", "surface") where "user_id" is not null;--> statement-breakpoint

-- `create policy` has no `if not exists`, so a replay of this file would throw and stop core
-- booting. See the header of 0001_rls.sql.
drop policy if exists "dashboard_layouts_ws_isolation" on "mod_core"."dashboard_layouts";--> statement-breakpoint
alter table "mod_core"."dashboard_layouts" enable row level security;--> statement-breakpoint
alter table "mod_core"."dashboard_layouts" force row level security;--> statement-breakpoint
create policy "dashboard_layouts_ws_isolation" on "mod_core"."dashboard_layouts"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

drop policy if exists "dashboard_settings_ws_isolation" on "mod_core"."dashboard_settings";--> statement-breakpoint
alter table "mod_core"."dashboard_settings" enable row level security;--> statement-breakpoint
alter table "mod_core"."dashboard_settings" force row level security;--> statement-breakpoint
create policy "dashboard_settings_ws_isolation" on "mod_core"."dashboard_settings"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
