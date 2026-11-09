import { Schema } from "effect";

const Connection = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  adapter: Schema.Literal("moss"),
  enabled: Schema.Boolean,
  key: Schema.String,
});

export const ProviderSettings = Schema.Struct({
  revision: Schema.Int,
  connections: Schema.Array(Connection),
  dictation: Schema.NullOr(Schema.Struct({ connection: Schema.String, model: Schema.String })),
  image: Schema.NullOr(Schema.Struct({ connection: Schema.String, model: Schema.String })),
  speech: Schema.NullOr(Schema.Struct({ connection: Schema.String, model: Schema.String })),
  understanding: Schema.NullOr(Schema.Struct({ connection: Schema.String, model: Schema.String })),
  live: Schema.NullOr(Schema.Struct({ connection: Schema.String, model: Schema.String })),
  speakers: Schema.NullOr(Schema.Struct({ connection: Schema.String, model: Schema.String })),
  voiceDesign: Schema.NullOr(Schema.Struct({ connection: Schema.String, model: Schema.String })),
  transcription: Schema.NullOr(Schema.Struct({ connection: Schema.String, model: Schema.String })),
  vision: Schema.NullOr(Schema.Struct({ connection: Schema.String, model: Schema.String })),
});
export type ProviderSettings = typeof ProviderSettings.Type;

export const emptyProviders: ProviderSettings = {
  revision: 0,
  connections: [],
  dictation: null,
  image: null,
  understanding: null,
  speech: null,
  live: null,
  speakers: null,
  voiceDesign: null,
  transcription: null,
  vision: null,
};

export const boundConnection = (settings: ProviderSettings, id: string | null) =>
  settings.connections.find((connection) => connection.id === id && connection.enabled && connection.key !== "");
