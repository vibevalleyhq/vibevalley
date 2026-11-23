import "./polyfill";
import { host } from "nsh";
import { afterEach, describe, expect, test } from "nsh/test";

import type { Attachment } from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";

import { importLocalAttachment, localPathFromUri } from "./attachmentFile";
import { setTransport, type Transport } from "./transport";

const originalDescriptor = Object.getOwnPropertyDescriptor(host, "params");

function setHostParams(params: Record<string, unknown>) {
  Object.defineProperty(host, "params", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: params,
  });
}

afterEach(() => {
  if (originalDescriptor) {
    Object.defineProperty(host, "params", originalDescriptor);
  }
});

function recordingTransport(handler: (op: string, payload: unknown) => Promise<{ bizCode: number; message: string; data?: unknown }>) {
  const calls: { op: string; payload: unknown }[] = [];
  const t: Transport = {
    call: async (op, payload) => {
      calls.push({ op, payload });
      return handler(op, payload);
    },
    slice: () => () => {},
    live: () => () => {},
    subscribe: () => () => {},
  };
  setTransport(t);
  return calls;
}

describe("infra/attachmentFile", () => {
  test("localPathFromUri extracts decoded POSIX absolute paths and rejects non-local URIs", () => {
    expect(localPathFromUri("/tmp/report.pdf")).toBe("/tmp/report.pdf");
    expect(localPathFromUri("file:///Users/demo/my%20video.mov")).toBe("/Users/demo/my video.mov");
    expect(localPathFromUri("file://localhost/tmp/shot%201.png")).toBe("/tmp/shot 1.png");
    expect(localPathFromUri("file://remote-host/share/file.bin")).toBeUndefined();
    expect(localPathFromUri("relative/file.txt")).toBeUndefined();
    expect(localPathFromUri("https://example.com/a.png")).toBeUndefined();
    expect(localPathFromUri("   ")).toBeUndefined();
  });

  test("importLocalAttachment uses zero-Base64 attachment.importPath when connected to embedded server", async () => {
    setHostParams({ connectionMode: "embedded" });
    const imported: Attachment = { id: "att-local-1", name: "large.mov", type: "video/quicktime", size: 42_000_000 };
    const calls = recordingTransport(async (op) => {
      if (op === "attachment.importPath") return { bizCode: 0, message: "ok", data: imported };
      throw new Error(`unexpected op: ${op}`);
    });

    const result = await importLocalAttachment("file:///Users/demo/large%20clip.mov", { name: "large.mov" });
    expect(result).toEqual(imported);
    expect(calls).toEqual([{ op: "attachment.importPath", payload: { path: "/Users/demo/large clip.mov", name: "large.mov" } }]);
  });

  test("importLocalAttachment falls back to host.readFile + attachment.create when connected remotely", async () => {
    setHostParams({ connectionMode: "remote" });
    const created: Attachment = { id: "att-remote-1", name: "notes.txt", type: "text/plain", size: 5 };
    const calls = recordingTransport(async (op) => {
      if (op === "host.readFile") return { bizCode: 0, message: "ok", data: { data: "aGVsbG8=", type: "text/plain", name: "notes.txt" } };
      if (op === "attachment.create") return { bizCode: 0, message: "ok", data: created };
      throw new Error(`unexpected op: ${op}`);
    });

    const result = await importLocalAttachment("/tmp/notes.txt");
    expect(result).toEqual(created);
    expect(calls.map((c) => c.op)).toEqual(["host.readFile", "attachment.create"]);
  });

  test("importLocalAttachment falls back when attachment.importPath is Forbidden", async () => {
    setHostParams({ connectionMode: "embedded" });
    const created: Attachment = { id: "att-fallback-1", name: "notes.txt", type: "text/plain", size: 5 };
    const calls = recordingTransport(async (op) => {
      if (op === "attachment.importPath") return { bizCode: BizCode.Forbidden, message: "Forbidden" };
      if (op === "host.readFile") return { bizCode: 0, message: "ok", data: { data: "aGVsbG8=", type: "text/plain", name: "notes.txt" } };
      if (op === "attachment.create") return { bizCode: 0, message: "ok", data: created };
      throw new Error(`unexpected op: ${op}`);
    });

    const result = await importLocalAttachment("/tmp/notes.txt");
    expect(result).toEqual(created);
    expect(calls.map((c) => c.op)).toEqual(["attachment.importPath", "host.readFile", "attachment.create"]);
  });
});
