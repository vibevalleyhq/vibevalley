import { t } from "@vibevalley/i18n";

import { chatNamed } from "./mentions.ts";
/** No #, : or spaces, so an address reads back. */
const channelNamePattern = /^[\p{L}\p{N}_-]{1,24}$/u;

const chatThreadTarget = /^[\p{L}\p{N}_-]{1,24}:([0-9]+)$/u;

export function channelNameProblem(name: string, taken: readonly string[]): string {
  if (!channelNamePattern.test(name)) return t("server.channel.channelName");
  if (taken.includes(name)) return t("server.channel.channelTaken", { name });
  return "";
}

export type ChatTarget =
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
