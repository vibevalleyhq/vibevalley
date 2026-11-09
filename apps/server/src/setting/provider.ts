import { Array as Arr, Option, Schema } from "effect";

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

/** What an account serves: each use the owner binds to one. */
export type Use = "dictation" | "image" | "understanding" | "speech" | "live" | "speakers" | "voiceDesign" | "transcription" | "vision";

type Connection = ProviderSettings["connections"][number];

/** The account a use is bound to, ready to call; or what it lacks, first things first: an account at all, a binding,
 * the account turned on, its key. The one rule readiness and the calls both follow. */
export const bindingOf =
  (use: Use) =>
  (
    settings: ProviderSettings,
  ):
    | { readonly ready: true; readonly connection: Connection; readonly model: string }
    | { readonly ready: false; readonly missing: "mossAccount" | "binding" | "mossOff" | "mossKey" } => {
    if (settings.connections.length === 0) return { ready: false, missing: "mossAccount" };
    const binding = settings[use];
    const found = binding === null ? Option.none() : Arr.findFirst(settings.connections, (c) => c.id === binding.connection);
    if (binding === null || Option.isNone(found)) return { ready: false, missing: "binding" };
    const connection = found.value;
    if (!connection.enabled) return { ready: false, missing: "mossOff" };
    if (connection.key === "") return { ready: false, missing: "mossKey" };
    return { ready: true, connection, model: binding.model };
  };

export const boundConnection = (settings: ProviderSettings, id: string | null) =>
  settings.connections.find((connection) => connection.id === id && connection.enabled && connection.key !== "");
