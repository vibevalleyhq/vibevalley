export * from "./shapes.gen";

/** Every endpoint is a POST at its op, named as in api.ts. */
export const pathOf = (op: string) => "/api/v1/" + op.replaceAll(".", "/");

/** The three long-lived streams; the client asks for them by path. */
export const statePath = "/api/v1/state";

export const eventsPath = "/api/v1/events";

export const livePath = "/api/v1/live";
