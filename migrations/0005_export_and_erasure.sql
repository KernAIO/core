-- Workspace data export and scheduled erasure.
--
-- Every statement here is idempotent, because the kernel migrates each hosted module at boot and a
-- module migration that throws takes the whole service down with it — core hosts five others, so a
-- replay here is an outage for all of them. `create policy` and `add constraint` have no
-- `if not exists`, so each is preceded by a drop.
CREATE TABLE IF NOT EXISTS "mod_core"."data_exports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"key" text,
	"size_bytes" integer,
	"follow_ups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mod_core"."deletion_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"reason" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"purge_after" timestamp with time zone NOT NULL,
	"follow_ups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "data_exports_ws_created_idx" ON "mod_core"."data_exports" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deletion_requests_due_idx" ON "mod_core"."deletion_requests" USING btree ("status","purge_after");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deletion_requests_subject_idx" ON "mod_core"."deletion_requests" USING btree ("subject_kind","subject_id");--> statement-breakpoint
-- At most one *open* request per subject. Partial, so cancelling one and asking again works, which a
-- plain unique index would refuse.
CREATE UNIQUE INDEX IF NOT EXISTS "deletion_requests_open_uq" ON "mod_core"."deletion_requests" USING btree ("subject_kind","subject_id") WHERE status in ('scheduled','running');--> statement-breakpoint
-- An export carries a whole workspace, so it is a tenant table like the rest.
ALTER TABLE "mod_core"."data_exports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mod_core"."data_exports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "data_exports_ws_isolation" ON "mod_core"."data_exports";--> statement-breakpoint
CREATE POLICY "data_exports_ws_isolation" ON "mod_core"."data_exports"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint
-- `deletion_requests` is deliberately not row-level secured: an account deletion belongs to no
-- workspace, and the purge worker has to find everything that is due without knowing the tenant.
ALTER TABLE "mod_core"."deletion_requests" DROP CONSTRAINT IF EXISTS "deletion_requests_subject_kind_check";--> statement-breakpoint
ALTER TABLE "mod_core"."deletion_requests" ADD CONSTRAINT "deletion_requests_subject_kind_check" CHECK (subject_kind in ('workspace','account'));
