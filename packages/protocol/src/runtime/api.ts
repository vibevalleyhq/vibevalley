import { z } from "zod";

import { type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface RuntimeHandlers {
  readonly "runtime.list": () => Promise<T.RuntimeInfo[]>;
  readonly "runtime.refresh": (a: { readonly id: string }) => Promise<T.RuntimeInfo>;
  readonly "runtime.setting.update": (a: { readonly id: string } & T.RuntimeSettings) => Promise<T.RuntimeInfo>;
  readonly "runtime.mcp.list": (a: T.McpListInput) => Promise<T.McpListResult>;
  readonly "runtime.mcp.install": (a: T.McpInstallInput) => Promise<T.McpHostInfo>;
  readonly "runtime.mcp.uninstall": (a: T.McpUninstallInput) => Promise<T.McpHostInfo>;
}

export const runtimeEndpoints: readonly Endpoint[] = [
  {
    op: "runtime.list",
    about: [],
    input: undefined,
    result: z.array(S.RuntimeInfo),
    can: ["user", "remote"],
  },
  {
    op: "runtime.refresh",
    about: ["id"],
    input: input({ id: z.string() }),
    result: S.RuntimeInfo,
    can: ["user", "remote"],
  },
  {
    op: "runtime.setting.update",
    about: ["id"],
    input: input({ id: z.string() }, S.RuntimeSettings),
    result: S.RuntimeInfo,
    can: ["user"],
  },
  {
    op: "runtime.mcp.list",
    about: [],
    input: S.McpListInput,
    result: S.McpListResult,
    can: ["user", "remote"],
  },
  {
    op: "runtime.mcp.install",
    about: ["host"],
    input: S.McpInstallInput,
    result: S.McpHostInfo,
    can: ["user"],
  },
  {
    op: "runtime.mcp.uninstall",
    about: ["host"],
    input: S.McpUninstallInput,
    result: S.McpHostInfo,
    can: ["user"],
  },
];
