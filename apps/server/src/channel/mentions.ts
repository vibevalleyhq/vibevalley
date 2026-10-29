import { maybe } from "@vibevalley/i18n";
import { everyone, defaultOrchestrator, ownerId } from "@vibevalley/protocol";
// The chat's names for who is not a helper; defaultOrchestrator is filled in where the place is known.
export const chatNamed: Readonly<Record<string, string>> = {
  管家: defaultOrchestrator,
  主人: ownerId,
  所有人: everyone,
  manager: defaultOrchestrator,
  owner: ownerId,
  everyone,
};

export const mentionOf = (id: string): string | undefined => maybe(`server.channel.mention.${id}`);

const chatFence = /```[\s\S]*?```/g;

const chatTick = /`[^`\n]*`/g;

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
    `(^|[^\\p{L}\\p{N}_@])@(w[0-9]+|${[...names.orchestrators, ...Object.keys(chatNamed)]
      .sort((a, b) => b.length - a.length)
      .map(escaped)
      .join("|")})`,
    "gu",
  );
  const prose = text.replace(chatFence, " ").replace(chatTick, " ");
  const found: string[] = [];
  for (const m of prose.matchAll(pattern)) {
    const named = chatNamed[m[2]!];
    const id = named === defaultOrchestrator ? names.here : (named ?? m[2]!);
    if (!found.includes(id)) found.push(id);
  }
  return found;
}
