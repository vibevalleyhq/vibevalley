// For the stories only; the product never imports it.

import type { SessionEvent, SessionEventType, ToolAction } from "@vibevalley/protocol";

export const start = Date.now() - 9 * 60_000;

let seq = 0;
const at = (s: number) => start + s * 1000;

const ev = (s: number, type: SessionEventType, text: string, more: Partial<SessionEvent> = {}): SessionEvent => ({
  seq: ++seq,
  revision: 1,
  time: at(s),
  type,
  text,
  ...more,
});

/** A tool call and its result, the result pointing back at the call. */
const tool = (s: number, took: number, action: ToolAction, tool: string, input: string, output: string | undefined, ok = true): SessionEvent[] => {
  const call = ev(s, "tool/call", "", { action, tool, input, actionText: input });
  return output === undefined ? [call] : [call, ev(s + took, "tool/result", "", { call: call.seq, output, ok })];
};

/** One finished round: read, edit, a failing test, a retry of the model, the fix, the answer. */
export const finishedRound: SessionEvent[] = [
  ev(0, "run/start", ""),
  ev(0, "user/message", "修好登录过期：过期就回到登录页，说清楚为什么。"),
  ev(1, "memory/recalled", "这个项目的测试用 vp test；会话的有效期在 session.ts。"),
  ev(2, "assistant/thinking", "先看 session.ts 怎么判断过期，再找登录页。"),
  ...tool(4, 1, "read_file", "read", "apps/web/src/base/session.ts", "export function session() { … }"),
  ...tool(8, 2, "edit_file", "edit", "apps/web/src/base/session.ts", "+5 −1"),
  ...tool(
    14,
    21,
    "run_command",
    "bash",
    "vp test run src/base/session.test.ts",
    "FAIL session.test.ts > 过期以后回到登录页\n  expected '/signin' to be '/login'",
    false,
  ),
  ev(37, "llm/retry", "模型忙，2 秒后再试（第 1 次）"),
  ...tool(42, 1, "edit_file", "edit", "apps/web/src/base/session.test.ts", "+1 −1"),
  ...tool(45, 18, "run_command", "bash", "vp test run src/base/session.test.ts", "✓ 2 passed"),
  ev(64, "llm/usage", "", { tokens: { input: 18_400, cacheRead: 12_100, output: 2_300 } }),
  ev(66, "assistant/message", "改好了：过期回到登录页，登录页说「登录过期了」。加了两条测试，都过了。"),
  ev(66, "run/end", ""),
];

/** A second round still going: asked, thinking, a command running with no result yet. */
export const liveRound: SessionEvent[] = [
  ev(300, "run/start", ""),
  ev(300, "user/message", "再补一条跨过期限的测试。"),
  ev(302, "assistant/thinking", "在过期前一秒和后一秒各测一次。"),
  ...tool(306, 0, "run_command", "bash", "vp test run src/base/session.test.ts", undefined),
];

/** A round that ended in an error before it got anywhere. */
export const failedRound: SessionEvent[] = [
  ev(500, "run/start", ""),
  ev(500, "user/message", "跑一遍全部测试。"),
  ...tool(502, 3, "run_command", "bash", "vp run web:check", "error: DEEPSEEK_API_KEY is not set", false),
  ev(506, "run/error", "这一轮没跑完：模型的钥匙没设（设置 › 模型）"),
];

/** When the last step of a log happened, a little after: "now" for the stories. */
export const nowAfter = (log: readonly SessionEvent[]) => (log.at(-1)?.time ?? start) + 20_000;
