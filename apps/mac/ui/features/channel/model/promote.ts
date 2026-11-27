import { t } from "@vibevalley/i18n";
import type { Channel, ChatMessage } from "@vibevalley/protocol";

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

/** Builds a prefilled artifact draft carrying message body, Markdown attachment links, and `/chat/<channel>?m=<seq>` back-link. */
export function buildPromotedArtifactDraft(
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
    note: t("web.channel.promote.artifactNote", { where }),
    backLink,
  };
}
