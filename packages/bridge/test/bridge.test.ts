import { Schema } from "effect";
import { expect, test } from "vite-plus/test";

import { BridgeError, call, connect, push, serve } from "../src/index";
import { linkPair } from "../src/testing";

const contract = {
  add: call({ input: Schema.Struct({ a: Schema.Finite, b: Schema.Finite }), output: Schema.Finite }),
  say: call({ input: Schema.String, output: Schema.Void }),
  ticked: push(Schema.Struct({ n: Schema.Finite })),
};

test("a call is answered by its handler, typed both ways", async () => {
  const [near, far] = linkPair();
  serve(contract, far, { add: ({ a, b }) => a + b, say: () => undefined });
  const client = connect(contract, near);
  await expect(client.call.add({ a: 2, b: 3 })).resolves.toBe(5);
  await expect(client.call.say("hi")).resolves.toBeUndefined();
});

test("an input that does not decode is refused on the answering side, and the handler is not run", async () => {
  const [near, far] = linkPair();
  const ran: unknown[] = [];
  serve(contract, far, {
    add: (x) => {
      ran.push(x);
      return 0;
    },
    say: () => undefined,
  });
  const answers: unknown[] = [];
  const both = new Promise<void>((resolve) => near.receive((m) => answers.push(m) === 2 && resolve()));
  near.send({ id: 1, call: "add", input: { a: "2", b: 3 } });
  near.send({ id: 2, call: "nothing", input: 1 });
  await both;
  expect(ran).toEqual([]);
  expect(answers).toEqual([
    { id: 1, ok: false, error: expect.stringContaining("Expected number") },
    { id: 2, ok: false, error: "no call nothing" },
  ]);
});

test("a handler's failure reaches the caller as its reason", async () => {
  const [near, far] = linkPair();
  serve(contract, far, {
    add: () => {
      throw new Error("没有通知权限");
    },
    say: async () => Promise.reject(new Error("走开")),
  });
  const client = connect(contract, near);
  await expect(client.call.add({ a: 1, b: 1 })).rejects.toThrow(new BridgeError("没有通知权限"));
  await expect(client.call.say("x")).rejects.toThrow("走开");
});

test("pushes reach their listeners until they stop, and a payload that does not decode reaches none", async () => {
  const [near, far] = linkPair();
  const server = serve(contract, far, { add: () => 0, say: () => undefined });
  const client = connect(contract, near);
  const heard: number[] = [];
  const stop = client.on("ticked", ({ n }) => heard.push(n));
  server.push("ticked", { n: 1 });
  far.send({ push: "ticked", payload: { n: "two" } });
  stop();
  server.push("ticked", { n: 3 });
  expect(heard).toEqual([1]);
});

test("closing the asking side rejects what is unanswered; closing the answering side answers nothing more", async () => {
  const [near, far] = linkPair();
  const server = serve(contract, far, { add: async ({ a }) => a, say: () => undefined });
  const client = connect(contract, near);
  server.close();
  const unanswered = client.call.add({ a: 1, b: 0 });
  client.close();
  await expect(unanswered).rejects.toThrow("the bridge is closed");
  await expect(client.call.say("late")).rejects.toThrow(BridgeError);
});
