import { type RunTriggerKind } from "@vibevalley/protocol";

import { sourceHead } from "./prompts.ts";

/** Who woke the orchestrator: what the input's words are worth. */
export type Source =
  /** The owner's words alone: in a channel, on a call, over chat/completions, from a connector. */
  | "owner"
  /** A channel or a thread with a helper's words in it. */
  | "chat"
  | "issue"
  | "cron"
  | "patrol"
  | "graph";

/** How an input of each source goes in. head: its first words, fixed per source so that the conversation's prefix stays
 * the same, and how its log names the round. now: it joins the run under way (the owner waits on it); else it waits until
 * the run would stop. trigger: what its run is started by, unless the input brings its own. */
export const intake: Readonly<Record<Source, { readonly head: string; readonly now: boolean; readonly trigger: RunTriggerKind }>> = {
  owner: { head: sourceHead.owner, now: true, trigger: "comment" },
  chat: { head: sourceHead.chat, now: false, trigger: "comment" },
  issue: { head: sourceHead.issue, now: false, trigger: "issue" },
  cron: { head: sourceHead.cron, now: false, trigger: "cron" },
  patrol: { head: sourceHead.patrol, now: false, trigger: "runtime" },
  graph: { head: sourceHead.graph, now: false, trigger: "runtime" },
};
