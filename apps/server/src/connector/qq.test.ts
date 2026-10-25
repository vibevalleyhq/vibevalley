import { describe, expect, it } from "vite-plus/test";
import { decodeGatewayEvent } from "./qq.ts";

describe("QQ gateway events", () => {
  it("decodes an event and rejects null and wrong field types", () => {
    const raw = `{"op":0,"s":7,"t":"C2C_MESSAGE_CREATE","d":{"id":"m1"}}`;
    expect(decodeGatewayEvent(raw)).toEqual({ op: 0, s: 7, t: "C2C_MESSAGE_CREATE", d: { id: "m1" } });
    expect(() => decodeGatewayEvent("null")).toThrow();
    expect(() => decodeGatewayEvent(`{"op":"0"}`)).toThrow();
  });
});
