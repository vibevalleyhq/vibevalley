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

  fillRect(0, 0, width, height, 250, 248, 244);
  fillRect(0, 0, 148, height, 239, 236, 230);
  fillRect(148, 0, 2, height, 214, 208, 198);
  fillRect(18, 24, 96, 12, 77, 122, 42);
  fillRect(18, 56, 110, 22, 226, 222, 213);
  fillRect(18, 88, 92, 12, 168, 162, 154);
  fillRect(18, 112, 102, 12, 168, 162, 154);
  fillRect(18, 136, 84, 12, 168, 162, 154);
  fillRect(150, 0, width - 150, 44, 246, 244, 239);
  fillRect(150, 44, width - 150, 1, 224, 220, 212);
  fillRect(172, 16, 160, 12, 42, 38, 34);
  fillRect(518, 11, 98, 22, 77, 122, 42);
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
  ihdr[8] = 8;
  ihdr[9] = 6;
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
  readonly hrChannelId: string;
  readonly adminChannelId: string;
  readonly docId: string;
  readonly onboardingDocId: string;
  readonly reviewDocId: string;
  readonly reviewBaseId: string;
  readonly baseId: string;
  readonly hrBaseId: string;
  readonly childPageId: string;
  readonly canvasId: string;
  readonly hrCanvasId: string;
  readonly mediaId: string;
}

const seededNotesByTransport = new WeakMap<VdpRpcTransport, Promise<NoteShowcaseIds>>();

async function performSeedNoteShowcase(v: VdpScenarioContext): Promise<NoteShowcaseIds> {
  const core = await seedWorkspaceCore(v);
  const nowMs = Date.now();
  const issue1Id = core.issueIds[0]!;
  const issue2Id = core.issueIds[1] ?? issue1Id;
  const issue3Id = core.issueIds[2] ?? issue1Id;
  const issue4Id = core.issueIds[3] ?? issue1Id;
  const issue5Id = core.issueIds[4] ?? issue1Id;
  const issue7Id = core.issueIds[6] ?? issue1Id;
  const issue10Id = core.issueIds[9] ?? issue1Id;
  const issue11Id = core.issueIds[10] ?? issue1Id;
  const issue12Id = core.issueIds[11] ?? issue11Id;
  const issue13Id = core.issueIds[12] ?? issue11Id;
  const issue14Id = core.issueIds[13] ?? issue11Id;
  const issue15Id = core.issueIds[14] ?? issue11Id;
  const issue16Id = core.issueIds[15] ?? issue1Id;
  const issue18Id = core.issueIds[17] ?? issue11Id;

  const childPage = await v.rpc(
    "note.create",
    {
      title: "OAuth2 令牌轮换与接口限流设计规范",
      noteType: "doc",
      sortOrder: 20,
      issue: issue2Id,
      content: JSON.stringify(
        {
          version: 1,
          blocks: [
            { id: "c1", type: "heading", level: 1, text: "OAuth2 令牌轮换与接口限流设计规范" },
            {
              id: "c2",
              type: "prose",
              text: "统一通过租户粒度 `KeyLock` 串行化 Refresh Token 旋转流程，并在下游 Redis 不可用时平滑切换本地令牌桶。",
            },
            {
              id: "c3",
              type: "callout",
              tone: "ok",
              title: "性能与一致性基线",
              text: "10 并发刷新同一租户仅触发 1 次上游换票请求；P99 响应稳定在 6.4ms 以内。",
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
      title: "12 月新员工首周入职与开发环境配置清单",
      noteType: "doc",
      sortOrder: 22,
      issue: issue11Id,
      content: JSON.stringify(
        {
          version: 1,
          blocks: [
            { id: "m1", type: "heading", level: 1, text: "12 月新员工首周入职与开发环境配置清单" },
            {
              id: "m2",
              type: "prose",
              text: "面向 12 月 2 日报到的 6 位研发与产品新同学：入职当日上午由行政交付办公电脑、门禁卡与工位铭牌，下午由导师引导完成仓库拉取与本地启动。",
            },
            { id: "m3", type: "todo", checked: true, text: "签收 MacBook Pro 并校验 SSH Ed25519 密钥与 VPN 证书" },
            { id: "m4", type: "todo", checked: false, text: "加入 GitHub 团队仓库并跑通 core-gateway 本地单测" },
            { id: "m5", type: "todo", checked: false, text: "周五前在人事系统确认直属导师一对一首周总结" },
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
      title: "月度差旅报销、考勤折算与设备申领制度",
      noteType: "doc",
      sortOrder: 24,
      issue: issue15Id,
      content: JSON.stringify(
        {
          version: 1,
          blocks: [
            { id: "e1", type: "heading", level: 1, text: "月度差旅报销、考勤折算与设备申领制度" },
            {
              id: "e2",
              type: "prose",
              text: "每月 25 日 18:00 为当月报销单据与异常考勤核对截止时间；跨自然月连续休假优先抵扣加班调休余额，剩余天数按年假顺序核减。",
            },
            {
              id: "e3",
              type: "table",
              headers: ["补贴类别", "一线城市上限", "审批要求"],
              alignments: ["left", "right", "left"],
              rows: [
                ["差旅住宿", "650 元/晚", "需附酒店水单与行程审批单"],
                ["外出餐补", "120 元/天", "随月度报销单统一核算"],
                ["外设增补", "按工位配额", "行政资产台账登记序列号"],
              ],
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
      title: "本周版本封板与行政采购周会纪要",
      noteType: "doc",
      sortOrder: 60,
      channel: core.channelId,
      content: JSON.stringify(
        {
          version: 1,
          blocks: [
            { id: "s1", type: "heading", level: 1, text: "本周版本封板与行政采购周会纪要" },
            {
              id: "s_kpi",
              type: "kpi",
              items: [
                { label: "研发交付率", value: "91.4%", delta: "+6.2%", tone: "ok" },
                { label: "秋招 Offer 发出", value: "9 / 9 份", delta: "已完成", tone: "ok" },
                { label: "11 月报销待复核", value: "42 笔", delta: "25 日截单", tone: "info" },
              ],
            },
            { id: "s2", type: "todo", checked: true, text: "网关连接池与 WebSocket 断点恢复合入主干" },
            { id: "s3", type: "todo", checked: true, text: "四楼研发工区 12 台 4K 显示器完成资产贴标验收" },
            { id: "s4", type: "todo", checked: false, text: "macOS Alpha 公证流程与 CSV UTF-8 BOM 导出下周合入" },
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
        name: "研发与人事协同台账",
        columns: [
          { id: "c_item", name: "交付事项", kind: "text", width: 250 },
          {
            id: "c_status",
            name: "阶段",
            kind: "select",
            width: 102,
            options: [
              { value: "todo", label: "待启动", color: "amber" },
              { value: "doing", label: "进行中", color: "blue" },
              { value: "review", label: "评审/核验", color: "purple" },
              { value: "done", label: "已交付", color: "green" },
            ],
          },
          {
            id: "c_tags",
            name: "所属条线",
            kind: "multiSelect",
            width: 155,
            options: [
              { value: "网关架构", label: "网关架构", color: "green" },
              { value: "企业控制台", label: "企业控制台", color: "blue" },
              { value: "招聘入职", label: "招聘入职", color: "amber" },
              { value: "薪酬行政", label: "薪酬行政", color: "purple" },
              { value: "发版运维", label: "发版运维", color: "red" },
            ],
          },
          { id: "c_window", name: "排期窗口", kind: "date", width: 175 },
          { id: "c_note", name: "制度/方案", kind: "noteRef", width: 175 },
          { id: "c_issue", name: "关联工单", kind: "issueRef", width: 165 },
          { id: "c_pts", name: "人天投入", kind: "number", width: 84 },
          { id: "c_score", name: "达成系数", kind: "formula", width: 108, formula: 'if({c_status} == "done", 100, {c_pts} * 10)' },
          { id: "c_verified", name: "已验收", kind: "checkbox", width: 72 },
          {
            id: "c_agent",
            name: "Agent 协同",
            kind: "agentAction",
            width: 150,
            agentConfig: { promptTemplate: "Review {{c_item}} delivery status and list blockers." },
          },
        ],
        rows: [
          {
            id: "r1",
            pageNoteId: childPage.id,
            cells: {
              c_item: { _tag: "text", value: "OAuth2 Refresh Token 防重放锁与降级限流" },
              c_status: { _tag: "text", value: "review" },
              c_tags: { _tag: "strings", items: ["网关架构"] },
              c_window: { _tag: "text", value: `${isoDayOffset(nowMs, -3)} -> ${isoDayOffset(nowMs, 1)}` },
              c_note: { _tag: "noteRef", noteId: childPage.id },
              c_issue: { _tag: "issueRef", issueId: issue2Id },
              c_pts: { _tag: "number", value: 6 },
              c_verified: { _tag: "bool", value: false },
              c_agent: {
                _tag: "agentRun",
                status: "done",
                summary: "10 并发压测零重放通过",
                updatedAt: nowMs - 2_400_000,
              },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "r2",
            pageNoteId: childMotionPage.id,
            cells: {
              c_item: { _tag: "text", value: "2026 秋招终面定级与 9 份正式 Offer 签发" },
              c_status: { _tag: "text", value: "done" },
              c_tags: { _tag: "strings", items: ["招聘入职"] },
              c_window: { _tag: "text", value: `${isoDayOffset(nowMs, -7)} -> ${isoDayOffset(nowMs, -2)}` },
              c_note: { _tag: "noteRef", noteId: childMotionPage.id },
              c_issue: { _tag: "issueRef", issueId: issue12Id },
              c_pts: { _tag: "number", value: 5 },
              c_verified: { _tag: "bool", value: true },
              c_agent: {
                _tag: "agentRun",
                status: "done",
                summary: "Offer 签发 100% 归档",
                updatedAt: nowMs - 3_600_000,
              },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "r3",
            cells: {
              c_item: { _tag: "text", value: "PostgreSQL 连接池空闲回收与指标导出" },
              c_status: { _tag: "text", value: "done" },
              c_tags: { _tag: "strings", items: ["网关架构", "发版运维"] },
              c_window: { _tag: "text", value: `${isoDayOffset(nowMs, -5)} -> ${isoDayOffset(nowMs, -2)}` },
              c_issue: { _tag: "issueRef", issueId: issue3Id },
              c_pts: { _tag: "number", value: 4 },
              c_verified: { _tag: "bool", value: true },
              c_agent: {
                _tag: "agentRun",
                status: "spawned",
                summary: "PR #412 已合入主干",
                spawnedIssueId: issue3Id,
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
              c_item: { _tag: "text", value: "12 月 6 名新人 MacBook Pro 与门禁开通" },
              c_status: { _tag: "text", value: "review" },
              c_tags: { _tag: "strings", items: ["招聘入职", "薪酬行政"] },
              c_window: { _tag: "text", value: `${isoDayOffset(nowMs, -1)} -> ${isoDayOffset(nowMs, 2)}` },
              c_note: { _tag: "noteRef", noteId: childMotionPage.id },
              c_issue: { _tag: "issueRef", issueId: issue13Id },
              c_pts: { _tag: "number", value: 3 },
              c_verified: { _tag: "bool", value: false },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "r5",
            pageNoteId: childEmptyStatePage.id,
            cells: {
              c_item: { _tag: "text", value: "11 月差旅报销单抽检与云厂商对账" },
              c_status: { _tag: "text", value: "review" },
              c_tags: { _tag: "strings", items: ["薪酬行政"] },
              c_window: { _tag: "text", value: `${isoDayOffset(nowMs, -2)} -> ${isoDayOffset(nowMs, 1)}` },
              c_note: { _tag: "noteRef", noteId: childEmptyStatePage.id },
              c_issue: { _tag: "issueRef", issueId: issue15Id },
              c_pts: { _tag: "number", value: 4 },
              c_verified: { _tag: "bool", value: false },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "r6",
            cells: {
              c_item: { _tag: "text", value: "晚高峰 Webhook 队列积压与死信锁排查" },
              c_status: { _tag: "text", value: "doing" },
              c_tags: { _tag: "strings", items: ["网关架构"] },
              c_window: { _tag: "text", value: `${isoDayOffset(nowMs, -4)} -> ${isoDayOffset(nowMs, 0)}` },
              c_issue: { _tag: "issueRef", issueId: issue4Id },
              c_pts: { _tag: "number", value: 5 },
              c_verified: { _tag: "bool", value: false },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "r7",
            cells: {
              c_item: { _tag: "text", value: "员工请假跨月自动折算年假与调休余额" },
              c_status: { _tag: "text", value: "review" },
              c_tags: { _tag: "strings", items: ["企业控制台", "薪酬行政"] },
              c_window: { _tag: "text", value: `${isoDayOffset(nowMs, -1)} -> ${isoDayOffset(nowMs, 3)}` },
              c_issue: { _tag: "issueRef", issueId: issue16Id },
              c_pts: { _tag: "number", value: 4 },
              c_verified: { _tag: "bool", value: false },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "r8",
            cells: {
              c_item: { _tag: "text", value: "macOS 客户端 Developer ID 自动公证流" },
              c_status: { _tag: "text", value: "doing" },
              c_tags: { _tag: "strings", items: ["发版运维"] },
              c_window: { _tag: "text", value: `${isoDayOffset(nowMs, -1)} -> ${isoDayOffset(nowMs, 3)}` },
              c_issue: { _tag: "issueRef", issueId: issue5Id },
              c_pts: { _tag: "number", value: 5 },
              c_verified: { _tag: "bool", value: false },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "r9",
            cells: {
              c_item: { _tag: "text", value: "控制台 429 退避提示与会话续期弹窗" },
              c_status: { _tag: "text", value: "doing" },
              c_tags: { _tag: "strings", items: ["企业控制台"] },
              c_window: { _tag: "text", value: `${isoDayOffset(nowMs, 1)} -> ${isoDayOffset(nowMs, 5)}` },
              c_issue: { _tag: "issueRef", issueId: issue10Id },
              c_pts: { _tag: "number", value: 3 },
              c_verified: { _tag: "bool", value: false },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "r10",
            cells: {
              c_item: { _tag: "text", value: "月度考勤 CSV UTF-8 BOM 导出适配" },
              c_status: { _tag: "text", value: "todo" },
              c_tags: { _tag: "strings", items: ["企业控制台", "薪酬行政"] },
              c_window: { _tag: "text", value: `${isoDayOffset(nowMs, 3)} -> ${isoDayOffset(nowMs, 8)}` },
              c_issue: { _tag: "issueRef", issueId: issue7Id },
              c_pts: { _tag: "number", value: 2 },
              c_verified: { _tag: "bool", value: false },
            },
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        views: [
          {
            id: "v_table",
            name: "台账表格",
            kind: "table",
            summaries: [
              { columnId: "c_pts", op: "sum" },
              { columnId: "c_pts", op: "avg" },
            ],
          },
          { id: "v_board", name: "阶段看板", kind: "board", groupBy: "c_status" },
          { id: "v_gallery", name: "交付画廊", kind: "gallery" },
          { id: "v_timeline", name: "排期甘特", kind: "timeline" },
        ],
      },
      {
        id: "sheet_bugs",
        name: "线上与行政待办速览",
        columns: [
          { id: "c_bug", name: "问题摘要", kind: "text", width: 260 },
          {
            id: "c_sev",
            name: "优先级",
            kind: "select",
            width: 100,
            options: [
              { value: "p0", label: "P0 紧急", color: "red" },
              { value: "p1", label: "P1 高优", color: "amber" },
              { value: "p2", label: "P2 常规", color: "blue" },
            ],
          },
          { id: "c_fixed", name: "已关闭", kind: "checkbox", width: 80 },
        ],
        rows: [
          {
            id: "b1",
            cells: {
              c_bug: { _tag: "text", value: "晚高峰 Webhook 死信重放竞争行锁" },
              c_sev: { _tag: "text", value: "p0" },
              c_fixed: { _tag: "bool", value: false },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "b2",
            cells: {
              c_bug: { _tag: "text", value: "跨自然月请假调休扣减顺序异常" },
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
      title: "Q4 研发交付与人事行政重点事项台账",
      noteType: "base",
      sortOrder: 30,
      issue: issue2Id,
      content: JSON.stringify(baseDoc, null, 2),
    },
    CreatedNoteSchema,
  );

  const hrBaseDoc = {
    version: 1,
    sheets: [
      {
        id: "sheet_recruiting",
        name: "2026 秋招候选人跟踪",
        columns: [
          { id: "c_name", name: "候选人", kind: "text", width: 120 },
          { id: "c_role", name: "应聘岗位", kind: "text", width: 170 },
          {
            id: "c_stage",
            name: "面试阶段",
            kind: "select",
            width: 112,
            options: [
              { value: "screen", label: "简历初筛", color: "amber" },
              { value: "tech1", label: "技术一面", color: "blue" },
              { value: "final", label: "架构终面", color: "purple" },
              { value: "offer", label: "已发 Offer", color: "green" },
            ],
          },
          { id: "c_interviewer", name: "主面试官", kind: "text", width: 130 },
          { id: "c_join_date", name: "拟入职日期", kind: "date", width: 128 },
          { id: "c_salary", name: "月薪基数(k)", kind: "number", width: 98 },
          { id: "c_kit_ready", name: "设备就绪", kind: "checkbox", width: 84 },
          { id: "c_issue", name: "关联统筹单", kind: "issueRef", width: 150 },
        ],
        rows: [
          {
            id: "hr_1",
            cells: {
              c_name: { _tag: "text", value: "林远" },
              c_role: { _tag: "text", value: "后端研发工程师（Rust）" },
              c_stage: { _tag: "text", value: "offer" },
              c_interviewer: { _tag: "text", value: "沈括 · 后端架构" },
              c_join_date: { _tag: "text", value: isoDayOffset(nowMs, 4) },
              c_salary: { _tag: "number", value: 34 },
              c_kit_ready: { _tag: "bool", value: true },
              c_issue: { _tag: "issueRef", issueId: issue11Id },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "hr_2",
            cells: {
              c_name: { _tag: "text", value: "陈思琪" },
              c_role: { _tag: "text", value: "资深前端工程师（TSX）" },
              c_stage: { _tag: "text", value: "offer" },
              c_interviewer: { _tag: "text", value: "林徽 · 前端研发" },
              c_join_date: { _tag: "text", value: isoDayOffset(nowMs, 4) },
              c_salary: { _tag: "number", value: 32 },
              c_kit_ready: { _tag: "bool", value: true },
              c_issue: { _tag: "issueRef", issueId: issue13Id },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "hr_3",
            cells: {
              c_name: { _tag: "text", value: "赵明轩" },
              c_role: { _tag: "text", value: "基础设施与发版 SRE" },
              c_stage: { _tag: "text", value: "offer" },
              c_interviewer: { _tag: "text", value: "周密 · 质量与发版" },
              c_join_date: { _tag: "text", value: isoDayOffset(nowMs, 11) },
              c_salary: { _tag: "number", value: 30 },
              c_kit_ready: { _tag: "bool", value: false },
              c_issue: { _tag: "issueRef", issueId: issue13Id },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "hr_4",
            cells: {
              c_name: { _tag: "text", value: "周雨桐" },
              c_role: { _tag: "text", value: "企业体验设计师" },
              c_stage: { _tag: "text", value: "final" },
              c_interviewer: { _tag: "text", value: "苏晴 · 招聘与入职" },
              c_join_date: { _tag: "text", value: isoDayOffset(nowMs, 14) },
              c_salary: { _tag: "number", value: 27 },
              c_kit_ready: { _tag: "bool", value: false },
              c_issue: { _tag: "issueRef", issueId: issue12Id },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "hr_5",
            cells: {
              c_name: { _tag: "text", value: "吴浩然" },
              c_role: { _tag: "text", value: "自动化测试开发工程师" },
              c_stage: { _tag: "text", value: "tech1" },
              c_interviewer: { _tag: "text", value: "周密 · 质量与发版" },
              c_join_date: { _tag: "text", value: isoDayOffset(nowMs, 18) },
              c_salary: { _tag: "number", value: 26 },
              c_kit_ready: { _tag: "bool", value: false },
              c_issue: { _tag: "issueRef", issueId: issue11Id },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "hr_6",
            cells: {
              c_name: { _tag: "text", value: "郑佳怡" },
              c_role: { _tag: "text", value: "招聘与员工关系专员" },
              c_stage: { _tag: "text", value: "offer" },
              c_interviewer: { _tag: "text", value: "苏晴 · 招聘与入职" },
              c_join_date: { _tag: "text", value: isoDayOffset(nowMs, 4) },
              c_salary: { _tag: "number", value: 18 },
              c_kit_ready: { _tag: "bool", value: true },
              c_issue: { _tag: "issueRef", issueId: issue14Id },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "hr_7",
            cells: {
              c_name: { _tag: "text", value: "许嘉伟" },
              c_role: { _tag: "text", value: "macOS 客户端工程师" },
              c_stage: { _tag: "text", value: "final" },
              c_interviewer: { _tag: "text", value: "沈括 · 后端架构" },
              c_join_date: { _tag: "text", value: isoDayOffset(nowMs, 16) },
              c_salary: { _tag: "number", value: 35 },
              c_kit_ready: { _tag: "bool", value: false },
              c_issue: { _tag: "issueRef", issueId: issue5Id },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "hr_8",
            cells: {
              c_name: { _tag: "text", value: "宋知夏" },
              c_role: { _tag: "text", value: "财务与行政运营专员" },
              c_stage: { _tag: "text", value: "screen" },
              c_interviewer: { _tag: "text", value: "顾言 · 行政与薪酬" },
              c_join_date: { _tag: "text", value: isoDayOffset(nowMs, 21) },
              c_salary: { _tag: "number", value: 17 },
              c_kit_ready: { _tag: "bool", value: false },
              c_issue: { _tag: "issueRef", issueId: issue15Id },
            },
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        views: [
          {
            id: "v_hr_table",
            name: "候选人名册",
            kind: "table",
            summaries: [{ columnId: "c_salary", op: "avg" }],
          },
          { id: "v_hr_board", name: "招聘漏斗", kind: "board", groupBy: "c_stage" },
        ],
      },
    ],
  };

  const hrBaseNote = await v.rpc(
    "note.create",
    {
      title: "2026 秋招候选人面试与 Offer 审批库",
      noteType: "base",
      sortOrder: 32,
      issue: issue11Id,
      content: JSON.stringify(hrBaseDoc, null, 2),
    },
    CreatedNoteSchema,
  );

  const whiteboardDoc = {
    version: 1,
    grid: "architectural",
    theme: "warm",
    viewport: { x: 0, y: 0, zoom: 1 },
    elements: {
      t_title: { id: "t_title", type: "text", variant: "title", x: 48, y: 20, w: 820, h: 44, label: "core-gateway 高并发鉴权与多租户限流架构" },
      grp_edge: { id: "grp_edge", type: "container", x: 48, y: 84, w: 492, h: 264, title: "接入与鉴权层 (Rust / Axum)", fill: "water" },
      n_client: {
        id: "n_client",
        type: "shape",
        shape: "pill",
        parentId: "grp_edge",
        x: 68,
        y: 144,
        w: 162,
        h: 64,
        title: "Web / 桌面端",
        body: "Bearer + PKCE",
        fill: "side",
      },
      n_lock: {
        id: "n_lock",
        type: "shape",
        shape: "card",
        parentId: "grp_edge",
        x: 316,
        y: 132,
        w: 200,
        h: 88,
        badge: "6.4ms",
        title: "OAuth2 KeyLock",
        body: "同租户并发换票归并",
        fill: "water",
      },
      n_check: {
        id: "n_check",
        type: "shape",
        shape: "diamond",
        parentId: "grp_edge",
        x: 350,
        y: 248,
        w: 132,
        h: 76,
        title: "Redis 在线?",
        fill: "sun",
      },
      grp_data: { id: "grp_data", type: "container", x: 624, y: 84, w: 444, h: 264, title: "配额存储与降级兜底", fill: "leaf" },
      n_redis: {
        id: "n_redis",
        type: "shape",
        shape: "cylinder",
        parentId: "grp_data",
        x: 648,
        y: 132,
        w: 156,
        h: 88,
        title: "Redis 滑动窗",
        body: "租户级 QPS 计数",
        fill: "peach",
      },
      n_fallback: {
        id: "n_fallback",
        type: "shape",
        shape: "sticky",
        parentId: "grp_data",
        x: 892,
        y: 132,
        w: 152,
        h: 88,
        title: "本地令牌桶",
        body: "断连 <1.5ms 兜底",
        fill: "sun",
      },
      n_pg: {
        id: "n_pg",
        type: "shape",
        shape: "cylinder",
        parentId: "grp_data",
        x: 648,
        y: 248,
        w: 396,
        h: 80,
        badge: "1.8ms",
        title: "PostgreSQL 主从池 + Outbox",
        body: "空闲回收与死信分片游标投递",
        fill: "leaf",
      },
      grp_ops: { id: "grp_ops", type: "container", x: 48, y: 376, w: 1020, h: 148, title: "可观测告警与控制台联动", fill: "lavender" },
      n_prom: {
        id: "n_prom",
        type: "shape",
        shape: "card",
        parentId: "grp_ops",
        x: 76,
        y: 420,
        w: 296,
        h: 82,
        title: "Prometheus 慢查询指标",
        body: "pg_pool_idle_reaped_total",
        fill: "lavender",
      },
      n_web429: {
        id: "n_web429",
        type: "shape",
        shape: "card",
        parentId: "grp_ops",
        x: 410,
        y: 420,
        w: 296,
        h: 82,
        title: "控制台 429 退避横幅",
        body: "自动解析 Retry-After 续期",
        fill: "water",
      },
      n_oncall: {
        id: "n_oncall",
        type: "shape",
        shape: "sticky",
        parentId: "grp_ops",
        x: 744,
        y: 420,
        w: 296,
        h: 82,
        title: "周五预发容灾演练",
        body: "验证 30s 主从自动切换 RTO",
        fill: "peach",
      },
      e_1: {
        id: "e_1",
        type: "arrow",
        from: { id: "n_client", side: "e" },
        to: { id: "n_lock", side: "w" },
        curve: "smooth",
        endHead: "arrow",
        label: "Refresh",
      },
      e_2: { id: "e_2", type: "arrow", from: { id: "n_lock", side: "s" }, to: { id: "n_check", side: "n" }, curve: "smooth", endHead: "arrow" },
      e_3: { id: "e_3", type: "arrow", from: { id: "n_check", side: "e" }, to: { id: "n_redis", side: "w" }, curve: "smooth", endHead: "arrow", label: "正常" },
      e_4: {
        id: "e_4",
        type: "arrow",
        from: { id: "n_redis", side: "e" },
        to: { id: "n_fallback", side: "w" },
        curve: "smooth",
        style: "dashed",
        endHead: "arrow",
        label: "超时降级",
      },
      e_5: { id: "e_5", type: "arrow", from: { id: "n_lock", side: "e" }, to: { id: "n_pg", side: "w" }, curve: "smooth", endHead: "arrow", label: "审计落库" },
    },
  };

  const canvasNote = await v.rpc(
    "note.create",
    {
      title: "网关高并发鉴权与主从容灾架构白板",
      noteType: "canvas",
      sortOrder: 40,
      content: JSON.stringify(whiteboardDoc, null, 2),
    },
    CreatedNoteSchema,
  );

  const hrWhiteboardDoc = {
    version: 1,
    grid: "architectural",
    theme: "warm",
    viewport: { x: 0, y: 0, zoom: 1 },
    elements: {
      t_hr: { id: "t_hr", type: "text", variant: "title", x: 48, y: 20, w: 780, h: 44, label: "2026 Q4 秋招 Offer 审批与 12/02 新人入职协同流转图" },
      lane_rec: { id: "lane_rec", type: "container", x: 48, y: 84, w: 272, h: 300, title: "HR 招聘定级 (苏晴)", fill: "water" },
      hr_step1: {
        id: "hr_step1",
        type: "shape",
        shape: "card",
        parentId: "lane_rec",
        x: 68,
        y: 132,
        w: 232,
        h: 92,
        badge: "14 人终面",
        title: "面试评议与定级",
        body: "研发 / 前端 / SRE 薪酬包审批完成",
        fill: "water",
      },
      hr_step2: {
        id: "hr_step2",
        type: "shape",
        shape: "sticky",
        parentId: "lane_rec",
        x: 68,
        y: 256,
        w: 232,
        h: 92,
        title: "9 份 Offer 电子签",
        body: "确认 12/02 与 12/16 两批报到时间",
        fill: "sun",
      },
      lane_admin: { id: "lane_admin", type: "container", x: 352, y: 84, w: 272, h: 300, title: "行政 IT 资产 (顾言)", fill: "peach" },
      ad_step1: {
        id: "ad_step1",
        type: "shape",
        shape: "card",
        parentId: "lane_admin",
        x: 372,
        y: 132,
        w: 232,
        h: 92,
        badge: "6/6 就绪",
        title: "MacBook Pro 备货",
        body: "资产贴码、工位 E12-E17 电源调通",
        fill: "peach",
      },
      ad_step2: {
        id: "ad_step2",
        type: "shape",
        shape: "card",
        parentId: "lane_admin",
        x: 372,
        y: 256,
        w: 232,
        h: 92,
        title: "门禁卡与邮箱预开",
        body: "归档保密协议与考勤考评账号",
        fill: "sun",
      },
      lane_rd: { id: "lane_rd", type: "container", x: 656, y: 84, w: 264, h: 300, title: "研发导师带教 (沈括/林徽)", fill: "leaf" },
      rd_step1: {
        id: "rd_step1",
        type: "shape",
        shape: "card",
        parentId: "lane_rd",
        x: 676,
        y: 132,
        w: 224,
        h: 92,
        title: "GitHub + VPN 下发",
        body: "开通 core-gateway 与测试库权限",
        fill: "leaf",
      },
      rd_step2: {
        id: "rd_step2",
        type: "shape",
        shape: "pill",
        parentId: "lane_rd",
        x: 676,
        y: 266,
        w: 224,
        h: 68,
        title: "首日破冰与 Buddy 面谈",
        body: "第 1 周跑通本地全量单测",
        fill: "leaf",
      },
      hr_summary_table: {
        id: "hr_summary_table",
        type: "table",
        x: 48,
        y: 410,
        w: 872,
        h: 112,
        headers: ["入职批次", "报到人数", "MacBook 贴码", "导师配对"],
        rows: [
          ["12/02 首批", "6 人", "6 / 6 就绪", "100% 确认"],
          ["12/16 次批", "3 人", "采购流转中", "待分配"],
        ],
        fill: "side",
      },
      he_1: { id: "he_1", type: "arrow", from: { id: "hr_step1", side: "s" }, to: { id: "hr_step2", side: "n" }, curve: "smooth", endHead: "arrow" },
      he_2: {
        id: "he_2",
        type: "arrow",
        from: { id: "hr_step2", side: "e" },
        to: { id: "ad_step1", side: "w" },
        curve: "smooth",
        endHead: "arrow",
        label: "Offer 回执",
      },
      he_3: { id: "he_3", type: "arrow", from: { id: "ad_step1", side: "s" }, to: { id: "ad_step2", side: "n" }, curve: "smooth", endHead: "arrow" },
      he_4: {
        id: "he_4",
        type: "arrow",
        from: { id: "ad_step2", side: "e" },
        to: { id: "rd_step1", side: "w" },
        curve: "smooth",
        endHead: "arrow",
        label: "工号就绪",
      },
      he_5: { id: "he_5", type: "arrow", from: { id: "rd_step1", side: "s" }, to: { id: "rd_step2", side: "n" }, curve: "smooth", endHead: "arrow" },
    },
  };

  const hrCanvasNote = await v.rpc(
    "note.create",
    {
      title: "2026 秋招审批与 12 月新员工入职全流程白板",
      noteType: "canvas",
      sortOrder: 42,
      content: JSON.stringify(hrWhiteboardDoc, null, 2),
    },
    CreatedNoteSchema,
  );

  const mediaDoc = {
    version: 1,
    title: "跨部门周会实录：网关压测复盘与 12 月入职排期",
    mediaKind: "video",
    caption: "后端网关压测数据复盘、控制台请假流改版与 12 月集中入职行政筹备",
    durationSec: 142,
    posterAsset: null,
    items: [
      {
        id: "m1",
        kind: "video",
        src: "asset/video/weekly-sync.mp4",
        title: "Q4 第八周研发与人事联合例会",
        durationSec: 94,
        transcript: [
          {
            id: "c1",
            startSec: 0,
            endSec: 24,
            speaker: "沈括 · 后端架构",
            text: "网关在 1,500 QPS 压测下 P99 稳定到 6.4ms，Refresh Token 并发防重放锁已进入评审。",
          },
          {
            id: "c2",
            startSec: 24,
            endSec: 58,
            speaker: "苏晴 · 招聘与入职",
            text: "秋招 9 份正式 Offer 已全部签发，下周一报到的 6 位同学将统一安排研发 Buddy 带教。",
          },
          {
            id: "c3",
            startSec: 58,
            endSec: 94,
            speaker: "顾言 · 行政与薪酬",
            text: "6 台 MacBook Pro 已贴码入库，11 月差旅报销单据请提醒部门同事在 25 日 18:00 前提交。",
          },
        ],
      },
      {
        id: "m2",
        kind: "audio",
        src: "asset/audio/console-review.m4a",
        title: "控制台审批体验走查语音片段",
        durationSec: 48,
        transcript: [
          { id: "c4", startSec: 0, endSec: 22, speaker: "林徽 · 前端研发", text: "跨自然月请假现在按先扣调休后扣年假顺序实时计算，不会再丢失草稿。" },
          { id: "c5", startSec: 22, endSec: 48, speaker: "周密 · 质量与发版", text: "周五下午预发环境会再跑一轮主从切换演练，确认只读降级横幅提示准确。" },
        ],
      },
      {
        id: "m3",
        kind: "image",
        src: WALKTHROUGH_MOCKUP_PNG,
        title: "控制台审批台走查采样截图",
        caption: "归一化坐标批注层（与控制台整改清单实时双向关联）",
        annotations: [
          {
            id: "media_ann_1",
            number: 1,
            rect: { x: 0.03, y: 0.14, w: 0.19, h: 0.25 },
            severity: "p0",
            title: "侧栏部门切换高亮态偏弱",
            body: "深色模式下建议增强选中导航条与分割线层次。",
            status: "open",
            issueId: issue2Id,
            author: "林徽",
          },
          {
            id: "media_ann_2",
            number: 2,
            rect: { x: 0.78, y: 0.02, w: 0.19, h: 0.1 },
            severity: "ux",
            title: "顶部主操作按钮尺寸协调",
            status: "resolved",
            author: "苏晴",
          },
        ],
      },
    ],
  };

  const mediaNote = await v.rpc(
    "note.create",
    {
      title: "跨部门周会实录：网关压测与入职排期",
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
      { id: "b1", type: "heading", level: 1, text: "研发与人事协同总纲：网关高可用改造与 Q4 入职规范" },
      { id: "b_toc", type: "toc", maxLevel: 3 },
      {
        id: "b2",
        type: "prose",
        text: `本文汇总 **core-gateway** 双周高可用改造与 **12 月首批新员工集中入职** 的跨团队排期；核心鉴权方案见 [[note:${childPage.id}]]，重点研发追踪见 [[issue:${issue2Id}]]，入职协同单见 [[issue:${issue11Id}]]。`,
      },
      {
        id: "b_callout_warn",
        type: "callout",
        tone: "warn",
        title: "本周封板与财务截单提醒",
        text: "请研发同事在周四 20:00 前合并网关防重放 PR；全员 11 月差旅报销与异常考勤单据于 25 日 18:00 截单。",
      },
      { id: "b3", type: "heading", level: 2, text: "工程指标基线与人事服务 SLA" },
      {
        id: "b4",
        type: "quote",
        text: "让系统可观测、让流程少卡点——研发网关稳在毫秒级，新人第一天下午就能把代码跑起来。",
        attribution: "Q4 工程效率与 People Ops 联合复盘",
      },
      { id: "b_todo1", type: "todo", checked: true, text: "完成 14 位秋招终面评议与 9 份正式 Offer 签发归档" },
      { id: "b_todo2", type: "todo", checked: false, text: "周五前联调 429 退避横幅并验收首批 6 位新人笔记本序列号" },
      {
        id: "b5",
        type: "toggle",
        title: "为什么把研发交付台账与入职筹备放在同一套多维 Base 协同？",
        text: "新员工账号开通、门禁与开发机镜像直接依赖架构组、前端组与行政 IT 并行验收；单套台账与关联工单能直观暴露跨部门阻塞点。",
      },
      {
        id: "b_cols",
        type: "columns",
        columns: [
          {
            blocks: [
              { id: "col_l1", type: "heading", level: 3, text: "研发侧 · 网关与控制台" },
              { id: "col_l2", type: "prose", text: "聚焦 `OAuth2 PKCE` 并发锁、PG 连接池 1.8ms 回收及跨月请假年假精确折算。" },
            ],
          },
          {
            blocks: [
              { id: "col_r1", type: "heading", level: 3, text: "人事行政 · 招聘与后勤" },
              { id: "col_r2", type: "prose", text: "保障 12/02 首批新人电脑门禁就绪、导师一对一带教与 360 绩效环评窗口发布。" },
            ],
          },
        ],
      },
      {
        id: "b6",
        type: "code",
        language: "rust",
        code: "pub async fn rotate_refresh_token(lock: &KeyLock<TenantId>, token: &str) -> Result<TokenPair, AuthError> {\n    let _guard = lock.acquire().await;\n    oauth_upstream::exchange_once(token).await\n}",
      },
      {
        id: "b7",
        type: "table",
        headers: ["协同条线", "核心负责模块", "当前关键里程碑"],
        alignments: ["left", "left", "left"],
        rows: [
          ["后端架构 (沈括)", "core-gateway / PostgreSQL", "Refresh Token 防重放锁评审中"],
          ["前端与控制台 (林徽)", "console-web 审批台与 CSV", "跨月请假年假折算进 Reviewing"],
          ["招聘与人事 (苏晴)", "秋招 Offer / 360 环评", "9 份 Offer 签发 + 导师名单确认"],
          ["行政与财务 (顾言)", "M4 Pro 备货 / 11 月报销", "42 笔差旅发票抽检 & 资产入库"],
        ],
      },
      { id: "b8", type: "math", display: true, expression: "\\text{Gateway}_{p99} = 6.4\\,\\text{ms} \\le 12.0\\,\\text{ms}" },
      {
        id: "b_slide_2",
        type: "pageBreak",
        title: "Q4 效率指标与招聘交付趋势",
        speakerNotes: "汇总网关 P99 耗时下降曲线、连接池回收效率以及本月入职与报销处理进度。",
      },
      { id: "b9", type: "heading", level: 2, text: "实时效能指标、图表、内嵌协同台账与关联工单" },
      {
        id: "b10",
        type: "kpi",
        items: [
          { label: "网关稳态 P99", value: "6.4 ms", delta: "-3.1 ms", tone: "ok" },
          { label: "秋招 Offer 签发", value: "9 份", delta: "100% 达成", tone: "ok" },
          { label: "待办差旅复核", value: "42 笔", delta: "25 日截止", tone: "info" },
        ],
      },
      {
        id: "b_chart",
        type: "chart",
        title: "各迭代核心接口响应耗时 p99 (ms)",
        kind: "bar",
        labels: ["W1", "W2", "W3", "W4"],
        series: [
          { name: "OAuth2 Rotate", data: [14.2, 10.8, 8.1, 6.4] },
          { name: "Approval Query", data: [19.5, 13.4, 9.2, 5.8] },
        ],
      },
      {
        id: "b_diagram",
        type: "diagram",
        title: "新员工入职 IT 与人事协同流水线",
        source: "flowchart LR\n  A[Offer Signed] --> B[Admin Laptop + Badge]\n  B --> C[Mentor + Repo Access]\n  C --> D[Week-1 Checkin]",
      },
      {
        id: "b_slide_3",
        type: "pageBreak",
        title: "Q4 研发与人事协同总表与工单上下文",
        speakerNotes: "直接从总表点击打开工单详情或对应流程文档。",
      },
      { id: "b11", type: "baseEmbed", noteId: baseNote.id, sheetId: "sheet_deliverables", viewId: "v_table" },
      { id: "b12", type: "issueCard", issueId: issue2Id },
      {
        id: "b_bookmark",
        type: "bookmark",
        url: "https://intranet.company.local/q4-handbook",
        title: "公司 Q4 研发工程规范与人事行政服务台总览",
        description: "统一查阅网关 SLA、校招面试评分表、入职首周指南及差旅报销标准。",
      },
    ],
  };

  const docNote = await v.rpc(
    "note.create",
    {
      title: "研发与人事协同总纲：网关高可用与 Q4 入职",
      noteType: "doc",
      sortOrder: 10,
      issue: issue2Id,
      content: JSON.stringify(mainDoc, null, 2),
    },
    CreatedNoteSchema,
  );

  await v.rpc("note.tree.move", { id: childPage.id, parentId: docNote.id, sortOrder: 10 });
  await v.rpc("note.tree.move", { id: childMotionPage.id, parentId: docNote.id, sortOrder: 20 });
  await v.rpc("note.tree.move", { id: childEmptyStatePage.id, parentId: docNote.id, sortOrder: 30 });

  const perfDoc = await v.rpc(
    "note.create",
    {
      title: "2026 年度 360 绩效互评与晋升答辩指引",
      noteType: "doc",
      sortOrder: 55,
      issue: issue18Id,
      content: JSON.stringify(
        {
          version: 1,
          blocks: [
            { id: "pf_h1", type: "heading", level: 1, text: "2026 年度 360 绩效互评与晋升答辩指引" },
            {
              id: "pf_p1",
              type: "prose",
              text: "请各位研发与职能同事在 12 月 5 日前完成 3–5 位协作方互评提名；申请 P7/T4 及以上晋升的同事同步提交年度代表项目复盘。",
            },
            { id: "pf_t1", type: "todo", checked: true, text: "12 月 5 日：开启互评提名与自评草稿提交" },
            { id: "pf_t2", type: "todo", checked: false, text: "12 月 18 日：直属主管绩效一对一面谈" },
          ],
        },
        null,
        2,
      ),
    },
    CreatedNoteSchema,
  );

  void siblingChecklist;
  void perfDoc;

  const reviewBaseDoc = {
    version: 1,
    sheets: [
      {
        id: "sheet_review",
        name: "控制台 UI 走查清单",
        columns: [
          { id: "c_title", name: "走查项", kind: "text", width: 240 },
          {
            id: "c_severity",
            name: "优先级",
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
              c_title: { _tag: "text", value: "左侧部门导航选中态对比度偏弱" },
              c_severity: { _tag: "text", value: "p0" },
              c_status: { _tag: "text", value: "open" },
              c_module: { _tag: "text", value: "控制台 / 侧栏" },
              c_issue: { _tag: "issueRef", issueId: issue1Id },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "rev_2",
            cells: {
              c_title: { _tag: "text", value: "审批提交主按钮与标题基线未居中" },
              c_severity: { _tag: "text", value: "p1" },
              c_status: { _tag: "text", value: "in_progress" },
              c_module: { _tag: "text", value: "控制台 / 顶栏" },
              c_issue: { _tag: "issueRef", issueId: issue2Id },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "rev_3",
            cells: {
              c_title: { _tag: "text", value: "考勤汇总表格行高与折算显示已达标" },
              c_severity: { _tag: "text", value: "ux" },
              c_status: { _tag: "text", value: "resolved" },
              c_module: { _tag: "text", value: "人事 / 表格" },
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
      title: "控制台审批台走查清单 Base",
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
      { id: "rev_h1", type: "heading", level: 1, text: "控制台审批台走查与非破坏性视觉标注评审" },
      {
        id: "rev_media",
        type: "media",
        mediaKind: "image",
        src: WALKTHROUGH_MOCKUP_PNG,
        caption: "审批台走查截图 · 0..1 归一化坐标非破坏性标注层（与下方清单双向联动）",
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
            author: "林徽",
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
            author: "苏晴",
          },
          {
            id: "ann_3",
            number: 3,
            rect: { x: 0.27, y: 0.54, w: 0.69, h: 0.38 },
            severity: "ux",
            title: "考勤与报销表格密度已达标",
            body: "已验证 Light / Dark 双主题下零截断。",
            status: "resolved",
            baseRowId: "rev_3",
            author: "顾言",
          },
        ],
      },
      { id: "rev_base", type: "baseEmbed", noteId: reviewBaseNote.id, sheetId: "sheet_review", viewId: "v_review_table" },
      {
        id: "rev_table",
        type: "table",
        headers: ["走查维度", "验收标准", "当前结论"],
        alignments: ["left", "center", "right"],
        rows: [
          ["归一化标注对齐", "1x / 2x Retina 零漂移", "已通过"],
          ["Base 双向联动", "点击圆标 ↔ 高亮清单行", "已通过"],
          ["表格键盘流转", "Tab / Shift+Tab / Enter", "已通过"],
        ],
      },
    ],
  };

  const reviewDocNote = await v.rpc(
    "note.create",
    {
      title: "控制台审批台视觉标注评审",
      noteType: "doc",
      sortOrder: 15,
      issue: issue2Id,
      content: JSON.stringify(reviewWalkthroughDoc, null, 2),
    },
    CreatedNoteSchema,
  );

  const suggestedDoc = {
    ...mainDoc,
    blocks: [
      ...mainDoc.blocks.slice(0, 3),
      {
        id: "b_callout_suggest",
        type: "callout",
        tone: "info",
        title: "人事实操补充建议",
        text: "建议在 12 月 2 日新人报到指引中追加社保公积金转移办理时间窗口与补充医保说明。",
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
      summary: "补充新人社保公积金转移时间与补充医保说明",
    },
  });

  return {
    issueIds: core.issueIds,
    channelId: core.channelId,
    hrChannelId: core.hrChannelId,
    adminChannelId: core.adminChannelId,
    docId: docNote.id,
    onboardingDocId: childMotionPage.id,
    reviewDocId: reviewDocNote.id,
    reviewBaseId: reviewBaseNote.id,
    baseId: baseNote.id,
    hrBaseId: hrBaseNote.id,
    childPageId: childPage.id,
    canvasId: canvasNote.id,
    hrCanvasId: hrCanvasNote.id,
    mediaId: mediaNote.id,
  };
}

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
