// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { MemoryRouter } from "@/lib/router";
import { TaskChatLiveProgress } from "./TaskChatLiveProgress";

describe("TaskChatLiveProgress", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    container.remove();
  });

  function render(text: string) {
    flushSync(() =>
      root!.render(
        <MemoryRouter>
          <ThemeProvider>
            <TaskChatLiveProgress text={text} />
          </ThemeProvider>
        </MemoryRouter>,
      ),
    );
  }

  it("keeps short progress commentary expanded inline", () => {
    render("Looking into the failing test.");
    const node = container.querySelector('[data-testid="task-chat-phase-interstitial"]');
    expect(node?.getAttribute("data-compact")).toBe("false");
    expect(node?.textContent).toContain("Looking into the failing test.");
    expect(
      container.querySelector('[data-testid="task-chat-phase-interstitial-toggle"]'),
    ).toBeNull();
  });

  it("collapses long skill/prompt dumps to a one-line preview until expanded", () => {
    const dump = [
      "## Skills",
      "",
      "You have access to the following skills:",
      "- paperclip/api — call the Paperclip REST API",
      "- linear/triage — classify Linear issues",
      "- github/pr — open and review pull requests",
      "",
      "System prompt:",
      "You are an autonomous company agent. Follow every rule below…",
      "1. Never expose secrets",
      "2. Prefer tools over speculation",
      "3. Keep replies short after planning",
    ].join("\n");
    render(dump);

    const node = container.querySelector('[data-testid="task-chat-phase-interstitial"]');
    expect(node?.getAttribute("data-compact")).toBe("true");
    expect(
      container.querySelector('[data-testid="task-chat-phase-interstitial-preview"]')
        ?.textContent,
    ).toContain("Skills");
    expect(container.textContent).not.toContain("Never expose secrets");

    flushSync(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="task-chat-phase-interstitial-toggle"]',
        )
        ?.click(),
    );

    expect(container.textContent).toContain("Never expose secrets");
    expect(container.textContent).toContain("Prefer tools over speculation");
  });
});
