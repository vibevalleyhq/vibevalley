/** One server-sent event: `event` is "message" when the frame named none; data lines are joined with "\n". */
export interface SseEvent {
  readonly event: string;
  readonly id: string | undefined;
  readonly data: string;
}

/** An event, or the frame still being read, grew past the limit. */
export class SseTooLarge extends Error {
  override readonly name = "SseTooLarge";
  readonly maxEventSize: number;
  constructor(maxEventSize: number) {
    super(`Pending SSE event exceeded the maximum size of ${maxEventSize}`);
    this.maxEventSize = maxEventSize;
  }
}

/** The stream asked to be reconnected after a delay (a `retry:` field). */
export class SseRetry extends Error {
  override readonly name = "SseRetry";
  readonly ms: number;
  readonly lastEventId: string | undefined;
  constructor(ms: number, lastEventId: string | undefined) {
    super(`The stream asked to retry after ${ms} ms`);
    this.ms = ms;
    this.lastEventId = lastEventId;
  }
}

const BOM = "﻿";
const LF = 10;
const CR = 13;
const SPACE = 32;

/** The events of an SSE text stream, by the WHATWG rules: CR, LF and CRLF end lines (also across chunks), comments and
 * events without data are skipped, a leading BOM is dropped. A `retry:` field ends the stream with SseRetry after the
 * events of its chunk; a chunk leaving more than maxEventSize unfinished ends it with SseTooLarge. */
export async function* sseEvents(source: AsyncIterable<string>, options: { readonly maxEventSize: number }): AsyncGenerator<SseEvent> {
  const { maxEventSize } = options;
  let isFirstChunk = true;
  let pending: string[] = [];
  let pendingLength = 0;
  let discardTrailingNewline = false;
  let lastEventId: string | undefined;
  let eventName: string | undefined;
  let data = "";
  let retry: SseRetry | undefined;
  let out: SseEvent[] = [];

  const parseLine = (line: string) => {
    if (line.length === 0) {
      const eventData = data;
      const event = eventName || "message";
      eventName = undefined;
      data = "";
      if (eventData.length > 0) out.push({ event, id: lastEventId, data: eventData.slice(0, -1) });
      return;
    }
    const colon = line.indexOf(":");
    let field = line;
    let value = "";
    if (colon >= 0) {
      field = line.slice(0, colon);
      value = line.slice(line.charCodeAt(colon + 1) === SPACE ? colon + 2 : colon + 1);
    }
    if (field === "data") data += value + "\n";
    else if (field === "event") eventName = value;
    else if (field === "id" && !value.includes("\u0000")) lastEventId = value;
    else if (field === "retry" && /^\d+$/u.test(value)) retry = new SseRetry(Number.parseInt(value, 10), lastEventId);
  };

  for await (let chunk of source) {
    if (chunk.length === 0) continue;
    if (isFirstChunk && chunk.startsWith(BOM)) chunk = chunk.slice(BOM.length);
    isFirstChunk = false;
    const length = chunk.length;
    let position = 0;
    while (position < length) {
      if (discardTrailingNewline) {
        discardTrailingNewline = false;
        if (chunk.charCodeAt(position) === LF) {
          ++position;
          continue;
        }
      }
      let lineEnd = position;
      while (lineEnd < length) {
        const code = chunk.charCodeAt(lineEnd);
        if (code === CR || code === LF) break;
        ++lineEnd;
      }
      if (lineEnd === length) {
        pending.push(chunk.slice(position));
        pendingLength += length - position;
        break;
      }
      discardTrailingNewline = chunk.charCodeAt(lineEnd) === CR;
      let line = chunk.slice(position, lineEnd);
      if (pending.length > 0) {
        pending.push(line);
        line = pending.join("");
        pending = [];
        pendingLength = 0;
      }
      parseLine(line);
      position = lineEnd + 1;
    }
    // Events finished in the chunk that overflowed are dropped with it.
    if (pendingLength + data.length > maxEventSize) throw new SseTooLarge(maxEventSize);
    const ready = out;
    out = [];
    yield* ready;
    if (retry !== undefined) throw retry;
  }
}
