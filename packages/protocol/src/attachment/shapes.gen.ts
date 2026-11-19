// Generated from crates/vibevalley-protocol/src/contract (vp run protocol:ts). Do not edit.

/**
 * A file kept by the farm: id is the sha256 of its bytes, served at attachmentPath. A message says it as an attachment,
 * a media job's result is one, a library item is one with where it came from.
 */
export type Attachment = { id: string, name: string,
/**
 * A media type: image/png, application/pdf…
 */
type: string, size: number, };

/**
 * At most attachmentMax bytes, as base64.
 */
export type AttachmentUpload = { name: string, type: string, data: string, };
