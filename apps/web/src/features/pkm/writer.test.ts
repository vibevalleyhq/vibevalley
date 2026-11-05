import { expect, test } from "vite-plus/test";

import type { PkmBlock, PkmBlockOp, PkmPage } from "@vibevalley/protocol";
import { whenTrue } from "@vibevalley/testkit/until";

import { applied } from "./editing";
import { PageWriter } from "./writer";

const block = (id: string, body = id): PkmBlock => ({ id, depth: 0, body, props: {}, path: "" });
const pageOf = (blocks: PkmBlock[]): PkmPage => ({ slug: "p", title: "p", tier: "inbox", file: "p.md", props: {}, tldr: "", blocks, updated: 0 });

function server(initial: PkmBlock[]) {
  let held = initial;
  const sent: PkmBlockOp[][] = [];
  const pending: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  return {
    sent,
    answer: () => pending.shift()?.resolve(),
    refuse: () => pending.shift()?.reject(new Error("disk full")),
    to: {
      apply: (_page: string, ops: readonly PkmBlockOp[]) => {
        sent.push([...ops]);
        return new Promise<PkmPage>((resolve, reject) =>
          pending.push({
            resolve: () => {
              held = applied(held, ops);
              resolve(pageOf(held));
            },
            reject,
          }),
        );
      },
      undo: () => Promise.resolve({ undone: true }),
    },
  };
}

test("an edit shows at once; the next waits for the answer to the last, then goes as one batch", async () => {
  const s = server([block("a")]);
  let drawn: PkmBlock[] = [];
  const w = new PageWriter("p", [block("a")], s.to, { changed: (b) => (drawn = b), answered: () => {}, refused: () => {} });
  w.apply([{ op: "update", block: "a", body: "a1" }]);
  w.apply([{ op: "insert_after", block: "a", id: "b", body: "b" }]);
  w.apply([{ op: "insert_after", block: "b", id: "c", body: "c" }]);
  expect(drawn.map((b) => b.body)).toEqual(["a1", "b", "c"]);
  expect(s.sent).toHaveLength(1);
  s.answer();
  await whenTrue(() => s.sent.length === 2, "the second batch");
  expect(s.sent[1]?.map((op) => op.op)).toEqual(["insert_after", "insert_after"]);
  expect(drawn.map((b) => b.body)).toEqual(["a1", "b", "c"]);
  expect(w.busy).toBe(true);
  s.answer();
  await whenTrue(() => !w.busy, "the second answer");
  expect(drawn.map((b) => b.body)).toEqual(["a1", "b", "c"]);
});

test("a refused batch drops what was waiting and puts the server's blocks back", async () => {
  const s = server([block("a")]);
  let drawn: PkmBlock[] = [];
  let why = "";
  const w = new PageWriter("p", [block("a")], s.to, { changed: (b) => (drawn = b), answered: () => {}, refused: (r) => (why = r) });
  w.apply([{ op: "update", block: "a", body: "lost" }]);
  w.apply([{ op: "update", block: "a", body: "lost too" }]);
  s.refuse();
  await whenTrue(() => why !== "", "the refusal");
  expect(why).toBe("disk full");
  expect(drawn.map((b) => b.body)).toEqual(["a"]);
  expect(w.busy).toBe(false);
});

test("the server's copy read again is taken only when nothing of ours is on the way", async () => {
  const s = server([block("a")]);
  let drawn: PkmBlock[] = [];
  const w = new PageWriter("p", [block("a")], s.to, { changed: (b) => (drawn = b), answered: () => {}, refused: () => {} });
  w.apply([{ op: "update", block: "a", body: "mine" }]);
  expect(w.take([block("a", "theirs")])).toBe(false);
  expect(drawn[0]?.body).toBe("mine");
  expect(w.undo()).toBeUndefined();
  s.answer();
  await whenTrue(() => !w.busy, "the answer");
  expect(w.take([block("a", "theirs")])).toBe(true);
  expect(drawn[0]?.body).toBe("theirs");
});
