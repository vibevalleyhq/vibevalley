import type { ChatMessage, IssueHistory, SessionEvent, StateFrame } from "@vibevalley/protocol";

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

function buildHistory(frame: StateFrame): IssueHistory[] {
  const byId = new Map<string, (typeof frame.state.sessions)[number]>(frame.state.sessions.map((s) => [s.id, s]));
  return frame.state.issues.map((issue) => {
    const sessions = issue.assignments.flatMap((a) => a.executions.map((e) => byId.get(e.session))).filter((s): s is NonNullable<typeof s> => s !== undefined);
    return { issue, sessions, missingSessions: [] };
  });
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

function responsesFor(density: ScenarioDensity, frame: StateFrame): Record<string, unknown> {
  const pixelDir = { path: decodeURI(new URL("../../../../../../assets/pixel", import.meta.url).pathname) };
  const baseSettings = (baseResponses["setting.get"] as Record<string, unknown> | undefined) ?? {};
  const messages = buildMessages(density, SCENARIO_NOW);

  if (density === "empty") {
    return {
      ...baseResponses,
      "host.pixelDir": pixelDir,
      "agent.list": [],
      "agent.template.list": [],
      "agent.validate": [],
      "skill.list": [],
      "repo.list": [],
      "runtime.list": [],
      "issue.history.list": [],
      "issue.run.list": [],
      "issue.timeline.get": { milestones: [] },
      "issue.diff.get": { files: [], truncated: false },
      "issue.conversation.get": null,
      "issue.answer": null,
      "issue.status.update": { seq: frame.seq + 1 },
      "issue.comment.create": { seq: frame.seq + 1 },
      "orchestrator.approval.list": [],
      "channel.message.list": [],
      "channel.pin.list": [],
      "channel.message.search": [],
      "session.list": [],
      "session.event.list": [],
      "artifact.list": [],
      "artifact.suggestion.list": [],
      "library.item.list": [],
      "memory.list": { memories: [] },
      "pkm.page.list": [],
      "pkm.search": [],
      "pkm.radar.get": { counts: { inbox: 0, overdue: 0, later: 0 }, inbox: [], overdue: [], projects: [], areas: [], resources: [], archives: [] },
      "setting.get": { ...baseSettings, deepseekApiKey: { source: null } },
    };
  }

  return {
    ...baseResponses,
    "host.pixelDir": pixelDir,
    "orchestrator.approval.list": [],
    "issue.history.list": buildHistory(frame),
    "issue.timeline.get": {
      milestones: [
        { at: SCENARIO_NOW - 40 * MIN_MS, kind: "opened", text: "写下这张工单" },
        { at: SCENARIO_NOW - 20 * MIN_MS, kind: "started", who: "老周", text: "开始处理" },
        { at: SCENARIO_NOW - 6 * MIN_MS, kind: "reported", who: "老周", text: "已提交修改并补充测试。" },
      ],
      spent: { tokens: 182_400, cny: 0.42 },
    },
    "issue.answer": null,
    "issue.status.update": { seq: frame.seq + 1 },
    "issue.comment.create": { seq: frame.seq + 1 },
    "channel.message.list": messages,
    "channel.pin.list": messages.filter((m) => m.pinned !== undefined),
    "session.list": frame.state.sessions,
    "session.event.list": buildSessionEvents(SCENARIO_NOW, density !== "minimal", density === "dense"),
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

function asFrame(raw: unknown): StateFrame {
  return raw as StateFrame;
}

const rawFrames: Record<ScenarioDensity, StateFrame> = {
  empty: asFrame(emptyRaw),
  minimal: asFrame(minimalRaw),
  typical: asFrame(typicalRaw),
  dense: asFrame(denseRaw),
  extreme: asFrame(extremeRaw),
  edge: asFrame(edgeRaw),
};

export const scenarios: Record<ScenarioDensity, { state: StateFrame; responses: Record<string, unknown> }> = {
  empty: { state: rawFrames.empty, responses: responsesFor("empty", rawFrames.empty) },
  minimal: { state: rawFrames.minimal, responses: responsesFor("minimal", rawFrames.minimal) },
  typical: { state: rawFrames.typical, responses: responsesFor("typical", rawFrames.typical) },
  dense: { state: rawFrames.dense, responses: responsesFor("dense", rawFrames.dense) },
  extreme: { state: rawFrames.extreme, responses: responsesFor("extreme", rawFrames.extreme) },
  edge: { state: rawFrames.edge, responses: responsesFor("edge", rawFrames.edge) },
};
