import type { ConnectorHandlers } from "@vibevalley/protocol/api";

import type { Connector } from "#/gateway/connector/connector.ts";

export function connectorHandlers(deps: { readonly connector: Connector }): ConnectorHandlers {
  const connectors = deps.connector;
  return {
    "connector.list": () => connectors.list(),
    "connector.login": ({ id, ...body }) => connectors.login(id, body),
    "connector.verify": ({ id, ...body }) => connectors.verify(id, body.code),
    "connector.logout": ({ id }) => connectors.logout(id),
    "connector.channel.set": ({ id, ...body }) => connectors.setChannel(id, body.channel),
  };
}
