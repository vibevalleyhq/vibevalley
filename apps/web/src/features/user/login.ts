import type { UserLoginRequest } from "@vibevalley/protocol";

import { api } from "#/infra/api.ts";

/** Signs this device in. The gate keeps its key in an HttpOnly cookie, so the page holds nothing; the answer's copy of
 * the key is for the command line. */
export const signIn = (login: UserLoginRequest) => api.user.login(login).then(() => undefined);
