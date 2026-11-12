import type { SettingHandlers } from "@vibevalley/protocol/api";

import type { Setting } from "#/platform/setting/setting.ts";

export function settingHandlers(deps: { readonly setting: Setting }): SettingHandlers {
  const { setting } = deps;
  return {
    "setting.get": async () => setting.status(),
    "setting.validate": async (body) => setting.validate(body),
    "setting.update": (body) => setting.save(body),
  };
}
