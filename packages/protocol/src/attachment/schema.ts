import { Schema } from "effect";

import type { Codec } from "../codec";
import type * as T from "./shapes";

export const Attachment: Codec<T.Attachment> = Schema.Struct({ id: Schema.String, name: Schema.String, type: Schema.String, size: Schema.Finite });
export const AttachmentUpload: Codec<T.AttachmentUpload> = Schema.Struct({ name: Schema.String, type: Schema.String, data: Schema.String });
