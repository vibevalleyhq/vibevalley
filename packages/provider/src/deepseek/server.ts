import { z } from "zod";

import { isAbort } from "@vibevalley/async";

import { bodyChunks, decodeText, ProviderTransportError } from "../base/http.ts";
import { fromJson, jsonText } from "../base/json.ts";
import { SseRetry, SseTooLarge, sseEvents } from "../base/sse.ts";
import { type DeepSeekInput, encodeDeepSeekRequest } from "./request.ts";
import { type DeepSeekChunk, decodeDeepSeekChunk } from "./response.ts";

const maxEventSize = 4 << 20;

class DeepSeekError extends Error {
  override readonly name = "DeepSeekError";
  readonly reason: "network" | "status" | "stream";
  declare readonly status?: number;

  constructor(fields: { readonly reason: "network" | "status" | "stream"; readonly status?: number; readonly message: string; readonly cause?: unknown }) {
    super(fields.message, fields.cause === undefined ? undefined : { cause: fields.cause });
    this.reason = fields.reason;
    if (fields.status !== undefined) this.status = fields.status;
  }
}

const ErrorBody = z.object({ error: z.record(z.string(), z.unknown()) });

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function statusMessage(status: number, text: string): string {
  const body = fromJson(ErrorBody, text);
  if (body !== undefined) return `${status}: ${jsonText(body.error)}`;
  return `${status} ${text.trim() || "status code (no body)"}`;
}

export interface DeepSeekConnection {
  readonly model: string;
  readonly baseUrl: string;
  readonly key: string;
}

export function makeDeepSeekModel(fetcher: typeof fetch, connection: DeepSeekConnection) {
  async function* events(response: Response, signal: AbortSignal): AsyncGenerator<DeepSeekChunk> {
    try {
      for await (const event of sseEvents(decodeText(bodyChunks(response, signal)), { maxEventSize })) {
        if (event.data.startsWith("[DONE]")) return;
        let chunk: unknown;
        try {
          chunk = JSON.parse(event.data);
        } catch {
          throw new DeepSeekError({ reason: "stream", message: `Not JSON in the stream: ${event.data.slice(0, 200)}` });
        }
        const error: unknown = typeof chunk === "object" && chunk !== null && "error" in chunk ? chunk.error : undefined;
        if (error === undefined || error === null) {
          yield decodeDeepSeekChunk(chunk);
          continue;
        }
        const said = typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : jsonText(error);
        throw new DeepSeekError({ reason: "stream", message: said });
      }
    } catch (e) {
      // A retry field is the server's to act on; this client does not reconnect, so it is the end of the answer.
      if (e instanceof SseRetry) return;
      if (e instanceof SseTooLarge) throw new DeepSeekError({ reason: "stream", message: `SSE frame too large: ${e.message}`, cause: e });
      if (e instanceof ProviderTransportError)
        throw new DeepSeekError({ reason: "stream", message: `The stream broke: ${messageOf(e.cause)}`, cause: e.cause });
      throw e;
    }
  }

  /** Sends the request and answers once the response has a status: a refusal rejects here, the answer is the iterable. */
  const stream = async (input: DeepSeekInput, signal: AbortSignal = new AbortController().signal): Promise<AsyncIterable<DeepSeekChunk>> => {
    let response: Response;
    try {
      response = await fetcher(`${connection.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${connection.key}`, "content-type": "application/json" },
        body: JSON.stringify(encodeDeepSeekRequest(connection.model, input)),
        signal,
      });
    } catch (cause) {
      if (isAbort(cause, signal)) throw cause;
      throw new DeepSeekError({ reason: "network", message: `Connection error: ${messageOf(cause)}`, cause });
    }
    if (response.status >= 400) {
      let text = "";
      try {
        text = await response.text();
      } catch (e) {
        if (isAbort(e, signal)) throw e;
        // The status alone still says what went wrong; the body was only its detail.
      }
      throw new DeepSeekError({ reason: "status", status: response.status, message: statusMessage(response.status, text) });
    }
    return events(response, signal);
  };
  return { stream };
}

export const deepseekModel = (connection: DeepSeekConnection, fetcher: typeof fetch = globalThis.fetch) => makeDeepSeekModel(fetcher, connection);
