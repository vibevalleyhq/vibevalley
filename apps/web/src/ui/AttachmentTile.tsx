import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Attachment, attachmentPath } from "@vibevalley/protocol";

import { Icon } from "./Icon";
import type { IconName } from "./icons";

const recipeStyles = stylex.create({
  attachmentTileButton: {
    marginLeft: "auto",
    flexShrink: "0",
    cursor: "pointer",
    borderRadius: "var(--radius-sm)",
    padding: "var(--spacing)",
    color: {
      default: "var(--wb-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-ink)",
      },
    },
    transitionProperty: "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke",
    transitionTimingFunction: "var(--default-transition-timing-function)",
    transitionDuration: ".12s",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
    },
  },
});

const viewStyles = stylex.create({
  attachmentTileSpan: {
    display: "flex",
    maxWidth: "calc(var(--spacing) * 64)",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
    backgroundColor: "var(--wb-page)",
    paddingBlock: "var(--spacing)",
    paddingRight: "var(--spacing)",
    paddingLeft: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  attachmentTileSpan2: {
    display: "flex",
    width: "calc(var(--spacing) * 8)",
    height: "calc(var(--spacing) * 8)",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRadius: "var(--radius-sm)",
    backgroundColor: "var(--wb-hover)",
    color: "var(--wb-muted)",
  },
  attachmentTileImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  attachmentTileSpan3: {
    display: "flex",
    minWidth: "0",
    flexDirection: "column",
  },
  attachmentTileSpan4: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    color: "var(--wb-ink)",
  },
  attachmentTileSpan5: {
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--text-2xs--line-height)",
    color: "var(--wb-muted)",
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
    <span data-testid={props.testid} data-key={props.file.name} {...stylex.attrs(viewStyles.attachmentTileSpan)}>
      <span {...stylex.attrs(viewStyles.attachmentTileSpan2)}>
        <Show when={kind() === "image"} fallback={<Icon name={kindIcon[kind()]} size={16} />}>
          <img src={attachmentPath(props.file.id)} alt="" {...stylex.attrs(viewStyles.attachmentTileImg)} loading="lazy" />
        </Show>
      </span>
      <span {...stylex.attrs(viewStyles.attachmentTileSpan3)}>
        <span {...stylex.attrs(viewStyles.attachmentTileSpan4)}>{props.file.name}</span>
        <span {...stylex.attrs(viewStyles.attachmentTileSpan5)}>{kind() === "pdf" ? t("web.base.file.pdf") : sizeText(props.file.size)}</span>
      </span>
      <Show when={props.onRemove}>
        {(remove) => (
          <button
            type="button"
            {...stylex.attrs(recipeStyles.attachmentTileButton)}
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
