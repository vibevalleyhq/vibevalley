export * from "./shapes.gen";

/** The built-in orchestrator's profile id. */
export const defaultOrchestrator = "orchestrator";

/** The runtime of VibeValley's own agent: the only one an orchestrator runs on. */
export const orchestratorRuntime = "vibevalley";

/** The user's participant id: who the user mention is. */
export const userId = "user";

/** Who the everyone mention is. */
export const everyone = "everyone";

/** Sessions working at once; also the beds on the farm. */
export const maxRunning = 6;

/** Times are Unix milliseconds. */
export const dayMs = 86400000;
