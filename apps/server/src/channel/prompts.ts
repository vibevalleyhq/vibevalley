// What a helper is told of the chat when it is woken for messages or busy with unread ones: said to the model, in
// Chinese whatever the owner's locale.

import { messageLine, summaryChannels, type UnreadRow, wakeMessages, type InboxMessage } from "./rules.ts";

const rowText = (r: UnreadRow) => `${r.target} ${r.unread} 条` + (r.mentionsYou ? "（提到了你）" : "") + (r.latest ? "，最后是 " + r.latest : "");

/** What a session woken for messages is told: the newest few for it, and what else is unread elsewhere. */
export function wakeInput(messages: readonly InboxMessage[], others: readonly UnreadRow[]): string {
  const shown = messages.slice(Math.max(0, messages.length - wakeMessages));
  const more = messages.length > shown.length ? `（这里是最新的 ${shown.length} 条）` : "";
  const lines = [`[群聊消息] 有 ${messages.length} 条给你的新消息${more}：`, ...shown.map(messageLine)];
  if (others.length > 0) lines.push("", "别处还有没读的（只读不回，除非直接问到你）：", ...others.slice(0, summaryChannels).map((r) => "- " + rowText(r)));
  lines.push("", "要回就用 channel_say，target 照抄；要看前面的上下文用 read_chat。不用回的就不回。");
  return lines.join("\n");
}

/** What a busy session is told of messages it has not read. */
export const busyNotice = (rows: readonly UnreadRow[]) =>
  `[群聊提示] 有新消息还没读：${rows.slice(0, summaryChannels).map(rowText).join("；")}。方便的时候用 read_chat 读；不读不代表没事。`;
