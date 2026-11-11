import { Effect } from "effect";

import type { Handlers } from "@vibevalley/protocol/api";

import { agentHandlers } from "#/gateway/http/handlers/agent.ts";
import { artifactHandlers } from "#/gateway/http/handlers/artifact.ts";
import { attachmentHandlers } from "#/gateway/http/handlers/attachment.ts";
import { channelHandlers } from "#/gateway/http/handlers/channel.ts";
import { connectorHandlers } from "#/gateway/http/handlers/connector.ts";
import { coreHandlers } from "#/gateway/http/handlers/core.ts";
import { cronHandlers } from "#/gateway/http/handlers/cron.ts";
import { gameHandlers } from "#/gateway/http/handlers/game.ts";
import { issueHandlers } from "#/gateway/http/handlers/issue.ts";
import { lanHandlers } from "#/gateway/http/handlers/lan.ts";
import { libraryHandlers } from "#/gateway/http/handlers/library.ts";
import { mediaHandlers } from "#/gateway/http/handlers/media.ts";
import { memoryHandlers } from "#/gateway/http/handlers/memory.ts";
import { orchestratorHandlers } from "#/gateway/http/handlers/orchestrator.ts";
import { pkmHandlers } from "#/gateway/http/handlers/pkm.ts";
import { providerHandlers } from "#/gateway/http/handlers/provider.ts";
import { repoHandlers } from "#/gateway/http/handlers/repo.ts";
import { runtimeHandlers } from "#/gateway/http/handlers/runtime.ts";
import { sessionHandlers } from "#/gateway/http/handlers/session.ts";
import { settingHandlers } from "#/gateway/http/handlers/setting.ts";
import { userHandlers } from "#/gateway/http/handlers/user.ts";
import { voiceHandlers } from "#/gateway/http/handlers/voice.ts";

/** Every endpoint's answer, put together from each concept's (http/handlers/<concept>.ts). */
export const handlers = Effect.gen(function* () {
  const done: Handlers = {
    ...(yield* coreHandlers),
    ...(yield* orchestratorHandlers),
    ...(yield* gameHandlers),
    ...(yield* voiceHandlers),
    ...(yield* connectorHandlers),
    ...(yield* lanHandlers),
    ...(yield* userHandlers),
    ...(yield* repoHandlers),
    ...(yield* channelHandlers),
    ...(yield* settingHandlers),
    ...(yield* providerHandlers),
    ...(yield* mediaHandlers),
    ...(yield* agentHandlers),
    ...(yield* memoryHandlers),
    ...(yield* runtimeHandlers),
    ...(yield* sessionHandlers),
    ...(yield* artifactHandlers),
    ...(yield* libraryHandlers),
    ...(yield* attachmentHandlers),
    ...(yield* pkmHandlers),
    ...(yield* cronHandlers),
    ...(yield* issueHandlers),
  };
  return done;
});
