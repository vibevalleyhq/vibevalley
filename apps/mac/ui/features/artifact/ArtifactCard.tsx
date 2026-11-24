import { Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import { type ArtifactCard as Card, type ArtifactListRequest, type ArtifactType } from "@vibevalley/protocol";
import { artifactId } from "@vibevalley/protocol/schema";

import { Icon } from "../../design/Icon";
import type { IconName } from "../../design/icons";
import { api } from "../../infra/api";
import { defineQuery, retryRead, useQuery } from "../../infra/query";
import { Link as A, useRouter } from "../../infra/router";
import { artifactSuffixOf } from "./html";

// Artifacts (docs/subsystems/artifact.md) are not in the frame.
const fresh = 5_000;

const artifactQuery = defineQuery({
  key: (id: string) => ["artifacts", "one", id],
  fetch: (id, context) => api.artifact.get({ id: artifactId(id) }, context),
});
const artifactsQuery = defineQuery({
  key: (q: ArtifactListRequest) => ["artifacts", "list", q.channel ?? null, q.issue ?? null, q.artifactType ?? null],
  fetch: (q, context) => api.artifact.list(q, context),
  ...retryRead,
});
export const useArtifact = (id: () => string) => useQuery(() => artifactQuery(id()), { interval: () => fresh });
export const useArtifacts = (q: () => ArtifactListRequest) => useQuery(() => artifactsQuery(q()), { interval: () => fresh });

/** Where an artifact is looked at; a version other than the latest is in the query string. */
export const artifactHref = (id: string, version?: number) => `/artifacts/${id}${version != null && version !== 0 ? `?v=${version}` : ""}`;

export function artifactTypeLabel(type: ArtifactType): string {
  switch (type) {
    case "docs":
      return t("web.artifact.types.docs");
    case "outline":
      return t("web.artifact.types.outline");
    case "slides":
      return t("web.artifact.types.slides");
    case "dashboard":
      return t("web.artifact.types.dashboard");
    case "motion":
      return t("web.artifact.types.motion");
    case "whiteboard":
      return t("web.artifact.types.whiteboard");
    case "design":
      return t("web.artifact.types.design");
    case "design-system":
      return t("web.artifact.types.designSystem");
    case "sheet":
      return "Sheet";
    case "prototype":
      return "Prototype";
    case "diagram":
      return "Diagram";
    case "storyboard":
      return "Storyboard";
  }
}

export const artifactTypeIcon: Record<ArtifactType, IconName> = {
  docs: "artifacts",
  outline: "notes",
  slides: "present",
  dashboard: "catalog",
  motion: "video",
  whiteboard: "idea",
  design: "devices",
  "design-system": "appearance",
  sheet: "log",
  prototype: "web",
  diagram: "branch",
  storyboard: "image",
};

export const kindLabel = (a: { readonly artifactType: ArtifactType }): string => artifactTypeLabel(a.artifactType);

export const artifactIcon = (a: { readonly artifactType: ArtifactType }): IconName => artifactTypeIcon[a.artifactType];

export const artifactSuffix = (a: { readonly artifactType: ArtifactType }): string => artifactSuffixOf(a);

/** The card's second line: what it is, its snapshot version if any, and its note. */
const cardLine = (card: Card) =>
  [kindLabel(card), ...(card.version > 0 ? [t("web.artifact.card.version", { version: card.version })] : []), ...(card.note ? [card.note] : [])].join(" · ");

/** The card a message announces an artifact with: the whole card opens that artifact or version. */
export function ArtifactCard(props: { card: Card }) {
  const router = useRouter();
  // In a chat the card opens the artifact beside the talk; anywhere else it goes to the artifact's page.
  const href = () => {
    const [path = ""] = router.path().split("?");
    if (!path.startsWith("/chat")) return artifactHref(props.card.id, props.card.version > 0 ? props.card.version : undefined);
    const params = new URLSearchParams(router.path().split("?")[1] ?? "");
    params.set("artifact", props.card.id);
    return `${path}?${params.toString()}`;
  };
  return (
    <A
      href={href()}
      testID="artifact-card"
      accessibilityLabel={t("web.artifact.card.open", { title: props.card.title })}
      class="group mt-1 w-full max-w-md flex-row items-center gap-3 rounded-lg border border-line bg-page px-3 py-2.5 hover:border-faint hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
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
