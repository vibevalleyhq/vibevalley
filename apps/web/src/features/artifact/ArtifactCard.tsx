import { t } from "@vibevalley/i18n";
import type { ArtifactBody, ArtifactCard as Card } from "@vibevalley/protocol";
import { Show } from "solid-js";
import { A } from "@/ui/A";
import { Icon } from "@/ui/Icon";
import type { IconName } from "@/ui/icons";
import { artifactHref } from "./queries";

export const bodyLabel: Record<ArtifactBody, string> = { blocks: t("web.artifact.body.blocks"), html: t("web.artifact.body.html") };
export const bodyIcon: Record<ArtifactBody, IconName> = { blocks: "artifacts", html: "web" };

/** The card a message announces an artifact with: the whole card opens that version. */
export function ArtifactCard(props: { card: Card }) {
  return (
    <A
      href={artifactHref(props.card.id, props.card.body === "html" ? props.card.version : undefined)}
      data-testid="artifact-card"
      data-key={props.card.id}
      data-version={props.card.version}
      aria-label={t("web.artifact.card.open", { title: props.card.title })}
      class="mt-1 flex w-full max-w-md items-center gap-3 rounded-lg border border-line bg-page px-3 py-2 transition-colors duration-120 hover:bg-hover"
    >
      <span class="flex size-9 shrink-0 items-center justify-center rounded-md bg-hover text-muted">
        <Icon name={bodyIcon[props.card.body]} size={20} />
      </span>
      <span class="flex min-w-0 flex-col">
        <span class="truncate text-sm font-semibold">{props.card.title}</span>
        <span class="truncate text-xs text-muted">
          {bodyLabel[props.card.body]}
          <Show when={props.card.body === "html"}> · {t("web.artifact.card.version", { version: props.card.version })}</Show>
          <Show when={props.card.note}>{(note) => <> · {note()}</>}</Show>
        </span>
      </span>
    </A>
  );
}
