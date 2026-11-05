import { Effect } from "effect";

import type { ConnectorHandlers } from "@vibevalley/protocol/api";

import { Connector } from "#/connector/connector.ts";

export const connectorHandlers = Effect.gen(function* () {
  const connectors = yield* Connector;
  const done: ConnectorHandlers = {
    "connector.list": () => connectors.list(),
    "connector.login": ({ id, ...body }) => connectors.login(id, body),
    "connector.verify": ({ id, ...body }) => connectors.verify(id, body.code),
    "connector.logout": ({ id }) => connectors.logout(id),
    "connector.channel.set": ({ id, ...body }) => connectors.setChannel(id, body.channel),
  };
  return done;
});
