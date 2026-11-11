import { Layer } from "effect";

import { app as application } from "#/gateway/http/app.ts";

import { offlineNetwork } from "./layers.ts";

export const app = (...args: Parameters<typeof application>) => application(...args).pipe(Layer.provide(offlineNetwork));
