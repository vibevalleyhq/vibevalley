import { t } from "@vibevalley/i18n";

import { type Agent, everyone, defaultOrchestrator, ownerId, type Session, type SessionView } from "@vibevalley/protocol";
import { phaseText } from "./presence";
export const mentionOf: Record<string, string> = {
  [defaultOrchestrator]: t("web.channel.names.mention.orchestrator"),
  [ownerId]: t("web.channel.names.mention.owner"),
  [everyone]: t("web.channel.names.mention.everyone"),
};

export interface Nameable {
  token: string;
  name: string;
  note: string;
  session?: Session;
  /** An orchestrator's profile id. */
  orchestrator?: string;
}

export const menuMax = 6;

/** The place's orchestrator (here) is @管家, every other orchestrator its @<profile id>; everyone only when there is
 * more than one helper. */
export const nameables = (sessions: SessionView[], orchestrators: readonly Agent[], here: string, now: number): Nameable[] => [
  ...sessions.map((h) => ({ token: `@${h.id}`, name: h.name, note: phaseText(h, now), session: h })),
  {
    token: mentionOf[defaultOrchestrator]!,
    name: orchestrators.find((a) => a.id === here)?.name || t("web.base.orchestrator"),
    note: t("web.channel.names.orchestratorNote"),
    orchestrator: here,
  },
  ...orchestrators
    .filter((a) => a.id !== here)
    .map((a) => ({ token: `@${a.id}`, name: a.name, note: a.duty || t("web.channel.names.orchestratorNote"), orchestrator: a.id })),
  ...(sessions.length > 1 ? [{ token: mentionOf[everyone]!, name: t("web.channel.names.everyone"), note: t("web.channel.names.everyoneNote") }] : []),
];

export const typed = /(^|[^\p{L}\p{N}_@])@([\p{L}\p{N}_]*)$/u;

/** The @name being typed before the caret: where its @ is and what follows it. */
export function typedName(text: string, caret: number) {
  if (caret < 0 || caret > text.length) return undefined;
  const m = typed.exec(text.slice(0, caret));
  if (!m) return undefined;
  const query = m[2] ?? "";
  return { start: caret - query.length - 1, query };
}

export function offeredFor(all: Nameable[], query: string) {
  const q = query.toLowerCase();
  return all.filter((n) => n.token.slice(1).toLowerCase().startsWith(q) || n.name.toLowerCase().includes(q)).slice(0, menuMax);
}

export function insertName(text: string, caret: number, start: number, token: string) {
  const next = `${text.slice(0, start)}${token} ${text.slice(Math.min(Math.max(caret, start), text.length))}`;
  return { text: next, caret: start + token.length + 1 };
}

/** @tokens in a message's text, as the chat draws them apart. */
export const mentionPattern = /(^|[^\p{L}\p{N}_@])(@[\p{L}\p{N}_-]+)/gu;
