import { Effect } from "effect";

import type { Handlers } from "@vibevalley/protocol/api";

import { agentHandlers } from "./http/handlers/agent.ts";
import { artifactHandlers } from "./http/handlers/artifact.ts";
import { channelHandlers } from "./http/handlers/channel.ts";
import { connectorHandlers } from "./http/handlers/connector.ts";
import { coreHandlers } from "./http/handlers/core.ts";
import { cronHandlers } from "./http/handlers/cron.ts";
import { gameHandlers } from "./http/handlers/game.ts";
import { issueHandlers } from "./http/handlers/issue.ts";
import { lanHandlers } from "./http/handlers/lan.ts";
import { memoryHandlers } from "./http/handlers/memory.ts";
import { orchestratorHandlers } from "./http/handlers/orchestrator.ts";
import { pkmHandlers } from "./http/handlers/pkm.ts";
import { projectHandlers } from "./http/handlers/project.ts";
import { runtimeHandlers } from "./http/handlers/runtime.ts";
import { sessionHandlers } from "./http/handlers/session.ts";
import { settingHandlers } from "./http/handlers/setting.ts";
import { voiceHandlers } from "./http/handlers/voice.ts";

/** Every endpoint's answer, put together from each concept's (http/handlers/<concept>.ts). */
export const handlers = Effect.gen(function* () {
  const done: Handlers = {
    ...(yield* coreHandlers),
    ...(yield* orchestratorHandlers),
    ...(yield* gameHandlers),
    ...(yield* voiceHandlers),
    ...(yield* connectorHandlers),
    ...(yield* lanHandlers),
    ...(yield* projectHandlers),
    ...(yield* channelHandlers),
    ...(yield* settingHandlers),
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
