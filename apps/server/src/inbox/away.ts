import { type ChatMessage, everyone, ownerId, type Notify } from "@vibevalley/protocol";

export function forOwner(m: ChatMessage, notify: Notify = "all"): boolean {
  if (m.from === ownerId || notify === "none") return false;
  if (notify === "mentions") return m.mentions.includes(ownerId) || m.mentions.includes(everyone);
  switch (m.kind) {
    case "report":
    case "dispatch":
      return true;
    case "chat":
      return m.fromKind === "orchestrator" || m.mentions.includes(ownerId) || m.mentions.includes(everyone);
    case "notice":
      break;
  }
  return false;
}
