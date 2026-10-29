// How a helper shows in the chat: its phase as a dot, an icon and the server's words, its runtime and its duty.

import { spanText } from "@vibevalley/protocol/rules";

import { actionIcon, type IconName } from "@/ui/icons";
import { type Phase, type SessionView } from "@vibevalley/protocol";
const span = spanText;

/** The server's words for what the session is doing, how long it has been quiet filled in by the clock. */
export function phaseText(h: SessionView, now: number) {
  const words = h.phaseText;
  return h.phase._tag === "working" && h.phase.quietSince !== undefined ? words.replaceAll("{span}", span(now - h.phase.quietSince)) : words;
}

export type DotTone = "leaf" | "berry" | "wheat";

export function phaseDot(p: Phase): DotTone {
  switch (p._tag) {
    case "working":
    case "arriving":
      return "leaf";
    case "failed":
      return "berry";
    case "done":
    case "resting":
    case "closed":
      return "wheat";
  }
}

/** The sprite for a phase; undefined draws nothing. */
export function phaseIcon(p: Phase): IconName | undefined {
  switch (p._tag) {
    case "arriving":
      return "send";
    case "working":
      return p.doing.action === "none" ? undefined : actionIcon[p.doing.action];
    case "done":
      return "check";
    case "failed":
      return "cross";
    case "resting":
      return "wait";
    case "closed":
      return p.closed === "merged" ? "check" : "wait";
  }
}

export const runtimeLabel: Record<string, string> = { claude: "Claude", codex: "Codex" };

/** A profile's duty up to its first stop, at most 18 characters. */
export function dutyShort(duty: string) {
  const first = duty.split(/[，。,.]/)[0] ?? "";
  return first.length > 18 ? first.slice(0, 18) : first;
}
