import { t } from "@vibevalley/i18n";
import { type Attachment, attachmentPath } from "@vibevalley/protocol";
import { Show } from "solid-js";
import { Icon } from "./Icon";
import type { IconName } from "./icons";

/** How a file shows: a picture, a player, a PDF to open in a tab, or a file to save. */
export type FileKind = "image" | "video" | "audio" | "pdf" | "file";

export const fileKind = (type: string): FileKind =>
  type.startsWith("image/") ? "image" : type.startsWith("video/") ? "video" : type.startsWith("audio/") ? "audio" : type === "application/pdf" ? "pdf" : "file";

const kindIcon: Record<FileKind, IconName> = { image: "file", video: "play", audio: "record", pdf: "file", file: "attach" };

export const sizeText = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * A file as a tile (docs/style/design.md, 附件): a picture's thumbnail or the icon of its kind, its name and its size.
 * onRemove: a file not sent yet, which the owner may take back.
 */
export function AttachmentTile(props: { file: Attachment; onRemove?: (() => void) | undefined; testid?: string }) {
  const kind = () => fileKind(props.file.type);
  return (
    <span
      data-testid={props.testid}
      data-key={props.file.name}
      class="flex max-w-64 items-center gap-2 rounded-md border border-line bg-page py-1 pr-1 pl-1 text-xs"
    >
      <span class="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-hover text-muted">
        <Show when={kind() === "image"} fallback={<Icon name={kindIcon[kind()]} size={16} />}>
          <img src={attachmentPath(props.file.id)} alt="" class="size-full object-cover" loading="lazy" />
        </Show>
      </span>
      <span class="flex min-w-0 flex-col">
        <span class="truncate text-ink">{props.file.name}</span>
        <span class="text-2xs text-muted">{kind() === "pdf" ? t("web.base.file.pdf") : sizeText(props.file.size)}</span>
      </span>
      <Show when={props.onRemove}>
        {(remove) => (
          <button
            type="button"
            class="ml-auto shrink-0 cursor-pointer rounded-sm p-1 text-muted transition-colors duration-120 hover:bg-hover hover:text-ink"
            aria-label={t("web.base.file.remove", { name: props.file.name })}
            onClick={() => remove()()}
          >
            <Icon name="close" size={12} />
          </button>
        )}
      </Show>
    </span>
  );
}
