import { t } from "@vibevalley/i18n";
import { type Chat, type Channel, type Issue, type Session } from "@vibevalley/protocol";

import { compareText, or } from "@/base/order";

import { channelLabel, channelName, topOf } from "./places";
import { threadTitle } from "./threads";
import { unreadIn, unreadUnder } from "./unread";

export interface SwitchTarget {
  readonly kind: "channel" | "direct" | "thread" | "profile";
  /** The channel's id; a profile's id for one with no direct channel yet. */
  readonly id: string;
  readonly label: string;
  /** Where it is or what picking it does: a channel's group, a thread's channel. */
  readonly hint: string;
  readonly unread: number;
  /** When it was last talked in, newest first among equals. */
  readonly at: number;
}

const switchMax = 12;

/** The places for what is typed: `#` keeps channels and threads, `@` direct channels and profiles; the rest matches the
 * name anywhere, a name starting with it first, then the unread, then the newest talked in. Archived places are left out. */
export function switchTargets(
  chat: Chat | undefined,
  query: string,
  named: { readonly issues?: Issue[]; readonly sessions?: Session[]; readonly profiles?: readonly { id: string; name: string }[] } = {},
): SwitchTarget[] {
  const all = (chat?.channels ?? []).filter((c) => c.archived === undefined);
  const at = (c: Channel) => c.last?.at ?? c.at;
  const peers = new Set(all.filter((c) => c.type === "direct").map((c) => c.peer));
  const targets: SwitchTarget[] = [
    ...all.map((c): SwitchTarget => {
      switch (c.type) {
        case "channel":
          return { kind: "channel", id: c.id, label: `#${channelName(c)}`, hint: c.category, unread: unreadUnder(chat, c), at: at(c) };
        case "direct":
          return { kind: "direct", id: c.id, label: `@${channelName(c)}`, hint: t("web.channel.switcher.direct"), unread: unreadIn(c), at: at(c) };
        case "thread":
          return {
            kind: "thread",
            id: c.id,
            label: threadTitle(c, named.issues, named.sessions),
            hint: channelLabel(topOf(chat, c)),
            unread: unreadIn(c),
            at: at(c),
          };
      }
    }),
    ...(named.profiles ?? [])
      .filter((p) => !peers.has(`profile:${p.id}`))
      .map((p): SwitchTarget => ({ kind: "profile", id: p.id, label: `@${p.name}`, hint: t("web.channel.switcher.newDirect"), unread: 0, at: 0 })),
  ];
  const typed = query.trim().toLowerCase();
  const only = typed.startsWith("#") ? "hash" : typed.startsWith("@") ? "at" : undefined;
  const words = only ? typed.slice(1) : typed;
  const kept = targets.filter((target) => {
    if (only === "hash" && target.kind !== "channel" && target.kind !== "thread") return false;
    if (only === "at" && target.kind !== "direct" && target.kind !== "profile") return false;
    return target.label.toLowerCase().includes(words);
  });
  const starts = (target: SwitchTarget) => (words !== "" && target.label.toLowerCase().replace(/^[#@]/u, "").startsWith(words) ? 0 : 1);
  return kept.toSorted((a, b) => or(starts(a) - starts(b), b.unread - a.unread, b.at - a.at, compareText(a.id, b.id))).slice(0, switchMax);
}
