import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the reason above
export const asTransport = (transport: object): Transport => transport as Transport;
