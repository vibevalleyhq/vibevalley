import { type InboxMessage, summaryChannels, type UnreadRow } from "@/mailbox/envelope.ts";

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
  const made = m.artifact ? `\n  │ [稿子「${m.artifact.title}」第 ${m.artifact.version} 稿：id=${m.artifact.id}，原文用 artifact_content_get 读]` : "";
  const quoted = (m.blocks ?? [])
    .map((b) => {
      const now = b.deleted === true ? "已删除" : b.nowRev !== undefined && b.nowRev !== b.rev ? `现在第 ${b.nowRev} 版` : "没变";
      return `\n  │ [指着稿子「${b.title}」的块：artifact=${b.artifactId} block=${b.blockId} 引用时第 ${b.rev} 版，${now}]${b.text ? "\n  │ " + b.text.replaceAll("\n", "\n  │ ") : ""}`;
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

/** A direct talk's opening: the owner chats with this helper alone, with no issue or project behind it. */
export const talkBrief = (name: string, said: string) =>
  `主人在和你（档案「${name}」）私聊。用主人的语言回答，延续这段对话。你有独立的工作目录，可用来保留聊天中的笔记和写出来的东西；这段对话没有关联工单或项目。主人要改一个项目时，先明确项目和要做的事，再用工单安排。\n\n私聊里最近说的，回答最后的问题：\n` +
  said;
