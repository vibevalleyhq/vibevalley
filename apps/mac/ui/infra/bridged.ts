// The transport inside the app: the bridge to the Rust server (ui/bridge.ts,
// docs/vibevalley-port.md "Bridge"). Entries that run in the app call
// `useBridge()` once before mounting; stories and tests keep a transport of
// their own.
import { LiveEvent as LiveEventSchema, sliceDecoders } from "@vibevalley/protocol/schema";

import { call, onLive, subscribe, watchSlice } from "./bridge";
import { setTransport, type Transport } from "./transport";

interface ZodIssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

function summarizeZodIssues(issues: readonly ZodIssueLike[]): string {
  if (issues.length === 0) return "unknown schema mismatch";
  const preview = issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length > 0 ? issue.path.map(String).join(".") : "<root>"}: ${issue.message}`)
    .join("; ");
  return issues.length > 5 ? `${preview} (+${issues.length - 5} more)` : preview;
}

function summarizePayload(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value !== "object") return typeof value;
  if (Array.isArray(value)) return `array(len=${value.length})`;
  const tagVal: unknown = Reflect.get(value, "_tag") ?? Reflect.get(value, "kind") ?? Reflect.get(value, "type");
  const keys = Object.keys(value).slice(0, 6).join(",");
  return typeof tagVal === "string" ? `object(tag=${tagVal}, keys=[${keys}])` : `object(keys=[${keys}])`;
}

function reportDecodeFailure(channel: "slice" | "live", target: string, payload: unknown, issues: readonly ZodIssueLike[]): void {
  console.error(`[bridge] dropped malformed ${channel} frame (${target})`, {
    channel,
    target,
    payloadSummary: summarizePayload(payload),
    issues: summarizeZodIssues(issues),
  });
}

const bridged: Transport = {
  call: (op, payload) => call(op, payload ?? null),
  slice: (kind, listener) =>
    watchSlice(kind, (data) => {
      const parsed = sliceDecoders[kind].safeParse(data);
      if (parsed.success) {
        listener(parsed.data);
      } else {
        reportDecodeFailure("slice", kind, data, parsed.error.issues);
      }
    }),
  live: (listener) =>
    onLive((event) => {
      const parsed = LiveEventSchema.safeParse(event);
      if (parsed.success) {
        listener(parsed.data);
      } else {
        reportDecodeFailure("live", "live", event, parsed.error.issues);
      }
    }),
  subscribe: (name, payload, on, ended) => subscribe(name, payload, on, ended),
};

export function useBridge(): void {
  setTransport(bridged);
}
