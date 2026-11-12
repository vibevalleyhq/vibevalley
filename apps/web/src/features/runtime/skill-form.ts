import { z } from "zod";

export const SkillInput = z.object({
  name: z.string().trim().min(1),
  description: z.string(),
  body: z.string().regex(/\S/u),
});
