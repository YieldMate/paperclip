-- Cheap company-level short-circuit for externalConversationStateSql.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_endpoints_company_external_active_idx"
  ON "chat_endpoints" USING btree ("company_id")
  WHERE "provider" in ('slack', 'speko') AND "status" in ('active', 'verifying');
--> statement-breakpoint
-- Match slack-conversation-state wakeup EXISTS coalesce precedence.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_wakeup_requests_company_payload_issue_key_idx"
  ON "agent_wakeup_requests" USING btree (
    "company_id",
    (coalesce(
      nullif(("payload" ->> 'issueId'), ''),
      nullif(("payload" ->> 'taskId'), ''),
      nullif((("payload" -> '_paperclipWakeContext') ->> 'issueId'), '')
    ))
  )
  WHERE "status" in ('queued', 'claimed', 'deferred_issue_execution');
--> statement-breakpoint
-- Match blocker EXISTS on related_issue_id for type = blocks.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_relations_company_related_blocks_idx"
  ON "issue_relations" USING btree ("company_id", "related_issue_id")
  WHERE "type" = 'blocks';
