import { readFile } from "node:fs/promises";

import { z } from "zod";

import { t } from "@vibevalley/i18n";

import { show } from "#/base/format.ts";
import { exit, Failure } from "#/base/output.ts";
import { arg, command, group, type Spec } from "#/infra/command.ts";

const Credentials = z.object({ endpoint: z.string(), token: z.string() });

const Response = z.object({
  result: z.exactOptional(
    z.object({
      isError: z.exactOptional(z.boolean()),
      content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
    }),
  ),
  error: z.exactOptional(z.unknown()),
});
const refused = () => new Failure({ code: exit.refused, tag: "WorkerAccess", text: t("cli.worker.failed") });
const operations = {
  report: { tool: "issue_report", about: "cli.worker.report" },
  "pr-submit": { tool: "issue_pr_submit", about: "cli.worker.pr" },
  context: { tool: "channel_message_list", about: "cli.worker.context" },
  read: { tool: "resource_read", about: "cli.worker.read" },
  doctor: { tool: "session_list", about: "cli.worker.doctor" },
} as const;

/** text as JSON decoded by schema; any failure (unreadable, not JSON, not that shape) is the same refusal, saying nothing of why. */
const decodedOr = <A>(schema: z.ZodType<A>, text: string): A => {
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    // Said as one refusal: the credential's contents are never echoed.
    throw refused();
  }
};

export const workerCommand: Spec = group(
  "worker",
  t("cli.worker.about"),
  Object.entries(operations).map(([name, { tool, about }]) =>
    command(name, {
      about: t(about),
      params: { input: arg.textOr("json", "{}", "cli.worker.json") },
      run: async ({ input }, ctx) => {
        const file = ctx.flags.workerAccessFile;
        if (!file || ctx.flags.dryRun) throw refused();
        const text = await readFile(file, "utf8").catch(() => {
          throw refused();
        });
        const { endpoint, token } = decodedOr(Credentials, text);
        if (!token || !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u.test(endpoint)) throw refused();
        const args = decodedOr(z.record(z.string(), z.unknown()), input);
        let reply: globalThis.Response;
        try {
          reply = await ctx.fetch(endpoint, {
            method: "POST",
            headers: { authorization: "Bearer " + token, accept: "application/json, text/event-stream", "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
            signal: ctx.signal,
          });
        } catch {
          // Unreachable: the same refusal, without the endpoint's details.
          throw refused();
        }
        if (reply.status !== 200) throw refused();
        const body = decodedOr(Response, await reply.text().catch(() => ""));
        if (body.error !== undefined || !body.result) throw refused();
        if (body.result.isError === true)
          throw new Failure({
            code: exit.refused,
            tag: "WorkerTool",
            text:
              body.result.content
                .map((item) => item.text)
                .join("")
                .replaceAll(token, "[redacted]")
                .slice(0, 8000) || t("cli.worker.failed"),
          });
        show(ctx, body.result, (result) => result.content.map((item) => item.text).join(""));
      },
    }),
  ),
);
