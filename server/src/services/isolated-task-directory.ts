import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { ExecutionWorkspace } from "@paperclipai/shared";
import { parseObject } from "../adapters/utils.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

/**
 * YIE-69 / F8: opt Hermes issue runs into a private task directory instead of a
 * shared project checkout. Off by default; unset or any value other than
 * 1/true/yes restores the previous shared-cwd behaviour (documented rollback).
 */
export function isPerIssueExecutionCwdEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.PAPERCLIP_PER_ISSUE_EXECUTION_CWD?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Force per-issue task-directory allocation for Hermes local runs when the F8
 * flag is on. Auto-created and inherited `reuse_existing` bindings must NOT
 * block this (live platforms bind every new issue that way, including children
 * inheriting a parent tree). Only an operator-pinned workspaceSelection
 * (`source === "explicit"`) opts out. Non-Hermes adapters stay on git worktree
 * isolation via enableIsolatedWorkspaces*. Old warm residents keep their prior
 * cwd until idle/stop; the next start for the issue uses the new cwd and skips
 * reuse when liveResident.cwd mismatches.
 */
export function shouldForcePerIssueExecutionCwd(input: {
  enabled: boolean;
  adapterType: string;
  isDotRun: boolean;
  issueId: string | null;
  /** True when taskWorkspaceIntent.source === "explicit" (operator-pinned). */
  operatorPinnedWorkspace: boolean;
}): boolean {
  if (!input.enabled || input.isDotRun || !input.issueId) return false;
  if (input.adapterType !== "hermes_local") return false;
  if (input.operatorPinnedWorkspace) return false;
  return true;
}

/**
 * True when the bound execution workspace is already this issue's F8 task
 * directory (safe to restore/reuse under the force path). Inherited parent
 * trees and shared checkouts return false so force allocates a fresh
 * per-issue cwd and creates a new workspace row instead of rewriting the
 * foreign binding.
 */
export function isOwnIsolatedTaskDirectoryBinding(
  workspace: Pick<ExecutionWorkspace, "sourceIssueId" | "mode" | "strategyType"> | null | undefined,
  issueId: string | null,
): boolean {
  return Boolean(
    workspace
    && issueId
    && workspace.sourceIssueId === issueId
    && workspace.mode === "isolated_workspace"
    && workspace.strategyType === "project_primary",
  );
}

/** A repository-free sandbox task needs isolation, but has no Git base. */
export function shouldUseIsolatedTaskDirectory(input: {
  trustPreset: string;
  environmentDriver: string | null;
  mode: string;
  hasProjectWorkspace: boolean;
  projectWorkspaceId: string | null;
  workspaceStrategies: unknown[];
}): boolean {
  return input.trustPreset === "low_trust_review"
    && input.environmentDriver === "sandbox"
    && input.mode === "isolated_workspace"
    && !input.hasProjectWorkspace
    && !input.projectWorkspaceId
    // Never discard an explicit repository/branch requirement or setup hook.
    && input.workspaceStrategies.every((value) => Object.keys(parseObject(value)).length === 0);
}

/** Stable across turns, separate from project roots and shared agent homes. */
export async function materializeIsolatedTaskDirectory(input: {
  companyId: string;
  issueId: string;
  attemptId?: string;
  /** Validate retained files in place; never recreate a missing directory. */
  reuseCwd?: string;
}): Promise<string> {
  // Files belong to the task, so reassignment preserves the same workspace.
  let identities = [input.companyId, input.issueId, ...(input.attemptId ? [input.attemptId] : [])];
  if (identities.some((value) => !/^[a-zA-Z0-9_-]+$/.test(value))) {
    throw new Error("Invalid isolated task workspace identity");
  }
  const root = resolvePaperclipInstanceRoot();
  if (!input.reuseCwd) await mkdir(root, { recursive: true });
  let cwd = await realpath(root);
  let namespace = input.attemptId ? "isolated-workspace-attempts" : "isolated-workspaces";
  if (input.reuseCwd) {
    const segments = path.relative(cwd, input.reuseCwd).split(path.sep);
    if (input.attemptId || path.resolve(input.reuseCwd) !== input.reuseCwd ||
        segments[1] !== input.companyId || segments[2] !== input.issueId ||
        !((segments[0] === "isolated-workspaces" && segments.length === 3) ||
          (segments[0] === "isolated-workspace-attempts" && segments.length === 4 && /^[a-zA-Z0-9_-]+$/.test(segments[3])))) {
      throw new Error("Isolated task workspace path is not this task's directory");
    }
    namespace = segments[0];
    identities = segments.slice(1);
  }
  // A retry is a sibling namespace, never a descendant of the retained root.
  // An old copyback operation must not be able to overwrite its replacement.
  for (const segment of [namespace, ...identities]) {
    cwd = path.join(cwd, segment);
    if (!input.reuseCwd) await mkdir(cwd, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    const stat = await lstat(cwd);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(cwd) !== cwd) {
      throw new Error("Isolated task workspace path is not a private directory");
    }
  }
  return cwd;
}

export async function isBoundIsolatedTaskDirectory(input: {
  companyId: string; issueId: string; workspaceId: string | null;
  workspace: Pick<ExecutionWorkspace, "id" | "companyId" | "sourceIssueId" | "status" | "mode" | "strategyType" | "providerType" | "cwd" | "repoUrl" | "branchName"> | null;
}): Promise<boolean> {
  const workspace = input.workspace;
  if (!workspace || workspace.id !== input.workspaceId || workspace.companyId !== input.companyId ||
      workspace.sourceIssueId !== input.issueId || workspace.status !== "active" ||
      workspace.mode !== "isolated_workspace" || workspace.strategyType !== "project_primary" ||
      workspace.providerType !== "local_fs" || !workspace.cwd || workspace.repoUrl || workspace.branchName) return false;
  try {
    await materializeIsolatedTaskDirectory({ companyId: input.companyId, issueId: input.issueId, reuseCwd: workspace.cwd });
    return true;
  } catch {
    return false;
  }
}
