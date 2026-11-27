import type {
  ChatMessage,
  IssueHistory,
  IssueRetroReport,
  MorningDigest,
  RetroWindow,
  SessionEvent,
  SessionEventPage,
  SliceBundle,
} from "@vibevalley/protocol";
import { SliceBundle as SliceBundleSchema } from "@vibevalley/protocol/schema";

import workbenchResponsesJson from "../workbench/responses.json";
import denseRaw from "./dense/state.json";
import edgeRaw from "./edge/state.json";
import emptyRaw from "./empty/state.json";
import extremeRaw from "./extreme/state.json";
import minimalRaw from "./minimal/state.json";
import typicalRaw from "./typical/state.json";

export const SCENARIO_NOW = 1_795_194_443_624;

export type ScenarioDensity = "empty" | "minimal" | "typical" | "dense" | "extreme" | "edge";

const MIN_MS = 60_000;
const baseResponses = workbenchResponsesJson as Record<string, unknown>;

function buildHistory(bundle: SliceBundle): IssueHistory[] {
  const byId = new Map<string, (typeof bundle.sessions.sessions)[number]>(bundle.sessions.sessions.map((s) => [s.id, s]));
  return bundle.board.issues.map((issue) => {
    const sessions = issue.assignments.flatMap((a) => a.executions.map((e) => byId.get(e.session))).filter((s): s is NonNullable<typeof s> => s !== undefined);
    return { issue, sessions, missingSessions: [] };
  });
}

function emptyRetro(window: RetroWindow): IssueRetroReport {
  return {
    window,
    generatedAt: SCENARIO_NOW,
    totalIssues: 0,
    openCount: 0,
    completedCount: 0,
    canceledCount: 0,
    cycleTime: { sampleCount: 0 },
    reviewWait: { sampleCount: 0 },
    withDueCount: 0,
    withoutDueCount: 0,
    onTimeCount: 0,
    overdueCount: 0,
    upcomingDueCount: 0,
    reworkIssueCount: 0,
    totalFindingsCount: 0,
    unresolvedFindingsCount: 0,
    overdueItems: [],
    reworkItems: [],
    byRepo: [],
    byTag: [],
    byAgent: [],
  };
}

function emptyDigest(): MorningDigest {
  return {
    generatedAt: SCENARIO_NOW,
    windowStart: SCENARIO_NOW - 86_400_000,
    windowEnd: SCENARIO_NOW,
    progress: {
      asking: [],
      reviewing: [],
      stuck: [],
      working: [],
      completedRecent: [],
      runsTotal: 0,
      runsCompleted: 0,
      runsFailed: 0,
      runsInterrupted: 0,
      tokensSpent: 0,
    },
    repoHealth: [],
    triage: [],
  };
}

function buildSessionEvents(now: number, working: boolean, dense: boolean): SessionEvent[] {
  const t0 = now - 3 * MIN_MS;
  const events: SessionEvent[] = [
    { seq: 1, revision: 1, time: t0, type: "run/start", run: "run-1", text: "" },
    { seq: 2, revision: 1, time: t0 + 1_000, type: "user/message", run: "run-1", text: "修好登录过期：过期就回到登录页，说清楚为什么。" },
    { seq: 3, revision: 1, time: t0 + 2_000, type: "assistant/thinking", run: "run-1", text: "先检查鉴权中间件和登录跳转。" },
    {
      seq: 4,
      revision: 1,
      time: t0 + 4_000,
      type: "tool/call",
      run: "run-1",
      action: "read_file",
      tool: "read",
      input: "session.ts",
      actionText: "session.ts",
      text: "",
    },
    { seq: 5, revision: 1, time: t0 + 5_000, type: "tool/result", run: "run-1", call: 4, output: "export function isExpired() {}", ok: true, text: "" },
    { seq: 6, revision: 1, time: t0 + 12_000, type: "assistant/message", run: "run-1", text: "已修复过期跳转并补充回归测试。" },
  ];
  if (dense) {
    for (let i = 7; i <= 58; i++) {
      events.push({
        seq: i,
        revision: 1,
        time: t0 + i * 2_000,
        type: i % 2 === 0 ? "assistant/message" : "tool/call",
        run: "run-1",
        ...(i % 2 !== 0 ? { action: "run_command" as const, tool: "bash", input: `step-${i}`, actionText: `step-${i}` } : {}),
        text: i % 2 === 0 ? `第 ${i} 步：校验状态与界面性能指标` : "",
      });
    }
  }
  if (working) {
    const seqBase = events.length + 1;
    events.push(
      { seq: seqBase, revision: 1, time: now - 45_000, type: "run/start", run: "run-2", text: "" },
      { seq: seqBase + 1, revision: 1, time: now - 44_000, type: "user/message", run: "run-2", text: "继续运行全量测试并确认耗时。" },
      {
        seq: seqBase + 2,
        revision: 1,
        time: now - 30_000,
        type: "tool/call",
        run: "run-2",
        action: "run_command",
        tool: "bash",
        input: "vp test run",
        actionText: "vp test run",
        text: "",
      },
    );
  } else {
    events.push({ seq: events.length + 1, revision: 1, time: now - 30_000, type: "run/end", run: "run-1", text: "" });
  }
  return events;
}

function buildMessages(density: ScenarioDensity, now: number): ChatMessage[] {
  if (density === "empty") return [];
  const sample = (baseResponses["channel.message.list"] as ChatMessage[] | undefined) ?? [];
  const anchored = sample.map((m, idx) => ({
    ...m,
    at: now - (sample.length - idx) * MIN_MS,
    ...(m.edited !== undefined ? { edited: now - 90_000 } : {}),
    ...(m.pinned !== undefined ? { pinned: now - 60_000 } : {}),
    ...(m.deleted !== undefined ? { deleted: now - 30_000 } : {}),
  }));
  if (density === "minimal") return anchored.slice(0, 2);
  if (density === "typical" || density === "extreme" || density === "edge") return anchored;

  const extra = Array.from({ length: 80 - anchored.length }, (_, i) => {
    const n = anchored.length + i + 1;
    return {
      id: `m-dense-${n}` as ChatMessage["id"],
      number: n,
      channel: "general",
      from: i % 2 === 0 ? "user" : "w1",
      actor: i % 2 === 0 ? ({ kind: "user", id: "user", name: "你" } as const) : ({ kind: "agent", id: "laozhou", role: "worker", name: "老周" } as const),
      name: i % 2 === 0 ? "你" : "老周",
      kind: i % 5 === 0 ? ("report" as const) : ("chat" as const),
      text: i % 4 === 0 ? `第 ${n} 条消息：\n\`\`\`ts\nexport const step${n} = () => ${n};\n\`\`\`` : `第 ${n} 条高密压测消息：核对工单状态与增量帧同步 #18`,
      at: now - (80 - n) * 20_000,
      revision: 1,
      mentions: [],
      spoken: false,
      reactions: [],
      attachments: [],
      embeds: [],
      outcome: null,
    } satisfies ChatMessage;
  });
  return [...anchored, ...extra];
}

function eventPage(events: SessionEvent[]): SessionEventPage {
  const oldestSeq = events[0]?.seq;
  const newestSeq = events.at(-1)?.seq;
  return {
    events,
    hasMore: false,
    ...(oldestSeq !== undefined ? { oldestSeq } : {}),
    ...(newestSeq !== undefined ? { newestSeq } : {}),
  };
}

function responsesFor(density: ScenarioDensity, bundle: SliceBundle): Record<string, unknown> {
  const assetsDir = { path: decodeURI(new URL("../../../../../assets", import.meta.url).pathname) };
  const baseSettings = (baseResponses["setting.get"] as Record<string, unknown> | undefined) ?? {};
  const messages = buildMessages(density, SCENARIO_NOW);

  if (density === "empty") {
    return {
      ...baseResponses,
      "host.assetsDir": assetsDir,
      "agent.list": [],
      "agent.template.list": [],
      "agent.validate": [],
      "skill.list": [],
      "repo.list": [],
      "runtime.list": [],
      "issue.history.list": [],
      "issue.retro.get": emptyRetro("7d"),
      "issue.digest.get": emptyDigest(),
      "issue.triage.list": [],
      "issue.run.list": [],
      "issue.timeline.get": { milestones: [] },
      "issue.diff.get": { files: [], truncated: false },
      "issue.conversation.get": null,
      "issue.answer": null,
      "issue.status.update": { seq: bundle.seq + 1 },
      "issue.comment.create": { seq: bundle.seq + 1 },
      "orchestrator.approval.list": [],
      "channel.message.list": [],
      "channel.pin.list": [],
      "channel.message.search": [],
      "session.list": [],
      "session.event.list": eventPage([]),
      "artifact.list": [],
      "artifact.suggestion.list": [],
      "library.item.list": [],
      "memory.list": { memories: [] },
      "setting.get": { ...baseSettings, deepseekApiKey: { source: null } },
    };
  }

  return {
    ...baseResponses,
    "host.assetsDir": assetsDir,
    "orchestrator.approval.list": [],
    "issue.history.list": buildHistory(bundle),
    "issue.retro.get": emptyRetro("7d"),
    "issue.digest.get": emptyDigest(),
    "issue.triage.list": [],
    "issue.timeline.get": {
      milestones: [
        { at: SCENARIO_NOW - 40 * MIN_MS, kind: "opened", text: "写下这张工单" },
        { at: SCENARIO_NOW - 20 * MIN_MS, kind: "started", who: "老周", text: "开始处理", run: "run-1" },
        { at: SCENARIO_NOW - 6 * MIN_MS, kind: "reported", who: "老周", text: "交回来了", said: "已提交修改并补充测试。", run: "run-1" },
      ],
      spent: { tokens: 182_400, cny: 0.42 },
    },
    "issue.answer": null,
    "issue.status.update": { seq: bundle.seq + 1 },
    "issue.comment.create": { seq: bundle.seq + 1 },
    "channel.message.list": messages,
    "channel.pin.list": messages.filter((m) => m.pinned !== undefined),
    "session.list": bundle.sessions.sessions,
    "session.event.list": eventPage(buildSessionEvents(SCENARIO_NOW, density !== "minimal", density === "dense")),
    "library.item.list": [
      {
        attachment: { id: "lib-poster", name: "海报.png", type: "image/png", size: 482_113 },
        origin: { kind: "generated", job: "job-img-ready", jobKind: "image" },
        addedAt: SCENARIO_NOW - 30 * MIN_MS,
        lastAt: SCENARIO_NOW - 30 * MIN_MS,
      },
      {
        attachment: { id: "lib-standup", name: "周会录音.m4a", type: "audio/mp4", size: 3_204_882 },
        origin: { kind: "uploaded", channel: "general" },
        addedAt: SCENARIO_NOW - 3 * 60 * MIN_MS,
        lastAt: SCENARIO_NOW - 60 * MIN_MS,
      },
    ],
  };
}

function asBundle(raw: unknown): SliceBundle {
  return SliceBundleSchema.parse(raw);
}

const rawBundles: Record<ScenarioDensity, SliceBundle> = {
  empty: asBundle(emptyRaw),
  minimal: asBundle(minimalRaw),
  typical: asBundle(typicalRaw),
  dense: asBundle(denseRaw),
  extreme: asBundle(extremeRaw),
  edge: asBundle(edgeRaw),
};

export const scenarios: Record<ScenarioDensity, { state: SliceBundle; responses: Record<string, unknown> }> = {
  empty: { state: rawBundles.empty, responses: responsesFor("empty", rawBundles.empty) },
  minimal: { state: rawBundles.minimal, responses: responsesFor("minimal", rawBundles.minimal) },
  typical: { state: rawBundles.typical, responses: responsesFor("typical", rawBundles.typical) },
  dense: { state: rawBundles.dense, responses: responsesFor("dense", rawBundles.dense) },
  extreme: { state: rawBundles.extreme, responses: responsesFor("extreme", rawBundles.extreme) },
  edge: { state: rawBundles.edge, responses: responsesFor("edge", rawBundles.edge) },
};
