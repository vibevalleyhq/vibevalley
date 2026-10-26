// OpenAI's chat/completions for an agent that keeps its own conversation. Only the
// newest user message is read: the agent's session is the history and its own prompt the persona, so earlier messages,
// system messages and tools in the request are not. Only the agent's words come back, without usage. Who may ask (paths,
// keys) is the mounting side's business.

import { randomBytes } from "node:crypto";
import { Schema } from "effect";

/** One turn's words as they come; done when the turn is over. */
export type Answer = (text: string, signal: AbortSignal) => AsyncIterable<string>;

export interface ChatCompletions {
  /** Undefined: no such model. */
  readonly answerer: (model: string) => Answer | undefined;
  /** Said when a request has no user text; absent: such a request is refused. */
  readonly misheard?: string;
  readonly log?: (line: string) => void;
  /** The service's Clock: a completion's created time and how long its first words took. */
  readonly now: () => number;
}

const ContentPart = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
});
const ChatRequest = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  stream: Schema.optionalKey(Schema.Boolean),
  messages: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        role: Schema.optionalKey(Schema.String),
        content: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(ContentPart)])),
      }),
    ),
  ),
});
type ChatRequest = typeof ChatRequest.Type;

/** Content is a string or a list of parts, of which only the text ones count. */
export function newestUserText(req: ChatRequest): string {
  const m = (req.messages ?? []).findLast((x) => x.role === "user");
  if (!m) return "";
  if (typeof m.content === "string") return m.content.trim();
  if (!Array.isArray(m.content)) return "";
  return m.content
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const refuse = (status: number, kind: string, code: string, message: string) => json(status, { error: { message, type: kind, code } });

/** finish_reason is null until the last chunk, which has an empty delta. */
export function chatChunk(id: string, created: number, model: string, content: string, stop: boolean, first: boolean): string {
  const delta = stop ? {} : { ...(first ? { role: "assistant" } : {}), content };
  return (
    "data: " +
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: stop ? "stop" : null }],
    }) +
    "\n\n"
  );
}

async function* once(text: string) {
  yield text;
}

export function chatCompletions(c: ChatCompletions) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return refuse(405, "invalid_request_error", "method_not_allowed", "only POST");
    const asked = c.now();
    let req: ChatRequest;
    try {
      req = Schema.decodeUnknownSync(ChatRequest)(await request.json());
    } catch (e) {
      return refuse(400, "invalid_request_error", "invalid_json", e instanceof Error ? e.message : String(e));
    }
    const model = req.model ?? "";
    const answer = c.answerer(model);
    if (!answer) return refuse(404, "invalid_request_error", "model_not_found", "no model " + model);
    const text = newestUserText(req);
    if (!text && !c.misheard) return refuse(400, "invalid_request_error", "no_user_message", "no user message to answer");
    const ended = new AbortController();
    // An abort before this line has already fired: it is passed on as it is, so the answer is not started for nobody.
    if (request.signal.aborted) ended.abort();
    else request.signal.addEventListener("abort", () => ended.abort(), { once: true });
    const words = text ? answer(text, ended.signal) : once(c.misheard!);
    const id = "chatcmpl-" + randomBytes(6).toString("hex");
    const created = Math.floor(asked / 1000);
    const firstWords = () => c.log?.(`vibevalley: ${model}'s first words ${c.now() - asked}ms after it was asked`);
    if (!req.stream) {
      let all = "";
      for await (const w of words) {
        if (all === "") firstWords();
        all += w;
      }
      return json(200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: all }, finish_reason: "stop" }],
      });
    }
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let first = true;
        try {
          for await (const w of words) {
            if (first) firstWords();
            controller.enqueue(encoder.encode(chatChunk(id, created, model, w, false, first)));
            first = false;
          }
          controller.enqueue(encoder.encode(chatChunk(id, created, model, "", true, false)));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch {
          controller.close();
        }
      },
      cancel() {
        ended.abort();
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  };
}
