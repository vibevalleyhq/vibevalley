import { t } from "@vibevalley/i18n";
// What the chat apps are sent: which farm messages reach the owner, as plain text, cut
// to what each app takes; a digest of what waited; the pairing words.
import type * as T from "@vibevalley/protocol";

import { slice } from "@/base/clip.ts";

/** In UTF-16 units; longer ones are cut. */
export const maxChars: Record<T.ConnectorID, number> = { weixin: 1800, feishu: 4000, qq: 2000 };

export const digestOver = 3;

export function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/gu, (_, code: string) => code.trimEnd())
    .replace(/`([^`\n]+)`/gu, "$1")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/gu, "[$1] $2")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, "$1 ($2)")
    .replace(/^#{1,6}\s+/gmu, "")
    .replace(/\*\*(.+?)\*\*|__(.+?)__/gu, (_, a?: string, b?: string) => (a ?? "") + (b ?? ""))
    .replace(/(^|[^*])\*([^*\s][^*\n]*?)\*/gu, "$1$2")
    .replace(/^\s*[-*+]\s+/gmu, "· ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** The owner sees one chat, the farm has many threads. */
export function ownerLine(m: T.ChatMessage, where: T.Channel | undefined): string {
  const who = m.fromKind === "orchestrator" ? t("server.connector.line.orchestrator") : m.name;
  const what =
    m.kind === "report"
      ? t(`shared.outcome.${m.outcome ?? "interrupted"}`)
      : m.kind === "dispatch"
        ? t("server.connector.line.dispatch")
        : where?.type === "thread"
          ? t("server.connector.line.thread")
          : "";
  return (what ? t("server.connector.line.headWhat", { who, what }) : t("server.connector.line.head", { who })) + "\n" + plainText(m.text);
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
  return [t("server.connector.digest", { n: lines.length, lines: firstLines.join("\n") })];
}

/** Spaces and the pairing word in front (配对, or pair) allowed, whatever the locale. */
export const isPairing = (text: string, code: string) => {
  const flat = text.replace(/\s+/gu, "");
  const word = /^(?:配对|pair)/iu.exec(flat)?.[0] ?? "";
  return flat.slice(word.length) === code;
};

/** Enough to recognise, not to copy. */
export const shortId = (id: string) => (id.length > 10 ? slice(id, 0, 4) + "…" + slice(id, id.length - 4) : id);
