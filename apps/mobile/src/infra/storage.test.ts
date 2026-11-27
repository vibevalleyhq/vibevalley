import { Storage } from "nsh";
import { expect, test } from "nsh/test";

import { clearCredentials, loadCredentials, PROFILE_STORAGE_KEY, saveCredentials, type SecureTokenStore } from "./storage";

function createStubTokenStore(): SecureTokenStore {
  const tokens = new Map<string, string>();
  return {
    backend: "memory-only",
    getToken: (account) => Promise.resolve(tokens.get(account)),
    setToken: (account, token) => {
      tokens.set(account, token);
      return Promise.resolve();
    },
    deleteToken: (account) => {
      tokens.delete(account);
      return Promise.resolve();
    },
  };
}

test("saveCredentials / loadCredentials / clearCredentials round-trips profile JSON and token store", async () => {
  const tokenStore = createStubTokenStore();
  await clearCredentials(tokenStore);

  await saveCredentials(
    {
      baseUrl: "http://127.0.0.1:8890",
      deviceName: "iPhone",
      serverName: "Mac Studio",
      token: "vv_tok_123",
    },
    tokenStore,
  );

  expect(await loadCredentials(tokenStore)).toEqual({
    baseUrl: "http://127.0.0.1:8890",
    deviceName: "iPhone",
    serverName: "Mac Studio",
    token: "vv_tok_123",
  });

  await clearCredentials(tokenStore);
  expect(await loadCredentials(tokenStore)).toBeUndefined();
});

test("loadCredentials clears malformed or incomplete profile JSON cleanly", async () => {
  const tokenStore = createStubTokenStore();
  await tokenStore.setToken("vibevalley.remote.bearer-token.v1", "vv_tok_corrupt");
  await Storage.setItem(PROFILE_STORAGE_KEY, "{not valid json");

  expect(await loadCredentials(tokenStore)).toBeUndefined();
  expect(await Storage.getItem(PROFILE_STORAGE_KEY)).toBeNull();
  expect(await tokenStore.getToken("vibevalley.remote.bearer-token.v1")).toBeUndefined();
});
