import { z } from "zod";

import { bounded, type ProviderHttp, send } from "../base/http.ts";
import { codePoints, fromJson, httpsUrl, int } from "../base/json.ts";
import { badKey, type MossErrorFields, MossResponseTooLarge, readMossResponse, rejectedStatuses } from "./response.ts";
import { mossUnderstandingModels } from "./understanding-models.ts";

const FileId = codePoints(1, 256).regex(/\S/u);
const MediaUrl = httpsUrl(8192);
const Image = z.union([z.strictObject({ kind: z.literal("image"), fileId: FileId }), z.strictObject({ kind: z.literal("image"), url: MediaUrl })]);
const Video = z.union([z.strictObject({ kind: z.literal("video"), fileId: FileId }), z.strictObject({ kind: z.literal("video"), url: MediaUrl })]);
const Input = z.strictObject({
  model: z.enum(mossUnderstandingModels),
  text: codePoints(1, 64000).regex(/\S/u),
  media: z.union([z.array(Image).min(1).max(5), z.tuple([Video])]),
  maxOutputTokens: z.exactOptional(int(1, 8192)),
});
const Tokens = int();
const Answer = z.object({
  id: FileId,
  model: z.string().min(1),
  status: z.enum(["completed", "incomplete"]),
  incomplete_details: z.exactOptional(z.object({ reason: z.exactOptional(z.string().nullable()) }).nullable()),
  output: z
    .array(
      z.object({
        content: z.array(z.object({ type: z.literal("output_text"), text: z.string() })).min(1),
      }),
    )
    .min(1),
  usage: z.object({ input_tokens: Tokens, output_tokens: Tokens, total_tokens: Tokens }),
});

class MossUnderstandingError extends Error {
  override readonly name = "MossUnderstandingError";
  readonly reason: MossErrorFields["reason"];
  readonly outcome: MossErrorFields["outcome"];
  declare readonly status?: number;

  constructor(fields: MossErrorFields) {
    super(`MOSS understanding: ${fields.reason}`);
    this.reason = fields.reason;
    this.outcome = fields.outcome;
    if (fields.status !== undefined) this.status = fields.status;
  }
}

const invalidInput = () => new MossUnderstandingError({ reason: "InvalidInput", outcome: "NotSubmitted" });

export const prepareMossUnderstanding = async (input: unknown) => {
  const parsed = Input.safeParse(input);
  if (!parsed.success) throw invalidInput();
  const request = parsed.data;
  return {
    model: request.model,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: request.text },
          ...request.media.map((media) => ({
            type: media.kind === "image" ? "input_image" : "input_video",
            ...("fileId" in media ? { file_id: media.fileId } : media.kind === "image" ? { image_url: media.url.href } : { video_url: media.url.href }),
          })),
        ],
      },
    ],
    ...(request.maxOutputTokens !== undefined ? { max_output_tokens: request.maxOutputTokens } : {}),
  };
};

export interface MossUnderstanding {
  readonly id: string;
  readonly model: string;
  readonly status: "completed" | "incomplete";
  readonly text: string;
  readonly incompleteReason: "max_output_tokens" | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number };
}

export const understandMossMedia = (key: string, input: unknown, http: ProviderHttp): Promise<MossUnderstanding> =>
  bounded(
    180_000,
    http,
    async (signal) => {
      if (badKey(key)) throw new MossUnderstandingError({ reason: "Credentials", outcome: "NotSubmitted" });
      const request = await prepareMossUnderstanding(input);
      let body: string;
      try {
        body = JSON.stringify(request);
      } catch {
        throw invalidInput();
      }
      const response = await send(
        http,
        "https://api.mosi.cn/v1/responses",
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
        if (e instanceof MossResponseTooLarge) throw new MossUnderstandingError({ reason: "TooLarge", outcome: "Unknown" });
        throw e;
      }
      if (response.status !== 200)
        throw new MossUnderstandingError({
          reason: "HttpStatus",
          status: response.status,
          outcome: rejectedStatuses.includes(response.status) ? "Rejected" : "Unknown",
        });
      const result = fromJson(Answer, raw);
      if (result === undefined) throw new MossUnderstandingError({ reason: "InvalidResponse", outcome: "Unknown" });
      const incompleteReason: "max_output_tokens" | null =
        result.status === "incomplete" && result.incomplete_details?.reason === "max_output_tokens" ? "max_output_tokens" : null;
      return {
        id: result.id,
        model: result.model,
        status: result.status,
        text: result.output.flatMap((item) => item.content.map((part) => part.text)).join("\n"),
        incompleteReason,
        usage: { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens, totalTokens: result.usage.total_tokens },
      };
    },
    {
      timeout: () => new MossUnderstandingError({ reason: "Timeout", outcome: "Unknown" }),
      network: () => new MossUnderstandingError({ reason: "Network", outcome: "Unknown" }),
    },
  );
