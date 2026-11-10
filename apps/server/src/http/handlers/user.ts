import { Effect, Option } from "effect";
import { HttpServerRequest } from "effect/http";

import type { UserHandlers } from "@vibevalley/protocol/api";

import { deviceHeader, outsideHeader } from "#/lan/lan.ts";
import { type Caller, User } from "#/user/user.ts";

// Only the gate says a request came from outside, and which device: it drops both headers from what it is handed.
const caller = Effect.map(Effect.serviceOption(HttpServerRequest.HttpServerRequest), (request): Caller => {
  const headers = Option.getOrUndefined(Option.map(request, (r) => r.headers));
  const device = headers?.[deviceHeader];
  return { here: headers?.[outsideHeader] === undefined, ...(device !== undefined && device !== "" ? { device } : {}) };
});

export const userHandlers = Effect.gen(function* () {
  const user = yield* User;
  const done: UserHandlers = {
    "user.get": () => Effect.map(caller, user.status),
    "user.update": (body) => user.rename(body.name),
    "user.password.set": (body) => Effect.flatMap(caller, (c) => user.setPassword(c, body.password)),
    "user.login": (body) => user.login(body.password, body.device),
    "user.logout": () => Effect.flatMap(caller, user.logout),
    "user.device.list": () => Effect.sync(user.devices),
    "user.device.delete": ({ id }) => user.revoke(id),
    "user.device.previewDelete": ({ id }) => user.previewRevoke(id),
  };
  return done;
});
