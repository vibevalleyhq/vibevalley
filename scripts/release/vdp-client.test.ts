import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  captureVdpScreenshot,
  createWsVdpDriver,
  discoverVdpEndpoint,
  normalizeExplicitVdpUrl,
  resolveVdpCargoBuildArgs,
  VdpWsClient,
  type VdpDriver,
} from "./vdp-client.ts";

describe("vdp-client", () => {
  it("builds only vibevalley-mac with shot feature for WS VDP runs", () => {
    expect(resolveVdpCargoBuildArgs()).toEqual(["build", "-p", "vibevalley-mac", "--features", "vibevalley-mac/shot"]);
  });

  it("normalizes explicit VDP URLs and discovers endpoints from debug.json or port", () => {
    expect(normalizeExplicitVdpUrl("http://127.0.0.1:9222/devtools?token=secret-1")).toEqual({
      httpUrl: "http://127.0.0.1:9222",
      wsUrl: "ws://127.0.0.1:9222/devtools",
      token: "secret-1",
      port: 9222,
    });

    expect(normalizeExplicitVdpUrl("wss://127.0.0.1:9443", "override-tok")).toEqual({
      httpUrl: "https://127.0.0.1:9443",
      wsUrl: "wss://127.0.0.1:9443/devtools",
      token: "override-tok",
      port: 9443,
    });

    const homeDir = mkdtempSync(join(tmpdir(), "vv-vdp-client-test-"));
    try {
      writeFileSync(
        join(homeDir, "debug.json"),
        JSON.stringify({
          pid: 4242,
          port: 9333,
          httpUrl: "http://127.0.0.1:9333/",
          wsUrl: "ws://127.0.0.1:9333/devtools",
          token: "tok-from-file",
        }),
        "utf8",
      );

      expect(discoverVdpEndpoint({ home: homeDir })).toEqual({
        httpUrl: "http://127.0.0.1:9333",
        wsUrl: "ws://127.0.0.1:9333/devtools",
        token: "tok-from-file",
        pid: 4242,
        port: 9333,
      });

      expect(discoverVdpEndpoint({ home: homeDir, port: 9333 })).toEqual({
        httpUrl: "http://127.0.0.1:9333",
        wsUrl: "ws://127.0.0.1:9333/devtools",
        token: "tok-from-file",
        port: 9333,
      });

      expect(() => discoverVdpEndpoint({ home: join(homeDir, "missing") })).toThrow(/no live VDP debug endpoint/u);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("validates captureVdpScreenshot against empty and non-empty PNG outputs", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "vv-vdp-shot-test-"));
    try {
      const fakeDriver: VdpDriver = {
        async navigate() {},
        async resize() {},
        async setTheme() {},
        async getState() {
          return { loaded: true };
        },
        async uiQuery() {
          return { view: "workbench", count: 0, nodes: [] };
        },
        async uiPress() {
          return { pressed: true };
        },
        async uiWaitFor() {
          return { found: false };
        },
        async uiGetTree() {
          return { view: "workbench", nodes: [] };
        },
        async captureScreenshot(outPath) {
          if (outPath.endsWith("good.png")) {
            writeFileSync(outPath, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
            return { path: outPath, mime: "image/png", width: 1280, height: 840, bytes: 8 };
          }
          return { path: outPath, mime: "image/png", width: 0, height: 0, bytes: 0 };
        },
        async settle() {},
      };

      const errors: string[] = [];
      const good = await captureVdpScreenshot(fakeDriver, outDir, "good.png", errors);
      expect(good.bytes).toBe(8);
      expect(good.relPath).toBe("shots/good.png");
      expect(errors).toEqual([]);

      const bad = await captureVdpScreenshot(fakeDriver, outDir, "empty.png", errors);
      expect(bad.bytes).toBe(0);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("screenshot missing or empty");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("handles WebSocket JSON-RPC request/response framing and screenshot decoding", async () => {
    // Minimal RFC 6455 loopback server exercising VdpWsClient + createWsVdpDriver.
    const { createHash } = await import("node:crypto");
    const server = createServer();
    server.on("upgrade", (req, socket) => {
      const key = req.headers["sec-websocket-key"];
      const accept = createHash("sha1")
        .update(`${String(key)}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));

      let buf = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const masked = (buf[1]! & 0x80) !== 0;
          let len = buf[1]! & 0x7f;
          let offset = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            offset = 4;
          }
          const maskLen = masked ? 4 : 0;
          if (buf.length < offset + maskLen + len) return;
          const payload = Buffer.from(buf.subarray(offset + maskLen, offset + maskLen + len));
          if (masked) {
            const mask = buf.subarray(offset, offset + 4);
            for (let i = 0; i < payload.length; i += 1) {
              payload[i] = payload[i]! ^ mask[i % 4]!;
            }
          }
          buf = buf.subarray(offset + maskLen + len);
          if (payload.length > 0) {
            let reqJson: { id?: number; method?: string };
            try {
              reqJson = JSON.parse(payload.toString("utf8")) as { id?: number; method?: string };
            } catch {
              continue;
            }
            let result: unknown = {};
            if (reqJson.method === "Shell.getState") {
              result = { loaded: true, load_error: null, route: "/issues" };
            } else if (reqJson.method === "Page.captureScreenshot") {
              result = {
                data: Buffer.from("png-bytes").toString("base64"),
                mime: "image/png",
                width: 640,
                height: 480,
              };
            }
            const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: reqJson.id, result }), "utf8");
            const header = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, (body.length >> 8) & 0xff, body.length & 0xff]);
            socket.write(Buffer.concat([header, body]));
          }
        }
      });
    });

    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const outDir = mkdtempSync(join(tmpdir(), "vv-vdp-ws-test-"));

    try {
      const client = await VdpWsClient.connect({
        httpUrl: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}/devtools`,
        token: "test-tok",
        port,
      });
      const driver = createWsVdpDriver(client);
      expect(await driver.getState()).toEqual({ loaded: true, load_error: null, route: "/issues" });

      const shotPath = join(outDir, "ws-shot.png");
      const info = await driver.captureScreenshot(shotPath, "shell");
      expect(info).toEqual({ path: shotPath, mime: "image/png", width: 640, height: 480, bytes: 9 });
      expect(readFileSync(shotPath, "utf8")).toBe("png-bytes");

      client.close();
    } finally {
      rmSync(outDir, { recursive: true, force: true });
      server.close();
    }
  });
});
