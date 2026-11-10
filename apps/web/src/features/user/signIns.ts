import * as S from "@vibevalley/protocol/schema";

import { api } from "#/infra/api.ts";
import { defineQuery, retryRead } from "#/infra/query.ts";

export const userQuery = defineQuery({ schema: S.UserStatus, key: () => ["user"], fetch: (_: void, context) => api.user.get(context), ...retryRead });

export const devicesQuery = defineQuery({
  schema: S.UserDevices,
  key: () => ["user", "devices"],
  fetch: (_: void, context) => api.user.device.list(context),
  ...retryRead,
});

export const approvalsQuery = defineQuery({
  schema: S.Approvals,
  key: () => ["user", "approvals"],
  fetch: (_: void, context) => api.user.approval.list(context),
  ...retryRead,
});
