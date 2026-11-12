import { app as application } from "#/gateway/http/app.ts";
import type { ServerConfig } from "#/infra/config.ts";
import type { ServiceOptions } from "#/services.ts";

import { offlineNetwork } from "./layers.ts";

/** The whole app on the test's network: loopback only. */
export const app = (config: ServerConfig, port: number, listening?: (address: string) => void | Promise<void>, options: ServiceOptions = {}) =>
  application(config, port, listening, { ...options, platform: { ...offlineNetwork, ...options.platform } });
