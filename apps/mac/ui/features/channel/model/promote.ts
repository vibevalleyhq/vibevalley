import { t } from "@vibevalley/i18n";
import type { Channel, ChatMessage, NoteType } from "@vibevalley/protocol";

import type { PendingNewIssueDraft } from "../../../infra/state/issueDraft";
import { buildDocFromMarkdown } from "../../note";
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

/** Builds the canonical entry JSON payload for promoting channel text into any of the 4 `NoteType` primitives. */
export function buildPromotedNoteContent(input: { readonly title: string; readonly noteType: NoteType; readonly content: string }): string {
  switch (input.noteType) {
    case "doc":
      return `${JSON.stringify(buildDocFromMarkdown(input.title, input.content, { fallbackTitle: false }), null, 2)}\n`;
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
