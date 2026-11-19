export * from "./shapes.gen";

/** Served over GET because <iframe src> cannot POST. */
const artifactPrefix = "/api/v1/artifact/";
export const artifactPath = (id: string, version: number) => `${artifactPrefix}${id}/${version}`;
export const artifactViewPath = (id: string) => `${artifactPrefix}${id}/view`;
