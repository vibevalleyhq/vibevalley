import { describe, expect, test } from "vite-plus/test";

import type * as T from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";
import { subscriptionUrl } from "@vibevalley/protocol/rpc";
import * as S from "@vibevalley/protocol/schema";

import { app } from "#/testing/http.ts";
import { testConfig } from "#/testing/layers.ts";
import { quietApp } from "#/testing/world.ts";

import { fromTheFarm } from "./rpc.ts";

/** The first n events of a subscription, read as a page reads them. */
async function take(url: string, n: number): Promise<T.ChannelEvent[]> {
  const res = await fetch(url, { headers: { accept: "text/event-stream" } });
  if (!res.ok || !res.body) throw new Error(`${url}: ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const got: T.ChannelEvent[] = [];
  let buffer = "";
  try {
    while (got.length < n) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`${url}: ended`);
      buffer += value;
      let at: number;
      while ((at = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (frame.startsWith("data: ")) got.push(S.ChannelEvent.parse(JSON.parse(frame.slice(6))));
      }
    }
  } finally {
    await reader.cancel();
  }
  return got.slice(0, n);
}

describe("the subscriptions", () => {
  test("a page follows a channel over the WebSocket: what it missed, then what is said", async () => {
    await using served = await app(testConfig(), 0, undefined, quietApp);
    const chat = served.farm.channel;
    const general = chat.defaultChannel();
    for (const text of ["早", "在吗"]) await chat.post({ _tag: "User", text: text, sendKey: "" });
    const first = (await chat.history(general)).find((m) => m.text === "早")!;
    const base = `http://${served.address}`;
    const following = take(base + subscriptionUrl("channel.follow", { id: general, after: first.revision }), 2);
    await chat.post({ _tag: "User", text: "看看进度", sendKey: "" });
    const got = await following;
    expect(got.map((e) => (e._tag === "Message" ? e.message.text : e._tag))).toEqual(["在吗", "看看进度"]);
    const refused = await fetch(base + subscriptionUrl("channel.follow", { id: "no-such-channel", after: 0 }));
    expect(await refused.json()).toMatchObject({ bizCode: BizCode.ChannelRefused });
  });

  test("only the farm's own page gets in", async () => {
    await using served = await app(testConfig(), 0, undefined, quietApp);
    const url = `http://${served.address}${subscriptionUrl("channel.reports", {})}`;
    const status = async (headers: Record<string, string>) => {
      const res = await fetch(url, { headers });
      await res.body?.cancel();
      return res.status;
    };
    expect(await status({})).toBe(200);
    expect(await status({ origin: `http://${served.address}` })).toBe(200);
    expect(await status({ origin: "https://evil.example" })).toBe(403);
    // A name made to resolve here is its own origin: the host has to be a loopback name. (fetch does not let a test set
    // Host, so this one is asked of the check itself.)
    const [, port] = served.address.split(":");
    expect(fromTheFarm(new Headers({ host: `evil.example:${port}`, origin: `http://evil.example:${port}` }))).toBe(false);
  });

  test("checks origins even when a device header is present", () => {
    const at = (h: Record<string, string>) => fromTheFarm(new Headers(h));
    expect(at({ host: "192.168.1.20:8789", origin: "http://192.168.1.20:8789" })).toBe(false);
    expect(at({ host: "127.0.0.1:8787", origin: "http://192.168.1.20:8789", "x-vibevalley-lan-device": "d1" })).toBe(false);
    expect(at({ host: "localhost:5173", origin: "http://localhost:5173" })).toBe(true);
  });
});
