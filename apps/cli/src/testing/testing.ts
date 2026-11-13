/** The command line run in the process (cli.ts), and the whole farm it is run against: apps/server's, or the Rust
 * server's when VIBEVALLEY_SERVER_BIN names its binary. */
import * as ts from "@vibevalley/server/testing";

import { rustFarm } from "./rust.ts";

export { cli } from "./cli.ts";
export { lookIn, memoriesOf } from "@vibevalley/server/testing";

const rust = process.env.VIBEVALLEY_SERVER_BIN;

export const farm = (): Promise<ts.RunningFarm> => (rust ? rustFarm(rust) : ts.farm());
export const workingFarm = (): Promise<ts.RunningFarm> => (rust ? rustFarm(rust) : ts.workingFarm());
