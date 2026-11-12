import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { type Answer, chatChunk, chatCompletions, newestUserText } from "./openai.ts";

const said = (...words: string[]) =>
  async function* () {
    yield* words;
  };

const only = (model: string, answer: Answer) => (m: string) => (m === model ? answer : undefined);

const Chunk = z.object({ choices: z.array(z.object({ delta: z.object({ content: z.exactOptional(z.string()) }) })) });

const ask = async (handle: (r: Request) => Promise<Response>, body: unknown, method = "POST") =>
  handle(
    new Request("http://127.0.0.1/v1/chat/completions", {
      method,
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    }),
  );
/** The chunk's JSON, without the blank line after it. */
const chunkOf = (chunk: string): unknown => JSON.parse(chunk.slice("data: ".length));

describe("chat/completions", () => {
  it("takes the newest user text", () => {
    const cases: [unknown, string][] = [
      [
        {
          messages: [
            { role: "system", content: "你是助手" },
            { role: "user", content: "旧的" },
            { role: "assistant", content: "好" },
            { role: "user", content: " 让老周跑测试 " },
          ],
        },
        "让老周跑测试",
      ],
      [
        {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "看看" }, { type: "image_url" }, { type: "text", text: "进度" }],
            },
          ],
        },
        "看看进度",
      ],
      [{ messages: [{ role: "assistant", content: "好" }] }, ""],
      [{}, ""],
    ];
    for (const [req, want] of cases) expect(newestUserText(req as never)).toBe(want);
  });

  it("chunks as OpenAI does", async () => {
    expect(chunkOf(chatChunk("id1", 7, "m", "好", false, true))).toEqual({
      id: "id1",
      object: "chat.completion.chunk",
      created: 7,
      model: "m",
      choices: [{ index: 0, delta: { role: "assistant", content: "好" }, finish_reason: null }],
    });
    expect(chunkOf(chatChunk("id1", 7, "m", "", true, false))).toEqual({
      id: "id1",
      object: "chat.completion.chunk",
      created: 7,
      model: "m",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
  });

  it("answers whole without a stream", async () => {
    let heard = "";
    const handle = chatCompletions({
      answerer: only("m", (text) => {
        heard = text;
        return said("好，", "这就去。")();
      }),
    });
    const res = await ask(handle, { model: "m", messages: [{ role: "user", content: "跑测试" }] });
    const got = (await res.json()) as {
      object: string;
      model: string;
      choices: { message: { role: string; content: string }; finish_reason: string }[];
    };
    expect([res.status, got.object, got.model, got.choices.length]).toEqual([200, "chat.completion", "m", 1]);
    expect(got.choices[0]).toMatchObject({
      message: { role: "assistant", content: "好，这就去。" },
      finish_reason: "stop",
    });
    expect(heard).toBe("跑测试");
  });

  it("streams its words, then stop and [DONE]", async () => {
    const handle = chatCompletions({ answerer: only("m", said("好，", "这就去。")) });
    const res = await ask(handle, {
      model: "m",
      stream: true,
      messages: [{ role: "user", content: "跑测试" }],
    });
    const lines = (await res.text()).split("\n\n").filter(Boolean);
    expect(lines.at(-1)).toBe("data: [DONE]");
    const chunks = lines.slice(0, 2).map((l) => Chunk.parse(JSON.parse(l.slice(6))));
    expect(chunks.map((c) => c.choices[0]?.delta.content)).toEqual(["好，", "这就去。"]);
  });

  it("refuses in OpenAI's shape", async () => {
    const answer: Answer = said("在");
    const strict = chatCompletions({ answerer: only("m", answer) });
    const lenient = chatCompletions({ answerer: only("m", answer), misheard: "没听清" });
    const cases: [typeof strict, unknown, number, string][] = [
      [strict, { model: "nope", messages: [{ role: "user", content: "在吗" }] }, 404, "model_not_found"],
      [strict, { model: "m", messages: [] }, 400, "no_user_message"],
      [strict, "not an object", 400, "invalid_json"],
    ];
    const answers = await Promise.all(
      cases.map(async ([handle, body]) => {
        const res = await ask(handle, body);
        return [res.status, ((await res.json()) as { error: { code: string } }).error.code];
      }),
    );
    expect(answers).toEqual(cases.map(([, , status, code]) => [status, code]));
    const misheard = await ask(lenient, { model: "m", messages: [] });
    expect([misheard.status, await misheard.text()]).toEqual([200, expect.stringContaining("没听清")]);
    expect((await ask(strict, undefined, "GET")).status).toBe(405);
  });

  it("rejects valid JSON with an invalid request shape before answering", async () => {
    let calls = 0;
    const handle = chatCompletions({
      answerer: only("m", () => {
        calls++;
        return said("不该回答")();
      }),
    });
    const cases = [
      { model: "m", messages: {} },
      { model: "m", messages: [null] },
      { model: "m", messages: [{ role: "user", content: 1 }] },
      { model: "m", stream: "false", messages: [] },
      { model: 1, messages: [] },
    ];
    const answers = await Promise.all(
      cases.map(async (body) => {
        const res = await ask(handle, body);
        return [res.status, ((await res.json()) as { error: { code: string } }).error.code];
      }),
    );
    expect(answers).toEqual(cases.map(() => [400, "invalid_json"]));
    expect(calls).toBe(0);
  });
});
