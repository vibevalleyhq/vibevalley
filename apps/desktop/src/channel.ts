// Which VibeValley this is: one app, one farm and one command a channel, so they open side by side and an alpha never
// touches the farm in daily use (.agents/notes/proposed/feature/2026-11-04-desktop-channels-and-cli.md).

import { homedir } from "node:os";
import { join } from "node:path";

import { defaultHome } from "@vibevalley/home";

import { stageOf } from "./releases";

export type Channel = "stable" | "beta" | "alpha" | "dev";

interface ChannelPlace {
  /** The app's name: the .app, its menu and windows, and its userData folder (so its single-instance lock). */
  readonly name: string;
  readonly appId: string;
  /** What its command line is installed as. */
  readonly command: string;
  /** ~/.vibevalley<suffix> is its farm, ~/vibevalley<suffix> its work folder. */
  readonly suffix: string;
  /** Fixed, as a tunnel and paired phones keep them: ten apart, so channels open side by side. */
  readonly voiceLinePort: number;
  readonly lanPort: number;
}

export const channels: Readonly<Record<Channel, ChannelPlace>> = {
  stable: { name: "VibeValley", appId: "dev.vibevalley.app", command: "vibevalley", suffix: "", voiceLinePort: 8788, lanPort: 8790 },
  beta: { name: "VibeValley Beta", appId: "dev.vibevalley.app.beta", command: "vibevalley-beta", suffix: "-beta", voiceLinePort: 8798, lanPort: 8800 },
  alpha: {
    name: "VibeValley Alpha",
    appId: "dev.vibevalley.app.alpha",
    command: "vibevalley-alpha",
    suffix: "-alpha",
    voiceLinePort: 8808,
    lanPort: 8810,
  },
  dev: { name: "VibeValley Dev", appId: "dev.vibevalley.app.dev", command: "vibevalley-dev", suffix: "-dev", voiceLinePort: 8818, lanPort: 8820 },
};

/** A packaged app is the channel of its version's stage; one run from the repository, or packaged between tags (0.0.0),
 * is dev. */
export function channelOf(version: string, packaged: boolean): Channel {
  if (!packaged || version === "0.0.0") return "dev";
  return stageOf(version) ?? "dev";
}

/** The farm's home: VIBEVALLEY_HOME when the owner set one, else the channel's. */
export const farmHomeOf = (channel: Channel, env: NodeJS.ProcessEnv, home = homedir()) => env.VIBEVALLEY_HOME || defaultHome(channels[channel].suffix, home);

/** What the channel's server starts with: its farm, work folder and ports, each unless the owner set it. */
export function serverEnvOf(channel: Channel, env: NodeJS.ProcessEnv, home = homedir()): NodeJS.ProcessEnv {
  const c = channels[channel];
  return {
    ...env,
    VIBEVALLEY_HOME: farmHomeOf(channel, env, home),
    VIBEVALLEY_WORK_ROOT: env.VIBEVALLEY_WORK_ROOT || join(home, `vibevalley${c.suffix}`),
    VIBEVALLEY_VOICE_LINE_PORT: env.VIBEVALLEY_VOICE_LINE_PORT || String(c.voiceLinePort),
    VIBEVALLEY_LAN_PORT: env.VIBEVALLEY_LAN_PORT || String(c.lanPort),
  };
}
