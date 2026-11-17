import { describe, expect, test } from "vite-plus/test";

import {
  ApprovalPromptView,
  ArtifactCardView,
  ArtifactDisplayMode,
  BacklinkView,
  BudgetSnapshot,
  BudgetSpec,
  ChannelEventKind,
  ChannelEventView,
  ControlAction,
  ControlOutcome,
  ControlStatus,
  DelegationRequest,
  DelegationResult,
  DreamProposalView,
  ExecResult,
  ExecSpec,
  HarvestedOutput,
  ImageBounds,
  InboxItemKind,
  InboxItemView,
  IssueStatus,
  IssueView,
  MountConflict,
  MountFile,
  MountSyncRequest,
  MountSyncResult,
  PermissionEvaluation,
  PermissionPolicy,
  PermissionVerdict,
  Principal,
  PrincipalKind,
  RubricSpec,
  RubricVerdict,
  SpaceView,
  UsageTotals,
} from "./schema";

describe("go-contract generated codecs", () => {
  test("decodes Principal with optional and required fields", () => {
    const full = Principal.parse({
      kind: "session_token",
      id: "prin_01",
      sessionId: "sess_01",
      capabilities: ["exec", "mount.sync"],
      allowedHosts: ["api.anthropic.com", "github.com"],
      expiresAtMs: 1_763_300_000_000,
    });
    expect(full.kind).toBe("session_token");
    expect(full.sessionId).toBe("sess_01");

    const minimal = Principal.parse({
      kind: PrincipalKind.parse("user_device"),
      id: "dev_01",
    });
    expect(minimal.sessionId).toBeUndefined();
    expect(Principal.safeParse({ kind: "unknown", id: "x" }).success).toBe(false);
    expect(Principal.safeParse({ kind: "user_device", id: "dev_01", sessionId: null }).success).toBe(false);
    expect(Principal.safeParse({ kind: "user_device", id: "dev_01", sessionId: undefined }).success).toBe(false);
  });

  test("decodes ExecSpec and execution environment shapes including base64 []byte fields", () => {
    const spec = ExecSpec.parse({
      argv: ["git", "status", "--porcelain"],
      dir: "/workspace/repo",
      env: ["TERM=xterm-256color"],
      stdin: "aGVsbG8gd29ybGQK",
      timeoutMs: 30_000,
    });
    expect(spec.argv).toEqual(["git", "status", "--porcelain"]);
    expect(spec.stdin).toBe("aGVsbG8gd29ybGQK");

    const bounds = ImageBounds.parse({ maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592 });
    expect(bounds.maxBytes).toBe(4_718_592);

    const execResult = ExecResult.parse({
      exitCode: 0,
      stdout: "clean\n",
      stderr: "",
      interrupted: false,
      durationMs: 42,
    });
    expect(execResult.exitCode).toBe(0);

    const mountFile = MountFile.parse({
      relPath: ".vibe/memory/patterns.md",
      version: 3,
      baseVersion: 2,
      sha256: "e3b0c44298fc1c149afbf4c8996fb924",
      content: "IyBQYXR0ZXJucwo=",
      readOnly: false,
    });
    const syncReq = MountSyncRequest.parse({
      sessionId: "sess_01",
      memories: [mountFile],
      flush: true,
    });
    expect(syncReq.memories).toHaveLength(1);

    const conflict = MountConflict.parse({
      relPath: ".vibe/memory/patterns.md",
      baseVersion: 2,
      serverVersion: 4,
      conflictRelPath: ".vibe/memory/patterns.conflict-4.md",
      uploadedSha256: "abcdef01",
    });
    const syncRes = MountSyncResult.parse({
      materialized: 1,
      uploaded: [mountFile],
      conflicts: [conflict],
    });
    expect(syncRes.conflicts).toHaveLength(1);

    const output = HarvestedOutput.parse({
      relPath: ".vibe/outputs/report.html",
      sha256: "deadbeef",
      size: 128,
      mimeType: "text/html",
      data: "PGh0bWw+PC9odG1sPg==",
    });
    expect(output.mimeType).toBe("text/html");
  });

  test("decodes UsageTotals and delegation shapes with pointer/omitempty fields", () => {
    const unknownCost = UsageTotals.parse({
      inputTokens: 1200,
      outputTokens: 450,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
      reasoningTokens: 250,
    });
    expect(unknownCost.costMicros).toBeUndefined();

    const withCost = UsageTotals.parse({
      inputTokens: 1200,
      outputTokens: 450,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
      reasoningTokens: 250,
      costMicros: 15_400,
    });
    expect(withCost.costMicros).toBe(15_400);
    expect(UsageTotals.safeParse({ inputTokens: 1.5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }).success).toBe(false);

    expect(ControlAction.parse("steer")).toBe("steer");
    const outcome = ControlOutcome.parse({
      status: ControlStatus.parse("accepted"),
      spanId: "span_01",
      message: "queued steer",
    });
    expect(outcome.status).toBe("accepted");

    const req = DelegationRequest.parse({
      taskId: "task_01",
      runtime: "claude",
      prompt: "Implement tsgen",
      allowedTools: ["read_file", "edit_file"],
      metadata: { repo: "vibevalley", branch: "feat/go-managed-platform" },
    });
    expect(req.metadata?.["repo"]).toBe("vibevalley");

    const res = DelegationResult.parse({
      sessionId: "sess_01",
      success: true,
      exitCode: 0,
      summary: "All tests green",
      usage: withCost,
      interrupted: false,
    });
    expect(res.usage?.costMicros).toBe(15_400);

    const bareRes = DelegationResult.parse({
      success: false,
      exitCode: 1,
      interrupted: true,
      error: "timeout",
    });
    expect(bareRes.usage).toBeUndefined();
    expect(bareRes.sessionId).toBeUndefined();
  });

  test("decodes PermissionEvaluation, RubricVerdict, and budget shapes", () => {
    const budgetSpec = BudgetSpec.parse({ maxCostMicros: 5_000_000 });
    const budgetSnap = BudgetSnapshot.parse({ spentMicros: 5_000_000, maxCostMicros: budgetSpec.maxCostMicros, reached: true });
    expect(budgetSnap.reached).toBe(true);

    const evalResult = PermissionEvaluation.parse({
      toolName: "bash",
      policy: PermissionPolicy.parse("always_ask"),
      verdict: PermissionVerdict.parse("ask"),
      reason: "Shell command requires owner confirmation",
      clientOverridable: true,
    });
    expect(evalResult.verdict).toBe("ask");

    const rubricSpec = RubricSpec.parse({ markdown: "- Zero lint errors", maxIterations: 3 });
    const verdict = RubricVerdict.parse({
      satisfied: false,
      summary: "Missing integration test",
      unmetItems: ["Add contract test"],
      iteration: 1,
    });
    expect(rubricSpec.maxIterations).toBe(3);
    expect(verdict.satisfied).toBe(false);
  });

  test("decodes IssueView, SpaceView, and all workbench view shapes", () => {
    const issue = IssueView.parse({
      id: "iss_01",
      title: "Generate TS codecs from pkg/contract",
      status: IssueStatus.parse("in_progress"),
      repoId: "repo_01",
      assigneeId: "agent_coder",
      sessionId: "sess_01",
      rubric: { markdown: "- All packages build", maxIterations: 2 },
      updatedAtMs: 1_763_300_000_500,
    });
    expect(issue.rubric?.maxIterations).toBe(2);

    const channelEvent = ChannelEventView.parse({
      channelId: "chan_general",
      seq: 42,
      kind: ChannelEventKind.parse("report"),
      authorId: "agent_coder",
      text: "Codegen complete",
      sessionId: "sess_01",
      createdAtMs: 1_763_300_001_000,
    });
    expect(channelEvent.seq).toBe(42);

    const inboxItem = InboxItemView.parse({
      id: "inb_01",
      kind: InboxItemKind.parse("approval"),
      title: "Approve bash execution",
      summary: "Run go test",
      sessionId: "sess_01",
      issueId: "iss_01",
      resolved: false,
      createdAtMs: 1_763_300_002_000,
    });
    expect(inboxItem.kind).toBe("approval");

    const artifactCard = ArtifactCardView.parse({
      id: "art_01",
      title: "Architecture Dashboard",
      body: "html",
      display: ArtifactDisplayMode.parse("dashboard"),
      version: 2,
      sha256: "0123456789abcdef",
      channelId: "chan_general",
      issueId: "iss_01",
      updatedAtMs: 1_763_300_003_000,
    });
    expect(artifactCard.display).toBe("dashboard");

    const backlink = BacklinkView.parse({
      sourcePath: "projects/go-platform.md",
      targetTitle: "Chord Link",
      blockId: "blk_01",
      line: 14,
      byteStart: 120,
      byteEnd: 134,
      snippet: "[[Chord Link]]",
    });
    expect(backlink.byteEnd).toBe(134);

    const approval = ApprovalPromptView.parse({
      taskId: "task_01",
      sessionId: "sess_01",
      toolName: "bash",
      policy: "always_ask",
      summary: "Execute deployment script",
      requestedAtMs: 1_763_300_004_000,
    });

    const dream = DreamProposalView.parse({
      proposalId: "drm_01",
      baseVersion: 5,
      candidateVersion: 6,
      deduplicatedCount: 12,
      summary: "Merged duplicate Go toolchain notes",
      status: "pending",
      createdAtMs: 1_763_300_005_000,
    });

    const space = SpaceView.parse({
      rev: 99,
      issues: [issue],
      inbox: [inboxItem],
      approvals: [approval],
      dreams: [dream],
      onlineMachines: ["mac-studio-01"],
    });
    expect(space.rev).toBe(99);
    expect(space.issues).toHaveLength(1);
    expect(space.onlineMachines).toEqual(["mac-studio-01"]);

    const emptySpace = SpaceView.parse({
      rev: 0,
      issues: [],
      inbox: [],
      approvals: [],
      dreams: [],
      onlineMachines: [],
    });
    expect(emptySpace.issues).toEqual([]);
  });
});
