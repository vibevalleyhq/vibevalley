import { z } from "zod";

export const SpriteManifest = z.record(
  z.string(),
  z.object({
    w: z.number(),
    h: z.number(),
    ax: z.number(),
    ay: z.number(),
    hx: z.exactOptional(z.number()),
    hy: z.exactOptional(z.number()),
    yard: z.exactOptional(z.array(z.number())),
    sheet: z.exactOptional(z.string()),
  }),
);
export const CursorManifest = z.record(z.string(), z.object({ hx: z.number(), hy: z.number() }));
