import type { UserHandlers } from "@vibevalley/protocol/api";

import { requestHeaders } from "#/gateway/http/api.ts";
import { deviceHeader, fromHeader, outsideHeader } from "#/gateway/lan/lan.ts";
import type { Caller, User } from "#/platform/user/user.ts";

// Only the gate says a request came from outside, and which device: it drops both headers from what it is handed.
const caller = (): Caller => {
  const headers = requestHeaders();
  const device = headers?.get(deviceHeader) ?? undefined;
  const from = headers?.get(fromHeader) ?? undefined;
  return {
    here: (headers?.get(outsideHeader) ?? null) === null,
    ...(device !== undefined && device !== "" ? { device } : {}),
    ...(from !== undefined && from !== "" ? { from } : {}),
  };
};

export function userHandlers(deps: { readonly user: User }): UserHandlers {
  const { user } = deps;
  return {
    "user.get": async () => user.status(caller()),
    "user.update": (body) => user.rename(body.name),
    "user.password.set": (body) => user.setPassword(caller(), body.password),
    "user.login": (body) => user.login(body.password, body.device),
    "user.logout": () => user.logout(caller()),
    "user.device.list": async () => user.devices(),
    "user.device.delete": ({ id }) => user.revoke(id),
    "user.device.previewDelete": ({ id }) => user.previewRevoke(id),
    "user.approval.create": (body) => user.request(caller(), body.name),
    "user.approval.collect": (body) => user.collect(body.claim),
    "user.approval.list": async () => user.requests(),
    "user.approval.answer": (body) => user.answerRequest(body.id, body.allow),
  };
}
