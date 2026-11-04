// The shapes the server and the page share, one folder per concept (<concept>/shapes.ts): every type on the wire and
// on disk, and the closed sets' members. Each has a Schema in <concept>/schema.ts, typed by it, so the two cannot drift.

export * from "./common/shapes";
export * from "./core/shapes";
export * from "./agent/shapes";
export * from "./runtime/shapes";
export * from "./memory/shapes";
export * from "./project/shapes";
export * from "./session/shapes";
export * from "./mailbox/shapes";
export * from "./channel/shapes";
export * from "./artifact/shapes";
export * from "./pkm/shapes";
export * from "./issue/shapes";
export * from "./cron/shapes";
export * from "./inbox/shapes";
export * from "./orchestrator/shapes";
export * from "./game/shapes";
export * from "./lan/shapes";
export * from "./connector/shapes";
export * from "./voice/shapes";
export * from "./setting/shapes";
