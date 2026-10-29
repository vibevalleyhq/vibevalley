// The one place the MCP SDK's transports are taken as its Transport. The SDK's classes declare members such as sessionId
// and onclose as `T | undefined` where Transport has them optional, which exactOptionalPropertyTypes refuses; the shapes
// are the SDK's own and fit at run time.

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export const asTransport = (transport: object): Transport => transport as Transport;
