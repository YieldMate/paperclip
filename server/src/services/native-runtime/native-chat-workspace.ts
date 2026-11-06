import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { chatConversations, issues, executionWorkspaces, projectWorkspaces, type Db } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";

export type NativeChatWorkspaceScope = {
  companyId: string;
  agentId: string;
  issueId: string;
  projectId: string | null;
  instanceRoot: string;
  taskRoot: string;
  freshAttemptId?: string;
};

function segment(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error("native_chat_workspace_identity_invalid");
  }
  return value;
}

/** Selection is durable task state, never a caller-supplied wake/source flag. */
export async function findNativeChatWorkspaceScope(
  db: Db,
  input: {
    adapterType: string;
    environmentDriver: string | null;
    companyId: string;
    agentId: string;
    issueId: string | null;
    instanceRoot?: string;
    admittedCwd?: string | null;
    /** Supplied only after validating a committed fresh-attempt receipt. */
    freshAttemptId?: string;
  },
): Promise<NativeChatWorkspaceScope | null> {
  if (
    input.adapterType !== "paperclip_runner" ||
    input.environmentDriver !== "local" ||
    !input.issueId
  )
    return null;
  const [issue] = await db
    .select({
      id: issues.id,
      projectId: issues.projectId,
      originKind: issues.originKind,
      selection: issues.workspaceSelection,
      configuredProjectId: projectWorkspaces.projectId,
      hasConfiguredDefault: sql<boolean>`exists (
        select 1 from ${projectWorkspaces}
        where ${projectWorkspaces.projectId} = ${issues.projectId}
          and ${projectWorkspaces.companyId} = ${input.companyId}
          and (nullif(btrim(${projectWorkspaces.cwd}), '') is not null
            or nullif(btrim(${projectWorkspaces.repoUrl}), '') is not null)
      )`,
      boundWorkspaceId: executionWorkspaces.id,
      boundProjectId: executionWorkspaces.projectId,
      boundSourceIssueId: executionWorkspaces.sourceIssueId,
      boundCwd: executionWorkspaces.cwd,
      hasConversation: sql<boolean>`exists (
      select 1 from ${chatConversations}
      where ${chatConversations.issueId} = ${issues.id}
        and ${chatConversations.companyId} = ${input.companyId}
    )`,
    })
    .from(issues)
    .leftJoin(projectWorkspaces, and(eq(projectWorkspaces.id, issues.projectWorkspaceId), eq(projectWorkspaces.companyId, input.companyId)))
    .leftJoin(executionWorkspaces, and(eq(executionWorkspaces.id, issues.executionWorkspaceId), eq(executionWorkspaces.companyId, input.companyId)))
    .where(
      and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)),
    )
    .limit(1);
  if (!issue) throw new Error("native_chat_workspace_issue_unavailable");
  if (issue.originKind !== "chat_channel" && !issue.hasConversation)
    return null;
  const instanceRoot = await realpath(
    input.instanceRoot ?? resolvePaperclipInstanceRoot(),
  );
  const projectId = issue.boundWorkspaceId ? issue.boundProjectId : issue.selection?.selection.kind === "task_directory"
    ? null : issue.configuredProjectId ?? (issue.hasConfiguredDefault ? issue.projectId : null);
  return {
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: issue.id,
    projectId,
    ...(input.freshAttemptId ? { freshAttemptId: input.freshAttemptId } : {}),
    instanceRoot,
    // This must be a sibling of agent homes, not a child readable by an old
    // provider thread whose immutable permission root is the entire agent home.
    // YIE-69 / F8: taskRoot is always per-issue (companyId/issueId). Never fall
    // back to a host-wide shared checkout; boundCwd/admittedCwd are only kept
    // when they already resolve under this issue's isolated path.
    taskRoot: resolveNativeChatTaskRoot({
      instanceRoot,
      companyId: input.companyId,
      issueId: issue.id,
      projectId,
      freshAttemptId: input.freshAttemptId,
      boundSourceIssueId: issue.boundSourceIssueId,
      boundCwd: issue.boundCwd,
      admittedCwd: input.admittedCwd,
    }),
  };
}

/** Prefer a validated per-issue binding; otherwise allocate the canonical task root. */
export function resolveNativeChatTaskRoot(input: {
  instanceRoot: string;
  companyId: string;
  issueId: string;
  projectId: string | null;
  freshAttemptId?: string;
  boundSourceIssueId: string | null;
  boundCwd: string | null;
  admittedCwd?: string | null;
}): string {
  if (input.freshAttemptId) {
    return path.join(
      input.instanceRoot,
      "isolated-workspace-attempts",
      segment(input.companyId),
      segment(input.issueId),
      segment(input.freshAttemptId),
      ...(input.projectId ? ["workspace"] : []),
    );
  }
  const canonical = path.join(
    input.instanceRoot,
    "isolated-workspaces",
    segment(input.companyId),
    segment(input.issueId),
  );
  const candidates = [
    input.boundSourceIssueId === input.issueId ? input.boundCwd : null,
    input.admittedCwd ?? null,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(candidate);
    const relative = path.relative(input.instanceRoot, resolved);
    const parts = relative.split(path.sep);
    const underIssue =
      (parts[0] === "isolated-workspaces"
        && parts[1] === input.companyId
        && parts[2] === input.issueId
        && parts.length === 3)
      || ((parts.length === 4 || (parts.length === 5 && parts[4] === "workspace"))
        && parts[0] === "isolated-workspace-attempts"
        && parts[1] === input.companyId
        && parts[2] === input.issueId)
      || (parts.length === 4
        && parts[0] === "chat-workspaces"
        && parts[1] === input.companyId
        && parts[3] === input.issueId
        && /^[a-zA-Z0-9_-]+$/.test(parts[2]!));
    if (underIssue) return resolved;
  }
  return canonical;
}

export type NativeChatProjectWorkspace = {
  companyId: string;
  projectId: string | null;
  sourceIssueId: string | null;
  mode: string;
  strategyType: string;
  status: string;
  cwd: string | null;
  providerRef: string | null;
};

function isNativeChatTaskRoot(scope: NativeChatWorkspaceScope): boolean {
  const relative = path.relative(scope.instanceRoot, scope.taskRoot);
  const allowedTask = path.join("isolated-workspaces", segment(scope.companyId), segment(scope.issueId));
  const legacyParts = relative.split(path.sep);
  const attempt = relative.split(path.sep);
  const isolatedAttempt = (attempt.length === 4 || (attempt.length === 5 && attempt[4] === "workspace")) &&
    attempt[0] === "isolated-workspace-attempts" && attempt[1] === scope.companyId &&
    attempt[2] === scope.issueId && /^[0-9a-f-]{36}$/i.test(attempt[3]!);
  return relative === allowedTask || isolatedAttempt || (
    legacyParts.length === 4 && legacyParts[0] === "chat-workspaces" &&
    legacyParts[1] === scope.companyId && /^[a-zA-Z0-9_-]+$/.test(legacyParts[2]!) && legacyParts[3] === scope.issueId
  );
}

/** No implicit move from an intentionally configured repository to an empty cwd. */
export function nativeChatWorkspaceCwd(
  scope: NativeChatWorkspaceScope,
  workspace: NativeChatProjectWorkspace | null,
  reuseExisting: boolean,
): string | null {
  if (scope.freshAttemptId && workspace === null && isNativeChatTaskRoot(scope)) return scope.taskRoot;
  if (!scope.projectId) return isNativeChatTaskRoot(scope) && (workspace === null || (
    workspace.companyId === scope.companyId && workspace.sourceIssueId === scope.issueId &&
    workspace.projectId === null && workspace.cwd === scope.taskRoot && ["active", "idle"].includes(workspace.status)
  )) ? scope.taskRoot : null;
  if (
    !reuseExisting ||
    !workspace ||
    workspace.companyId !== scope.companyId ||
    workspace.projectId !== scope.projectId ||
    workspace.sourceIssueId !== scope.issueId ||
    workspace.mode !== "isolated_workspace" ||
    !(workspace.strategyType === "git_worktree" ||
      (workspace.strategyType === "project_primary" && workspace.cwd === scope.taskRoot && isNativeChatTaskRoot(scope))) ||
    !["active", "idle"].includes(workspace.status) ||
    !workspace.cwd ||
    !path.isAbsolute(workspace.cwd) ||
    workspace.providerRef !== workspace.cwd
  )
    return null;
  return path.resolve(workspace.cwd);
}

/** Only create empty, server-owned task directories. Never import legacy bytes. */
export async function materializeNativeChatTaskRoot(
  scope: NativeChatWorkspaceScope,
): Promise<string> {
  if (scope.projectId)
    throw new Error("native_chat_workspace_project_requires_isolation");
  let cursor = scope.instanceRoot;
  const relative = path.relative(scope.instanceRoot, scope.taskRoot);
  if (!isNativeChatTaskRoot(scope)) throw new Error("native_chat_workspace_path_not_isolated");
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    await mkdir(cursor, { mode: 0o700 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    const stat = await lstat(cursor);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(cursor)) !== cursor
    ) {
      throw new Error("native_chat_workspace_path_not_isolated");
    }
  }
  return cursor;
}

export function nativeChatWorkspaceMatches(input: {
  scope: NativeChatWorkspaceScope;
  expectedCwd: string | null;
  execution: {
    binding: { companyId: string; agentId: string; issueId: string };
    workspace: { cwd: string };
  };
}): boolean {
  return (
    input.expectedCwd !== null &&
    input.execution.binding.companyId === input.scope.companyId &&
    input.execution.binding.agentId === input.scope.agentId &&
    input.execution.binding.issueId === input.scope.issueId &&
    path.resolve(input.execution.workspace.cwd) === input.expectedCwd
  );
}
