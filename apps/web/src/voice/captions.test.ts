import { expect, test } from "bun:test";
import { LiveCaptions } from "./captions";

function chunked(id: string, message: Record<string, unknown>, parts: number) {
  const encoded = Buffer.from(JSON.stringify(message), "utf8").toString("base64");
  const size = Math.ceil(encoded.length / parts);
  return Array.from({ length: parts }, (_, i) => `${id}|${i + 1}|${parts}|${encoded.slice(i * size, (i + 1) * size)}`);
}

test("chunks arrive out of order; the turn is captioned once all are in", () => {
  const c = new LiveCaptions();
  const [first, second] = chunked("m1", { object: "user.transcription", turn_id: 3, text: "我想看看项目", final: false }, 2);
  expect(c.feed(second!)).toBe(false);
  expect(c.turns).toHaveLength(0);
  expect(c.feed(first!)).toBe(true);
  expect(c.turns.map((t) => [t.text, t.speaker, t.done])).toEqual([["我想看看项目", "you", false]]);
});

test("a turn's text is replaced as it grows, and ends with final or turn_status", () => {
  const c = new LiveCaptions();
  c.apply({ object: "user.transcription", turn_id: 1, text: "你好", final: false });
  c.apply({ object: "user.transcription", turn_id: 1, text: "你好，农场怎么样", final: true });
  c.apply({ object: "assistant.transcription", turn_id: 1, text: "挺好", turn_status: 0 });
  c.apply({ object: "assistant.transcription", turn_id: 1, text: "挺好的，地里有一个帮工。", turn_status: 1 });
  expect(c.turns.map((t) => [t.speaker, t.text, t.done])).toEqual([
    ["you", "你好，农场怎么样", true],
    ["manager", "挺好的，地里有一个帮工。", true],
  ]);
});

test("talking over the manager stops its turn where it was; later text of that turn is ignored", () => {
  const c = new LiveCaptions();
  c.apply({ object: "assistant.transcription", turn_id: 2, text: "今天地里", turn_status: 0 });
  c.apply({ object: "message.interrupt", turn_id: 2 });
  c.apply({ object: "assistant.transcription", turn_id: 2, text: "今天地里有三块熟了", turn_status: 2 });
  expect([c.turns[0]!.text, c.turns[0]!.interrupted]).toEqual(["今天地里", true]);
});

test("the agent's state is what it last said; only the last few turns are kept; each is told once", () => {
  const c = new LiveCaptions();
  const heard: string[] = [];
  c.onHeard = (t) => heard.push(t);
  c.apply({ object: "message.state", state: "thinking", turn_id: 1 });
  c.apply({ object: "message.state", state: "speaking", turn_id: 1 });
  expect(c.agentState).toBe("speaking");
  for (let i = 0; i < LiveCaptions.keep + 3; i++) c.apply({ object: "user.transcription", turn_id: i, text: `第 ${i} 句`, final: true });
  c.apply({ object: "user.transcription", turn_id: 10, text: "第 10 句", final: true });
  expect(c.turns).toHaveLength(LiveCaptions.keep);
  expect(c.turns[0]!.text).toBe("第 3 句");
  expect(heard).toHaveLength(LiveCaptions.keep + 3);
});
