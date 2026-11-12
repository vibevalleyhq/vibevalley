import { Show } from "solid-js";
import { z } from "zod";

import { t } from "@vibevalley/i18n";
import type { ArtifactBody, ArtifactCard as Card, ArtifactDisplay, ArtifactListRequest } from "@vibevalley/protocol";
import { artifactId } from "@vibevalley/protocol/schema";
import * as S from "@vibevalley/protocol/schema";

import { api } from "#/infra/api.ts";
import { defineQuery, retryRead, useQuery } from "#/infra/query.ts";
import { useRouter, Link as A } from "#/infra/router.ts";
import { Icon } from "#/ui/Icon.tsx";
import type { IconName } from "#/ui/icons.ts";

// Artifacts (docs/subsystems/artifact.md) are not in the frame.
const fresh = 5_000;

const artifactQuery = defineQuery({
  schema: S.Artifact,
  key: (id: string) => ["artifacts", "one", id],
  fetch: (id, context) => api.artifact.get({ id: artifactId(id) }, context),
});
const artifactsQuery = defineQuery({
  schema: z.array(S.Artifact),
  key: (q: ArtifactListRequest) => ["artifacts", "list", q.channel ?? null, q.issue ?? null],
  fetch: (q, context) => api.artifact.list(q, context),
  ...retryRead,
});
export const useArtifact = (id: () => string) => useQuery(() => artifactQuery(id()), { interval: () => fresh });
export const useArtifacts = (q: () => ArtifactListRequest) => useQuery(() => artifactsQuery(q()), { interval: () => fresh });

/** Where an artifact is looked at; a version other than the latest is in the query string. */
export const artifactHref = (id: string, version?: number) => `/artifacts/${id}${version != null && version !== 0 ? `?v=${version}` : ""}`;

const displayLabel: Record<ArtifactDisplay, string> = {
  page: t("web.artifact.body.html"),
  slides: t("web.artifact.body.slides"),
  motion: t("web.artifact.body.motion"),
};
/** What it is, as a card or a header says it: an html one by how it is shown. */
export const kindLabel = (a: { readonly body: ArtifactBody; readonly display?: ArtifactDisplay | undefined }) =>
  a.body === "blocks" ? t("web.artifact.body.blocks") : displayLabel[a.display ?? "page"];
export const bodyIcon: Record<ArtifactBody, IconName> = { blocks: "artifacts", html: "web" };

/** The card a message announces an artifact with: the whole card opens that version. */
export function ArtifactCard(props: { card: Card }) {
  const router = useRouter();
  // In a chat the card opens the artifact beside the talk; anywhere else it goes to the artifact's page.
  const href = () => {
    const [path = ""] = router.path().split("?");
    if (!path.startsWith("/chat")) return artifactHref(props.card.id, props.card.body === "html" ? props.card.version : undefined);
    const params = new URLSearchParams(router.path().split("?")[1] ?? "");
    params.set("artifact", props.card.id);
    return `${path}?${params}`;
  };
  return (
    <A
      href={href()}
      data-testid="artifact-card"
      data-key={props.card.id}
      data-version={props.card.version}
      aria-label={t("web.artifact.card.open", { title: props.card.title })}
      class="mt-1 flex w-full max-w-md items-center gap-3 rounded-lg border border-line bg-page hover:bg-hover px-3 py-2 transition-[color,background-color,border-color] ease-out duration-120"
    >
      <span class="flex w-9 h-9 shrink-0 items-center justify-center rounded-md bg-hover text-muted">
        <Icon name={bodyIcon[props.card.body]} size={20} />
      </span>
      <span class="flex min-w-0 flex-col">
        <span class="truncate text-sm font-semibold">{props.card.title}</span>
        <span class="truncate text-xs text-muted">
          {kindLabel(props.card)}
          <Show when={props.card.body === "html"}> · {t("web.artifact.card.version", { version: props.card.version })}</Show>
          <Show when={props.card.note}>{(note) => <> · {note()}</>}</Show>
        </span>
      </span>
    </A>
  );
}
