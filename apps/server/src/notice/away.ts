// What of the farm's talk reaches the owner away from the farm, by way of the chat apps.

import { type ChatMessage, everyone, ownerId, type Notify } from "@vibevalley/protocol";

/** What of the farm's talk reaches the owner off the farm (the chat apps): reports, dispatches, the orchestrator's words
 * and what names the owner or everyone; from a place set to mentions, only what names them; from one set to none, nothing. */
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
