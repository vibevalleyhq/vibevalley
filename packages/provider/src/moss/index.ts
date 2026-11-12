import { z } from "zod";

import { fromJson } from "../base/json.ts";

export const mossRealtimeUrl = "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0";
export const mossInRate = 16000;
export const mossOutRate = 48000;
export const mossFrameSamples = 320;
export const mossTaggedFrameBytes = 1 + mossFrameSamples * 2;
export const mossAudioTag = 0x00;

const MossErrorObjectSchema = z.object({
  message: z.exactOptional(z.string()),
  code: z.exactOptional(z.string()),
  client_event_id: z.exactOptional(z.string()),
});
const MossEventPayloadSchema = z.object({
  session_id: z.exactOptional(z.string()),
  memory_scope: z.exactOptional(z.string()),
  delegation: z.exactOptional(z.string()),
  status: z.exactOptional(z.string()),
  reconnect: z.exactOptional(z.boolean()),
  code: z.exactOptional(z.union([z.string(), z.number()])),
  text: z.exactOptional(z.string()),
  turn: z.exactOptional(z.string()),
  turn_id: z.exactOptional(z.string()),
  chunk_id: z.exactOptional(z.string()),
  run_id: z.exactOptional(z.string()),
  reason: z.exactOptional(z.string()),
  call_id: z.exactOptional(z.string()),
  name: z.exactOptional(z.string()),
  arguments: z.exactOptional(z.string()),
  error: z.exactOptional(z.union([z.string(), MossErrorObjectSchema])),
});
const MossFrameSchema = z.object({
  action: z.exactOptional(z.string()),
  type: z.exactOptional(z.string()),
  call_id: z.exactOptional(z.string()),
  name: z.exactOptional(z.string()),
  arguments: z.exactOptional(z.string()),
  error: z.exactOptional(MossErrorObjectSchema),
  data: z.exactOptional(MossEventPayloadSchema),
});
export type MossFrame = z.output<typeof MossFrameSchema>;
/** A MOSS Live text frame, or undefined when it is not JSON of that shape. */
export const decodeMossFrame = (input: unknown): MossFrame | undefined => fromJson(MossFrameSchema, input);

export const mossErrorMessage = (body: string): string => {
  const msg = decodeMossFrame(body)?.error?.message;
  return msg ? msg : body.slice(0, 200);
};

export function packTaggedAudio(pcm: Int16Array, muted = false): Uint8Array {
  const bytes = new Uint8Array(1 + pcm.byteLength);
  bytes[0] = mossAudioTag;
  if (!muted) bytes.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 1);
  return bytes;
}

export function unpackPcm16(data: ArrayBuffer): Int16Array {
  return new Int16Array(data, 0, Math.floor(data.byteLength / 2));
}
