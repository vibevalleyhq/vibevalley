import { describe, expect, it } from "vite-plus/test";
import { type Answer, chatChunk, chatCompletions, newestUserText } from "./openai.ts";

async function* said(...words: string[]) {
  for (const w of words) yield w;
}

const only = (model: string, answer: Answer) => (m: string) => (m === model ? answer : undefined);

const ask = (handle: (r: Request) => Promise<Response>, body: unknown, method = "POST") =>
  handle(
    new Request("http://127.0.0.1/v1/chat/completions", {
      method,
      ...(method === "POST" ? { body: typeof body === "string" ? JSON.stringify(body) : JSON.stringify(body) } : {}),
    }),
  );

describe("chat/completions", () => {
  it("takes the newest user text", () => {
    const cases: [unknown, string][] = [
      [
        {
          messages: [
            { role: "system", content: "你是管家" },
            { role: "user", content: "旧的" },
            { role: "assistant", content: "好" },
            { role: "user", content: " 让老周跑测试 " },
          ],
        },
        "让老周跑测试",
      ],
      [{ messages: [{ role: "user", content: [{ type: "text", text: "看看" }, { type: "image_url" }, { type: "text", text: "进度" }] }] }, "看看进度"],
      [{ messages: [{ role: "assistant", content: "好" }] }, ""],
      [{}, ""],
    ];
    for (const [req, want] of cases) expect(newestUserText(req as never)).toBe(want);
  });

  it("chunks as OpenAI does", () => {
    expect(JSON.parse(chatChunk("id1", 7, "m", "好", false, true).slice("data: ".length))).toEqual({
      id: "id1",
      object: "chat.completion.chunk",
      created: 7,
      model: "m",
      choices: [{ index: 0, delta: { role: "assistant", content: "好" }, finish_reason: null }],
    });
    expect(JSON.parse(chatChunk("id1", 7, "m", "", true, false).slice("data: ".length)).choices[0]).toEqual({ index: 0, delta: {}, finish_reason: "stop" });
  });

  it("answers whole without a stream", async () => {
    let heard = "";
    const handle = chatCompletions({
      answerer: only("m", (text) => {
        heard = text;
        return said("好，", "这就去。");
      }),
    });
    const res = await ask(handle, { model: "m", messages: [{ role: "user", content: "跑测试" }] });
    const got = (await res.json()) as { object: string; model: string; choices: { message: { role: string; content: string }; finish_reason: string }[] };
    expect([res.status, got.object, got.model, got.choices.length]).toEqual([200, "chat.completion", "m", 1]);
    expect(got.choices[0]).toMatchObject({ message: { role: "assistant", content: "好，这就去。" }, finish_reason: "stop" });
    expect(heard).toBe("跑测试");
  });

  it("streams its words, then stop and [DONE]", async () => {
    const handle = chatCompletions({ answerer: only("m", () => said("好，", "这就去。")) });
    const res = await ask(handle, { model: "m", stream: true, messages: [{ role: "user", content: "跑测试" }] });
    const lines = (await res.text()).split("\n\n").filter(Boolean);
    expect(lines.at(-1)).toBe("data: [DONE]");
    expect(lines.slice(0, 2).map((l) => JSON.parse(l.slice(6)).choices[0].delta.content)).toEqual(["好，", "这就去。"]);
  });

  it.each([false, true])("accepts content parts and additional fields when stream is %s", async (stream) => {
    let heard = "";
    const handle = chatCompletions({
      answerer: only("m", (text) => {
        heard = text;
        return said("收到");
      }),
    });
    const res = await ask(handle, {
      model: "m",
      stream,
      temperature: 0.2,
      messages: [
        {
          role: "user",
          name: "owner",
          content: [
            { type: "text", text: "看看", provider: "extra" },
            { type: "image_url", image_url: { url: "https://example.test/image.png" } },
            { type: "text", text: "进度" },
          ],
        },
      ],
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(heard).toBe("看看进度");
  });

  it.each([
    ["a null message without streaming", { model: "m", stream: false, messages: [null] }],
    ["a null message with streaming", { model: "m", stream: true, messages: [null] }],
    ["a null content part without streaming", { model: "m", stream: false, messages: [{ role: "user", content: [null] }] }],
    ["a null content part with streaming", { model: "m", stream: true, messages: [{ role: "user", content: [null] }] }],
    ["a non-string model without streaming", { model: 42, stream: false, messages: [{ role: "user", content: "在吗" }] }],
    ["a non-string model with streaming", { model: 42, stream: true, messages: [{ role: "user", content: "在吗" }] }],
  ] as [string, unknown][])("returns an OpenAI 400 before answering %s", async (_name, body) => {
    let lookups = 0;
    let answers = 0;
    const handle = chatCompletions({
      answerer: () => {
        lookups++;
        return () => {
          answers++;
          return said("不应回答");
        };
      },
    });
    const res = await ask(handle, body);
    const got = (await res.json()) as { error: { message: string; type: string } };
    expect(res.status).toBe(400);
    expect(got.error.type).toBe("invalid_request_error");
    expect(typeof got.error.message).toBe("string");
    expect([lookups, answers]).toEqual([0, 0]);
  });

  it("returns an OpenAI 400 for a non-boolean stream without answering", async () => {
    let lookups = 0;
    const handle = chatCompletions({
      answerer: () => {
        lookups++;
        return () => said("不应回答");
      },
    });
    const res = await ask(handle, { model: "m", stream: "yes", messages: [{ role: "user", content: "在吗" }] });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: { type: string } }).toMatchObject({ error: { type: "invalid_request_error" } });
    expect(lookups).toBe(0);
  });

  it("refuses in OpenAI's shape", async () => {
    const answer: Answer = () => said("在");
    const strict = chatCompletions({ answerer: only("m", answer) });
    const lenient = chatCompletions({ answerer: only("m", answer), misheard: "没听清" });
    const cases: [typeof strict, unknown, number, string][] = [
      [strict, { model: "nope", messages: [{ role: "user", content: "在吗" }] }, 404, "model_not_found"],
      [strict, { model: "m", messages: [] }, 400, "no_user_message"],
      [strict, "not an object", 400, "invalid_json"],
    ];
    for (const [handle, body, status, code] of cases) {
      const res = await ask(handle, body);
      expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([status, code]);
    }
    const misheard = await ask(lenient, { model: "m", messages: [] });
    expect([misheard.status, await misheard.text()]).toEqual([200, expect.stringContaining("没听清")]);
    expect((await ask(strict, undefined, "GET")).status).toBe(405);
  });
});
