import { type Endpoint } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface SettingHandlers {
  readonly "setting.get": () => Promise<T.SettingsStatus>;
  /** The first thing Save would refuse in these settings, without saving them. */
  readonly "setting.validate": (a: T.SettingsUpdate) => Promise<T.Validation>;
  readonly "setting.update": (a: T.SettingsUpdate) => Promise<T.SettingsStatus>;
}

export const settingEndpoints: readonly Endpoint[] = [
  {
    op: "setting.get",
    about: [],
    input: undefined,
    result: S.SettingsStatus,
    can: ["user", "remote"],
  },
  {
    op: "setting.validate",
    about: [],
    input: S.SettingsUpdate,
    result: S.Validation,
    can: ["user", "remote"],
  },
  {
    op: "setting.update",
    about: [],
    input: S.SettingsUpdate,
    result: S.SettingsStatus,
    can: ["user"],
  },
];
