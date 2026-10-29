// The core state's projection, given to the core at assembly: the fold, the effects and the frame read every module's
// rules, so they sit with the assembly, above every module.

import { Layer } from "effect";
import { Projection } from "@/core/core.ts";
import { withStations } from "@/game/play.ts";
import { effectsOf } from "@/game/view.ts";
import { frameOf } from "./frame.ts";
import { reduce } from "./reduce.ts";

export const layer = Layer.succeed(Projection, { reduce, effects: effectsOf, frame: frameOf, restore: withStations });
