// Ported from VibeValley apps/web/src/features/artifact/ArtifactCard.tsx:
// the artifact queries, the labels and icons a kind is shown with, and the
// card a message announces one with.
import { Text, View } from "nsh";
import { z } from "zod";

import { t } from "@vibevalley/i18n";
import type { ArtifactBody, ArtifactCard as Card, ArtifactDisplay, ArtifactListRequest } from "@vibevalley/protocol";
import { artifactId } from "@vibevalley/protocol/schema";
import * as S from "@vibevalley/protocol/schema";

import { api } from "../../infra/api";
import { defineQuery, retryRead, useQuery } from "../../infra/query";
import { Link as A, useRouter } from "../../infra/router";
import { Icon } from "../../ui/Icon";
import type { IconName } from "../../ui/icons";

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
/** An html version's page as made. VibeValley's frame loads it by URL (artifactPath); here it comes over the bridge. A
 * version never changes, so it is read once. */
const contentQuery = defineQuery({
  schema: S.ArtifactContent,
  key: (v: { readonly id: string; readonly version: number }) => ["artifacts", "content", v.id, v.version],
  fetch: (v, context) => api.artifact.content.get({ id: artifactId(v.id), version: v.version }, context),
});
export const useArtifact = (id: () => string) => useQuery(() => artifactQuery(id()), { interval: () => fresh });
export const useArtifacts = (q: () => ArtifactListRequest) => useQuery(() => artifactsQuery(q()), { interval: () => fresh });
export const useArtifactContent = (v: () => { readonly id: string; readonly version: number }) => useQuery(() => contentQuery(v()));

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

/** The card's second line: what it is, its version (html), its note. */
const cardLine = (card: Card) =>
  [kindLabel(card), ...(card.body === "html" ? [t("web.artifact.card.version", { version: card.version })] : []), ...(card.note ? [card.note] : [])].join(
    " · ",
  );

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
      testID="artifact-card"
      accessibilityLabel={t("web.artifact.card.open", { title: props.card.title })}
      class="mt-1 w-full max-w-md flex-row items-center gap-3 rounded-lg border border-line bg-page px-3 py-2 transition duration-120 ease-out hover:bg-hover"
    >
      <View class="size-9 shrink-0 items-center justify-center rounded-md bg-hover">
        <Icon name={bodyIcon[props.card.body]} size={20} tone="muted" />
      </View>
      <View class="min-w-0 flex-1">
        <Text class="truncate text-sm font-semibold text-ink">{props.card.title}</Text>
        <Text class="truncate text-xs text-muted">{cardLine(props.card)}</Text>
      </View>
    </A>
  );
}
