// OpenAI's chat/completions for an agent that keeps its own conversation. Only the
// newest user message is read: the agent's session is the history and its own prompt the persona, so earlier messages,
// system messages and tools in the request are not. Only the agent's words come back, without usage. Who may ask (paths,
// keys) is the mounting side's business.

import { randomBytes } from "node:crypto";

import { ByteSize, Cause, Clock, Effect, Schema, Stream } from "effect";
import { HttpIncomingMessage, HttpServerRequest, HttpServerResponse } from "effect/http";

/** One turn's words as they come, ending with the turn. Interrupting the stream (the asker went away) ends the turn's
 * part in it: nothing is said for nobody. */
export type Answer<E = never> = (text: string) => Stream.Stream<string, E>;

export interface ChatCompletions<E = never> {
  /** Undefined: no such model. */
  readonly answerer: (model: string) => Answer<E> | undefined;
  /** Said when a request has no user text; absent: such a request is refused. */
  readonly misheard?: string;
}

/** A request's body past this is refused before it is read: a turn's words are small. */
const bodyMax = 1024 * 1024;

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
  return (m.content ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("")
    .trim();
}

const json = (status: number, body: unknown) => HttpServerResponse.jsonUnsafe(body, { status });

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

/** The route's handler: the request read as OpenAI's, the answer whole or as server-sent chunks. A client that goes away
 * while it streams interrupts the response, and with it the answer. */
export const chatCompletions = <E>(c: ChatCompletions<E>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== "POST") return refuse(405, "invalid_request_error", "method_not_allowed", "only POST");
    const asked = yield* Clock.currentTimeMillis;
    const length = Number(request.headers["content-length"] ?? 0);
    if (length > bodyMax) return refuse(413, "invalid_request_error", "request_too_large", `the body is ${length} bytes, at most ${bodyMax}`);
    const text = yield* Effect.provideService(request.text, HttpIncomingMessage.MaxBodySize, ByteSize.bytes(bodyMax)).pipe(Effect.option);
    if (text._tag === "None") return refuse(413, "invalid_request_error", "request_too_large", `the body is more than ${bodyMax} bytes`);
    const decoded = Schema.decodeResult(Schema.fromJsonString(ChatRequest))(text.value);
    if (decoded._tag === "Failure") return refuse(400, "invalid_request_error", "invalid_json", decoded.failure.message);
    const req = decoded.success;
    const model = req.model ?? "";
    const answer = c.answerer(model);
    if (!answer) return refuse(404, "invalid_request_error", "model_not_found", "no model " + model);
    const said = newestUserText(req);
    if (!said && !c.misheard) return refuse(400, "invalid_request_error", "no_user_message", "no user message to answer");
    const words = (said ? answer(said) : Stream.succeed(c.misheard!)).pipe(
      Stream.zipWithIndex,
      // How long the first words took, in the log.
      Stream.tap(([, i]) =>
        i === 0
          ? Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.logInfo(`vibevalley: ${model}'s first words ${now - asked}ms after it was asked`))
          : Effect.void,
      ),
      Stream.map(([w]) => w),
    );
    const id = "chatcmpl-" + randomBytes(6).toString("hex");
    const created = Math.floor(asked / 1000);
    if (req.stream !== true) {
      const all = yield* Effect.option(Stream.mkString(words));
      if (all._tag === "None") return refuse(502, "server_error", "not_answered", "the answer was cut off");
      return json(200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: all.value }, finish_reason: "stop" }],
      });
    }
    const chunks = words.pipe(
      Stream.zipWithIndex,
      Stream.map(([w, i]) => chatChunk(id, created, model, w, false, i === 0)),
      Stream.concat(Stream.make(chatChunk(id, created, model, "", true, false), "data: [DONE]\n\n")),
      // An answer that fails midway ends the stream there, with no [DONE]: the asker sees it cut off.
      Stream.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        () => Stream.empty,
      ),
      Stream.encodeText,
    );
    return HttpServerResponse.stream(chunks, {
      contentType: "text/event-stream",
      headers: { "cache-control": "no-cache", connection: "keep-alive" },
    });
  });
