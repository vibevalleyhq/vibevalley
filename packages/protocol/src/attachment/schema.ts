import { z } from "zod";

import type { Codec } from "../codec";
import type * as T from "./shapes";

export const Attachment = z.object({ id: z.string(), name: z.string(), type: z.string(), size: z.number() }) satisfies Codec<T.Attachment>;
export const AttachmentUpload = z.object({ name: z.string(), type: z.string(), data: z.string() }) satisfies Codec<T.AttachmentUpload>;
