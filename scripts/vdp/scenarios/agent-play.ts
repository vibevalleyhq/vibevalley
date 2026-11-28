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
  description: "Multi-agent live Doc co-editing and progressive Whiteboard drawing with avatars, zero-shift checks, and MP4 recording",
  async run(v) {
    await seedNoteShowcase(v);
    const primaryTheme = v.defaultThemes[0] ?? "light";
    await v.resize(v.viewport.width, v.viewport.height);
    await v.theme(primaryTheme);

    const docInitial = {
      version: 1,
      blocks: [
        { id: "ag_h1", type: "heading", level: 1, text: "网关限流上线与 12 月新人入职协同台账" },
        {
          id: "ag_kpi",
          type: "kpi",
          items: [
            { label: "网关稳态 P99", value: "6.4 ms", delta: "-3.1 ms", tone: "ok" },
            { label: "首批入职备货", value: "6 / 6 台", delta: "已贴资产码", tone: "ok" },
            { label: "待会签事项", value: "2 项", delta: "今日联调", tone: "info" },
          ],
        },
        { id: "ag_p1", type: "prose", text: "Gateway P99 latency 6.4ms" },
        { id: "ag_todo", type: "todo", checked: false, text: "核验 12 月 6 位新同学仓库访问组与 MFA 初始凭证" },
        { id: "ag_todo_hr", type: "todo", checked: false, text: "确认首批入职导师结对名单并同步破冰日程" },
        {
          id: "ag_table",
          type: "table",
          headers: ["协同模块", "负责同事", "当前进展"],
          alignments: ["left", "left", "center"],
          rows: [
            ["OAuth2 KeyLock 防重放", "沈括 · 后端架构", "压测完成"],
            ["新人电脑与工位门禁", "顾言 · 行政与薪酬", "已贴码"],
            ["导师带教与破冰安排", "苏晴 · 招聘与入职", "待确认"],
          ],
        },
      ],
    };

    const docNote = await v.rpc(
      "note.create",
      {
        title: "网关限流与新人入职双人实时协同文档",
        noteType: "doc",
        sortOrder: 8,
        content: JSON.stringify(docInitial, null, 2),
      },
      CreatedNoteSchema,
    );

    const canvasBaseElements = {
      ag_title: {
        id: "ag_title",
        type: "text",
        variant: "title",
        x: 48,
        y: 22,
        w: 820,
        h: 44,
        label: "12/02 新员工入职、IT 备货与网关沙箱权限协同白板",
      },
      grp_lane1: {
        id: "grp_lane1",
        type: "container",
        x: 48,
        y: 86,
        w: 884,
        h: 176,
        title: "人事招聘与行政 IT 筹备",
        fill: "water",
      },
      ag_c1: {
        id: "ag_c1",
        type: "shape",
        shape: "card",
        parentId: "grp_lane1",
        x: 72,
        y: 132,
        w: 228,
        h: 102,
        badge: "9/9 签发",
        title: "秋招 Offer 定级归档",
        body: "首批 6 名同学入职资料与保密协议审核完成",
        fill: "water",
      },
    };

    const canvasInitial = {
      version: 1,
      grid: "architectural",
      theme: "warm",
      viewport: { x: 0, y: 0, zoom: 1 },
      elements: canvasBaseElements,
    };

    const canvasNote = await v.rpc(
      "note.create",
      {
        title: "12 月新员工入职与研发环境协同白板",
        noteType: "canvas",
        sortOrder: 9,
        content: JSON.stringify(canvasInitial, null, 2),
      },
      CreatedNoteSchema,
    );

    await v.record("agent-collab-play", { label: "Multi-Agent Doc Co-Editing & Progressive Whiteboard Drawing", fps: 4 }, async (recorder) => {
      await v.nav(`/notes/${docNote.id}`);
      await v.waitRoute(`/notes/${docNote.id}`);
      await v.wait("note-block-doc-view");
      await v.wait("doc-block-ag_p1");
      await v.settle(60);
      await recorder.captureFrame(30);

      const step1Doc = {
        version: 1,
        blocks: [
          docInitial.blocks[0],
          docInitial.blocks[1],
          { id: "ag_p1", type: "prose", text: "Gateway P99 latency 6.4ms (ok)" },
          docInitial.blocks[3],
          docInitial.blocks[4],
          docInitial.blocks[5],
        ],
      };
      const addDoc1 = {
        version: 1,
        blocks: [
          docInitial.blocks[0],
          docInitial.blocks[1],
          { id: "ag_p1", type: "prose", text: "Gateway P99 latency 6.4ms (ok v2)" },
          {
            id: "ag_add_1",
            type: "callout",
            tone: "ok",
            title: "防重放压测结论 (沈括新增)",
            text: "10 并发 Refresh Token 请求完成归并，仅签发 1 组新凭证，无重复撤销告警。",
          },
          docInitial.blocks[3],
          docInitial.blocks[4],
          docInitial.blocks[5],
        ],
      };
      const addDoc2 = {
        version: 1,
        blocks: [
          ...addDoc1.blocks.slice(0, 5),
          {
            id: "ag_add_2",
            type: "todo",
            checked: true,
            text: "完成 12/02 首批 6 位新同学首日破冰日程与工位 E12-E17 指引",
          },
          ...addDoc1.blocks.slice(5),
        ],
      };
      const addDoc3 = {
        version: 1,
        blocks: [
          ...addDoc2.blocks,
          {
            id: "ag_add_3",
            type: "callout",
            tone: "info",
            title: "行政 IT 资产与门禁清单 (顾言新增)",
            text: "6 台 MacBook Pro 资产条码已全部登记至四楼办公区台账，企业邮箱与考勤组同步生效。",
          },
        ],
      };

      await playAgentDocSession(v, {
        noteId: docNote.id,
        actor: {
          id: "agent:architect",
          name: "沈括 · 后端架构",
          avatar: "avatar-architect",
          color: "accent",
        },
        recorder,
        steps: [
          {
            blockId: "ag_p1",
            offset: 29,
            status: "正在修订网关压测指标",
            settleMs: 40,
            blocksJson: JSON.stringify(step1Doc, null, 2),
            expectStableTargetId: "doc-block-ag_p1",
          },
          {
            blockId: "ag_add_1",
            offset: 18,
            status: "正在新增防重放验收结论",
            animateEntrance: true,
            settleMs: 140,
            blocksJson: JSON.stringify(addDoc1, null, 2),
          },
        ],
        async onStep(idx) {
          if (idx === 1) {
            await v.wait("doc-block-ag_add_1");
            await v.wait("doc-presence-badge-agent:architect");
            await v.assertPresent("doc-presence-badge-agent:architect");
            await v.assertClean("agent-play-doc-add1");
            await v.shot(`01-agent-doc-add1-${primaryTheme}`, {
              label: `Architect Animated Doc Addition #1 (${primaryTheme})`,
              settleMs: 80,
            });
          }
        },
      });

      await playAgentDocSession(v, {
        noteId: docNote.id,
        actor: {
          id: "agent:hr",
          name: "苏晴 · 招聘与入职",
          avatar: "avatar-product",
          color: "water",
        },
        recorder,
        steps: [
          {
            blockId: "ag_add_2",
            offset: 16,
            status: "正在新增新人导师结对项",
            animateEntrance: true,
            settleMs: 140,
            blocksJson: JSON.stringify(addDoc2, null, 2),
          },
        ],
        async onStep(idx) {
          if (idx === 0) {
            await v.wait("doc-block-ag_add_2");
            await v.wait("doc-presence-badge-agent:hr");
            await v.assertPresent("doc-presence-badge-agent:hr");
            await v.assertClean("agent-play-doc-add2");
            await v.shot(`02-agent-doc-add2-${primaryTheme}`, {
              label: `HR Partner Animated Doc Addition #2 (${primaryTheme})`,
              settleMs: 80,
            });
          }
        },
      });

      await playAgentDocSession(v, {
        noteId: docNote.id,
        actor: {
          id: "agent:collector",
          name: "顾言 · 行政与薪酬",
          avatar: "avatar-collector",
          color: "leaf",
        },
        recorder,
        steps: [
          {
            blockId: "ag_add_3",
            offset: 20,
            status: "正在新增设备与门禁核对栏",
            animateEntrance: true,
            settleMs: 140,
            blocksJson: JSON.stringify(addDoc3, null, 2),
          },
        ],
        async onStep(idx) {
          if (idx === 0) {
            await v.wait("doc-block-ag_add_3");
            await v.wait("doc-presence-badge-agent:collector");
            await v.assertPresent("doc-presence-badge-agent:collector");
            await v.assertClean("agent-play-doc-add3");
            await v.shot(`03-agent-doc-add3-${primaryTheme}`, {
              label: `Admin Lead Animated Doc Addition #3 (${primaryTheme})`,
              settleMs: 80,
            });
          }
        },
      });

      await v.nav(`/notes/${canvasNote.id}`);
      await v.waitRoute(`/notes/${canvasNote.id}`);
      await v.wait("note-canvas-view");
      await v.settle(300);
      await recorder.captureFrame(30);

      const boardStep1Elements = {
        ...canvasBaseElements,
        ag_c2: {
          id: "ag_c2",
          type: "shape",
          shape: "card",
          parentId: "grp_lane1",
          x: 380,
          y: 132,
          w: 228,
          h: 102,
          badge: "6/6 就绪",
          title: "M4 Pro 与门禁卡备货",
          body: "资产贴码、企业邮箱与工位电源调试完成",
          fill: "sun",
        },
        ag_e1: {
          id: "ag_e1",
          type: "arrow",
          from: { id: "ag_c1", side: "e" },
          to: { id: "ag_c2", side: "w" },
          curve: "smooth",
          endHead: "arrow",
          label: "触发备货",
        },
      };

      const boardStep2Elements = {
        ...boardStep1Elements,
        ag_c3: {
          id: "ag_c3",
          type: "shape",
          shape: "sticky",
          parentId: "grp_lane1",
          x: 688,
          y: 132,
          w: 220,
          h: 102,
          title: "导师带教与首日破冰",
          body: "沈括 / 林徽 / 周密 担任首批研发 Buddy",
          fill: "leaf",
        },
        ag_e2: {
          id: "ag_e2",
          type: "arrow",
          from: { id: "ag_c2", side: "e" },
          to: { id: "ag_c3", side: "w" },
          curve: "smooth",
          endHead: "arrow",
          label: "12/02 报到",
        },
      };

      await playAgentCanvasSession(v, {
        noteId: canvasNote.id,
        actor: {
          id: "agent:collector",
          name: "顾言 · 行政与薪酬",
          avatar: "avatar-collector",
          color: "wheat",
        },
        recorder,
        steps: [
          {
            nodeId: "ag_c2",
            x: 380,
            y: 132,
            w: 228,
            h: 102,
            status: "正在新增 M4 Pro 备货卡",
            animateEntrance: true,
            settleMs: 300,
            boardJson: JSON.stringify({ ...canvasInitial, elements: boardStep1Elements }, null, 2),
          },
        ],
        async onStep(idx) {
          if (idx === 0) {
            await v.assertPresent("wb-el-ag_c2");
            await v.assertPresent("whiteboard-presence-badge-agent:collector");
            await v.assertClean("agent-play-canvas-add1");
            await v.shot(`04-agent-canvas-add1-${primaryTheme}`, {
              label: `Admin Lead Animated Card Addition #1 (${primaryTheme})`,
              settleMs: 180,
            });
          }
        },
      });

      await playAgentCanvasSession(v, {
        noteId: canvasNote.id,
        actor: {
          id: "agent:hr",
          name: "苏晴 · 招聘与入职",
          avatar: "avatar-product",
          color: "leaf",
        },
        recorder,
        steps: [
          {
            nodeId: "ag_c3",
            x: 688,
            y: 132,
            w: 220,
            h: 102,
            status: "正在新增导师带教便签",
            animateEntrance: true,
            settleMs: 180,
            boardJson: JSON.stringify({ ...canvasInitial, elements: boardStep2Elements }, null, 2),
          },
        ],
        async onStep(idx) {
          if (idx === 0) {
            await v.assertPresent("wb-el-ag_c3");
            await v.assertPresent("whiteboard-presence-badge-agent:hr");
            await v.assertClean("agent-play-canvas-add2");
            await v.shot(`05-agent-canvas-add2-${primaryTheme}`, {
              label: `HR Partner Animated Card Addition #2 (${primaryTheme})`,
              settleMs: 180,
            });
          }
        },
      });

      const boardStep3Elements = {
        ...boardStep2Elements,
        grp_lane2: {
          id: "grp_lane2",
          type: "container",
          x: 48,
          y: 296,
          w: 884,
          h: 176,
          title: "研发环境与网关沙箱权限",
          fill: "leaf",
        },
        ag_c4: {
          id: "ag_c4",
          type: "shape",
          shape: "card",
          parentId: "grp_lane2",
          x: 72,
          y: 342,
          w: 248,
          h: 102,
          badge: "自动开通",
          title: "GitHub + VPN + 测试租户",
          body: "下发 core-gateway 与 console-web 只读权限",
          fill: "water",
        },
        ag_db: {
          id: "ag_db",
          type: "shape",
          shape: "cylinder",
          parentId: "grp_lane2",
          x: 404,
          y: 342,
          w: 204,
          h: 102,
          title: "SSO 审计库",
          body: "记录工号、MFA 与 SSH 公钥指纹",
          fill: "lavender",
        },
        ag_c5: {
          id: "ag_c5",
          type: "shape",
          shape: "pill",
          parentId: "grp_lane2",
          x: 688,
          y: 360,
          w: 220,
          h: 68,
          title: "首周 PR 合入达成",
          body: "环境就绪 < 30 分钟",
          fill: "leaf",
        },
        ag_e3: {
          id: "ag_e3",
          type: "arrow",
          from: { id: "ag_c2", side: "s" },
          to: { id: "ag_c4", side: "n" },
          curve: "smooth",
          style: "dashed",
          endHead: "arrow",
          label: "同步工号",
        },
        ag_e4: {
          id: "ag_e4",
          type: "arrow",
          from: { id: "ag_c4", side: "e" },
          to: { id: "ag_db", side: "w" },
          curve: "smooth",
          endHead: "arrow",
          label: "鉴权落库",
        },
        ag_e5: {
          id: "ag_e5",
          type: "arrow",
          from: { id: "ag_db", side: "e" },
          to: { id: "ag_c5", side: "w" },
          curve: "smooth",
          endHead: "arrow",
        },
      };

      await playAgentCanvasSession(v, {
        noteId: canvasNote.id,
        actor: {
          id: "agent:architect",
          name: "沈括 · 后端架构",
          avatar: "avatar-architect",
          color: "accent",
        },
        recorder,
        steps: [
          {
            nodeId: "ag_c4",
            x: 72,
            y: 342,
            w: 248,
            h: 102,
            status: "正在新增研发沙箱权限流",
            animateEntrance: true,
            settleMs: 220,
            boardJson: JSON.stringify({ ...canvasInitial, elements: boardStep3Elements }, null, 2),
          },
        ],
        async onStep(idx) {
          if (idx === 0) {
            await v.assertPresent("wb-el-ag_c4");
            await v.assertPresent("wb-el-ag_db");
            await v.assertPresent("wb-el-ag_c5");
            await v.assertPresent("whiteboard-presence-badge-agent:architect");
            await v.assertClean("agent-play-canvas-add3");
            await v.shot(`06-agent-canvas-add3-${primaryTheme}`, {
              label: `Architect Animated Card Addition #3 (${primaryTheme})`,
              settleMs: 180,
            });
          }
        },
      });
    });
  },
});
