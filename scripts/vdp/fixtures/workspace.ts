import { z } from "zod";

import type { VdpRpcTransport, VdpScenarioContext } from "../dsl.ts";

const CreatedIssueSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string(),
});

const CreatedChannelSchema = z.string().min(1);

export interface WorkspaceCoreIds {
  readonly issueIds: readonly string[];
  readonly channelId: string;
}

const seededByTransport = new WeakMap<VdpRpcTransport, Promise<WorkspaceCoreIds>>();

async function performSeedWorkspaceCore(v: VdpScenarioContext): Promise<WorkspaceCoreIds> {
  const issue1 = await v.rpc(
    "issue.create",
    {
      title: "Refine editorial typography and hierarchy across 3+1 Note views",
      priority: "high",
      tags: ["UX", "Note", "Editorial"],
      description: "## Scope\nEliminate box-in-box chrome clutter, align Base column widths, and verify Canvas Light/Dark contrast.",
      criteria: [
        "Block Doc reads like a calm restrained editorial document",
        "Base Table/Board/Gallery switch preserves rows cleanly",
        "Canvas renders elements and adapts contrast cleanly",
      ],
    },
    CreatedIssueSchema,
  );

  const issue2 = await v.rpc(
    "issue.create",
    {
      title: "Support deterministic TS VDP scenario runner over single WebSocket",
      priority: "medium",
      tags: ["VDP", "Testing"],
      description: "## Goal\nReplace multi-minute ad-hoc scripts with repeatable `vp run vdp` scenarios.",
      criteria: ["Single persistent WS execution captures PNGs + manifest.json cleanly"],
    },
    CreatedIssueSchema,
  );

  const issue3 = await v.rpc(
    "issue.create",
    {
      title: "Audit Kanban lane overflow and mobile responsive spacing",
      priority: "urgent",
      tags: ["Board", "Layout"],
      description: "## Highlights\nVerify card title truncation, horizontal lane scrolling, and narrow `< 768px` fallback layout.",
      criteria: ["Cards stay readable without vertical clipping across Light & Dark modes"],
    },
    CreatedIssueSchema,
  );

  const issue4 = await v.rpc(
    "issue.create",
    {
      title: "Retire legacy pre-Note card badges from board columns",
      priority: "low",
      tags: ["Cleanup"],
      description: "Done as part of Papertrails restraint pass.",
      criteria: ["Only canonical priority and note counters remain on board cards"],
    },
    CreatedIssueSchema,
  );

  // Move sample issues across lanes so board columns look realistic without dispatching live sessions.
  await v.rpc("issue.status.update", { id: issue4.id, status: "canceled", reason: "dismissed" });

  const channelId = await v.rpc(
    "channel.create",
    {
      name: "release-ops",
      description: "Release readiness, VDP automated checks, and UX visual reviews",
    },
    CreatedChannelSchema,
  );

  await v.rpc("channel.message.send", {
    id: channelId,
    text: "TS VDP Scenario runner ready (`vp run vdp all --ui-only`) covering Light & Dark visual parity.",
  });

  return {
    issueIds: [issue1.id, issue2.id, issue3.id, issue4.id],
    channelId,
  };
}

/** Seeds shared issues and channel messages once per WebSocket transport so multi-scenario suites share one dataset. */
export function seedWorkspaceCore(v: VdpScenarioContext): Promise<WorkspaceCoreIds> {
  const existing = seededByTransport.get(v.transport);
  if (existing !== undefined) return existing;
  const pending = performSeedWorkspaceCore(v).catch((err) => {
    seededByTransport.delete(v.transport);
    throw err;
  });
  seededByTransport.set(v.transport, pending);
  return pending;
}
