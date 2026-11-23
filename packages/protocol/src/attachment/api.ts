import type { Endpoint } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface AttachmentHandlers {
  /** Kept once by its bytes: the same file again is the same attachment. */
  readonly "attachment.create": (a: T.AttachmentUpload) => Promise<T.Attachment>;
  /** Local regular file imported directly into CAS without base64 framing (`Caller::User` only). */
  readonly "attachment.importPath": (a: T.AttachmentImportPathInput) => Promise<T.Attachment>;
}

export const attachmentEndpoints: readonly Endpoint[] = [
  { op: "attachment.create", about: [], input: S.AttachmentUpload, result: S.Attachment, can: ["user", "remote"] },
  { op: "attachment.importPath", about: [], input: S.AttachmentImportPathInput, result: S.Attachment, can: ["user"] },
];
