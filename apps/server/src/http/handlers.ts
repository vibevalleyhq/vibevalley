import { Effect } from "effect";

import type { Handlers } from "@vibevalley/protocol/api";

import { agentHandlers } from "./handlers/agent.ts";
import { artifactHandlers } from "./handlers/artifact.ts";
import { channelHandlers } from "./handlers/channel.ts";
import { connectorHandlers } from "./handlers/connector.ts";
import { coreHandlers } from "./handlers/core.ts";
import { cronHandlers } from "./handlers/cron.ts";
import { gameHandlers } from "./handlers/game.ts";
import { issueHandlers } from "./handlers/issue.ts";
import { lanHandlers } from "./handlers/lan.ts";
import { mediaHandlers } from "./handlers/media.ts";
import { memoryHandlers } from "./handlers/memory.ts";
import { orchestratorHandlers } from "./handlers/orchestrator.ts";
import { pkmHandlers } from "./handlers/pkm.ts";
import { providerHandlers } from "./handlers/provider.ts";
import { repoHandlers } from "./handlers/repo.ts";
import { runtimeHandlers } from "./handlers/runtime.ts";
import { sessionHandlers } from "./handlers/session.ts";
import { settingHandlers } from "./handlers/setting.ts";
import { userHandlers } from "./handlers/user.ts";
import { voiceHandlers } from "./handlers/voice.ts";

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
    ...(yield* pkmHandlers),
    ...(yield* cronHandlers),
    ...(yield* issueHandlers),
  };
  return done;
});
