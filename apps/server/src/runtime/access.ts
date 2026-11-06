import type { Session as RuntimeSession, SessionOptions } from "@botiverse/oar";
import { Option, Schema } from "effect";

import type * as T from "@vibevalley/protocol";

import { redact, redactedHead } from "#/base/redact.ts";

export function loopbackEnvironment<Env extends SessionOptions["env"]>(
  env: Env,
  inherited: { readonly NO_PROXY?: string; readonly no_proxy?: string },
  refused?: string,
) {
  if (refused !== undefined) return env;
  const bypass = [
    ...new Set(
      [inherited.NO_PROXY ?? "", inherited.no_proxy ?? "", env?.NO_PROXY ?? "", env?.no_proxy ?? "", "127.0.0.1,localhost,::1"].flatMap((value) =>
        value
          .split(",")
          .map((host) => host.trim())
          .filter(Boolean),
      ),
    ),
  ].join(",");
  return { ...env, NO_PROXY: bypass, no_proxy: bypass };
}

const startupStatus = Schema.decodeUnknownOption(
  Schema.Struct({
    name: Schema.String,
    threadId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    status: Schema.Literals(["starting", "ready", "failed", "cancelled"]),
    error: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);

export function observeToolConnections(
  session: Pick<RuntimeSession, "id" | "rawEvents">,
  runtime: string,
  servers: readonly string[],
  observed: (connection: T.ToolConnection) => void,
) {
  for (const server of servers) observed({ server, status: "unknown" });
  if (runtime !== "codex") return () => {};
  return session.rawEvents(
    (record) => {
      if (record.kind !== "frame" || record.sessionId !== session.id || record.agentPath.length !== 0 || record.body.type !== "mcpServer/startupStatus/updated")
        return;
      const decoded = startupStatus(record.body.native);
      if (Option.isNone(decoded) || !servers.includes(decoded.value.name)) return;
      const { name, status, error, threadId } = decoded.value;
      if (threadId !== undefined && threadId !== null && threadId !== session.id) return;
      observed({ server: name, status, ...(error ? { reason: redactedHead(redact(error), 2000) } : {}) });
    },
    { sessionId: session.id, afterSeq: -1 },
  );
}
