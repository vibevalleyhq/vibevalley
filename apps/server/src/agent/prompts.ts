// What the orchestrator and the splitter read about a profile: said to models, in Chinese whatever the owner's locale.

import type { Agent } from "@vibevalley/protocol";

/** A profile's role and the work it suits, in words: 「职责：…；适合的活：…」, without a half that is not filled in. 适合的活
 * is its tags, which chooseAgent matches and the prompts tell a model to pick by. */
export const traitsOf = (a: Agent) =>
  [...(a.duty ? ["职责：" + a.duty] : []), ...((a.tags ?? []).length > 0 ? ["适合的活：" + a.tags.join("、")] : [])].join("；");
