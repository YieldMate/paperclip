ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "resident_start_decision" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "resident_warm_decision" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "resident_warm_reason" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "resident_warm_ttl_seconds" integer;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "resident_cwd_identity" text;