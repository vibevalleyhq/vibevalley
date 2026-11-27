import { t } from "@vibevalley/i18n";
import type { Attachment, LibraryItem, Note, NoteType } from "@vibevalley/protocol";

import { Dialog } from "../../design/Dialog";
import { Lightbox, type Picture } from "../../design/Lightbox";
import { Segmented } from "../../design/Segmented";
import { api } from "../../infra/api";
import { fileUrl, useAttachmentFile } from "../../infra/attachmentFile";
import { createMemo } from "../../infra/solid";
import type { ContentBucket } from "../../infra/state/contentNav";
import { noteTypeLabel } from "../note";
import { AudioPanel } from "./AudioPanel";
import { ImagePanel } from "./ImagePanel";
import { type NoteTypeFilter, textToDocJson } from "./items";
import { bucketFileKind, showsMediaInBucket } from "./libraryView";
import { SpeechPanel } from "./SpeechPanel";
import { UnderstandingPanel } from "./UnderstandingPanel";

export type MakeTab = "image" | "speech" | "audio";
export const makeTabs: readonly MakeTab[] = ["image", "speech", "audio"];

export const isMediaMakeSupported = (b: ContentBucket) => showsMediaInBucket(b) && bucketFileKind(b) !== "video" && bucketFileKind(b) !== "other";

export const noteFileNameRe = /\.(?:base\.json|canvas\.json|whiteboard\.json|media\.json|md|markdown)$/iu;

function inferNoteFile(filename: string, content: string): { readonly title: string; readonly noteType: NoteType; readonly content: string } {
  const trimmed = filename.trim();
  if (/\.base\.json$/iu.test(trimmed)) {
    return { title: trimmed.replace(/\.base\.json$/iu, "") || trimmed, noteType: "base", content };
  }
  if (/\.(?:canvas|whiteboard)\.json$/iu.test(trimmed)) {
    return { title: trimmed.replace(/\.(?:canvas|whiteboard)\.json$/iu, "") || trimmed, noteType: "canvas", content };
  }
  if (/\.media\.json$/iu.test(trimmed)) {
    return { title: trimmed.replace(/\.media\.json$/iu, "") || trimmed, noteType: "media", content };
  }
  return {
    title: trimmed.replace(/\.(?:doc\.md|md|markdown)$/iu, "") || trimmed,
    noteType: "doc",
    content: textToDocJson(content),
  };
}

export function importNoteFile(filename: string, content: string): Promise<Note> {
  const inferred = inferNoteFile(filename, content);
  return api.note.create({
    title: inferred.title,
    noteType: inferred.noteType,
    content: inferred.content,
  });
}

function noteTypeTitle(type: NoteTypeFilter | undefined): string {
  if (type === undefined) return t("web.library.content.artifactType.all");
  return noteTypeLabel(type);
}

export function titleOfBucket(bucket: ContentBucket): string {
  switch (bucket.kind) {
    case "recent":
      return t("web.library.content.recent");
    case "pinned":
      return t("web.library.content.pinned");
    case "apps":
      return t("web.library.content.installedApps");
    case "notes":
      return noteTypeTitle(bucket.noteType);
    case "media":
      return bucket.fileKind === undefined ? t("web.library.content.media") : t(`web.library.kind.${bucket.fileKind}`);
  }
}

export function LibraryLightbox(props: { items: readonly LibraryItem[]; at: number | undefined; onAt: (at: number | undefined) => void }) {
  const curId = createMemo(() => (props.at !== undefined ? (props.items[props.at]?.attachment.id ?? "") : ""));
  const file = useAttachmentFile(curId);
  const pictures = createMemo((): readonly Picture[] =>
    props.items.map((item, i) => {
      const f = i === props.at ? file() : undefined;
      return {
        src: f ? fileUrl(f.path) : "",
        name: item.attachment.name,
        ...(f ? { path: f.path } : {}),
      };
    }),
  );
  return <Lightbox pictures={pictures()} at={props.at} onAt={props.onAt} />;
}

export function LibraryMakeDialog(props: { make: MakeTab | undefined; onSelect: (tab: MakeTab) => void; onClose: () => void }) {
  return (
    <Dialog
      open={props.make !== undefined}
      onClose={() => props.onClose()}
      title={t("web.library.makeTitle")}
      size="lg"
      height="fixed"
      toolbar={
        <Segmented
          label={t("web.library.makeTitle")}
          testid="library-make-form"
          value={props.make ?? "image"}
          onChange={(value) => props.onSelect(value)}
          options={makeTabs.map((value) => ({ value, label: t(`web.library.makeTabs.${value}`) }))}
        />
      }
      testid="library-make-dialog"
    >
      <If when={props.make === "image"}>
        <ImagePanel />
      </If>
      <If when={props.make === "speech"}>
        <SpeechPanel />
      </If>
      <If when={props.make === "audio"}>
        <AudioPanel />
      </If>
    </Dialog>
  );
}

export function LibraryUnderstandDialog(props: { file: Attachment | undefined; onClose: () => void }) {
  return (
    <If when={props.file}>
      {(file) => (
        <Dialog
          open
          onClose={() => props.onClose()}
          title={t("web.library.understandTitle", { name: file().name })}
          size="lg"
          height="fixed"
          testid="library-understand-dialog"
        >
          <UnderstandingPanel file={file()} />
        </Dialog>
      )}
    </If>
  );
}
