ALTER TABLE "agent_wakeup_requests" ADD COLUMN IF NOT EXISTS "claim_reason" text;--> statement-breakpoint
ALTER TABLE "agent_wakeup_requests" ADD COLUMN IF NOT EXISTS "workspace_busy_retries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_wakeup_requests_payload_issue_agent_idx" ON "agent_wakeup_requests" ((payload->>'issueId'), (payload->>'agentId'));
