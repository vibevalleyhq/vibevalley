import type { Session as RuntimeSession, SessionOptions } from "@botiverse/oar";
import { z } from "zod";

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

const StartupStatus = z.object({
  name: z.string(),
  threadId: z.exactOptional(z.string().nullable()),
  status: z.enum(["starting", "ready", "failed", "cancelled"]),
  error: z.exactOptional(z.string().nullable()),
});

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
      const decoded = StartupStatus.safeParse(record.body.native);
      if (!decoded.success || !servers.includes(decoded.data.name)) return;
      const { name, status, error, threadId } = decoded.data;
      if (threadId !== undefined && threadId !== null && threadId !== session.id) return;
      observed({ server: name, status, ...(error ? { reason: redactedHead(redact(error), 2000) } : {}) });
    },
    { sessionId: session.id, afterSeq: -1 },
  );
}
