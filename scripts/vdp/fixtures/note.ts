import { z } from "zod";

import type { VdpRpcTransport, VdpScenarioContext } from "../dsl.ts";
import { seedWorkspaceCore } from "./workspace.ts";

const CreatedNoteSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
});

export interface NoteShowcaseIds {
  readonly issueIds: readonly string[];
  readonly channelId: string;
  readonly docId: string;
  readonly baseId: string;
  readonly childPageId: string;
  readonly canvasId: string;
  readonly mediaId: string;
}

const seededNotesByTransport = new WeakMap<VdpRpcTransport, Promise<NoteShowcaseIds>>();

async function performSeedNoteShowcase(v: VdpScenarioContext): Promise<NoteShowcaseIds> {
  const core = await seedWorkspaceCore(v);
  const issue1Id = core.issueIds[0]!;
  const issue2Id = core.issueIds[1] ?? issue1Id;

  const childPage = await v.rpc(
    "note.create",
    {
      title: "Typography & Contrast Token Spec",
      noteType: "doc",
      sortOrder: 20,
      issue: issue1Id,
      content: JSON.stringify(
        {
          version: 1,
          blocks: [
            { id: "c1", type: "heading", level: 1, text: "Typography & Contrast Token Spec" },
            {
              id: "c2",
              type: "prose",
              text: "Papertrails surfaces separate reading canvas (`page`) from recessed rails (`side`) using semantic contrast ramps in both Light and Dark themes.",
            },
            {
              id: "c3",
              type: "callout",
              tone: "ok",
              title: "Contrast Gate",
              text: "Primary ink maintains >= 7:1 contrast; muted captions remain legible without overpowering body copy.",
            },
          ],
        },
        null,
        2,
      ),
    },
    CreatedNoteSchema,
  );

  const baseDoc = {
    version: 1,
    sheets: [
      {
        id: "sheet_deliverables",
        name: "Editorial Audit",
        columns: [
          { id: "c_item", name: "交付项", kind: "text", width: 220 },
          {
            id: "c_status",
            name: "状态",
            kind: "select",
            width: 110,
            options: [
              { value: "todo", label: "待办", color: "amber" },
              { value: "doing", label: "进行中", color: "blue" },
              { value: "done", label: "已完成", color: "green" },
            ],
          },
          { id: "c_note", name: "关联笔记", kind: "noteRef", width: 170 },
          { id: "c_issue", name: "关联工单", kind: "issueRef", width: 170 },
          { id: "c_pts", name: "工作量", kind: "number", width: 90 },
          { id: "c_score", name: "完成度公式", kind: "formula", width: 120, formula: 'if({c_status} == "done", 100, {c_pts} * 8)' },
          { id: "c_verified", name: "验收", kind: "checkbox", width: 80 },
          {
            id: "c_agent",
            name: "Agent 评审",
            kind: "agentAction",
            width: 140,
            agentConfig: { promptTemplate: "Review {{c_item}} acceptance criteria and summarize gaps." },
          },
        ],
        rows: [
          {
            id: "r1",
            pageNoteId: childPage.id,
            cells: {
              c_item: { _tag: "text", value: "Doc 编辑器排版与大纲重构" },
              c_status: { _tag: "text", value: "done" },
              c_note: { _tag: "noteRef", noteId: childPage.id },
              c_issue: { _tag: "issueRef", issueId: issue1Id },
              c_pts: { _tag: "number", value: 8 },
              c_verified: { _tag: "bool", value: true },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "r2",
            cells: {
              c_item: { _tag: "text", value: "Base 多维视图切换与列对齐" },
              c_status: { _tag: "text", value: "doing" },
              c_note: { _tag: "noteRef", noteId: childPage.id },
              c_issue: { _tag: "issueRef", issueId: issue1Id },
              c_pts: { _tag: "number", value: 10 },
              c_verified: { _tag: "bool", value: false },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "r3",
            cells: {
              c_item: { _tag: "text", value: "TS 嵌入式 VDP 场景脚本体系" },
              c_status: { _tag: "text", value: "todo" },
              c_issue: { _tag: "issueRef", issueId: issue2Id },
              c_pts: { _tag: "number", value: 6 },
              c_verified: { _tag: "bool", value: false },
            },
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        views: [
          {
            id: "v_table",
            name: "表格",
            kind: "table",
            summaries: [
              { columnId: "c_pts", op: "sum" },
              { columnId: "c_pts", op: "avg" },
            ],
          },
          { id: "v_board", name: "看板", kind: "board", groupBy: "c_status" },
          { id: "v_gallery", name: "画廊", kind: "gallery" },
        ],
      },
    ],
  };

  const baseNote = await v.rpc(
    "note.create",
    {
      title: "Note 重构交付追踪 Base",
      noteType: "base",
      sortOrder: 30,
      issue: issue1Id,
      content: JSON.stringify(baseDoc, null, 2),
    },
    CreatedNoteSchema,
  );

  const whiteboardDoc = {
    version: 1,
    grid: "architectural",
    theme: "warm",
    viewport: { x: 0, y: 0, zoom: 1 },
    elements: {
      t_title: { id: "t_title", type: "text", variant: "title", x: 56, y: 24, w: 680, h: 44, label: "VibeValley 3+1 Note Architecture" },
      grp_core: { id: "grp_core", type: "container", x: 56, y: 96, w: 460, h: 250, title: "Primitives Layer", fill: "leaf" },
      n_doc: {
        id: "n_doc",
        type: "shape",
        shape: "card",
        parentId: "grp_core",
        x: 80,
        y: 146,
        w: 190,
        h: 96,
        title: "Block Doc (24 kinds)",
        body: "Editorial prose, embeds, outlines",
        fill: "water",
      },
      n_base: {
        id: "n_base",
        type: "shape",
        shape: "card",
        parentId: "grp_core",
        x: 302,
        y: 146,
        w: 190,
        h: 96,
        title: "Multi-View Base",
        body: "Row = Page, Formulas & Relations",
        fill: "leaf",
      },
      grp_sync: { id: "grp_sync", type: "container", x: 560, y: 96, w: 300, h: 250, title: "Sync & Graph Kernel", fill: "sun" },
      n_loro: {
        id: "n_loro",
        type: "shape",
        shape: "card",
        parentId: "grp_sync",
        x: 584,
        y: 146,
        w: 250,
        h: 96,
        title: "Loro CRDT + NoteLinks",
        body: "Realtime collab & bidirectional graph",
        fill: "lavender",
      },
      n_vdp: {
        id: "n_vdp",
        type: "shape",
        shape: "sticky",
        x: 180,
        y: 376,
        w: 240,
        h: 84,
        title: "TS VDP Scenario Gate",
        body: "Single-WS DSL visual verification",
        fill: "sun",
      },
    },
  };

  const canvasNote = await v.rpc(
    "note.create",
    {
      title: "3+1 Note 架构白板",
      noteType: "canvas",
      sortOrder: 40,
      content: JSON.stringify(whiteboardDoc, null, 2),
    },
    CreatedNoteSchema,
  );

  const mediaDoc = {
    version: 1,
    title: "Release Walkthrough Video & Transcript",
    mediaKind: "video",
    caption: "Editorial redesign walkthrough & Base interaction demo",
    durationSec: 84,
    posterAsset: null,
    items: [
      {
        id: "m1",
        kind: "video",
        src: "asset/video/walkthrough.mp4",
        title: "Note Editorial Walkthrough",
        durationSec: 84,
        transcript: [
          { id: "c1", startSec: 0, endSec: 18, speaker: "Ada", text: "Unified single sidebar combines Notes library and hierarchical PageTree cleanly." },
          { id: "c2", startSec: 18, endSec: 46, speaker: "Milo", text: "Block Doc strips heavy box chrome in favor of calm spacing and sticky Mini-Outline." },
        ],
      },
    ],
  };

  const mediaNote = await v.rpc(
    "note.create",
    {
      title: "发版演示录屏与逐字稿",
      noteType: "media",
      sortOrder: 50,
      issue: issue1Id,
      content: JSON.stringify(mediaDoc, null, 2),
    },
    CreatedNoteSchema,
  );

  const mainDoc = {
    version: 1,
    blocks: [
      { id: "b1", type: "heading", level: 1, text: "VibeValley Note 3+1 编辑体验规范" },
      {
        id: "b2",
        type: "prose",
        text: `这份架构笔记用于统一 **Block Doc**、**多维 Base** 与 **Canvas/Media** 原语设计；核心色彩与对比度规则见 [[note:${childPage.id}]]，整体需求追踪见 [[issue:${issue1Id}]]。`,
      },
      { id: "b3", type: "heading", level: 2, text: "排版克制性与可读性原则" },
      {
        id: "b4",
        type: "quote",
        text: "Good interfaces step back until needed — breathing room and typographic hierarchy carry more meaning than border boxes.",
        attribution: "Papertrails Design Review",
      },
      {
        id: "b5",
        type: "toggle",
        title: "为什么要合并页面树并隐藏常驻边框？",
        text: "双层侧栏挤压正文宽度；常驻高亮徽章、外框和工具栏会打断连续阅读体验。只在 hover 或激活当前块时按需浮现工具。",
      },
      {
        id: "b6",
        type: "code",
        language: "rust",
        code: "pub fn project_base_view(doc: &BaseDocument, sheet_id: Option<&str>, view_id: Option<&str>) -> BaseViewSnapshot {\n    // Deterministic table, board, gallery & timeline projection\n}",
      },
      {
        id: "b7",
        type: "table",
        headers: ["原语", "核心数据结构", "协同能力"],
        alignments: ["left", "left", "left"],
        rows: [
          ["Doc", "24 种结构化 Block + Markdown 双向映射", "块级光标 + Loro CRDT"],
          ["Base", "Sheet 与 View 分离 + 公式求值 + Row=Page", "多视图投影 + Agent 批处理"],
          ["Canvas", "无限白板 + 图形/连线/分组", "多人实时节点在场"],
        ],
      },
      { id: "b8", type: "math", display: true, expression: "\\text{Latency}_{p99} \\le 16.6\\,\\text{ms}" },
      { id: "b9", type: "heading", level: 2, text: "实时指标、内嵌多维库与关联工单" },
      {
        id: "b10",
        type: "kpi",
        items: [
          { label: "文档块类型", value: "24 Kinds", delta: "+6", tone: "ok" },
          { label: "P99 渲染帧率", value: "6.4 ms", delta: "-3.1 ms", tone: "ok" },
          { label: "Shell 报错", value: "0", tone: "info" },
        ],
      },
      { id: "b11", type: "baseEmbed", noteId: baseNote.id, sheetId: "sheet_deliverables", viewId: "v_table" },
      { id: "b12", type: "issueCard", issueId: issue1Id },
    ],
  };

  const docNote = await v.rpc(
    "note.create",
    {
      title: "VibeValley Note 3+1 编辑体验规范",
      noteType: "doc",
      sortOrder: 10,
      issue: issue1Id,
      content: JSON.stringify(mainDoc, null, 2),
    },
    CreatedNoteSchema,
  );

  // Move childPage cleanly under main docNote so PageTree hierarchy is populated in the unified sidebar.
  await v.rpc("note.tree.move", {
    id: childPage.id,
    parentId: docNote.id,
    sortOrder: 10,
  });

  return {
    issueIds: core.issueIds,
    channelId: core.channelId,
    docId: docNote.id,
    baseId: baseNote.id,
    childPageId: childPage.id,
    canvasId: canvasNote.id,
    mediaId: mediaNote.id,
  };
}

/** Seeds a linked 3+1 Note workspace once per WebSocket transport (`Server.invoke`). */
export function seedNoteShowcase(v: VdpScenarioContext): Promise<NoteShowcaseIds> {
  const existing = seededNotesByTransport.get(v.transport);
  if (existing !== undefined) return existing;
  const pending = performSeedNoteShowcase(v).catch((err) => {
    seededNotesByTransport.delete(v.transport);
    throw err;
  });
  seededNotesByTransport.set(v.transport, pending);
  return pending;
}
