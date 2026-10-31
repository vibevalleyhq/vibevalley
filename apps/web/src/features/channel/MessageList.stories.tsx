import { For } from "solid-js";

import type { ChatMessage } from "@vibevalley/protocol";
import { messageId } from "@vibevalley/protocol/schema";
import { stories, story, type Story } from "@vibevalley/stories";

import { MessageRow } from "./MessageList";

const now = Date.now();
const min = 60_000;
let n = 0;

const msg = (fromKind: ChatMessage["fromKind"], from: string, name: string, text: string, more: Partial<ChatMessage> = {}): ChatMessage => ({
  id: messageId(`m${++n}`),
  number: n,
  channel: "general",
  from,
  fromKind,
  name,
  kind: "chat",
  text,
  at: now - (40 - n) * min,
  revision: 1,
  mentions: [],
  spoken: false,
  reactions: [],
  attachments: [],
  embeds: [],
  ...more,
});

const owner = (text: string, more: Partial<ChatMessage> = {}) => msg("owner", "owner", "主人", text, more);
const orchestrator = (text: string, more: Partial<ChatMessage> = {}) => msg("orchestrator", "orchestrator", "管家", text, more);
const helper = (text: string, more: Partial<ChatMessage> = {}) => msg("session", "w1", "老周", text, { agent: "老周", ...more });

/** Rows as the channel draws them: one after another, a row from the same sender soon after folds under the one before. */
const list = (note: string, rows: { m: ChatMessage; continues?: boolean }[]): Story =>
  story({
    note,
    render: () => (
      <div class="flex w-full max-w-2xl flex-col">
        <For each={rows}>{(r) => <MessageRow m={r.m} continues={r.continues ?? false} inChannel />}</For>
      </div>
    ),
  });

export default stories({
  title: "界面/频道/消息",
  stories: {
    Talk: list("主人、管家、帮工在频道里说话；同一个人接着说，头像和名字只出现一次。", [
      { m: owner("登录过期的问题谁来修？") },
      { m: orchestrator("派给老周了，在工单 #18 里。") },
      { m: orchestrator("他说半小时左右。"), continues: true },
      { m: helper("收到，先看 session.ts。") },
    ]),
    Reports: list("帮工交活的报告：做成了、没做成，各自花了多少。", [
      { m: helper("改好了：过期回到登录页，加了两条测试。", { kind: "report", outcome: "completed", spent: { tokens: 32_800, cny: 0.42 } }) },
      { m: helper("测试起不来：缺一个环境变量。", { kind: "report", outcome: "failed", spent: { tokens: 9_100, cny: 0.11 } }) },
    ]),
    Rich: list("附件、链接预览、表态、Markdown；很长的一条先折起来。", [
      {
        m: owner("设计稿和录屏在这，参考 https://example.com/design", {
          attachments: [
            { id: "a1", name: "design-review.pdf", type: "application/pdf", size: 1_400_000 },
            { id: "a2", name: "bug.mov", type: "video/quicktime", size: 48_000_000 },
          ],
          embeds: [{ url: "https://example.com/design", image: "", site: "example.com", title: "登录页改版", description: "过期提示、重新登录、记住我" }],
          reactions: [
            { emoji: "👍", by: ["orchestrator", "w1"] },
            { emoji: "👀", by: ["owner"] },
          ],
        }),
      },
      {
        m: helper(
          ["## 改了什么", "", "- `session.ts`：过期判断", "- `Login.tsx`：提示文案", "", ...Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行说明`)].join(
            "\n",
          ),
        ),
      },
    ]),
    "Edited, pinned, deleted": list("改过的带「已编辑」，钉住的带标记，删掉的只留一行。", [
      { m: owner("周五之前合进去。", { edited: now - 2 * min }) },
      { m: orchestrator("记下了：周五之前。", { pinned: now - min }) },
      { m: helper("（这条删了）", { deleted: now - min }) },
    ]),
  },
});
