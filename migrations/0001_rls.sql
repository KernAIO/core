-- Row-level security for tenant tables (defense in depth). The kernel sets `app.workspace_id` via
-- `database.withWorkspace()`; every query on these tables must run inside it. Global tables (users, workspaces,
-- memberships, invitations, notifications, notification_settings, push_subscriptions, instance_settings, files)
-- are intentionally not row-level secured. NOTE: superusers bypass RLS – run the app as a regular role.
--
-- Every `create policy` is preceded by a `drop policy if exists`: `create policy` has no
-- `if not exists` form, so without it a replay throws — and a core migration that throws stops the
-- service booting, taking the five modules core hosts down with it. Drizzle replays a folder
-- whenever the journal is regenerated, so this is not hypothetical. `src/tests/migrations.test.ts`
-- applies the folder twice and is what caught it.
drop policy if exists "roles_ws_isolation" on "mod_core"."roles";--> statement-breakpoint
alter table "mod_core"."roles" enable row level security;--> statement-breakpoint
alter table "mod_core"."roles" force row level security;--> statement-breakpoint
create policy "roles_ws_isolation" on "mod_core"."roles"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint
drop policy if exists "groups_ws_isolation" on "mod_core"."groups";--> statement-breakpoint
alter table "mod_core"."groups" enable row level security;--> statement-breakpoint
alter table "mod_core"."groups" force row level security;--> statement-breakpoint
create policy "groups_ws_isolation" on "mod_core"."groups"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint
drop policy if exists "group_members_ws_isolation" on "mod_core"."group_members";--> statement-breakpoint
alter table "mod_core"."group_members" enable row level security;--> statement-breakpoint
alter table "mod_core"."group_members" force row level security;--> statement-breakpoint
create policy "group_members_ws_isolation" on "mod_core"."group_members"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint
drop policy if exists "role_bindings_ws_isolation" on "mod_core"."role_bindings";--> statement-breakpoint
alter table "mod_core"."role_bindings" enable row level security;--> statement-breakpoint
alter table "mod_core"."role_bindings" force row level security;--> statement-breakpoint
create policy "role_bindings_ws_isolation" on "mod_core"."role_bindings"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint
drop policy if exists "workspace_modules_ws_isolation" on "mod_core"."workspace_modules";--> statement-breakpoint
alter table "mod_core"."workspace_modules" enable row level security;--> statement-breakpoint
alter table "mod_core"."workspace_modules" force row level security;--> statement-breakpoint
create policy "workspace_modules_ws_isolation" on "mod_core"."workspace_modules"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint
drop policy if exists "integrations_ws_isolation" on "mod_core"."integrations";--> statement-breakpoint
alter table "mod_core"."integrations" enable row level security;--> statement-breakpoint
alter table "mod_core"."integrations" force row level security;--> statement-breakpoint
create policy "integrations_ws_isolation" on "mod_core"."integrations"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint
drop policy if exists "activity_events_ws_isolation" on "mod_core"."activity_events";--> statement-breakpoint
alter table "mod_core"."activity_events" enable row level security;--> statement-breakpoint
alter table "mod_core"."activity_events" force row level security;--> statement-breakpoint
create policy "activity_events_ws_isolation" on "mod_core"."activity_events"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint
drop policy if exists "search_documents_ws_isolation" on "mod_core"."search_documents";--> statement-breakpoint
alter table "mod_core"."search_documents" enable row level security;--> statement-breakpoint
alter table "mod_core"."search_documents" force row level security;--> statement-breakpoint
create policy "search_documents_ws_isolation" on "mod_core"."search_documents"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint
