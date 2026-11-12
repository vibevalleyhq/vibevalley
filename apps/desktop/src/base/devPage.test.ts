import { expect, test } from "vite-plus/test";

import { devPageEnv, devPageOf } from "./devPage.ts";

test("the window takes the dev page dev.ts says, as an origin", () => {
  expect(devPageOf(devPageEnv({ page: "http://127.0.0.1:5173/", serverPort: 51234 }))).toEqual({ page: "http://127.0.0.1:5173", serverPort: 51234 });
  expect(devPageOf({ VIBEVALLEY_DEV_PAGE: "http://localhost:5174/farm", VIBEVALLEY_DEV_SERVER_PORT: "8800" })).toEqual({
    page: "http://localhost:5174",
    serverPort: 8800,
  });
});

test("a dev page that is not Vite on this machine, or a port that is not one, is no dev page", () => {
  for (const env of [
    {},
    { VIBEVALLEY_DEV_PAGE: "http://127.0.0.1:5173" },
    { VIBEVALLEY_DEV_PAGE: "http://127.0.0.1:5173", VIBEVALLEY_DEV_SERVER_PORT: "0" },
    { VIBEVALLEY_DEV_PAGE: "http://127.0.0.1:5173", VIBEVALLEY_DEV_SERVER_PORT: "70000" },
    { VIBEVALLEY_DEV_PAGE: "http://127.0.0.1:5173", VIBEVALLEY_DEV_SERVER_PORT: "port" },
    { VIBEVALLEY_DEV_PAGE: "https://example.com", VIBEVALLEY_DEV_SERVER_PORT: "8800" },
    { VIBEVALLEY_DEV_PAGE: "http://192.168.1.2:5173", VIBEVALLEY_DEV_SERVER_PORT: "8800" },
    { VIBEVALLEY_DEV_PAGE: "not a url", VIBEVALLEY_DEV_SERVER_PORT: "8800" },
  ])
    expect(devPageOf(env)).toBeUndefined();
});
