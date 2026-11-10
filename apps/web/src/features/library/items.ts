import { Array as Arr, String as Str } from "effect";

import { t } from "@vibevalley/i18n";
import type { LibraryFileKind, LibraryItem, LibraryOrigin, LibraryOriginKind, MediaJob, MediaUnderstandingJob } from "@vibevalley/protocol";

export type OriginFilter = LibraryOriginKind | "all";
export type KindFilter = LibraryFileKind | "all";

/** What a file is, by its media type, as the server files it (library.item.list's type). */
export const kindOf = (type: string): LibraryFileKind =>
  Str.startsWith("image/")(type) ? "image" : Str.startsWith("audio/")(type) ? "audio" : Str.startsWith("video/")(type) ? "video" : "other";

/** The items a pair of filters lets through, in the order given. */
export const shown = (given: { readonly items: readonly LibraryItem[]; readonly origin: OriginFilter; readonly kind: KindFilter }): LibraryItem[] =>
  Arr.filter(
    given.items,
    (item) => (given.origin === "all" || item.origin.kind === given.origin) && (given.kind === "all" || kindOf(item.attachment.type) === given.kind),
  );

/** A job still working towards its file: shown first as a placeholder card. Understanding makes no file. */
export const making = (jobs: readonly MediaJob[]): MediaJob[] =>
  Arr.filter(jobs, (job) => job.kind !== "understanding" && (job.phase === "queued" || job.phase === "generating" || job.phase === "downloading"));

/** Names for ids an origin holds: a profile's and a channel's, the id itself when unknown. */
export interface Names {
  readonly agent: (id: string) => string;
  readonly channel: (id: string) => string;
}

const jobWord: Record<MediaJob["kind"], () => string> = {
  image: () => t("web.library.job.image"),
  speech: () => t("web.library.job.speech"),
  speakers: () => t("web.library.job.speakers"),
  voiceDesign: () => t("web.library.job.voiceDesign"),
  clone: () => t("web.library.job.clone"),
  transcription: () => t("web.library.job.transcription"),
  understanding: () => t("web.library.job.understanding"),
};

/** Where an item came from, in a line: who and from where; the time is the caller's. */
export const originLine =
  (names: Names) =>
  (origin: LibraryOrigin): string => {
    switch (origin.kind) {
      case "generated":
        return t("web.library.from.generated", { job: jobWord[origin.jobKind]() });
      case "uploaded":
        return origin.channel === undefined ? t("web.library.from.uploadedHere") : t("web.library.from.uploadedIn", { channel: names.channel(origin.channel) });
      case "fetched":
        return "url" in origin.from
          ? t("web.library.from.fetchedUrl", { agent: names.agent(origin.agent), url: origin.from.url })
          : t("web.library.from.fetchedPath", { agent: names.agent(origin.agent), path: origin.from.path });
    }
  };

const none = (): MediaUnderstandingJob | undefined => undefined;

/** The newest finished understanding of a file, if any: what the card shows under it. */
export const understoodText =
  (attachment: string) =>
  (jobs: readonly MediaJob[]): string | undefined =>
    Arr.reduce(jobs, none(), (newest, job) =>
      job.kind === "understanding" &&
      job.result !== null &&
      Arr.some(job.inputs, (input) => input.hash === attachment) &&
      (newest === undefined || job.updatedAt > newest.updatedAt)
        ? job
        : newest,
    )?.result?.text;
