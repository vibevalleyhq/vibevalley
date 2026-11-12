import { randomBytes } from "node:crypto";

import { z } from "zod";

import { type Clock, isAbort, systemClock } from "@vibevalley/async";

import type { Logger } from "#/infra/log.ts";

/** One turn's words as they come, ending with the turn. Breaking off the iteration (the asker went away) ends the
 * turn's part in it: nothing is said for nobody. */
export type Answer = (text: string, signal?: AbortSignal) => AsyncIterable<string>;

export interface ChatCompletions {
  /** Undefined: no such model. */
  readonly answerer: (model: string) => Answer | undefined;
  /** Said when a request has no user text; absent: such a request is refused. */
  readonly misheard?: string;
}

export interface ChatCompletionsDeps {
  readonly clock?: Clock;
  readonly log?: Logger;
}

/** A request's body past this is refused before it is read: a turn's words are small. */
const bodyMax = 1024 * 1024;

const ContentPart = z.object({
  type: z.exactOptional(z.string()),
  text: z.exactOptional(z.string()),
});
const ChatRequest = z.object({
  model: z.exactOptional(z.string()),
  stream: z.exactOptional(z.boolean()),
  messages: z.exactOptional(
    z.array(
      z.object({
        role: z.exactOptional(z.string()),
        content: z.exactOptional(z.union([z.string(), z.array(ContentPart)])),
      }),
    ),
  ),
});
type ChatRequest = z.output<typeof ChatRequest>;

/** Content is a string or a list of parts, of which only the text ones count. */
export function newestUserText(req: ChatRequest): string {
  const m = (req.messages ?? []).findLast((x) => x.role === "user");
  if (!m) return "";
  if (typeof m.content === "string") return m.content.trim();
  return (m.content ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}

const json = (status: number, body: unknown) => Response.json(body, { status });

const refuse = (status: number, kind: string, code: string, message: string) => json(status, { error: { message, type: kind, code } });

interface ChatChunk {
  readonly id: string;
  readonly object: "chat.completion.chunk";
  readonly created: number;
  readonly model: string;
  readonly choices: readonly {
    readonly index: number;
    readonly delta: { readonly role?: "assistant"; readonly content?: string };
    readonly finish_reason: "stop" | null;
  }[];
}

/** finish_reason is null until the last chunk, which has an empty delta. */
export const chatChunk = (id: string, created: number, model: string, content: string, stop: boolean, first: boolean): string => {
  const delta = stop ? {} : { ...(first ? { role: "assistant" as const } : {}), content };
  const chunk: ChatChunk = { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: stop ? "stop" : null }] };
  return "data: " + JSON.stringify(chunk) + "\n\n";
};

/** The body as text, or undefined past max bytes: read as it comes, so a long one is not read whole first. */
async function textUpTo(request: Request, max: number): Promise<string | undefined> {
  if (request.body === null) return "";
  const reader: ReadableStreamDefaultReader<Uint8Array> = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return undefined;
    }
    parts.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}

const readRequest = (text: string): { readonly ok: true; readonly value: ChatRequest } | { readonly ok: false; readonly problem: string } => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, problem: e instanceof Error ? e.message : String(e) };
  }
  const read = ChatRequest.safeParse(value);
  return read.success ? { ok: true, value: read.data } : { ok: false, problem: read.error.message };
};

/** The route's handler: the request read as OpenAI's, the answer whole or as server-sent chunks. The request's signal
 * (the asker going away) ends the answer. */
export const chatCompletions =
  (c: ChatCompletions, deps: ChatCompletionsDeps = {}) =>
  async (request: Request): Promise<Response> => {
    const clock = deps.clock ?? systemClock;
    if (request.method !== "POST") return refuse(405, "invalid_request_error", "method_not_allowed", "only POST");
    const asked = clock.now();
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > bodyMax) return refuse(413, "invalid_request_error", "request_too_large", `the body is ${length} bytes, at most ${bodyMax}`);
    const text = await textUpTo(request, bodyMax);
    if (text === undefined) return refuse(413, "invalid_request_error", "request_too_large", `the body is more than ${bodyMax} bytes`);
    const decoded = readRequest(text);
    if (!decoded.ok) return refuse(400, "invalid_request_error", "invalid_json", decoded.problem);
    const req = decoded.value;
    const model = req.model ?? "";
    const answer = c.answerer(model);
    if (!answer) return refuse(404, "invalid_request_error", "model_not_found", "no model " + model);
    const said = newestUserText(req);
    if (!said && !c.misheard) return refuse(400, "invalid_request_error", "no_user_message", "no user message to answer");
    const misheard = c.misheard ?? "";
    const answering: Answer = answer;
    async function* words(signal: AbortSignal): AsyncGenerator<string> {
      let i = 0;
      for await (const w of said ? answering(said, signal) : [misheard]) {
        // How long the first words took, in the log.
        if (i++ === 0) deps.log?.info(`vibevalley: ${model}'s first words ${clock.now() - asked}ms after it was asked`);
        yield w;
      }
    }
    const id = "chatcmpl-" + randomBytes(6).toString("hex");
    const created = Math.floor(asked / 1000);
    if (req.stream !== true) {
      let all = "";
      try {
        for await (const w of words(request.signal)) all += w;
      } catch (e) {
        if (isAbort(e, request.signal)) throw e;
        return refuse(502, "server_error", "not_answered", "the answer was cut off");
      }
      return json(200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: all }, finish_reason: "stop" }],
      });
    }
    const stop = new AbortController();
    const signal = AbortSignal.any([request.signal, stop.signal]);
    const encoder = new TextEncoder();
    const source = words(signal);
    let i = 0;
    let done = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (done) return;
        try {
          const next = await source.next();
          if (next.done !== true) {
            controller.enqueue(encoder.encode(chatChunk(id, created, model, next.value, false, i++ === 0)));
            return;
          }
          controller.enqueue(encoder.encode(chatChunk(id, created, model, "", true, false) + "data: [DONE]\n\n"));
        } catch (e) {
          // An answer that fails midway ends the stream there, with no [DONE]: the asker sees it cut off.
          if (!isAbort(e, signal)) deps.log?.warn(`vibevalley: ${model}'s answer failed midway`, e);
        }
        done = true;
        controller.close();
      },
      async cancel() {
        done = true;
        stop.abort();
        await source.return(undefined);
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  };
