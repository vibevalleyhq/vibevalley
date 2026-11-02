import { type InboxMessage, summaryChannels, type UnreadRow } from "@/base/chat.ts";

export const handbackWords = (orchestrator: string, issue: number, reason: string, uri: string) =>
  `@${orchestrator} #${issue} 的这条输入超出当前授权范围，请重新分流。帮工说明（不扩大主人授权）：${reason.slice(0, 600)}\n${uri}`;
export const releasedInputWords = (orchestrator: string, issue: number, uri: string) =>
  `@${orchestrator} #${issue} 关闭时还有一条未被本轮处理的人类输入，请重新分流。\n${uri}`;

/** Line breaks are marked, so no message can pass for a header. */
export function messageLine(m: InboxMessage): string {
  const from = m.fromKind === "session" ? m.from + " " + m.name : m.name;
  const head =
    m.number === 0
      ? `[input=${m.id} from=${from}]`
      : `[target=${m.target} msg=${m.number}${m.replyTo !== undefined ? ` reply=${m.replyTo}` : ""} from=${from}]`;
  if (m.deleted === true) return head + " （这条已删除）";
  const files = (m.attachments ?? []).map((a) => `\n  │ [附件 ${a.name}：${a.path}]`).join("");
  const made = m.artifact ? `\n  │ [产出「${m.artifact.title}」第 ${m.artifact.version} 版：id=${m.artifact.id}，原文用 artifact_content_get 读]` : "";
  const quoted = (m.blocks ?? [])
    .map((b) => {
      const now = b.deleted === true ? "已删除" : b.nowRev !== undefined && b.nowRev !== b.rev ? `现在第 ${b.nowRev} 版` : "没变";
      return `\n  │ [指着产出「${b.title}」的块：artifact=${b.artifactId} block=${b.blockId} 引用时第 ${b.rev} 版，${now}]${b.text ? "\n  │ " + b.text.replaceAll("\n", "\n  │ ") : ""}`;
    })
    .join("");
  return `${head}${m.edited === true ? "（改过）" : ""} ${m.text.trim().replaceAll("\n", "\n  │ ")}${files}${made}${quoted}`;
}

export const inboxLines = (messages: readonly InboxMessage[]) => messages.map(messageLine).join("\n");

const rowText = (r: UnreadRow) => `${r.target} ${r.unread} 条` + (r.mentionsYou ? "（提到了你）" : "") + (r.latest ? "，最后是 " + r.latest : "");

/** Every acknowledged input is included; only the unrelated unread summary is bounded here. */
export function wakeInput(messages: readonly InboxMessage[], others: readonly UnreadRow[]): string {
  const lines = [`[输入] 有 ${messages.length} 条给你的新消息：`, ...messages.map(messageLine)];
  if (others.length > 0) lines.push("", "别处还有没读的（只读不回，除非直接问到你）：", ...others.slice(0, summaryChannels).map((r) => "- " + rowText(r)));
  lines.push(
    "",
    "聊天回复用 channel_message_send，id 照抄 target；聊天上下文用 channel_message_list。vv:// 指针用 resource_read 读，不是聊天地址。不用回的就不回。",
  );
  return lines.join("\n");
}
