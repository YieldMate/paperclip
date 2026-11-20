import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { cn } from "@/lib/utils";
import { flattenSelfTalk } from "./transcript-adapter";

/**
 * Live progress / interstitial commentary. Long dumps (skills, prompt echoes,
 * multi-paragraph narration) stay as a one-line preview until expanded; short
 * status lines remain readable inline.
 */
export function TaskChatLiveProgress({
  text,
  channel,
  testId = "task-chat-phase-interstitial",
  defaultOpen = false,
}: {
  text: string;
  channel?: string | null;
  testId?: string;
  defaultOpen?: boolean;
}) {
  const trimmed = text.trim();
  const [open, setOpen] = useState(defaultOpen);
  if (!trimmed) return null;

  const flat = flattenSelfTalk(trimmed);
  const conversationText = channel === "final" ? "final" : "progress";
  const lineCount = trimmed.split("\n").filter((line) => line.trim()).length;
  const compact =
    lineCount > 2 || trimmed.length > 240 || flat.length > 180;
  const previewMax = 120;
  const preview =
    flat.length > previewMax ? `${flat.slice(0, previewMax - 1)}…` : flat;

  if (!compact) {
    return (
      <div
        className="min-w-0 px-1 text-sm text-foreground/90"
        data-testid={testId}
        data-conversation-text={conversationText}
        data-compact="false"
      >
        <MarkdownBody softBreaks linkIssueReferences>
          {text}
        </MarkdownBody>
      </div>
    );
  }

  return (
    <div
      className="flex min-w-0 max-w-full flex-col overflow-hidden text-sm"
      data-testid={testId}
      data-conversation-text={conversationText}
      data-compact="true"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} progress: ${preview}`}
        onClick={() => setOpen((value) => !value)}
        className="group/progress -mx-1.5 flex w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-sm px-1.5 py-0.5 text-left text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid={`${testId}-toggle`}
      >
        {!open ? (
          <span
            className="task-chat-collapsed-line-fade min-w-0 flex-1 text-foreground/90"
            data-testid={`${testId}-preview`}
            title={flat}
          >
            {preview}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            Progress
          </span>
        )}
        <ChevronRight
          className={cn(
            "tc-hover-disclosure-caret h-3 w-3 shrink-0 transition-[opacity,transform] group-hover/progress:opacity-80 group-focus-visible/progress:opacity-80",
            open ? "rotate-90 opacity-80" : "opacity-0",
          )}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="ml-2.5 mt-1 min-w-0 max-w-full overflow-hidden border-l-2 border-border pl-2.5 text-sm text-foreground/90">
          <MarkdownBody softBreaks linkIssueReferences>
            {text}
          </MarkdownBody>
        </div>
      ) : null}
    </div>
  );
}
