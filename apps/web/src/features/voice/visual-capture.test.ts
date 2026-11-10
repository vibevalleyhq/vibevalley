import { describe, expect, it } from "vite-plus/test";

import { localRelayHost } from "./visual-capture.ts";

describe("local realtime relay admission", () => {
  it.each(["localhost", "127.0.0.1", "[::1]", "::1"])("allows user loopback host %s", (hostname) => {
    expect(localRelayHost(hostname)).toBe(true);
  });

  it.each(["192.168.1.10", "10.0.0.2", "farm.example", "localhost.example", "100.64.0.1", "[fd00::1]"])(
    "regression: paired remote host %s cannot advertise local-only realtime relays",
    (hostname) => {
      expect(localRelayHost(hostname)).toBe(false);
    },
  );
});
