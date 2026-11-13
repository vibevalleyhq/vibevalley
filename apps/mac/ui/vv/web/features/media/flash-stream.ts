import { t } from "@vibevalley/i18n";
import { mediaSpeechStreamPath, type MediaSpeechEvent } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

const decodeEvent = (line: string) => S.jsonString(S.MediaSpeechEvent).parse(line);
const maximumChunk = 32 * 1024;
const maximumLine = 4 * Math.ceil(maximumChunk / 3) + 1024;
const maximumAudio = 512_000_000;

export async function* flashEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<MediaSpeechEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let eof = false;
  /** The format comes first, then audio numbered from 0, then done; nothing after done. */
  const read: { stage: { readonly _tag: "format" } | { readonly _tag: "audio"; readonly next: number } | { readonly _tag: "done" } } = {
    stage: { _tag: "format" },
  };
  const parse = (line: string) => {
    if (line.length > maximumLine || read.stage._tag === "done") throw new Error(t("web.audio.flashInvalid"));
    let event: MediaSpeechEvent;
    try {
      event = decodeEvent(line);
    } catch {
      throw new Error(t("web.audio.flashInvalid"));
    }
    switch (event.type) {
      case "format":
        if (read.stage._tag !== "format") throw new Error(t("web.audio.flashInvalid"));
        read.stage = { _tag: "audio", next: 0 };
        break;
      case "audio":
        if (read.stage._tag !== "audio" || event.sequence !== read.stage.next) throw new Error(t("web.audio.flashInvalid"));
        read.stage = { _tag: "audio", next: read.stage.next + 1 };
        break;
      case "done":
        if (read.stage._tag !== "audio" || read.stage.next === 0) throw new Error(t("web.audio.flashIncomplete"));
        read.stage = { _tag: "done" };
        break;
      case "failed":
        throw new Error(t("web.audio.flashIncomplete"));
    }
    return event;
  };
  try {
    while (!eof) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      eof = chunk.done;
      pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) yield parse(line);
        newline = pending.indexOf("\n");
      }
      if (pending.length > maximumLine) throw new Error(t("web.audio.flashInvalid"));
    }
    if (pending.trim()) yield parse(pending.trim());
    if (read.stage._tag !== "done") throw new Error(t("web.audio.flashIncomplete"));
  } finally {
    try {
      if (!eof && !signal.aborted) await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

export function flashPcm(audio: string, channels: number) {
  if (audio.length > 4 * Math.ceil(maximumChunk / 3)) throw new Error(t("web.audio.flashInvalid"));
  const bytes = Uint8Array.from(atob(audio), (character) => character.charCodeAt(0));
  if (bytes.length === 0 || bytes.length > maximumChunk || bytes.length % (2 * channels) !== 0) throw new Error(t("web.audio.flashInvalid"));
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export interface FlashPlaybackProgress {
  receivedSeconds: number;
  playedSeconds: number;
  bufferedSeconds: number;
  complete: boolean;
}

function untilEnded(ended: Promise<void>, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void ended.then(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    });
  });
}

export async function playFlashStream(id: string, context: AudioContext, signal: AbortSignal, progress: (value: FlashPlaybackProgress) => void) {
  const response = await fetch(mediaSpeechStreamPath(id), { signal, headers: { accept: "application/x-ndjson" } });
  if (!response.ok || !response.body) throw new Error(t("web.audio.flashUnavailable"));
  let format: Extract<MediaSpeechEvent, { type: "format" }> | undefined;
  let receivedBytes = 0;
  let receivedSeconds = 0;
  let playedSeconds = 0;
  let through = context.currentTime;
  let complete = false;
  let stopped = false;
  const queued: { source: AudioBufferSourceNode; ended: Promise<void> }[] = [];
  const publish = () => progress({ receivedSeconds, playedSeconds, bufferedSeconds: Math.max(0, through - context.currentTime), complete });
  const stop = () => {
    stopped = true;
    for (const item of queued) {
      item.source.stop();
      item.source.disconnect();
    }
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    for await (const event of flashEvents(response.body, signal)) {
      signal.throwIfAborted();
      switch (event.type) {
        case "format":
          format = event;
          break;
        case "audio": {
          if (!format) throw new Error(t("web.audio.flashInvalid"));
          const pcm = flashPcm(event.audio, format.channels);
          receivedBytes += pcm.byteLength;
          if (receivedBytes > maximumAudio) throw new Error(t("web.audio.flashInvalid"));
          const frames = pcm.byteLength / (2 * format.channels);
          receivedSeconds += frames / format.sampleRate;
          const maximumFrames = Math.floor(format.sampleRate / 2);
          for (let offset = 0; offset < frames; offset += maximumFrames) {
            const count = Math.min(maximumFrames, frames - offset);
            const duration = count / format.sampleRate;
            while (queued.length >= 32 || (queued.length > 0 && through - context.currentTime + duration > 5)) {
              const first = queued[0];
              if (first) await untilEnded(first.ended, signal);
            }
            signal.throwIfAborted();
            const buffer = context.createBuffer(format.channels, count, format.sampleRate);
            for (let channel = 0; channel < format.channels; channel++) {
              const output = buffer.getChannelData(channel);
              for (let frame = 0; frame < count; frame++) output[frame] = pcm.getInt16(((offset + frame) * format.channels + channel) * 2, true) / 32768;
            }
            const source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(context.destination);
            const ended = new Promise<void>((resolve) => {
              source.onended = () => {
                source.disconnect();
                const index = queued.findIndex((item) => item.source === source);
                if (index >= 0) queued.splice(index, 1);
                if (!signal.aborted && !stopped) {
                  playedSeconds += duration;
                  publish();
                }
                resolve();
              };
            });
            const start = Math.max(context.currentTime + 0.02, through);
            source.start(start);
            queued.push({ source, ended });
            through = start + duration;
            publish();
          }
          break;
        }
        case "done":
          complete = true;
          publish();
          break;
        case "failed":
          throw new Error(t("web.audio.flashIncomplete"));
      }
    }
    while (queued.length > 0) {
      const first = queued[0];
      if (first) await untilEnded(first.ended, signal);
    }
    signal.throwIfAborted();
    publish();
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
  }
}
