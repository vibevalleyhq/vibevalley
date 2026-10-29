import { describe, expect, it } from "vite-plus/test";
import { type Answer, chatChunk, chatCompletions, newestUserText } from "./openai.ts";
import { wallTime } from "@/base/time.ts";

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
      now: wallTime.now,
      answerer: only("m", (text) => {
        heard = text;
        return said("好，", "这就去。");
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
    const handle = chatCompletions({ now: wallTime.now, answerer: only("m", () => said("好，", "这就去。")) });
    const res = await ask(handle, {
      model: "m",
      stream: true,
      messages: [{ role: "user", content: "跑测试" }],
    });
    const lines = (await res.text()).split("\n\n").filter(Boolean);
    expect(lines.at(-1)).toBe("data: [DONE]");
    expect(lines.slice(0, 2).map((l) => JSON.parse(l.slice(6)).choices[0].delta.content)).toEqual(["好，", "这就去。"]);
  });

  it("refuses in OpenAI's shape", async () => {
    const answer: Answer = () => said("在");
    const strict = chatCompletions({ now: wallTime.now, answerer: only("m", answer) });
    const lenient = chatCompletions({ now: wallTime.now, answerer: only("m", answer), misheard: "没听清" });
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

  it("rejects valid JSON with an invalid request shape before answering", async () => {
    let calls = 0;
    const handle = chatCompletions({
      now: wallTime.now,
      answerer: only("m", () => {
        calls++;
        return said("不该回答");
      }),
    });
    const cases = [
      { model: "m", messages: {} },
      { model: "m", messages: [null] },
      { model: "m", messages: [{ role: "user", content: 1 }] },
      { model: "m", stream: "false", messages: [] },
      { model: 1, messages: [] },
    ];
    for (const body of cases) {
      const res = await ask(handle, body);
      expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([400, "invalid_json"]);
    }
    expect(calls).toBe(0);
  });
});
