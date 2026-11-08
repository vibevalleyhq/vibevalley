import type { Effect } from "effect";
import { Schema } from "effect";

import { Preview } from "../common/schema";
import type { ApiError, Endpoint } from "../endpoint";
import type * as T from "../shapes";
import * as S from "./schema";

export interface MediaHandlers<R = never> {
  readonly "media.input.create": (a: T.MediaInputRequest) => Effect.Effect<T.MediaInput, ApiError, R>;
  readonly "media.input.get": (a: T.MediaJobRequest) => Effect.Effect<T.MediaInput, ApiError, R>;
  readonly "media.input.list": () => Effect.Effect<T.MediaInput[], ApiError, R>;
  readonly "media.input.previewDelete": (a: T.MediaJobRequest) => Effect.Effect<T.Preview, ApiError, R>;
  readonly "media.input.delete": (a: T.MediaJobRequest) => Effect.Effect<void, ApiError, R>;
  readonly "media.image.create": (a: T.MediaImageRequest) => Effect.Effect<T.MediaImageJob, ApiError, R>;
  readonly "media.understanding.create": (a: T.MediaUnderstandingRequest) => Effect.Effect<T.MediaUnderstandingJob, ApiError, R>;
  readonly "media.understanding.previewCleanup": (a: T.MediaJobRequest) => Effect.Effect<T.Preview, ApiError, R>;
  readonly "media.understanding.cleanup": (a: T.MediaJobRequest) => Effect.Effect<T.MediaUnderstandingJob, ApiError, R>;
  readonly "media.job.get": (a: T.MediaJobRequest) => Effect.Effect<T.MediaJob, ApiError, R>;
  readonly "media.job.cancel": (a: T.MediaJobRequest) => Effect.Effect<T.MediaJob, ApiError, R>;
  readonly "media.job.download": (a: T.MediaJobRequest) => Effect.Effect<T.MediaJob, ApiError, R>;
  readonly "media.job.list": () => Effect.Effect<T.MediaJob[], ApiError, R>;
}

export const mediaEndpoints: readonly Endpoint[] = [
  { op: "media.input.create", about: [], input: S.MediaInputRequest, result: S.MediaInput, can: ["owner"] },
  { op: "media.input.get", about: ["id"], input: S.MediaJobRequest, result: S.MediaInput, can: ["owner"] },
  { op: "media.input.list", about: [], input: undefined, result: Schema.Array(S.MediaInput), can: ["owner"] },
  { op: "media.input.delete", about: ["id"], input: S.MediaJobRequest, result: undefined, can: ["owner"], dryRun: "media.input.previewDelete" },
  { op: "media.input.previewDelete", about: ["id"], input: S.MediaJobRequest, result: Preview, can: ["owner"] },
  { op: "media.image.create", about: [], input: S.MediaImageRequest, result: S.MediaImageJob, can: ["owner", "orchestrator"] },
  { op: "media.understanding.create", about: [], input: S.MediaUnderstandingRequest, result: S.MediaUnderstandingJob, can: ["owner"] },
  { op: "media.understanding.previewCleanup", about: ["id"], input: S.MediaJobRequest, result: Preview, can: ["owner"] },
  {
    op: "media.understanding.cleanup",
    about: ["id"],
    input: S.MediaJobRequest,
    result: S.MediaUnderstandingJob,
    can: ["owner"],
    dryRun: "media.understanding.previewCleanup",
  },
  { op: "media.job.get", about: ["id"], input: S.MediaJobRequest, result: S.MediaJob, can: ["owner", "orchestrator"] },
  { op: "media.job.cancel", about: ["id"], input: S.MediaJobRequest, result: S.MediaJob, can: ["owner", "orchestrator"] },
  { op: "media.job.download", about: ["id"], input: S.MediaJobRequest, result: S.MediaJob, can: ["owner", "orchestrator"] },
  { op: "media.job.list", about: [], input: undefined, result: Schema.Array(S.MediaJob), can: ["owner", "orchestrator"] },
];
