export * from "./shapes.gen";

/** Served over GET because <iframe src> cannot POST. */
export const artifactPrefix = "/api/v1/artifact/";
export const artifactPath = (id: string, version: number) => `${artifactPrefix}${id}/${version}`;

export type HtmlShellCommand = { vibevalley: "goto"; page: number } | { vibevalley: "seek"; time: number } | { vibevalley: "play" } | { vibevalley: "pause" };
