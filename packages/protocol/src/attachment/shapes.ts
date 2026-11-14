export * from "./shapes.gen";

/** The one read that is not a POST, since an <img src> can only GET. */
export const attachmentPath = (id: string) => `/api/v1/attachment/${id}`;

export const attachmentMax = 25 * 1024 * 1024;
