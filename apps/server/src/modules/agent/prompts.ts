import type * as T from "@vibevalley/protocol";

// What the orchestrator and the splitter read about a profile: said to models, in Chinese whatever the user's locale.
/** A profile's role and the work it suits, in words: duty and tags, without a half that is not filled in. */
export const traitsOf = (a: T.Agent) => [...(a.duty ? ["职责：" + a.duty] : []), ...(a.tags.length > 0 ? ["适合的活：" + a.tags.join("、")] : [])].join("；");
