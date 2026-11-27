import "../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { Attachment, Channel, ChatMessage, Issue, IssueId, MessageId, SliceBundle } from "@vibevalley/protocol";

import { fakeHost } from "../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../fixtures/scenarios";
import { setCoreBridgeForTest } from "../infra/rich";
import { CompareSpecSchema, formatCompareBlock, parseCompareSpec, splitMarkdownCompareBlocks, type CompareSpec } from "./compareModel";

const SAMPLE_PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function makeTestChannel(id: string): Channel {
  return {
    id,
    type: "channel",
    default: true,
    category: "",
    notify: "all",
    description: "",
    subjectKind: null,
    replies: 0,
    title: "general",
    name: "general",
    at: SCENARIO_NOW - 10_000,
  };
}

function testBlockOf(spec: CompareSpec): string {
  return `\`\`\`compare\n${JSON.stringify(spec, null, 2)}\n\`\`\``;
}

test("compareModel delegates parse/split/format cleanly to Rust VvCore bridge", () => {
  const spec: CompareSpec = {
    title: "Bridge smoke",
    before: { attachment: "att-1", label: "Before" },
    after: { attachment: "att-2", label: "After" },
  };
  let seenRaw = "";
  let seenSplit = "";
  const restore = setCoreBridgeForTest({
    parseCompareSpec: (raw) => {
      seenRaw = raw;
      return JSON.stringify(spec);
    },
    splitCompareBlocks: (text) => {
      seenSplit = text;
      return JSON.stringify([{ kind: "compare", raw: JSON.stringify(spec), spec }]);
    },
    formatCompareBlock: (specJson) => `\`\`\`compare\n${specJson}\n\`\`\``,
  });
  try {
    expect(parseCompareSpec("{}")).toEqual(spec);
    expect(seenRaw).toBe("{}");
    expect(splitMarkdownCompareBlocks("```compare\n{}\n```")).toEqual([{ kind: "compare", raw: JSON.stringify(spec), spec }]);
    expect(seenSplit).toContain("compare");
    expect(CompareSpecSchema.safeParse(spec).success).toBe(true);
    expect(formatCompareBlock(spec)).toContain("```compare");
  } finally {
    restore();
  }
});

test("Markdown renders Compare inline with side-by-side, slider, lightbox, annotation toggle, legend highlight, and malformed fallback", async () => {
  setLocale("zh");
  const dualSpec: CompareSpec = {
    title: "按钮高度修复",
    before: { attachment: "att-before-1", label: "修复前" },
    after: { attachment: "att-after-1", label: "修复后" },
    annotations: [
      { n: 1, side: "before", rect: [0.1, 0.15, 0.35, 0.2], tone: "issue", note: "按钮偏高导致换行" },
      { n: 2, side: "after", rect: [0.1, 0.15, 0.35, 0.2], tone: "fixed", note: "统一为 28px 高度" },
    ],
  };
  const singleSpec: CompareSpec = {
    title: "单图标注",
    image: { url: "file:///tmp/single-shot.png", label: "截图" },
    annotations: [{ n: 1, rect: [0.2, 0.2, 0.4, 0.3], tone: "note", note: "留白对齐基线" }],
  };
  const dualBlock = testBlockOf(dualSpec);
  const singleBlock = testBlockOf(singleSpec);
  const dualBody = `本次视觉回归检查：\n\n${dualBlock}`;
  const singleAndBadBody = `${singleBlock}\n\n\`\`\`compare\n{ bad json\n\`\`\``;
  {
    const channelId = "ch-compare";
    const base = scenarios.typical;
    const state: SliceBundle = {
      ...base.state,
      collab: {
        ...base.state.collab,
        chat: {
          channels: [makeTestChannel(channelId)],
          userMentions: [],
        },
        channelSummary: undefined,
      },
    };

    const fake = fakeHost({ state, responses: base.responses }, { route: "/chat", locale: "zh" });
    const messages: ChatMessage[] = [
      {
        id: "m-cmp-1" as MessageId,
        channel: channelId,
        number: 1,
        from: "orch-1",
        name: "主助手",
        actor: { kind: "agent", id: "orch-1", role: "orchestrator", name: "主助手" },
        kind: "chat",
        text: dualBody,
        outcome: null,
        spoken: false,
        revision: 1,
        attachments: [],
        embeds: [],
        reactions: [],
        mentions: [],
        at: SCENARIO_NOW - 2_000,
      },
      {
        id: "m-cmp-2" as MessageId,
        channel: channelId,
        number: 2,
        from: "orch-1",
        name: "主助手",
        actor: { kind: "agent", id: "orch-1", role: "orchestrator", name: "主助手" },
        kind: "chat",
        text: singleAndBadBody,
        outcome: null,
        spoken: false,
        revision: 1,
        attachments: [],
        embeds: [],
        reactions: [],
        mentions: [],
        at: SCENARIO_NOW - 1_000,
      },
    ];
    fake.respond("channel.message.list", messages);
    fake.respond("attachment.file", (payload: unknown) => {
      const id = (payload as { id?: string } | undefined)?.id ?? "unknown";
      return { path: `/tmp/${id}.png`, type: "image/png", name: `${id}.png` };
    });

    const app = await open("../app/main.tsx", {
      width: 1280,
      height: 900,
      colorScheme: "light",
      platform: "macos",
      clock: { time: SCENARIO_NOW },
      host: fake.options,
    });
    await fake.pumpUntil(app, () => app.count("id:compare-card") === 2);
    if (app.shows("id:message-1 >> text:展开全文")) await app.press("id:message-1 >> text:展开全文");
    if (app.shows("id:message-2 >> text:展开全文")) await app.press("id:message-2 >> text:展开全文");

    // Valid blocks render as Compare cards while malformed block stays a plain code block.
    expect(app.count("id:compare-card")).toBe(2);
    expect(app.count("id:compare-side-by-side")).toBe(1);
    expect(app.count("id:compare-single")).toBe(1);
    expect(app.count("id:code-block")).toBe(1);
    expect(app.texts()).toContain("按钮高度修复");
    expect(app.texts()).toContain("修复前");
    expect(app.texts()).toContain("修复后");
    expect(app.texts()).toContain("按钮偏高导致换行");
    expect(app.texts()).toContain("统一为 28px 高度");

    // Attachment IDs resolve via attachment.file into rendered images.
    await fake.pumpUntil(app, () => app.count("id:compare-image-before") === 1 && app.count("id:compare-image-after") === 1);
    expect(app.count("id:compare-callout-before-1")).toBe(1);
    expect(app.count("id:compare-callout-after-2")).toBe(1);

    // Clicking a legend row highlights matching callout and dims non-matching ones.
    await app.press("id:message-1 >> id:compare-legend-1");
    expect(app.accessibility("id:compare-callout-before-1")?.selected).toBe(true);
    expect(app.viewStyle("id:compare-callout-after-2")?.opacity).toBeLessThan(0.9);
    await app.press("id:message-1 >> id:compare-legend-1");
    expect(app.accessibility("id:compare-callout-before-1")?.selected).toBe(false);

    // Toggling annotations hides and restores callout overlays.
    await app.press("id:message-1 >> id:compare-annotations-toggle");
    expect(app.count("id:compare-callout-before-1")).toBe(0);
    expect(app.count("id:compare-callout-after-2")).toBe(0);
    await app.press("id:message-1 >> id:compare-annotations-toggle");
    expect(app.count("id:compare-callout-before-1")).toBe(1);
    expect(app.count("id:compare-callout-after-2")).toBe(1);

    // Clicking a panel opens Lightbox and closing dismisses it.
    await app.press("id:compare-stage-before");
    expect(app.count("id:lightbox")).toBe(1);
    await app.press("id:lightbox-close");
    expect(app.count("id:lightbox")).toBe(0);

    // Switching to Slider mode exposes split controls and updates split percentage.
    await app.press("id:compare-mode-slider");
    expect(app.count("id:compare-slider")).toBe(1);
    expect(app.count("id:compare-side-by-side")).toBe(0);
    expect(app.count("id:compare-slider-before-pill")).toBe(1);
    expect(app.count("id:compare-slider-after-pill")).toBe(1);
    expect(app.texts()).toContain("50%");

    await app.press("id:compare-split-25");
    expect(app.texts()).toContain("25%");
    await app.press("id:compare-split-75");
    expect(app.texts()).toContain("75%");

    await app.press("id:compare-mode-side");
    expect(app.count("id:compare-side-by-side")).toBe(1);
  }
});

test("Composer CompareUploadDialog picks and uploads two images and inserts compare block with attachments", async () => {
  {
    setLocale("zh");
    const channelId = "ch-compose-cmp";
    const base = scenarios.typical;
    const state: SliceBundle = {
      ...base.state,
      collab: {
        ...base.state.collab,
        chat: {
          channels: [makeTestChannel(channelId)],
          userMentions: [],
        },
        channelSummary: undefined,
      },
    };

    let createdIdx = 0;
    const fake = fakeHost({ state, responses: base.responses }, { route: "/chat", locale: "zh" });
    fake.respond("channel.message.list", []);
    fake.respond("attachment.create", (payload: unknown): Attachment => {
      const p = payload as { name?: string; type?: string };
      createdIdx += 1;
      return {
        id: `att-cmp-${createdIdx}`,
        name: p.name ?? `img-${createdIdx}.png`,
        type: p.type ?? "image/png",
        size: SAMPLE_PNG_BYTES.length,
      };
    });
    fake.respond("attachment.file", (payload: unknown) => {
      const id = (payload as { id?: string } | undefined)?.id ?? "att";
      return { path: `/tmp/${id}.png`, type: "image/png", name: `${id}.png` };
    });

    const app = await open("../app/main.tsx", {
      width: 1280,
      height: 900,
      colorScheme: "light",
      platform: "macos",
      clock: { time: SCENARIO_NOW },
      host: fake.options,
    });
    await fake.pumpUntil(app, () => app.count("id:composer-compare-btn") === 1);

    let pickStep = 0;
    app.onPick(() => {
      pickStep += 1;
      return [
        {
          name: pickStep === 1 ? "before.png" : "after.png",
          type: "image/png",
          data: SAMPLE_PNG_BYTES,
        },
      ];
    });

    await app.press("id:composer-compare-btn");
    expect(app.count("id:compare-upload-dialog")).toBe(1);
    expect(app.enabled("id:compare-upload-submit")).toBe(false);

    await app.type("id:compare-upload-title", "导航栏对比");
    await app.press("id:compare-pick-before");
    await fake.pumpUntil(app, () => app.count("id:compare-slot-name-before") === 1);
    expect(app.texts()).toContain("before.png");
    expect(app.enabled("id:compare-upload-submit")).toBe(true);

    await app.press("id:compare-pick-after");
    await fake.pumpUntil(app, () => app.count("id:compare-slot-name-after") === 1);
    expect(app.texts()).toContain("after.png");

    await app.press("id:compare-add-annotation");
    await app.type("id:compare-draft-note-1", "高亮指示条对齐");

    await app.press("id:compare-upload-submit");
    await fake.pumpUntil(app, () => app.count("id:compare-upload-dialog") === 0);

    const composerVal = app.value("id:composer-input") ?? "";
    expect(composerVal).toContain("```compare");
    const parsed = JSON.parse(composerVal.slice(composerVal.indexOf("{"), composerVal.lastIndexOf("}") + 1)) as CompareSpec;
    expect(parsed.title).toBe("导航栏对比");
    expect(parsed.before?.attachment).toBe("att-cmp-1");
    expect(parsed.after?.attachment).toBe("att-cmp-2");
    expect(parsed.annotations?.[0]?.note).toBe("高亮指示条对齐");
    expect(app.count("id:pending-file")).toBe(2);
  }
});

test("IssueAttachments omits redundant Compare upload action while preserving file upload", async () => {
  {
    setLocale("zh");
    const issue: Issue = {
      id: "i-cmp-1" as IssueId,
      number: 42,
      title: "Verify before/after comparison in issue detail",
      description: "Check visual diff workflow.",
      mandate: { strength: "explicit", maxBotReviewRounds: 0, autoSubmitPr: false },
      status: "in_review",
      moves: ["todo", "done", "canceled"],
      priority: "medium",
      deliver: "change",
      criteria: ["Compare block is posted cleanly"],
      checks: [],
      questions: [],
      findings: [],
      assignments: [],
      blockedBy: [],
      createdAt: SCENARIO_NOW - 600_000,
      stage: { state: "reviewing", acts: [{ act: "complete", does: "move", status: "done", words: "none" }], lead: "complete" },
    };

    const state: SliceBundle = {
      ...scenarios.empty.state,
      board: { seq: 12, issues: [issue] },
    };
    const fake = fakeHost({ state, responses: scenarios.typical.responses }, { route: `/issues/${issue.id}`, locale: "zh" });
    fake.respond("issue.history.list", [{ issue, sessions: [], missingSessions: [] }]);
    fake.respond("issue.timeline.get", { milestones: [{ at: SCENARIO_NOW - 600_000, kind: "opened", text: "开了这个工单" }] });

    const app = await open("../app/main.tsx", {
      width: 1200,
      height: 820,
      colorScheme: "light",
      platform: "macos",
      clock: { time: SCENARIO_NOW },
      host: fake.options,
    });
    await fake.pumpUntil(app, () => app.count("id:issue-attach-file") === 1);
    expect(app.count("id:issue-add-compare")).toBe(0);
  }
});
