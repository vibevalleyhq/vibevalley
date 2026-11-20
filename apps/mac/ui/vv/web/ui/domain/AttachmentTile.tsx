import { Image, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Attachment } from "@vibevalley/protocol";

import { useAttachmentUrl } from "../../infra/attachmentFile";
import { Icon } from "../Icon";
import type { IconName } from "../icons";

/** How a file shows: a picture, a player, a PDF to open in a tab, or a file to save. */
type FileKind = "image" | "video" | "audio" | "pdf" | "file";

export const fileKind = (type: string): FileKind =>
  type.startsWith("image/") ? "image" : type.startsWith("video/") ? "video" : type.startsWith("audio/") ? "audio" : type === "application/pdf" ? "pdf" : "file";

export const kindIcon: Record<FileKind, IconName> = { image: "image", video: "play", audio: "record", pdf: "file", file: "attach" };

export const sizeText = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** A file as a tile (docs/style/design.md): the icon of its kind, its name and its size. */
export function AttachmentTile(props: { file: Attachment; onRemove?: (() => void) | undefined; testid?: string }) {
  const kind = () => fileKind(props.file.type);
  const url = useAttachmentUrl(() => props.file.id);
  return (
    <View testID={props.testid} class="max-w-64 flex-row items-center gap-2 rounded-md border border-line bg-page p-1">
      <View class="h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-hover">
        <If when={kind() === "image" ? url() : undefined} else={<Icon name={kindIcon[kind()]} size={16} tone="muted" />}>
          {(src) => <Image testID="attachment-thumb" src={src()} class="h-8 w-8 object-cover" />}
        </If>
      </View>
      <View class="min-w-0 shrink">
        <Text class="truncate text-xs text-ink">{props.file.name}</Text>
        <Text class="text-2xs text-muted">{kind() === "pdf" ? t("web.base.file.pdf") : sizeText(props.file.size)}</Text>
      </View>
      <If when={props.onRemove}>
        {(remove) => (
          <View
            role="button"
            accessibilityLabel={t("web.base.file.remove", { name: props.file.name })}
            onPress={() => remove()()}
            class="ml-auto shrink-0 rounded-sm p-1 hover:bg-hover"
          >
            <Icon name="close" size={12} tone="muted" />
          </View>
        )}
      </If>
    </View>
  );
}
