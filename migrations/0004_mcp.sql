
CREATE TABLE "mod_core"."mcp_auth_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"scope" text,
	"state" text NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text DEFAULT 'S256' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_core"."mcp_clients" (
	"client_id" text PRIMARY KEY NOT NULL,
	"secret_hash" text,
	"name" text NOT NULL,
	"client_uri" text,
	"logo_uri" text,
	"redirect_uris" text[] DEFAULT '{}'::text[] NOT NULL,
	"first_party" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_core"."mcp_codes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "mod_core"."mcp_consents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_core"."mcp_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE INDEX "mcp_auth_requests_user_idx" ON "mod_core"."mcp_auth_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mcp_clients_created_by_idx" ON "mod_core"."mcp_clients" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "mcp_codes_user_idx" ON "mod_core"."mcp_codes" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_consents_uq" ON "mod_core"."mcp_consents" USING btree ("user_id","client_id","workspace_id");--> statement-breakpoint
CREATE INDEX "mcp_tokens_user_idx" ON "mod_core"."mcp_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mcp_tokens_workspace_idx" ON "mod_core"."mcp_tokens" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "mcp_tokens_client_idx" ON "mod_core"."mcp_tokens" USING btree ("client_id");