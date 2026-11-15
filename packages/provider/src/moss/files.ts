import { z } from "zod";

import { bounded, type ProviderHttp, send } from "../base/http.ts";
import { codePoints, fromJson, int } from "../base/json.ts";
import { MossError } from "./error.ts";
import { badKey, readMossResponse, rejectedStatuses } from "./response.ts";

const Id = codePoints(1, 256)
  .regex(/^[^\s\p{Cc}/\\?#]+$/u)
  .refine((id) => id.isWellFormed() && id !== "." && id !== "..");
const Count = int();
const File = z.object({
  id: Id,
  object: z.literal("file"),
  bytes: Count,
  created_at: Count,
  filename: z.string(),
  purpose: z.string(),
  status: z.string(),
});
export type MossFile = z.output<typeof File>;
const Upload = z.strictObject({
  file: z.instanceof(Blob).refine((file) => file.size > 0 && file.size <= 512_000_000),
  filename: codePoints(1, 256)
    .regex(/^[^\p{Cc}/\\]+$/u)
    .regex(/\S/u),
  purpose: z.enum(["image", "video", "audio"]),
});

const invalidResponse = () => new MossError({ reason: "InvalidResponse", outcome: "Unknown" });
const invalidInput = () => new MossError({ reason: "InvalidInput", outcome: "NotSubmitted" });

const request = <S extends z.ZodType>(key: string, url: string, init: RequestInit, schema: S, http: ProviderHttp): Promise<z.output<S>> =>
  bounded(
    300_000,
    http,
    async (signal) => {
      if (badKey(key)) throw new MossError({ reason: "Credentials", outcome: "NotSubmitted" });
      const response = await send(http, url, { ...init, headers: { authorization: `Bearer ${key}`, accept: "application/json" }, redirect: "manual" }, signal);
      const raw = await readMossResponse(response, signal);
      if (response.status < 200 || response.status >= 300)
        throw new MossError({
          reason: "HttpStatus",
          status: response.status,
          outcome: rejectedStatuses.includes(response.status) ? "Rejected" : "Unknown",
        });
      const result = fromJson(schema, raw);
      if (result === undefined) throw invalidResponse();
      return result;
    },
    {
      timeout: () => new MossError({ reason: "Timeout", outcome: "Unknown" }),
      network: () => new MossError({ reason: "Network", outcome: "Unknown" }),
    },
  );

const fileId = (id: string): string => {
  const parsed = Id.safeParse(id);
  if (!parsed.success) throw invalidInput();
  return parsed.data;
};

export const uploadMossFile = async (key: string, input: unknown, http: ProviderHttp): Promise<MossFile> => {
  const parsed = Upload.safeParse(input);
  if (!parsed.success) throw invalidInput();
  const upload = parsed.data;
  const form = new FormData();
  form.append("purpose", upload.purpose);
  // A disk-backed Blob stays streaming; do not convert it to an ArrayBuffer or Base64 here.
  form.append("file", upload.file, upload.filename);
  const result = await request(key, "https://api.mosi.cn/v1/files", { method: "POST", body: form }, File, http);
  if (result.bytes !== upload.file.size || result.purpose !== upload.purpose) throw invalidResponse();
  return result;
};

export const deleteMossFile = async (
  key: string,
  id: string,
  http: ProviderHttp,
): Promise<{ readonly id: string; readonly object: "file"; readonly deleted: true }> => {
  const checked = fileId(id);
  const result = await request(
    key,
    `https://api.mosi.cn/v1/files/${encodeURIComponent(checked)}`,
    { method: "DELETE" },
    z.object({ id: Id, object: z.literal("file"), deleted: z.literal(true) }),
    http,
  );
  if (result.id !== checked) throw invalidResponse();
  return result;
};
