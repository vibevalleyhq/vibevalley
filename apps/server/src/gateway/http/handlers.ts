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

/** The services every concept's handlers forward to (a Farm has them all). */
export type HandlersDeps = Parameters<typeof coreHandlers>[0] &
  Parameters<typeof orchestratorHandlers>[0] &
  Parameters<typeof gameHandlers>[0] &
  Parameters<typeof voiceHandlers>[0] &
  Parameters<typeof connectorHandlers>[0] &
  Parameters<typeof lanHandlers>[0] &
  Parameters<typeof userHandlers>[0] &
  Parameters<typeof repoHandlers>[0] &
  Parameters<typeof channelHandlers>[0] &
  Parameters<typeof settingHandlers>[0] &
  Parameters<typeof providerHandlers>[0] &
  Parameters<typeof mediaHandlers>[0] &
  Parameters<typeof agentHandlers>[0] &
  Parameters<typeof memoryHandlers>[0] &
  Parameters<typeof runtimeHandlers>[0] &
  Parameters<typeof sessionHandlers>[0] &
  Parameters<typeof artifactHandlers>[0] &
  Parameters<typeof attachmentHandlers>[0] &
  Parameters<typeof pkmHandlers>[0] &
  Parameters<typeof cronHandlers>[0] &
  Parameters<typeof issueHandlers>[0];

/** Every endpoint's answer, put together from each concept's (http/handlers/<concept>.ts). */
export function handlers(deps: HandlersDeps): Handlers {
  return {
    ...coreHandlers(deps),
    ...orchestratorHandlers(deps),
    ...gameHandlers(deps),
    ...voiceHandlers(deps),
    ...connectorHandlers(deps),
    ...lanHandlers(deps),
    ...userHandlers(deps),
    ...repoHandlers(deps),
    ...channelHandlers(deps),
    ...settingHandlers(deps),
    ...providerHandlers(deps),
    ...mediaHandlers(deps),
    ...agentHandlers(deps),
    ...memoryHandlers(deps),
    ...runtimeHandlers(deps),
    ...sessionHandlers(deps),
    ...artifactHandlers(deps),
    ...attachmentHandlers(deps),
    ...pkmHandlers(deps),
    ...cronHandlers(deps),
    ...issueHandlers(deps),
  };
}
