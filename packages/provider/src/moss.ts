import { Schema } from "effect";

export const mossRealtimeUrl = "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0";
export const mossInRate = 16000;
export const mossOutRate = 48000;
export const mossFrameSamples = 320;
export const mossTaggedFrameBytes = 1 + mossFrameSamples * 2;
export const mossAudioTag = 0x00;

const MossErrorObjectSchema = Schema.Struct({ message: Schema.optionalKey(Schema.String) });
const MossEventPayloadSchema = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  turn: Schema.optionalKey(Schema.String),
  turn_id: Schema.optionalKey(Schema.String),
  chunk_id: Schema.optionalKey(Schema.String),
  run_id: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  call_id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  arguments: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.Union([Schema.String, MossErrorObjectSchema])),
});
const MossFrameSchema = Schema.fromJsonString(
  Schema.Struct({
    action: Schema.optionalKey(Schema.String),
    type: Schema.optionalKey(Schema.String),
    call_id: Schema.optionalKey(Schema.String),
    name: Schema.optionalKey(Schema.String),
    arguments: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(MossErrorObjectSchema),
    data: Schema.optionalKey(MossEventPayloadSchema),
  }),
);
export const decodeMossFrame = Schema.decodeUnknownOption(MossFrameSchema);

export const mossErrorMessage = (body: string): string => {
  const decoded = decodeMossFrame(body);
  const msg = decoded._tag === "Some" ? decoded.value.error?.message : undefined;
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
