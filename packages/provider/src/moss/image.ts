import { z } from "zod";

import { bounded, type ProviderHttp, send } from "../base/http.ts";
import { codePoints, fromJson, httpsUrl, int } from "../base/json.ts";
import { mossImageModels } from "./image-models.ts";
import { badKey, type MossErrorFields, MossResponseTooLarge, readMossResponse, rejectedStatuses } from "./response.ts";

const Text = codePoints(1, 4000).regex(/\S/u);
const Dimension = int(256, 2048).multipleOf(16);
const Size = z.strictObject({ width: Dimension, height: Dimension }).refine((size) => size.width * size.height <= 2097152);
const Coordinate = z.number();
const Layout = z.strictObject({
  summary: z.strictObject({ caption: Text, meta: z.exactOptional(z.array(z.string().min(1))), canvas: z.exactOptional(z.string().min(1)) }),
  items: z
    .array(
      z.strictObject({
        label: z.string().min(1),
        caption: Text,
        text: z.exactOptional(z.string()),
        bbox: z.tuple([Coordinate, Coordinate, Coordinate, Coordinate]),
      }),
    )
    .min(1)
    .max(100),
  bbox_format: z.literal("yxyx"),
  bbox_coord_space: z.literal("abs_centralized"),
});

const MossImageInput = z.strictObject({
  model: z.enum(mossImageModels),
  prompt: z.union([Text, Layout]),
  size: z.exactOptional(Size),
  seed: z.exactOptional(int()),
  steps: z.exactOptional(int(1, 100)),
  guidance: z.exactOptional(z.number().min(0).max(10)),
  negativePrompt: z.exactOptional(codePoints(0, 4000)),
  enhance: z.exactOptional(z.boolean()),
  watermark: z.exactOptional(z.boolean()),
});

const ErrorCode = z.enum([
  "invalid_field_value",
  "forbidden",
  "prompt_enhancement_refused",
  "safety_guardrail_blocked",
  "resource_not_found",
  "concurrency_limit_exceeded",
  "rate_limit_exceeded",
  "prompt_enhancement_incomplete",
  "upstream_invalid_result",
]);
type ErrorCode = z.output<typeof ErrorCode>;
const ErrorResponse = z.object({ error: z.object({ code: ErrorCode }) });
const ImageResponse = z.object({
  created: int(),
  data: z.tuple([z.object({ url: httpsUrl() })]),
  usage: z
    .object({ generated_images: z.literal(1), output_width: Dimension, output_height: Dimension })
    .refine((usage) => usage.output_width * usage.output_height <= 2097152),
});

class MossImageError extends Error {
  override readonly name = "MossImageError";
  readonly reason: MossErrorFields["reason"];
  readonly outcome: MossErrorFields["outcome"];
  declare readonly status?: number;
  declare readonly code?: ErrorCode;

  constructor(fields: MossErrorFields & { readonly code?: ErrorCode }) {
    super(`MOSS image: ${fields.reason}`);
    this.reason = fields.reason;
    this.outcome = fields.outcome;
    if (fields.status !== undefined) this.status = fields.status;
    if (fields.code !== undefined) this.code = fields.code;
  }
}

const invalidInput = () => new MossImageError({ reason: "InvalidInput", outcome: "NotSubmitted" });

type ImageInput = z.output<typeof MossImageInput>;

export const prepareMossImage = async (
  input: unknown,
): Promise<Omit<ImageInput, "prompt" | "size"> & { readonly prompt: string; readonly size: { readonly width: number; readonly height: number } }> => {
  const parsed = MossImageInput.safeParse(input);
  if (!parsed.success) throw invalidInput();
  const request = parsed.data;
  const size = request.size ?? { width: 1024, height: 1024 };
  if (typeof request.prompt !== "string") {
    for (const item of request.prompt.items) {
      const [top, left, bottom, right] = item.bbox;
      if (top >= bottom || left >= right || top < -size.height / 2 || bottom > size.height / 2 || left < -size.width / 2 || right > size.width / 2)
        throw invalidInput();
    }
  }
  const prompt = typeof request.prompt === "string" ? request.prompt : JSON.stringify(request.prompt);
  if ([...prompt].length > 4000) throw invalidInput();
  return { ...request, prompt, size };
};

export interface MossImage {
  readonly url: string;
  readonly created: number;
  readonly usage: { readonly generated_images: 1; readonly output_width: number; readonly output_height: number };
}

export const generateMossImage = (key: string, input: unknown, http: ProviderHttp): Promise<MossImage> =>
  bounded(
    900_000,
    http,
    async (signal) => {
      if (badKey(key)) throw new MossImageError({ reason: "Credentials", outcome: "NotSubmitted" });
      const request = await prepareMossImage(input);
      const { prompt, size } = request;
      let body: string;
      try {
        body = JSON.stringify({
          model: request.model,
          prompt,
          size: `${size.width}x${size.height}`,
          n: 1,
          response_format: "url",
          prompt_enhance: request.enhance ?? false,
          output_watermark: { enabled: request.watermark ?? true },
          ...(request.seed !== undefined ? { seed: request.seed } : {}),
          ...(request.steps !== undefined ? { num_inference_steps: request.steps } : {}),
          ...(request.guidance !== undefined ? { guidance_scale: request.guidance } : {}),
          ...(request.negativePrompt !== undefined ? { negative_prompt: request.negativePrompt } : {}),
        });
      } catch {
        throw invalidInput();
      }
      const response = await send(
        http,
        "https://api.mosi.cn/v1/images/generations",
        {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, accept: "application/json", "content-type": "application/json" },
          body,
          redirect: "manual",
        },
        signal,
      );
      let raw: string;
      try {
        raw = await readMossResponse(response, signal);
      } catch (e) {
        if (e instanceof MossResponseTooLarge) throw new MossImageError({ reason: "TooLarge", outcome: "Unknown" });
        throw e;
      }
      if (response.status < 200 || response.status >= 300) {
        const code = fromJson(ErrorResponse, raw)?.error.code;
        throw new MossImageError({
          reason: "HttpStatus",
          status: response.status,
          outcome: rejectedStatuses.includes(response.status) ? "Rejected" : "Unknown",
          ...(code !== undefined ? { code } : {}),
        });
      }
      const result = fromJson(ImageResponse, raw);
      if (result === undefined || result.usage.output_width !== size.width || result.usage.output_height !== size.height)
        throw new MossImageError({ reason: "InvalidResponse", outcome: "Unknown" });
      // Persist this URL before downloading; a failed download must not trigger another generation.
      return { url: result.data[0].url.href, created: result.created, usage: result.usage };
    },
    // No request, prompt, signed URL or upstream error body may escape through failures.
    {
      timeout: () => new MossImageError({ reason: "Timeout", outcome: "Unknown" }),
      network: () => new MossImageError({ reason: "Network", outcome: "Unknown" }),
    },
  );
