import { t } from "@vibevalley/i18n";
import type { Channel, ChatMessage, DocBlock, NoteType } from "@vibevalley/protocol";

import type { PendingNewIssueDraft } from "../../../infra/state/issueDraft";
import { channelLabel } from "./places";

/** Canonical route back-link to a specific channel message. */
export function messageSourcePath(m: Pick<ChatMessage, "channel" | "number">): string {
  return `/chat/${encodeURIComponent(m.channel)}?m=${m.number}`;
}

function sourceWhere(m: Pick<ChatMessage, "channel" | "number">, channel: Channel | undefined): string {
  return `${channelLabel(channel)} #${m.number}`;
}

function sourceBackLinkLine(m: Pick<ChatMessage, "channel" | "number">, channel: Channel | undefined): string {
  const where = sourceWhere(m, channel);
  return `[${t("web.channel.promote.source", { where })}](${messageSourcePath(m)})`;
}

function deriveTitle(m: ChatMessage): string {
  const firstLine = m.text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.replace(/^#+\s+/u, "");
  if (firstLine) return firstLine.slice(0, 80);
  const firstFile = m.attachments[0]?.name.trim();
  if (firstFile) return firstFile.slice(0, 80);
  return t("web.channel.promote.fallbackTitle", { number: m.number });
}

/** Builds a prefilled issue draft carrying message body, attachments, and `/chat/<channel>?m=<seq>` back-link. */
export function buildPromotedIssueDraft(m: ChatMessage, channel: Channel | undefined): PendingNewIssueDraft {
  const body = m.text.trim();
  const titleFallback = m.attachments[0]?.name.trim() || t("web.channel.promote.fallbackTitle", { number: m.number });
  const text = `${body || titleFallback}\n\n${sourceBackLinkLine(m, channel)}`;
  return {
    text,
    attachmentFiles: [...m.attachments],
    ...(channel?.repo ? { repo: channel.repo } : {}),
  };
}

/** Builds a prefilled note draft carrying message body, Markdown attachment links, and `/chat/<channel>?m=<seq>` back-link. */
export function buildPromotedNoteDraft(
  m: ChatMessage,
  channel: Channel | undefined,
): { readonly title: string; readonly content: string; readonly note: string; readonly backLink: string } {
  const where = sourceWhere(m, channel);
  const backLink = messageSourcePath(m);
  const body = m.text.trim();
  const attachmentLines = m.attachments.map((a) =>
    a.type.startsWith("image/") ? `![${a.name}](/api/v1/attachment/${a.id})` : `[${a.name}](/api/v1/attachment/${a.id})`,
  );
  const content = [body, attachmentLines.join("\n"), `> ${sourceBackLinkLine(m, channel)}`].filter(Boolean).join("\n\n");
  return {
    title: deriveTitle(m),
    content,
    note: t("web.channel.promote.noteNote", { where }),
    backLink,
  };
}

/** Converts Markdown lines into a canonical `DocDocument` (`structure/doc.json`) payload. */
export function markdownToDocJson(markdown: string): string {
  const blocks: DocBlock[] = [];
  let seq = 1;
  const nextId = () => `b${seq++}`;
  const lines = markdown.split(/\r?\n/u);
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (trimmed === "") {
      i += 1;
      continue;
    }
    if (trimmed === "---" || trimmed === "***") {
      blocks.push({ id: nextId(), type: "divider" });
      i += 1;
      continue;
    }
    if (trimmed.startsWith("```")) {
      const lang = trimmed.slice(3).trim();
      i += 1;
      const codeLines: string[] = [];
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith("```")) {
        codeLines.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ id: nextId(), type: "code", ...(lang ? { language: lang } : {}), code: codeLines.join("\n") });
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/u.exec(trimmed);
    if (heading) {
      blocks.push({ id: nextId(), type: "heading", level: heading[1]?.length ?? 1, text: heading[2]?.trim() ?? "" });
      i += 1;
      continue;
    }
    const todo = /^[-*]\s+\[([ xX])\]\s*(.*)$/u.exec(trimmed);
    if (todo) {
      blocks.push({ id: nextId(), type: "todo", checked: todo[1]?.toLowerCase() === "x", text: todo[2]?.trim() ?? "" });
      i += 1;
      continue;
    }
    if (/^[-*]\s+/u.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+(?!\[[ xX]\])/u.test((lines[i] ?? "").trim())) {
        items.push((lines[i] ?? "").trim().replace(/^[-*]\s+/u, ""));
        i += 1;
      }
      blocks.push({ id: nextId(), type: "list", ordered: false, items });
      continue;
    }
    if (/^\d+\.\s+/u.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/u.test((lines[i] ?? "").trim())) {
        items.push((lines[i] ?? "").trim().replace(/^\d+\.\s+/u, ""));
        i += 1;
      }
      blocks.push({ id: nextId(), type: "list", ordered: true, items });
      continue;
    }
    if (trimmed.startsWith("> ") || trimmed === ">") {
      const quoteLines: string[] = [];
      while (i < lines.length && ((lines[i] ?? "").trim().startsWith("> ") || (lines[i] ?? "").trim() === ">")) {
        quoteLines.push((lines[i] ?? "").trim().replace(/^>\s?/u, ""));
        i += 1;
      }
      blocks.push({ id: nextId(), type: "quote", text: quoteLines.join("\n") });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const cur = (lines[i] ?? "").trim();
      if (
        cur === "" ||
        cur === "---" ||
        cur === "***" ||
        cur.startsWith("```") ||
        /^#{1,3}\s+/u.test(cur) ||
        /^[-*]\s+/u.test(cur) ||
        /^\d+\.\s+/u.test(cur) ||
        cur.startsWith(">")
      ) {
        break;
      }
      para.push(lines[i] ?? "");
      i += 1;
    }
    blocks.push({ id: nextId(), type: "prose", text: para.join("\n") });
  }

  return `${JSON.stringify({ version: 1, blocks }, null, 2)}\n`;
}

/** Builds the canonical entry JSON payload for promoting channel text into any of the 4 `NoteType` primitives. */
export function buildPromotedNoteContent(input: { readonly title: string; readonly noteType: NoteType; readonly content: string }): string {
  switch (input.noteType) {
    case "doc":
      return markdownToDocJson(input.content);
    case "base":
      return `${JSON.stringify(
        {
          version: 1,
          sheets: [
            {
              id: "sheet1",
              name: input.title,
              columns: [
                { id: "c_title", name: "Title", kind: "text", width: 240 },
                { id: "c_notes", name: "Notes", kind: "text", width: 360 },
              ],
              rows: [
                {
                  id: "r1",
                  cells: {
                    c_title: { _tag: "text", value: input.title },
                    c_notes: { _tag: "text", value: input.content },
                  },
                  createdAt: 0,
                  updatedAt: 0,
                },
              ],
              views: [{ id: "v_table", name: "Table", kind: "table" }],
            },
          ],
        },
        null,
        2,
      )}\n`;
    case "canvas":
      return `${JSON.stringify(
        {
          version: 1,
          grid: "architectural",
          theme: "warm",
          viewport: { x: 0, y: 0, zoom: 1 },
          elements: {
            t1: { id: "t1", type: "text", variant: "title", x: 80, y: 40, w: 640, h: 54, label: input.title },
            c1: { id: "c1", type: "sticky", x: 80, y: 120, w: 420, h: 220, label: input.title, body: input.content },
          },
        },
        null,
        2,
      )}\n`;
    case "media":
      return `${JSON.stringify(
        {
          version: 1,
          title: input.title,
          mediaKind: "audio",
          caption: input.content,
          durationSec: null,
          posterAsset: null,
          items: [],
        },
        null,
        2,
      )}\n`;
  }
}
