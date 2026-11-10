/** A file kept by the farm: id is the sha256 of its bytes, served at attachmentPath. A message says it as an attachment,
 * a media job's result is one, a library item is one with where it came from. */
export interface Attachment {
  id: string;
  name: string;
  /** A media type: image/png, application/pdf… */
  type: string;
  size: number;
}

/** The one read that is not a POST, since an <img src> can only GET. */
export const attachmentPath = (id: string) => `/api/v1/attachment/${id}`;

/** At most attachmentMax bytes, as base64. */
export interface AttachmentUpload {
  name: string;
  type: string;
  data: string;
}

export const attachmentMax = 25 * 1024 * 1024;
