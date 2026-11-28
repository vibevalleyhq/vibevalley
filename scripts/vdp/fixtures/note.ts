import { deflateSync } from "node:zlib";

import { z } from "zod";

import type { VdpRpcTransport, VdpScenarioContext } from "../dsl.ts";
import { seedWorkspaceCore } from "./workspace.ts";

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBytes, data, crc]);
}

/** Synthesizes a crisp 640x360 Papertrails workspace mockup PNG data URI for VDP annotation inspection. */
function buildWalkthroughMockupPngDataUri(): string {
  const width = 640;
  const height = 360;
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(stride * height);

  const fillRect = (x0: number, y0: number, w: number, h: number, r: number, g: number, b: number) => {
    const rx0 = Math.max(0, Math.floor(x0));
    const ry0 = Math.max(0, Math.floor(y0));
    const rx1 = Math.min(width, Math.floor(x0 + w));
    const ry1 = Math.min(height, Math.floor(y0 + h));
    for (let y = ry0; y < ry1; y += 1) {
      const rowOff = y * stride;
      for (let x = rx0; x < rx1; x += 1) {
        const off = rowOff + 1 + x * 4;
        raw[off] = r;
        raw[off + 1] = g;
        raw[off + 2] = b;
        raw[off + 3] = 255;
      }
    }
  };

  // Warm paper page canvas
  fillRect(0, 0, width, height, 250, 248, 244);
  // Left sidebar rail
  fillRect(0, 0, 148, height, 239, 236, 230);
  fillRect(148, 0, 2, height, 214, 208, 198);
  // Sidebar nav rows
  fillRect(18, 24, 96, 12, 77, 122, 42);
  fillRect(18, 56, 110, 22, 226, 222, 213);
  fillRect(18, 88, 92, 12, 168, 162, 154);
  fillRect(18, 112, 102, 12, 168, 162, 154);
  fillRect(18, 136, 84, 12, 168, 162, 154);
  // Top header toolbar
  fillRect(150, 0, width - 150, 44, 246, 244, 239);
  fillRect(150, 44, width - 150, 1, 224, 220, 212);
  fillRect(172, 16, 160, 12, 42, 38, 34);
  fillRect(518, 11, 98, 22, 77, 122, 42);
  // Two editorial metric cards
  fillRect(172, 64, 212, 110, 255, 254, 251);
  fillRect(172, 64, 212, 2, 226, 221, 213);
  fillRect(188, 82, 88, 10, 124, 116, 108);
  fillRect(188, 104, 120, 22, 28, 25, 23);
  fillRect(188, 140, 160, 10, 168, 162, 154);

  fillRect(404, 64, 212, 110, 255, 254, 251);
  fillRect(404, 64, 212, 2, 226, 221, 213);
  fillRect(420, 82, 96, 10, 124, 116, 108);
  fillRect(420, 104, 112, 22, 44, 106, 163);
  fillRect(420, 140, 164, 10, 168, 162, 154);

  // Lower table preview block
  fillRect(172, 194, 444, 142, 255, 254, 251);
  fillRect(172, 194, 444, 28, 242, 239, 233);
  fillRect(172, 256, 444, 1, 229, 225, 217);
  fillRect(172, 294, 444, 1, 229, 225, 217);
  fillRect(190, 204, 72, 8, 110, 104, 98);
  fillRect(310, 204, 64, 8, 110, 104, 98);
  fillRect(450, 204, 84, 8, 110, 104, 98);
  fillRect(190, 234, 100, 10, 44, 40, 36);
  fillRect(310, 232, 58, 14, 248, 228, 224);
  fillRect(190, 270, 112, 10, 44, 40, 36);
  fillRect(310, 268, 66, 14, 251, 240, 217);
  fillRect(190, 308, 96, 10, 44, 40, 36);
  fillRect(310, 306, 62, 14, 232, 240, 222);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const idat = deflateSync(raw, { level: 6 });
  const png = Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

const WALKTHROUGH_MOCKUP_PNG = buildWalkthroughMockupPngDataUri();

const CreatedNoteSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  seq: z.number().int().min(0),
});

const DAY_MS = 86_400_000;

function isoDayOffset(baseMs: number, offsetDays: number): string {
  const d = new Date(baseMs + offsetDays * DAY_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface NoteShowcaseIds {
  readonly issueIds: readonly string[];
  readonly channelId: string;
  readonly docId: string;
  readonly reviewDocId: string;
  readonly reviewBaseId: string;
  readonly baseId: string;
  readonly childPageId: string;
  readonly canvasId: string;
  readonly mediaId: string;
}

const seededNotesByTransport = new WeakMap<VdpRpcTransport, Promise<NoteShowcaseIds>>();

async function performSeedNoteShowcase(v: VdpScenarioContext): Promise<NoteShowcaseIds> {
  const core = await seedWorkspaceCore(v);
  const nowMs = Date.now();
  const issue1Id = core.issueIds[0]!;
  const issue2Id = core.issueIds[1] ?? issue1Id;
  const issue4Id = core.issueIds[3] ?? issue1Id;
  const issue5Id = core.issueIds[4] ?? issue1Id;
  const issue6Id = core.issueIds[5] ?? issue2Id;
  const issue7Id = core.issueIds[6] ?? issue1Id;
  const issue9Id = core.issueIds[8] ?? issue1Id;

  const childPage = await v.rpc(
    "note.create",
    {
      title: "Typography & Contrast Token Spec",
      noteType: "doc",
      sortOrder: 20,
      issue: issue2Id,
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

  const childMotionPage = await v.rpc(
    "note.create",
    {
      title: "Kanban & Inline Motion Notes",
      noteType: "doc",
      sortOrder: 22,
      issue: issue4Id,
      content: JSON.stringify(
        {
          version: 1,
          blocks: [
            { id: "m1", type: "heading", level: 1, text: "Kanban & Inline Motion Notes" },
            {
              id: "m2",
              type: "prose",
              text: "跨列拖拽应保持幽灵卡片与源卡片宽度一致，并在悬停列内以真实占位插槽体现挤压感。",
            },
            { id: "m3", type: "todo", checked: true, text: "移除卡片左上角多余多选框" },
            { id: "m4", type: "todo", checked: false, text: "补齐目标列内实时插槽位移预览" },
          ],
        },
        null,
        2,
      ),
    },
    CreatedNoteSchema,
  );

  const childEmptyStatePage = await v.rpc(
    "note.create",
    {
      title: "Empty State & Microcopy Audit",
      noteType: "doc",
      sortOrder: 24,
      issue: issue7Id,
      content: JSON.stringify(
        {
          version: 1,
          blocks: [
            { id: "e1", type: "heading", level: 1, text: "Empty State & Microcopy Audit" },
            {
              id: "e2",
              type: "prose",
              text: "空状态应区分「首次建立认知」「筛选无结果」「局部零状态」，提供有温度的引导与直接主操作。",
            },
          ],
        },
        null,
        2,
      ),
    },
    CreatedNoteSchema,
  );

  const siblingChecklist = await v.rpc(
    "note.create",
    {
      title: "v0.9 发版前产品走查清单",
      noteType: "doc",
      sortOrder: 60,
      channel: core.channelId,
      content: JSON.stringify(
        {
          version: 1,
          blocks: [
            { id: "s1", type: "heading", level: 1, text: "v0.9 发版前产品走查清单" },
            { id: "s2", type: "todo", checked: true, text: "全页面 Light / Dark 主题视觉对比走查" },
            { id: "s3", type: "todo", checked: true, text: "720px 窄屏响应断点验证" },
            { id: "s4", type: "todo", checked: false, text: "设置页字体选择器性能优化与实测" },
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
          { id: "c_item", name: "交付项", kind: "text", width: 240 },
          {
            id: "c_status",
            name: "状态",
            kind: "select",
            width: 108,
            options: [
              { value: "todo", label: "待办", color: "amber" },
              { value: "doing", label: "进行中", color: "blue" },
              { value: "review", label: "评审中", color: "purple" },
              { value: "done", label: "已完成", color: "green" },
            ],
          },
          {
            id: "c_tags",
            name: "领域标签",
            kind: "multiSelect",
            width: 150,
            options: [
              { value: "Editorial", label: "Editorial", color: "green" },
              { value: "Layout", label: "Layout", color: "blue" },
              { value: "Motion", label: "Motion", color: "amber" },
              { value: "VDP", label: "VDP", color: "purple" },
              { value: "Performance", label: "Performance", color: "red" },
            ],
          },
          { id: "c_window", name: "排期窗口", kind: "date", width: 175 },
          { id: "c_note", name: "关联笔记", kind: "noteRef", width: 175 },
          { id: "c_issue", name: "关联工单", kind: "issueRef", width: 165 },
          { id: "c_pts", name: "工作量", kind: "number", width: 84 },
          { id: "c_score", name: "完成度公式", kind: "formula", width: 112, formula: 'if({c_status} == "done", 100, {c_pts} * 8)' },
          { id: "c_verified", name: "验收", kind: "checkbox", width: 72 },
          {
            id: "c_agent",
            name: "Agent 评审",
            kind: "agentAction",
            width: 150,
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
              c_tags: { _tag: "strings", items: ["Editorial", "Layout"] },
              c_window: { _tag: "text", value: `${isoDayOffset(nowMs, -4)} -> ${isoDayOffset(nowMs, -1)}` },
              c_note: { _tag: "noteRef", noteId: childPage.id },
              c_issue: { _tag: "issueRef", issueId: issue1Id },
              c_pts: { _tag: "number", value: 8 },
              c_verified: { _tag: "bool", value: true },
              c_agent: {
                _tag: "agentRun",
                status: "done",
                summary: "对比度与层级通过",
                updatedAt: nowMs - 3_600_000,
              },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "r2",
            pageNoteId: childMotionPage.id,
            cells: {
              c_item: { _tag: "text", value: "Base 多维视图切换与列对齐" },
              c_status: { _tag: "text", value: "doing" },
              c_tags: { _tag: "strings", items: ["Layout"] },
              c_window: { _tag: "text", value: `${isoDayOffset(nowMs, -2)} -> ${isoDayOffset(nowMs, 2)}` },
              c_note: { _tag: "noteRef", noteId: childPage.id },
              c_issue: { _tag: "issueRef", issueId: issue2Id },
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
              c_status: { _tag: "text", value: "done" },
              c_tags: { _tag: "strings", items: ["VDP"] },
              c_window: { _tag: "text", value: `${isoDayOffset(nowMs, -3)} -> ${isoDayOffset(nowMs, 1)}` },
              c_issue: { _tag: "issueRef", issueId: issue6Id },
              c_pts: { _tag: "number", value: 6 },
              c_verified: { _tag: "bool", value: true },
              c_agent: {
                _tag: "agentRun",
                status: "spawned",
                summary: "覆盖 6 大场景",
                spawnedIssueId: issue6Id,
                updatedAt: nowMs - 1_800_000,
              },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "r4",
            pageNoteId: childMotionPage.id,
            cells: {
              c_item: { _tag: "text", value: "看板跨列拖拽 Ghost 与插槽挤压" },
              c_status: { _tag: "text", value: "review" },
              c_tags: { _tag: "strings", items: ["Motion", "Layout"] },
              c_window: { _tag: "text", value: `${isoDayOffset(nowMs, 0)} -> ${isoDayOffset(nowMs, 3)}` },
              c_note: { _tag: "noteRef", noteId: childMotionPage.id },
              c_issue: { _tag: "issueRef", issueId: issue4Id },
              c_pts: { _tag: "number", value: 8 },
              c_verified: { _tag: "bool", value: false },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "r5",
            cells: {
              c_item: { _tag: "text", value: "外观设置字体列表异步化去卡顿" },
              c_status: { _tag: "text", value: "doing" },
              c_tags: { _tag: "strings", items: ["Performance"] },
              c_window: { _tag: "text", value: `${isoDayOffset(nowMs, 1)} -> ${isoDayOffset(nowMs, 4)}` },
              c_issue: { _tag: "issueRef", issueId: issue5Id },
              c_pts: { _tag: "number", value: 5 },
              c_verified: { _tag: "bool", value: false },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "r6",
            pageNoteId: childEmptyStatePage.id,
            cells: {
              c_item: { _tag: "text", value: "全站空状态分层与主引导重设计" },
              c_status: { _tag: "text", value: "todo" },
              c_tags: { _tag: "strings", items: ["Editorial"] },
              c_window: { _tag: "text", value: `${isoDayOffset(nowMs, 3)} -> ${isoDayOffset(nowMs, 7)}` },
              c_note: { _tag: "noteRef", noteId: childEmptyStatePage.id },
              c_issue: { _tag: "issueRef", issueId: issue7Id },
              c_pts: { _tag: "number", value: 7 },
              c_verified: { _tag: "bool", value: false },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "r7",
            cells: {
              c_item: { _tag: "text", value: "微动效阻尼曲线与减动效适配" },
              c_status: { _tag: "text", value: "todo" },
              c_tags: { _tag: "strings", items: ["Motion"] },
              c_window: { _tag: "text", value: `${isoDayOffset(nowMs, 5)} -> ${isoDayOffset(nowMs, 9)}` },
              c_issue: { _tag: "issueRef", issueId: issue9Id },
              c_pts: { _tag: "number", value: 9 },
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
          { id: "v_timeline", name: "时间轴", kind: "timeline" },
        ],
      },
      {
        id: "sheet_bugs",
        name: "UI 走查缺陷库",
        columns: [
          { id: "c_bug", name: "缺陷标题", kind: "text", width: 260 },
          {
            id: "c_sev",
            name: "严重度",
            kind: "select",
            width: 100,
            options: [
              { value: "p0", label: "P0 阻塞", color: "red" },
              { value: "p1", label: "P1 体验", color: "amber" },
              { value: "p2", label: "P2 润色", color: "blue" },
            ],
          },
          { id: "c_fixed", name: "已修复", kind: "checkbox", width: 80 },
        ],
        rows: [
          {
            id: "b1",
            cells: {
              c_bug: { _tag: "text", value: "外观设置打开卡顿（系统字体同步枚举）" },
              c_sev: { _tag: "text", value: "p0" },
              c_fixed: { _tag: "bool", value: false },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "b2",
            cells: {
              c_bug: { _tag: "text", value: "跨列拖拽 Ghost 与落点不一致" },
              c_sev: { _tag: "text", value: "p1" },
              c_fixed: { _tag: "bool", value: false },
            },
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        views: [{ id: "v_bug_table", name: "表格", kind: "table" }],
      },
    ],
  };

  const baseNote = await v.rpc(
    "note.create",
    {
      title: "Note 重构交付追踪 Base",
      noteType: "base",
      sortOrder: 30,
      issue: issue2Id,
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
      grp_surfaces: { id: "grp_surfaces", type: "container", x: 56, y: 376, w: 804, h: 150, title: "Native Surfaces & VDP Gate", fill: "water" },
      n_mac: {
        id: "n_mac",
        type: "shape",
        shape: "card",
        parentId: "grp_surfaces",
        x: 80,
        y: 420,
        w: 230,
        h: 82,
        title: "Mac GPUI + nsh TSX",
        body: "Papertrails tokens & 6-nav workbench",
        fill: "water",
      },
      n_mobile: {
        id: "n_mobile",
        type: "shape",
        shape: "card",
        parentId: "grp_surfaces",
        x: 334,
        y: 420,
        w: 230,
        h: 82,
        title: "Mobile nsh Client",
        body: "Inbox / Chat / Sessions / Issues",
        fill: "leaf",
      },
      n_vdp: {
        id: "n_vdp",
        type: "shape",
        shape: "sticky",
        parentId: "grp_surfaces",
        x: 588,
        y: 420,
        w: 248,
        h: 82,
        title: "TS VDP Scenario Gate",
        body: "Single-WS Light/Dark visual regression",
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
    caption: "Editorial redesign walkthrough, Base multi-view switching & Light/Dark polish",
    durationSec: 128,
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
          { id: "c3", startSec: 46, endSec: 84, speaker: "Lin", text: "Base switches smoothly across Table, Kanban Board, Gallery cards, and Timeline bars." },
        ],
      },
      {
        id: "m2",
        kind: "audio",
        src: "asset/audio/design-critique.m4a",
        title: "Papertrails Visual Critique Snippet",
        durationSec: 44,
        transcript: [
          { id: "c4", startSec: 0, endSec: 21, speaker: "Ada", text: "外观设置字体菜单需要异步预加载，不能阻塞打开设置页的首帧渲染。" },
          { id: "c5", startSec: 21, endSec: 44, speaker: "Lin", text: "各模块空状态按首屏引导与无搜索结果分层，主动作按钮位置统一对齐。" },
        ],
      },
      {
        id: "m3",
        kind: "image",
        src: WALKTHROUGH_MOCKUP_PNG,
        title: "Workspace Editorial Review Frame",
        caption: "Non-destructive interactive pin overlay preserved in structure/media.json without mutating pixels",
        annotations: [
          {
            id: "media_ann_1",
            number: 1,
            rect: { x: 0.03, y: 0.14, w: 0.19, h: 0.25 },
            severity: "p0",
            title: "侧栏选中项对比度偏弱",
            body: "深色模式下建议提升 selected 表面亮度层级。",
            status: "open",
            issueId: issue2Id,
            author: "Ada",
          },
          {
            id: "media_ann_2",
            number: 2,
            rect: { x: 0.78, y: 0.02, w: 0.19, h: 0.1 },
            severity: "ux",
            title: "顶部主按钮视觉聚焦良好",
            status: "resolved",
            author: "Lin",
          },
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
      issue: issue2Id,
      content: JSON.stringify(mediaDoc, null, 2),
    },
    CreatedNoteSchema,
  );

  const mainDoc = {
    version: 1,
    blocks: [
      { id: "b1", type: "heading", level: 1, text: "VibeValley Note 3+1 编辑体验规范" },
      { id: "b_toc", type: "toc", maxLevel: 3 },
      {
        id: "b2",
        type: "prose",
        text: `这份架构笔记用于统一 **Block Doc**、**多维 Base** 与 **Canvas/Media** 原语设计；核心色彩与对比度规则见 [[note:${childPage.id}]]，整体需求追踪见 [[issue:${issue2Id}]]。`,
      },
      {
        id: "b_callout_warn",
        type: "callout",
        tone: "warn",
        title: "设计走查红线",
        text: "禁止嵌套「盒套盒」常驻描边；表格密集单元格禁止出现两套交互控件互相截断。",
      },
      { id: "b3", type: "heading", level: 2, text: "排版克制性与可读性原则" },
      {
        id: "b4",
        type: "quote",
        text: "Good interfaces step back until needed — breathing room and typographic hierarchy carry more meaning than border boxes.",
        attribution: "Papertrails Design Review",
      },
      { id: "b_todo1", type: "todo", checked: true, text: "收敛 Block Doc 常驻外框与统一 72ch 舒适阅读栏宽" },
      { id: "b_todo2", type: "todo", checked: false, text: "梳理所有空状态与设置页首帧阻塞（外观字体列表枚举）" },
      {
        id: "b5",
        type: "toggle",
        title: "为什么要合并页面树并隐藏常驻边框？",
        text: "双层侧栏挤压正文宽度；常驻高亮徽章、外框和工具栏会打断连续阅读体验。只在 hover 或激活当前块时按需浮现工具。",
      },
      {
        id: "b_cols",
        type: "columns",
        columns: [
          {
            blocks: [
              { id: "col_l1", type: "heading", level: 3, text: "Light Mode · 宣纸肌理" },
              { id: "col_l2", type: "prose", text: "`bg-page` 采用温润纸面底色，`bg-side` 微降亮度承担侧栏分区，减少冷硬纯白刺眼感。" },
            ],
          },
          {
            blocks: [
              { id: "col_r1", type: "heading", level: 3, text: "Dark Mode · 深林墨色" },
              { id: "col_r2", type: "prose", text: "严格维持 ≥7:1 主文对比度，卡片边线改用低饱和度 `border-line` 避免高对比亮框喧宾夺主。" },
            ],
          },
        ],
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
          ["Media", "音视频分段逐字稿 + 帧预览", "时间轴对齐与多语言检索"],
        ],
      },
      { id: "b8", type: "math", display: true, expression: "\\text{Latency}_{p99} \\le 16.6\\,\\text{ms}" },
      {
        id: "b_slide_2",
        type: "pageBreak",
        title: "实时性能指标与系统拓扑",
        speakerNotes: "重点展示从 StateFeed 到前端 6 路切片投影的 p99 帧耗时趋势与 Loro 协同路径。",
      },
      { id: "b9", type: "heading", level: 2, text: "实时指标、图表、内嵌多维库与关联工单" },
      {
        id: "b10",
        type: "kpi",
        items: [
          { label: "文档块类型", value: "24 Kinds", delta: "+6", tone: "ok" },
          { label: "P99 渲染帧率", value: "6.4 ms", delta: "-3.1 ms", tone: "ok" },
          { label: "Shell 报错", value: "0", tone: "info" },
        ],
      },
      {
        id: "b_chart",
        type: "chart",
        title: "各版本首帧渲染耗时 p99 (ms)",
        kind: "bar",
        labels: ["v0.6", "v0.7", "v0.8", "v0.9"],
        series: [
          { name: "Doc Render", data: [14.2, 10.8, 8.1, 6.4] },
          { name: "Base Switch", data: [19.5, 13.4, 9.2, 5.8] },
        ],
      },
      {
        id: "b_diagram",
        type: "diagram",
        title: "Note CRDT 到前端切片同步流",
        source: "flowchart LR\n  A[User / Agent Edit] --> B[Loro CRDT]\n  B --> C[StateFeed SliceMask]\n  C --> D[GPUI / nsh View]",
      },
      {
        id: "b_slide_3",
        type: "pageBreak",
        title: "内嵌多维交付库与双链上下文",
        speakerNotes: "演示 Doc 中直接嵌入 Base 视图和 Issue 实时状态卡片，以及底部的双向引用面板。",
      },
      { id: "b11", type: "baseEmbed", noteId: baseNote.id, sheetId: "sheet_deliverables", viewId: "v_table" },
      { id: "b12", type: "issueCard", issueId: issue2Id },
      {
        id: "b_bookmark",
        type: "bookmark",
        url: "https://vibevalley.dev/docs/note",
        title: "3+1 Note Architecture & Loro CRDT Design",
        description: "Directory-backed collaborative workspace combining Doc, Base, Canvas and Media.",
      },
    ],
  };

  const docNote = await v.rpc(
    "note.create",
    {
      title: "VibeValley Note 3+1 编辑体验规范",
      noteType: "doc",
      sortOrder: 10,
      issue: issue2Id,
      content: JSON.stringify(mainDoc, null, 2),
    },
    CreatedNoteSchema,
  );

  // Move child pages cleanly under main docNote so PageTree hierarchy is populated in the unified sidebar.
  await v.rpc("note.tree.move", { id: childPage.id, parentId: docNote.id, sortOrder: 10 });
  await v.rpc("note.tree.move", { id: childMotionPage.id, parentId: docNote.id, sortOrder: 20 });
  await v.rpc("note.tree.move", { id: childEmptyStatePage.id, parentId: docNote.id, sortOrder: 30 });

  // Keep docNote parented at root cleanly; reference siblingChecklist indirectly via Library & channel.
  void siblingChecklist;

  // Seed dedicated UI Review Walkthrough Base + Doc demonstrating Phase 1 (#144) MediaAnnotation overlay,
  // Phase 2 (#145) BaseEmbed <-> MediaAnnotation bidirectional checklist linkage, and enhanced Table Block editing.
  const reviewBaseDoc = {
    version: 1,
    sheets: [
      {
        id: "sheet_review",
        name: "UI 走查清单",
        columns: [
          { id: "c_title", name: "标题", kind: "text", width: 240 },
          {
            id: "c_severity",
            name: "严重度",
            kind: "select",
            width: 100,
            options: [
              { value: "p0", label: "P0 阻塞", color: "red" },
              { value: "p1", label: "P1 体验", color: "amber" },
              { value: "p2", label: "P2 润色", color: "blue" },
              { value: "ux", label: "UX 建议", color: "green" },
            ],
          },
          {
            id: "c_status",
            name: "状态",
            kind: "select",
            width: 96,
            options: [
              { value: "open", label: "待处理", color: "amber" },
              { value: "in_progress", label: "修复中", color: "blue" },
              { value: "resolved", label: "已解决", color: "green" },
            ],
          },
          { id: "c_module", name: "模块", kind: "text", width: 132 },
          { id: "c_issue", name: "关联工单", kind: "issueRef", width: 112 },
          {
            id: "c_agent",
            name: "Agent 转工单",
            kind: "agentAction",
            width: 140,
            agentConfig: { promptTemplate: "Create a scoped fix issue for UI finding {{c_title}}." },
          },
        ],
        rows: [
          {
            id: "rev_1",
            cells: {
              c_title: { _tag: "text", value: "侧栏导航选中态与分割线对比度偏弱" },
              c_severity: { _tag: "text", value: "p0" },
              c_status: { _tag: "text", value: "open" },
              c_module: { _tag: "text", value: "Note / 侧栏" },
              c_issue: { _tag: "issueRef", issueId: issue1Id },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "rev_2",
            cells: {
              c_title: { _tag: "text", value: "顶部主操作按钮与标题基线未完全对齐" },
              c_severity: { _tag: "text", value: "p1" },
              c_status: { _tag: "text", value: "in_progress" },
              c_module: { _tag: "text", value: "Note / 顶栏" },
              c_issue: { _tag: "issueRef", issueId: issue2Id },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "rev_3",
            cells: {
              c_title: { _tag: "text", value: "数据卡片下方留白与表格密度已收敛" },
              c_severity: { _tag: "text", value: "ux" },
              c_status: { _tag: "text", value: "resolved" },
              c_module: { _tag: "text", value: "Note / 卡片" },
            },
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        views: [
          { id: "v_review_table", name: "表格", kind: "table" },
          { id: "v_review_board", name: "看板", kind: "board", groupBy: "c_status" },
          { id: "v_review_gallery", name: "画廊", kind: "gallery" },
        ],
      },
    ],
  };

  const reviewBaseNote = await v.rpc(
    "note.create",
    {
      title: "Papertrails UI 走查清单 Base",
      noteType: "base",
      sortOrder: 35,
      issue: issue2Id,
      content: JSON.stringify(reviewBaseDoc, null, 2),
    },
    CreatedNoteSchema,
  );

  const reviewWalkthroughDoc = {
    version: 1,
    blocks: [
      { id: "rev_h1", type: "heading", level: 1, text: "UI 走查与非破坏性图片标注评审" },
      {
        id: "rev_media",
        type: "media",
        mediaKind: "image",
        src: WALKTHROUGH_MOCKUP_PNG,
        caption: "工作台截图 · 0..1 归一化坐标非破坏性标注层（与下方 Base 清单双向联动）",
        annotations: [
          {
            id: "ann_1",
            number: 1,
            rect: { x: 0.025, y: 0.14, w: 0.19, h: 0.28 },
            severity: "p0",
            title: "侧栏选中态对比度偏弱",
            body: "建议将选中态底色切到语义 selected 令牌并柔化右侧分割线。",
            status: "open",
            issueId: issue1Id,
            baseRowId: "rev_1",
            author: "Ada",
          },
          {
            id: "ann_2",
            number: 2,
            rect: { x: 0.78, y: 0.02, w: 0.19, h: 0.1 },
            severity: "p1",
            title: "主操作按钮与标题基线对齐",
            body: "统一使用 h-7 compact 尺寸并与标题行垂直居中。",
            status: "open",
            issueId: issue2Id,
            baseRowId: "rev_2",
            author: "Lin",
          },
          {
            id: "ann_3",
            number: 3,
            rect: { x: 0.27, y: 0.54, w: 0.69, h: 0.38 },
            severity: "ux",
            title: "表格密度与行高已达标",
            body: "已验证 Light / Dark 双主题下零截断。",
            status: "resolved",
            baseRowId: "rev_3",
            author: "Milo",
          },
        ],
      },
      { id: "rev_base", type: "baseEmbed", noteId: reviewBaseNote.id, sheetId: "sheet_review", viewId: "v_review_table" },
      {
        id: "rev_table",
        type: "table",
        headers: ["走查维度", "目标标准", "当前结果"],
        alignments: ["left", "center", "right"],
        rows: [
          ["归一化标注对齐", "1x / 2x Retina 零漂移", "已通过"],
          ["Base 双向联动", "点击圆标 ↔ 高亮清单行", "已通过"],
          ["轻量表格键盘流转", "Tab / Shift+Tab / Enter", "已通过"],
        ],
      },
    ],
  };

  const reviewDocNote = await v.rpc(
    "note.create",
    {
      title: "UI 走查与非破坏性图片标注评审",
      noteType: "doc",
      sortOrder: 15,
      issue: issue2Id,
      content: JSON.stringify(reviewWalkthroughDoc, null, 2),
    },
    CreatedNoteSchema,
  );

  // Create one open inline suggestion so the Doc review suggestion banner renders authentically.
  const suggestedDoc = {
    ...mainDoc,
    blocks: [
      ...mainDoc.blocks.slice(0, 3),
      {
        id: "b_callout_suggest",
        type: "callout",
        tone: "info",
        title: "评审建议新增",
        text: "建议在排版规范中补齐移动端与窄屏（<768px）字体阶梯回退标准。",
      },
      ...mainDoc.blocks.slice(3),
    ],
  };
  await v.rpc("note.suggestion.create", {
    id: docNote.id,
    path: "structure/doc.json",
    baseRev: docNote.seq,
    change: {
      content: JSON.stringify(suggestedDoc, null, 2),
      summary: "建议补充窄屏响应式字体阶梯说明",
    },
  });

  return {
    issueIds: core.issueIds,
    channelId: core.channelId,
    docId: docNote.id,
    reviewDocId: reviewDocNote.id,
    reviewBaseId: reviewBaseNote.id,
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
