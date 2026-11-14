export * from "./shapes.gen";

/** Every endpoint is a POST at its op, named as in api.ts. */
export const pathOf = (op: string) => "/api/v1/" + op.replaceAll(".", "/");
