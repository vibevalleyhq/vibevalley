import { Schema } from "effect";

export const SpriteManifest = Schema.Record(
  Schema.String,
  Schema.Struct({
    w: Schema.Finite,
    h: Schema.Finite,
    ax: Schema.Finite,
    ay: Schema.Finite,
    hx: Schema.optionalKey(Schema.Finite),
    hy: Schema.optionalKey(Schema.Finite),
    yard: Schema.optionalKey(Schema.Array(Schema.Finite)),
    sheet: Schema.optionalKey(Schema.String),
  }),
);
export const CursorManifest = Schema.Record(Schema.String, Schema.Struct({ hx: Schema.Finite, hy: Schema.Finite }));
export const TitleManifest = Schema.Record(Schema.String, Schema.Struct({ w: Schema.Finite, h: Schema.Finite }));
