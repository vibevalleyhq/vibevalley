// What the chat apps are sent: which farm messages reach the owner, as plain text, cut
// to what each app takes; a digest of what waited; the pairing words.

import { type ChatMessage, type ConnectorID, type Conversation, everyone } from "@vibevalley/protocol";
import { slice } from "../base/text.ts";

/** In UTF-16 units; longer ones are cut. */
export const maxChars: Record<ConnectorID, number> = { weixin: 1800, feishu: 4000, qq: 2000 };

export const digestOver = 3;

/** Only once a message is final: the manager's grow while he speaks. */
export function forOwner(m: ChatMessage): boolean {
  if (!m.final || m.from === "user") return false;
  switch (m.kind) {
    case "report":
    case "dispatch":
      return true;
    case "chat":
      return m.fromKind === "manager" || (m.mentions ?? []).includes("user") || (m.mentions ?? []).includes(everyone);
  }
  return false;
}

export function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code: string) => code.trimEnd())
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "[$1] $2")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a?: string, b?: string) => (a ?? "") + (b ?? ""))
    .replace(/(^|[^*])\*([^*\s][^*\n]*?)\*/g, "$1$2")
    .replace(/^\s*[-*+]\s+/gm, "· ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The owner sees one chat, the farm has many threads. */
export function ownerLine(m: ChatMessage, where: Conversation | undefined): string {
  const who = m.fromKind === "manager" ? "管家" : m.name;
  const what =
    m.kind === "report"
      ? m.outcome === "completed"
        ? "做完了"
        : m.outcome === "failed"
          ? "没做成"
          : "停下了"
      : m.kind === "dispatch"
        ? "派活"
        : where?.kind === "thread"
          ? "在工单串里"
          : "";
  return (what ? `【${who} · ${what}】` : `【${who}】`) + "\n" + plainText(m.text);
}

export function splitText(text: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
    const at = cut * 2 > max ? cut : max;
    pieces.push(slice(rest, 0, at).trimEnd());
    rest = slice(rest, at).trimStart();
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

export function flushText(lines: readonly string[]): string[] {
  if (lines.length <= digestOver) return [...lines];
  const firstLines = lines.map((l) => {
    const [head = "", body = ""] = l.split("\n", 2);
    return head + " " + slice(body, 0, 60) + (body.length > 60 ? "…" : "");
  });
  return [`你不在的时候有 ${lines.length} 条消息：\n${firstLines.join("\n")}\n\n完整的在农场的田头里。`];
}

/** Spaces and a 配对 in front allowed. */
export const isPairing = (text: string, code: string) => {
  const flat = text.replace(/\s+/g, "");
  return (flat.startsWith("配对") ? flat.slice(2) : flat) === code;
};

/** Enough to recognise, not to copy. */
export const shortId = (id: string) => (id.length > 10 ? slice(id, 0, 4) + "…" + slice(id, id.length - 4) : id);
