import { abortable, lines } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";

import { exit, Failure } from "#/base/output.ts";

/** Bytes of a stream as they come; cancelled when the reader stops early or signal aborts (a body that came without one
 * of its own, as a test's does, stops too). */
async function* chunks(body: ReadableStream<Uint8Array>, signal: AbortSignal | undefined): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) return;
      yield value;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already errored or aborted: there is nothing left to let go of.
    }
    reader.releaseLock();
  }
}

/** Each event's data of a text/event-stream, as the SSE format defines it: data lines joined by \n, an event with none
 * left out. A `retry:` directive asks the reader to reconnect, which the command line does not do on its own: it is a
 * failure of the stream. */
export async function* sseData(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  let data: string[] = [];
  let first = true;
  for await (let line of lines(chunks(body, signal))) {
    if (first && line.startsWith("﻿")) line = line.slice(1);
    first = false;
    if (line === "") {
      if (data.length > 0) yield data.join("\n");
      data = [];
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(line.charAt(colon + 1) === " " ? colon + 2 : colon + 1);
    if (field === "data") data.push(value);
    else if (field === "retry" && /^\d+$/u.test(value)) throw new Failure({ code: exit.other, tag: "Server", text: t("cli.failure.retry") });
  }
}
