import { maybe, t } from "@vibevalley/i18n";
import { everyone, defaultOrchestrator, ownerId } from "@vibevalley/protocol";
import { mentionLead } from "@vibevalley/protocol/rules";
// The chat's names for who is not a helper; defaultOrchestrator is filled in where the place is known.
export const chatNamed: Readonly<Record<string, string>> = {
  管家: defaultOrchestrator,
  主人: ownerId,
  所有人: everyone,
  // @manager is what the English page says for the orchestrator (server.channel.mention.orchestrator); @orchestrator already names the
  // default by its profile id.
  manager: defaultOrchestrator,
  owner: ownerId,
  everyone,
};

export const mentionOf = (id: string): string | undefined => maybe(`server.channel.mention.${id}`);

const chatFence = /```[\s\S]*?```/gu;

const chatTick = /`[^`\n]*`/gu;

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Who a place's words can name besides the sessions: its own orchestrator (@管家) and every orchestrator by its profile id. */
export interface Nameable {
  readonly here: string;
  readonly orchestrators: readonly string[];
}

const onlyDefault: Nameable = { here: defaultOrchestrator, orchestrators: [defaultOrchestrator] };

/** Code is not prose: a mention inside backticks or a fence names no one. A name ends where its token ends, so `@w3你看`
 * names w3; the longest name is tried first, so `@agent-12` is not agent-1. */
export function mentionsIn(text: string, names: Nameable = onlyDefault): string[] {
  const pattern = new RegExp(
    `${mentionLead}@(w[0-9]+|${[...names.orchestrators, ...Object.keys(chatNamed)]
      .toSorted((a, b) => b.length - a.length)
      .map(escaped)
      .join("|")})`,
    "gu",
  );
  const prose = text.replace(chatFence, " ").replace(chatTick, " ");
  const found: string[] = [];
  for (const m of prose.matchAll(pattern)) {
    const named = chatNamed[m[1]!];
    const id = named === defaultOrchestrator ? names.here : (named ?? m[1]!);
    if (!found.includes(id)) found.push(id);
  }
  return found;
}

/** No #, : or spaces, so an address reads back. */
const channelNamePattern = /^[\p{L}\p{N}_-]{1,24}$/u;

const chatThreadTarget = /^[\p{L}\p{N}_-]{1,24}:([0-9]+)$/u;

export function channelNameProblem(name: string, taken: readonly string[]): string {
  if (!channelNamePattern.test(name)) return t("server.channel.channelName");
  if (taken.includes(name)) return t("server.channel.channelTaken", { name });
  return "";
}

type ChatTarget =
  | { readonly kind: "channel"; readonly name: string }
  | { readonly kind: "thread"; readonly root: number }
  | { readonly kind: "direct"; readonly peer: string };

const chatDirectTarget = /^@(\S+)$/u;

const int64Max = 9223372036854775807n;

/** A channel's name, a thread's parent number, or @ the one a direct channel is with; a number past int64 is not one. */
export function parseChatTarget(target: string): ChatTarget | undefined {
  const direct = chatDirectTarget.exec(target.trim());
  if (direct) return { kind: "direct", peer: chatNamed[direct[1]!] ?? direct[1]! };
  const text = target.trim().replace(/^#/u, "");
  const m = chatThreadTarget.exec(text);
  if (m) return BigInt(m[1]!) > int64Max ? undefined : { kind: "thread", root: Number(m[1]) };
  return channelNamePattern.test(text) ? { kind: "channel", name: text } : undefined;
}
