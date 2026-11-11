import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Attachment, attachmentPath } from "@vibevalley/protocol";

import { Icon } from "#/ui/Icon.tsx";
import type { IconName } from "#/ui/icons.ts";

const styles = stylex.create({
  remove: {
    marginLeft: "auto",
    flexShrink: "0",
    cursor: "pointer",
    borderRadius: "var(--radius-sm)",
    padding: "0.25rem",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
    transitionProperty: "color, background-color, border-color",
    transitionTimingFunction: "var(--ease-out)",
    transitionDuration: "120ms",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  tile: {
    display: "flex",
    maxWidth: "16rem",
    alignItems: "center",
    gap: "0.5rem",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    paddingBlock: "0.25rem",
    paddingRight: "0.25rem",
    paddingLeft: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  preview: {
    display: "flex",
    width: "2rem",
    height: "2rem",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--color-hover)",
    color: "var(--color-muted)",
  },
  thumbnail: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  meta: {
    display: "flex",
    minWidth: "0",
    flexDirection: "column",
  },
  name: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    color: "var(--color-ink)",
  },
  size: {
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--leading-2xs)",
    color: "var(--color-muted)",
  },
});

/** How a file shows: a picture, a player, a PDF to open in a tab, or a file to save. */
type FileKind = "image" | "video" | "audio" | "pdf" | "file";

export const fileKind = (type: string): FileKind =>
  type.startsWith("image/") ? "image" : type.startsWith("video/") ? "video" : type.startsWith("audio/") ? "audio" : type === "application/pdf" ? "pdf" : "file";

const kindIcon: Record<FileKind, IconName> = { image: "file", video: "play", audio: "record", pdf: "file", file: "attach" };

export const sizeText = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** A file as a tile (docs/style/design.md): a picture's thumbnail or the icon of its kind, its name and its size. */
export function AttachmentTile(props: { file: Attachment; onRemove?: (() => void) | undefined; testid?: string }) {
  const kind = () => fileKind(props.file.type);
  return (
    <span data-testid={props.testid} data-key={props.file.name} {...stylex.attrs(styles.tile)}>
      <span {...stylex.attrs(styles.preview)}>
        <Show when={kind() === "image"} fallback={<Icon name={kindIcon[kind()]} size={16} />}>
          <img src={attachmentPath(props.file.id)} alt="" {...stylex.attrs(styles.thumbnail)} loading="lazy" />
        </Show>
      </span>
      <span {...stylex.attrs(styles.meta)}>
        <span {...stylex.attrs(styles.name)}>{props.file.name}</span>
        <span {...stylex.attrs(styles.size)}>{kind() === "pdf" ? t("web.base.file.pdf") : sizeText(props.file.size)}</span>
      </span>
      <Show when={props.onRemove}>
        {(remove) => (
          <button type="button" {...stylex.attrs(styles.remove)} aria-label={t("web.base.file.remove", { name: props.file.name })} onClick={() => remove()()}>
            <Icon name="close" size={12} />
          </button>
        )}
      </Show>
    </span>
  );
}
