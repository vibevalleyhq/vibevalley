// The farm's services, composed in order: each is built from those before it, and what goes the other way is news on
// a stream.

import { Layer } from "effect";
import { layer as agent } from "./agent/agent.ts";
import { type Config, Settings } from "./base/config.ts";
import { Database } from "./base/db.ts";
import { layer as core } from "./core/core.ts";
import { layer as channel } from "./channel/chat.ts";
import { layer as doc } from "./doc/doc.ts";
import { layer as issue } from "./issue/issue.ts";
import { layer as memory } from "./memory/memory.ts";
import { layer as project, start as projectStart } from "./project/project.ts";
import { layer as runtime } from "./runtime/runtime.ts";
import { layer as session, ready as sessionReady } from "./session/session.ts";
import { layer as schedule, start as scheduleStart } from "./schedule/schedule.ts";
import { layer as setting } from "./setting/setting.ts";
import { layer as task } from "./task/task.ts";
import { layer as tool } from "./tool/tool.ts";
import { layer as mcp } from "./mcp/mcp.ts";
import { layer as manager } from "./manager/manager.ts";
import { layer as game, start as gameStart } from "./game/game.ts";
import { layer as lan, type LanOptions } from "./lan/lan.ts";
import { layer as voice } from "./voice/voice.ts";
import { layer as connector } from "./connector/connector.ts";

/** Builds layer on what is below it, keeping what is below. */
const on =
  <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  <B, E2, R2>(below: Layer.Layer<B, E2, R2>) =>
    layer.pipe(Layer.provideMerge(below));

/** In build order, each on those before it; then what runs once all are built: what starts, then what is ready.
 * options: what a test changes. */
export const services = (config: Config, options: { readonly lan?: LanOptions } = {}) =>
  Database.pipe(
    Layer.provideMerge(Layer.succeed(Settings, config)),
    on(core),
    on(setting),
    on(agent),
    on(project()),
    on(memory),
    on(doc()),
    on(runtime()),
    on(session()),
    on(channel),
    on(schedule()),
    on(issue()),
    on(task()),
  ).pipe(
    on(tool),
    on(mcp()),
    on(manager()),
    on(lan(options.lan)),
    on(voice()),
    on(connector()),
    on(game),
    on(projectStart),
    on(sessionReady),
    on(scheduleStart),
    on(gameStart),
  );
