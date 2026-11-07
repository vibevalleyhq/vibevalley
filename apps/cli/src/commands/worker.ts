import { Config, Effect, FileSystem, Schema } from "effect";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { HttpClient, HttpClientRequest } from "effect/http";

import { t } from "@vibevalley/i18n";

import { DryRunFlag, show } from "#/format.ts";
import { exit, Failure } from "#/output.ts";

export const WorkerAccessFlag = GlobalFlag.Setting("worker-access-file")({
  flag: Flag.String("worker-access-file").pipe(Flag.withFallbackConfig(Config.String("VIBEVALLEY_WORKER_ACCESS_FILE")), Flag.withDefault("")),
});
const credentials = Schema.fromJsonString(Schema.Struct({ endpoint: Schema.String, token: Schema.String }));

const response = Schema.Struct({
  result: Schema.optionalKey(
    Schema.Struct({
      isError: Schema.optionalKey(Schema.Boolean),
      content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
    }),
  ),
  error: Schema.optionalKey(Schema.Unknown),
});
const refused = () => new Failure({ code: exit.refused, tag: "WorkerAccess", text: t("cli.worker.failed") });
const operations = {
  report: { tool: "issue_report", about: "cli.worker.report" },
  "pr-submit": { tool: "issue_pr_submit", about: "cli.worker.pr" },
  context: { tool: "channel_message_list", about: "cli.worker.context" },
  read: { tool: "resource_read", about: "cli.worker.read" },
  doctor: { tool: "session_list", about: "cli.worker.doctor" },
} as const;

export const workerCommand = Command.make("worker").pipe(
  Command.withDescription(t("cli.worker.about")),
  Command.withSubcommands(
    Object.entries(operations).map(([name, { tool, about }]) =>
      Command.make(name, { input: Argument.String("json").pipe(Argument.withDefault("{}"), Argument.withDescription(t("cli.worker.json"))) }, ({ input }) =>
        Effect.gen(function* () {
          const file = yield* WorkerAccessFlag;
          if (!file || (yield* DryRunFlag)) return yield* refused();
          const fs = yield* FileSystem.FileSystem;
          const { endpoint, token } = yield* fs.readFileString(file).pipe(Effect.flatMap(Schema.decodeEffect(credentials)), Effect.mapError(refused));
          if (!token || !/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u.test(endpoint)) return yield* refused();
          const args = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))(input).pipe(Effect.mapError(refused));
          const request = yield* HttpClientRequest.bodyJson(HttpClientRequest.post(endpoint), {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: tool, arguments: args },
          });
          const client = yield* HttpClient.HttpClient;
          const reply = yield* client
            .execute(
              request.pipe(
                HttpClientRequest.setHeaders({
                  authorization: "Bearer " + token,
                  accept: "application/json, text/event-stream",
                }),
              ),
            )
            .pipe(Effect.mapError(refused));
          if (reply.status !== 200) return yield* refused();
          const body = yield* reply.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(response)), Effect.mapError(refused));
          if (body.error !== undefined || !body.result) return yield* refused();
          if (body.result.isError === true)
            return yield* new Failure({
              code: exit.refused,
              tag: "WorkerTool",
              text:
                body.result.content
                  .map((item) => item.text)
                  .join("")
                  .replaceAll(token, "[redacted]")
                  .slice(0, 8000) || t("cli.worker.failed"),
            });
          yield* show(body.result, (result) => result.content.map((item) => item.text).join(""));
        }).pipe(Effect.scoped),
      ).pipe(Command.withDescription(t(about))),
    ),
  ),
);
