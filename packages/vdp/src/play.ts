import { setTimeout as sleep } from "node:timers/promises";

import type { VdpScenarioContext } from "./dsl.ts";
import type { VdpRecorder } from "./recorder.ts";

export interface AgentActorProfile {
  readonly id: string;
  readonly name: string;
  readonly avatar: string;
  readonly color?: string | undefined;
}

export interface AgentDocPlayStep {
  readonly blockId: string;
  readonly blocksJson: string;
  readonly status?: string | undefined;
  readonly offset?: number | undefined;
  readonly expectStableTargetId?: string | undefined;
  readonly animateEntrance?: boolean | undefined;
  readonly settleMs?: number | undefined;
}

export interface AgentCanvasPlayStep {
  readonly status?: string | undefined;
  readonly nodeId?: string | undefined;
  readonly x: number;
  readonly y: number;
  readonly w?: number | undefined;
  readonly h?: number | undefined;
  readonly boardJson: string;
  readonly animateEntrance?: boolean | undefined;
  readonly settleMs?: number | undefined;
}

async function publishAgentPresence(
  v: VdpScenarioContext,
  opts: {
    readonly noteId: string;
    readonly actor: AgentActorProfile;
    readonly kind: "cursor" | "selection";
    readonly path: string;
    readonly nodeId?: string | undefined;
    readonly offset?: number | undefined;
    readonly x?: number | undefined;
    readonly y?: number | undefined;
    readonly w?: number | undefined;
    readonly h?: number | undefined;
    readonly status?: string | undefined;
  },
): Promise<void> {
  await v.rpc("note.presence.update", {
    id: opts.noteId,
    presence: {
      id: opts.actor.id,
      name: opts.actor.name,
      avatar: opts.actor.avatar,
      color: opts.actor.color ?? "accent",
      kind: opts.kind,
      path: opts.path,
      ...(opts.nodeId !== undefined ? { nodeId: opts.nodeId, selector: opts.nodeId } : {}),
      ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
      ...(opts.x !== undefined ? { x: opts.x } : {}),
      ...(opts.y !== undefined ? { y: opts.y } : {}),
      ...(opts.w !== undefined ? { w: opts.w } : {}),
      ...(opts.h !== undefined ? { h: opts.h } : {}),
      ...(opts.status !== undefined ? { status: opts.status } : {}),
      updatedAt: Date.now(),
    },
  });
}

export async function playAgentDocSession(
  v: VdpScenarioContext,
  opts: {
    readonly noteId: string;
    readonly actor: AgentActorProfile;
    readonly steps: readonly AgentDocPlayStep[];
    readonly recorder?: VdpRecorder | undefined;
    readonly stepDelayMs?: number | undefined;
    readonly onStep?: ((stepIndex: number) => Promise<void>) | undefined;
  },
): Promise<void> {
  try {
    for (const [i, step] of opts.steps.entries()) {
      const applyStep = async () => {
        await publishAgentPresence(v, {
          noteId: opts.noteId,
          actor: opts.actor,
          kind: "cursor",
          path: "structure/doc.json",
          nodeId: step.blockId,
          offset: step.offset,
          status: step.status ?? "editing",
        });
        await v.rpc("note.file.write", {
          id: opts.noteId,
          files: [{ path: "structure/doc.json", content: step.blocksJson }],
          summary: `${opts.actor.name} edit step ${i + 1}`,
        });
        await v.wait(`doc-block-${step.blockId}`);
        await v.wait(`doc-presence-badge-${opts.actor.id}`);
        await v.settle(step.animateEntrance === true ? 20 : (step.settleMs ?? 80));
      };

      if (step.expectStableTargetId !== undefined) {
        await v.expectInlineStable(`agent-play-doc-step-${i + 1}`, { targetId: step.expectStableTargetId }, applyStep);
      } else {
        await applyStep();
      }

      if (opts.recorder !== undefined) {
        if (step.animateEntrance === true) {
          await opts.recorder.captureFrame(0);
          await v.settle(step.settleMs ?? 140);
        }
        await opts.recorder.captureFrame(40);
      }
      if (opts.onStep !== undefined) {
        await opts.onStep(i);
      }
      if ((opts.stepDelayMs ?? 0) > 0) {
        await sleep(opts.stepDelayMs);
      }
    }
  } finally {
    await v.rpc("note.presence.update", { id: opts.noteId, peerId: opts.actor.id }).catch(() => {});
  }
}

export async function playAgentCanvasSession(
  v: VdpScenarioContext,
  opts: {
    readonly noteId: string;
    readonly actor: AgentActorProfile;
    readonly steps: readonly AgentCanvasPlayStep[];
    readonly recorder?: VdpRecorder | undefined;
    readonly stepDelayMs?: number | undefined;
    readonly onStep?: ((stepIndex: number) => Promise<void>) | undefined;
  },
): Promise<void> {
  try {
    for (const [i, step] of opts.steps.entries()) {
      await v.rpc("note.file.write", {
        id: opts.noteId,
        files: [{ path: "structure/board.json", content: step.boardJson }],
        summary: `${opts.actor.name} board step ${i + 1}`,
      });
      if (step.nodeId !== undefined) {
        await v.wait(`wb-el-${step.nodeId}`);
      }
      await publishAgentPresence(v, {
        noteId: opts.noteId,
        actor: opts.actor,
        kind: "selection",
        path: "structure/board.json",
        nodeId: step.nodeId,
        x: step.x,
        y: step.y,
        w: step.w,
        h: step.h,
        status: step.status ?? "drawing",
      });
      await v.wait(`whiteboard-presence-badge-${opts.actor.id}`);
      if (step.animateEntrance === true && opts.recorder !== undefined) {
        await v.settle(65);
        await opts.recorder.captureFrame(0);
      }
      await v.settle(step.settleMs ?? 200);
      if (opts.recorder !== undefined) {
        await opts.recorder.captureFrame(100);
      }
      if (opts.onStep !== undefined) {
        await opts.onStep(i);
      }
      if ((opts.stepDelayMs ?? 0) > 0) {
        await sleep(opts.stepDelayMs);
      }
    }
  } finally {
    await v.rpc("note.presence.update", { id: opts.noteId, peerId: opts.actor.id }).catch(() => {});
  }
}
