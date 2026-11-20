// Ported from VibeValley apps/web/src/features/artifact/ArtifactCard.tsx:
// the artifact queries, the labels and icons a kind/type is shown with, and the
// card a message announces one with.
import { Text, View } from "nsh";
import { z } from "zod";

import { artifactSuffixOf } from "@vibevalley/artifact/html";
import { t } from "@vibevalley/i18n";
import type { ArtifactBody, ArtifactCard as Card, ArtifactDisplay, ArtifactListRequest, ArtifactType } from "@vibevalley/protocol";
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
  key: (q: ArtifactListRequest) => ["artifacts", "list", q.channel ?? null, q.issue ?? null, q.artifactType ?? null],
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

const artifactTypeLabel: Record<ArtifactType, string> = {
  docs: t("web.artifact.types.docs"),
  slides: t("web.artifact.types.slides"),
  dashboard: t("web.artifact.types.dashboard"),
  motion: t("web.artifact.types.motion"),
  whiteboard: t("web.artifact.types.whiteboard"),
  design: t("web.artifact.types.design"),
  "design-system": t("web.artifact.types.designSystem"),
};

export const artifactTypeIcon: Record<ArtifactType, IconName> = {
  docs: "artifacts",
  slides: "present",
  dashboard: "catalog",
  motion: "video",
  whiteboard: "idea",
  design: "devices",
  "design-system": "appearance",
};

const artifactTypeSuffix: Record<ArtifactType, string> = {
  docs: ".doc.md",
  slides: ".slide.html",
  dashboard: ".dashboard.html",
  motion: ".motion.html",
  whiteboard: ".whiteboard",
  design: ".design.html",
  "design-system": ".tokens.json",
};

/** What it is, as a card or a header says it: a structured type by its domain, or an html one by how it is shown. */
export const kindLabel = (a: {
  readonly body: ArtifactBody;
  readonly display?: ArtifactDisplay | undefined;
  readonly artifactType?: ArtifactType | undefined;
}) => {
  if (a.artifactType) return artifactTypeLabel[a.artifactType];
  if (a.body === "blocks") return t("web.artifact.body.blocks");
  if (a.body === "store") return t("web.artifact.body.store");
  return displayLabel[a.display ?? "page"];
};

const bodyIcon: Record<ArtifactBody, IconName> = { blocks: "artifacts", html: "web", store: "catalog" };

export const artifactIcon = (a: { readonly body: ArtifactBody; readonly artifactType?: ArtifactType | undefined }): IconName =>
  a.artifactType ? artifactTypeIcon[a.artifactType] : bodyIcon[a.body];

export const artifactSuffix = (a: {
  readonly body: ArtifactBody;
  readonly display?: ArtifactDisplay | undefined;
  readonly artifactType?: ArtifactType | undefined;
}): string => (a.artifactType ? artifactTypeSuffix[a.artifactType] : artifactSuffixOf(a));

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
      class="group mt-1 w-full max-w-md flex-row items-center gap-3 rounded-lg border border-line bg-page px-3 py-2.5 transition duration-120 ease-out hover:border-faint hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
    >
      <View class="size-9 shrink-0 items-center justify-center rounded-md bg-side">
        <Icon name={artifactIcon(props.card)} size={20} tone="muted" />
      </View>
      <View class="min-w-0 flex-1 gap-0.5">
        <View class="flex-row items-center gap-1.5">
          <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{props.card.title}</Text>
          <View class="shrink-0 rounded-xs bg-hover px-1.5 py-px">
            <Text class="font-mono text-2xs text-muted">{artifactSuffix(props.card)}</Text>
          </View>
        </View>
        <Text class="truncate text-xs text-muted tabular-nums">{cardLine(props.card)}</Text>
      </View>
      <Icon name="next" size={12} tone="faint" />
    </A>
  );
}
