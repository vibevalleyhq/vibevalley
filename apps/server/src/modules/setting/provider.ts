import { z } from "zod";

import { Secret } from "@vibevalley/protocol/schema";

/** A key: a plain string in settings.json; in memory it stays a Secret until a call sends it. */
export const StoredKey = z.codec(z.string(), z.instanceof(Secret), { decode: (s) => new Secret(s), encode: (s) => s.reveal() });

const Connection = z.object({
  id: z.string(),
  name: z.string(),
  adapter: z.literal("moss"),
  enabled: z.boolean(),
  key: StoredKey,
});

const Binding = z.object({ connection: z.string(), model: z.string() }).nullable();

export const ProviderSettings = z.object({
  revision: z.number().int(),
  connections: z.array(Connection),
  dictation: Binding,
  image: Binding,
  speech: Binding,
  understanding: Binding,
  live: Binding,
  speakers: Binding,
  voiceDesign: Binding,
  transcription: Binding,
  vision: Binding,
});
export type ProviderSettings = z.output<typeof ProviderSettings>;

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

/** What an account serves: each use the user binds to one. */
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
    const connection = binding === null ? undefined : settings.connections.find((c) => c.id === binding.connection);
    if (binding === null || connection === undefined) return { ready: false, missing: "binding" };
    if (!connection.enabled) return { ready: false, missing: "mossOff" };
    if (connection.key.reveal() === "") return { ready: false, missing: "mossKey" };
    return { ready: true, connection, model: binding.model };
  };

export const boundConnection = (settings: ProviderSettings, id: string | null) =>
  settings.connections.find((connection) => connection.id === id && connection.enabled && connection.key.reveal() !== "");
