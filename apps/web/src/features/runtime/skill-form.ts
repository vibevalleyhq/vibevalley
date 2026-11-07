import { Schema } from "effect";

export const SkillInput = Schema.Struct({
  name: Schema.Trim.check(Schema.isMinLength(1)),
  description: Schema.String,
  body: Schema.String.check(Schema.isPattern(/\S/u)),
});
