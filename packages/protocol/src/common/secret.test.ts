import { inspect } from "node:util";

import { describe, expect, it } from "vite-plus/test";

import { Secret } from "./schema";

describe("Secret", () => {
  it("redacts itself in strings, inspect output, and JSON serialization", () => {
    const secret = new Secret("sk-test-token");
    expect(secret.reveal()).toBe("sk-test-token");
    expect(String(secret)).toBe("[secret]");
    expect(inspect(secret)).toBe("[secret]");
    expect(() => JSON.stringify({ secret })).toThrow("a secret is never written as JSON");
  });
});
