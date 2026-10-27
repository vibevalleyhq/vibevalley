// What the server and the page both say, in Chinese: the source of en.ts's shape. Keys are the concepts, as the code
// names them; the words follow the glossary (docs/README.md, 用语).

import type { Attention, Deliverable, Delivery, IssueAct, IssueCanceled, IssueStatus, Outcome, Priority, SessionAction, StuckReason } from "../shapes";

export const zh = {
  action: {
    run_command: "跑命令",
    read_file: "读文件",
    edit_file: "改文件",
    search: "搜索",
    web: "查网页",
    mcp: "调 MCP 工具",
    wait: "等待",
    other: "用工具",
    thinking: "思考",
    speaking_text: "写汇报",
    none: "",
  } satisfies Record<SessionAction, string>,
  /** How a round ended. */
  outcome: { completed: "做完了", failed: "没做成", interrupted: "停在半路" } satisfies Record<Outcome, string>,
  status: {
    backlog: "备选",
    todo: "待办",
    in_progress: "处理中",
    in_review: "等你看",
    done: "已完成",
    canceled: "已取消",
  } satisfies Record<IssueStatus, string>,
  priority: { urgent: "紧急", high: "高", medium: "普通", low: "低" } satisfies Record<Priority, string>,
  /** What an issue is to deliver, as the owner picks it. */
  deliverable: { change: "改动，合进项目", answer: "结论，只查不改代码" } satisfies Record<Deliverable, string>,
  /** What a done issue delivered. */
  delivered: {
    merged: "合进了主分支",
    merged_into_parent: "合进了计划的分支",
    pull_request: "PR 合进去了",
    kept: "分支留着没合",
    none: "没有改动要合",
  } satisfies Record<Delivery, string>,
  /** Why a canceled issue was. */
  canceled: { dismissed: "取消了", lost: "干活的目录丢了" } satisfies Record<IssueCanceled, string>,
  doneWith: (what: string) => "已完成，" + what,
  canceledFor: (why: string) => "已取消，" + why,
  attention: {
    draft: "草稿",
    queued: "排队",
    working: "在做",
    asking: "等你回答",
    reviewing: "等你验收",
    stuck: "卡住了",
    done: "已完成",
    canceled: "已取消",
  } satisfies Record<Attention, string>,
  /** Why an issue is stuck, in a word or two. */
  stuck: { conflict: "有冲突", failed: "没做成", interrupted: "停在半路", quiet: "没动静" } satisfies Record<StuckReason, string>,
  /** What each act is called, on its button and in a refusal. */
  act: {
    start: "开工",
    answer: "回答",
    accept: "验收通过",
    reject: "打回",
    complete: "完成",
    keep: "完成，分支留着",
    acknowledge: "知道了",
    resolve: "让它解决冲突",
    resume: "接着做",
    cure: "接着修",
    tell: "带话",
    stop: "叫停这一轮",
    close: "取消",
    reopen: "重开",
  } satisfies Record<IssueAct, string>,
  /** What a session is doing (rules/phase.ts phaseWords). */
  phase: {
    arriving: "刚派出去，正在开工",
    working: (action: string, label: string) => "在" + action + (label !== "" ? "：" + label : ""),
    quiet: (what: string, span: string) => what + "（已经 " + span + "没动静了）",
    retrying: (what: string, attempt: number, of?: number) => `${what}（模型调用失败，在重试第 ${attempt}${of ? `/${of}` : ""} 次）`,
    done: (conflict: string) => "这一轮做完了，等你看" + conflict,
    failed: "这一轮没做成",
    resting: (last: string, conflict: string) => "歇着（上一轮" + last + "）" + conflict,
    unfinished: "没做完",
    conflict: (base: string, files: readonly string[]) => `，合进 ${base} 会冲突（${files.join("、")}）`,
  },
  /** A short span: seconds under a minute, else minutes. */
  span: (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.round(ms / 60_000)} 分钟`),
  order: { invalid: "不是有效的顺序键", unordered: (a: string, b: string) => `顺序键 ${a} 不在 ${b} 前面` },
  /** What the voice line says first, unless the owner set their own (the voice samples say it too). */
  greeting: "来啦！今天想种点什么？",
  /** The API client, when the server's answer says nothing more. */
  serverAnswered: (status: number) => "服务端答 " + status,
};

export type Words = typeof zh;
