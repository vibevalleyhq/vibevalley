import { z } from "zod";

import { defineScenario, playAgentCanvasSession, playAgentDocSession } from "../dsl.ts";
import { seedNoteShowcase } from "../fixtures/note.ts";

const CreatedNoteSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  seq: z.number().int().min(0),
});

export const agentPlayScenario = defineScenario({
  id: "agent-play",
  description: "Agent live co-editing & Canvas whiteboard drawing playback with Papertrails avatars, non-wrapping layout checks, and MP4 recording",
  async run(v) {
    await seedNoteShowcase(v);
    await v.resize(v.viewport.width, v.viewport.height);
    await v.theme("light");

    const docInitial = {
      version: 1,
      blocks: [
        { id: "ag_h1", type: "heading", level: 1, text: "Agent 协同编辑与零偏移实景回放" },
        { id: "ag_p1", type: "prose", text: "Baseline summary line" },
        { id: "ag_todo", type: "todo", checked: false, text: "验证协作者头像与状态徽标无偏移挂载" },
      ],
    };

    const docNote = await v.rpc(
      "note.create",
      {
        title: "Agent Co-Edit Playback",
        noteType: "doc",
        sortOrder: 8,
        content: JSON.stringify(docInitial, null, 2),
      },
      CreatedNoteSchema,
    );

    const canvasInitial = {
      version: 1,
      nodes: {
        ag_c1: {
          id: "ag_c1",
          type: "shape",
          shape: "card",
          x: 120,
          y: 120,
          w: 250,
          h: 108,
          title: "Core Runtime",
          body: "GPUI native surface & Loro CRDT",
          fill: "water",
        },
      },
    };

    const canvasNote = await v.rpc(
      "note.create",
      {
        title: "Agent Canvas Drawing Playback",
        noteType: "canvas",
        sortOrder: 9,
        content: JSON.stringify(canvasInitial, null, 2),
      },
      CreatedNoteSchema,
    );

    await v.record("agent-collab-play", { label: "Agent Co-Editing & Canvas Drawing Playback", fps: 4 }, async (recorder) => {
      await v.nav(`/notes/${docNote.id}`);
      await v.waitRoute(`/notes/${docNote.id}`);
      await v.wait("note-block-doc-view");
      await v.wait("doc-block-ag_p1");
      await v.settle(120);
      await recorder.captureFrame(60);

      const step1Doc = {
        version: 1,
        blocks: [docInitial.blocks[0], { id: "ag_p1", type: "prose", text: "Baseline summary line (ok)" }, docInitial.blocks[2]],
      };
      const step2Doc = {
        version: 1,
        blocks: [docInitial.blocks[0], { id: "ag_p1", type: "prose", text: "Baseline summary line (ok v2)" }, docInitial.blocks[2]],
      };
      const step3Doc = {
        version: 1,
        blocks: [docInitial.blocks[0], step2Doc.blocks[1], { id: "ag_todo", type: "todo", checked: true, text: "验证协作者头像与状态徽标无偏移挂载" }],
      };

      await playAgentDocSession(v, {
        noteId: docNote.id,
        actor: {
          id: "agent:architect",
          name: "鲁班 · 架构师",
          avatar: "avatar-architect",
          color: "accent",
        },
        recorder,
        steps: [
          {
            blockId: "ag_p1",
            offset: 26,
            status: "编辑中",
            blocksJson: JSON.stringify(step1Doc, null, 2),
            expectStableTargetId: "doc-block-ag_p1",
          },
          {
            blockId: "ag_p1",
            offset: 29,
            status: "校对中",
            blocksJson: JSON.stringify(step2Doc, null, 2),
            expectStableTargetId: "doc-block-ag_p1",
          },
          {
            blockId: "ag_todo",
            status: "已完成",
            blocksJson: JSON.stringify(step3Doc, null, 2),
          },
        ],
        async onStep(idx) {
          if (idx === 0) {
            await v.wait("doc-presence-badge-agent:architect");
            await v.assertPresent("doc-presence-badge-agent:architect");
            await v.assertClean("agent-play-doc-presence");
            await v.shot("01-agent-doc-presence-light", {
              label: "Agent Co-Editing BlockDoc with Papertrails Avatar Badge",
            });
          }
        },
      });

      await v.nav(`/notes/${canvasNote.id}`);
      await v.waitRoute(`/notes/${canvasNote.id}`);
      await v.wait("note-canvas-view");
      await v.settle(240);
      await recorder.captureFrame(60);

      const boardStep1 = {
        version: 1,
        nodes: {
          ...canvasInitial.nodes,
          ag_c2: {
            id: "ag_c2",
            type: "shape",
            shape: "sticky",
            x: 430,
            y: 120,
            w: 250,
            h: 108,
            title: "VDP 2.0 Playback",
            body: "Live presence badge + zero-shift probe",
            fill: "sun",
          },
        },
      };
      const boardStep2 = {
        version: 1,
        nodes: {
          ...boardStep1.nodes,
          ag_c2: {
            ...boardStep1.nodes.ag_c2,
            fill: "leaf",
            body: "Verified MP4 frame capture & avatar overlay",
          },
        },
      };

      await playAgentCanvasSession(v, {
        noteId: canvasNote.id,
        actor: {
          id: "agent:designer",
          name: "巧匠 · 视觉设计师",
          avatar: "avatar-designer",
          color: "water",
        },
        recorder,
        steps: [
          {
            nodeId: "ag_c2",
            x: 460,
            y: 145,
            w: 250,
            h: 108,
            status: "绘制卡片",
            boardJson: JSON.stringify(boardStep1, null, 2),
          },
          {
            nodeId: "ag_c2",
            x: 520,
            y: 170,
            w: 250,
            h: 108,
            status: "配色定稿",
            boardJson: JSON.stringify(boardStep2, null, 2),
          },
        ],
        async onStep(idx) {
          if (idx === 0) {
            await v.wait("whiteboard-presence-badge-agent:designer");
            await v.assertPresent("whiteboard-presence-badge-agent:designer");
            await v.assertClean("agent-play-canvas-presence");
            await v.shot("02-agent-canvas-presence-light", {
              label: "Agent Drawing on Canvas Whiteboard with Papertrails Avatar Badge",
            });
          }
        },
      });
    });
  },
});
