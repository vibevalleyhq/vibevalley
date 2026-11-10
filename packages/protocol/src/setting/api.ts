import { type Effect } from "effect";

import { type ApiError, type Endpoint } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface SettingHandlers<R = never> {
  readonly "setting.get": () => Effect.Effect<T.SettingsStatus, ApiError, R>;
  /** The first thing Save would refuse in these settings, without saving them. */
  readonly "setting.validate": (a: T.SettingsUpdate) => Effect.Effect<T.Validation, ApiError, R>;
  readonly "setting.update": (a: T.SettingsUpdate) => Effect.Effect<T.SettingsStatus, ApiError, R>;
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
