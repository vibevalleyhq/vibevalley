import { Effect } from "effect";

import type { SettingHandlers } from "@vibevalley/protocol/api";

import { refused } from "#/base/errors.ts";
import { Setting } from "#/setting/setting.ts";

export const settingHandlers = Effect.gen(function* () {
  const setting = yield* Setting;
  const done: SettingHandlers = {
    "setting.get": () => Effect.sync(setting.status),
    "setting.validate": (body) => Effect.sync(() => setting.validate(body)),
    "setting.update": (body) => setting.save(body).pipe(Effect.mapError((e) => refused(e.message))),
  };
  return done;
});
