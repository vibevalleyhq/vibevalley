import * as stylex from "@stylexjs/stylex";
import { Schema } from "effect";
import { Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { ArtifactBody, ArtifactCard as Card, ArtifactDisplay, ArtifactListRequest } from "@vibevalley/protocol";
import { artifactId } from "@vibevalley/protocol/schema";
import * as S from "@vibevalley/protocol/schema";

import { api } from "#/infra/api.ts";
import { defineQuery, retryRead, useQuery } from "#/infra/query.ts";
import { useRouter, Link as A } from "#/infra/router.ts";
import { Icon } from "#/ui/Icon.tsx";
import type { IconName } from "#/ui/icons.ts";

const recipeStyles = stylex.create({
  artifactCardA: {
    marginTop: "var(--spacing)",
    display: "flex",
    width: "100%",
    maxWidth: "var(--container-md)",
    alignItems: "center",
    gap: "calc(var(--spacing) * 3)",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: {
      default: "var(--color-page)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2)",
    transitionProperty: "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke",
    transitionTimingFunction: "var(--default-transition-timing-function)",
    transitionDuration: ".12s",
  },
});

const viewStyles = stylex.create({
  artifactCardSpan: {
    display: "flex",
    width: "calc(var(--spacing) * 9)",
    height: "calc(var(--spacing) * 9)",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--color-hover)",
    color: "var(--color-muted)",
  },
  artifactCardSpan2: {
    display: "flex",
    minWidth: "0",
    flexDirection: "column",
  },
  artifactCardSpan3: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  artifactCardSpan4: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
});

// Artifacts (docs/subsystems/artifact.md) are not in the frame.
const fresh = 5_000;

const artifactQuery = defineQuery({
  schema: S.Artifact,
  key: (id: string) => ["artifacts", "one", id],
  fetch: (id, context) => api.artifact.get({ id: artifactId(id) }, context),
});
const artifactsQuery = defineQuery({
  schema: Schema.mutable(Schema.Array(S.Artifact)),
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
      {...stylex.attrs(recipeStyles.artifactCardA)}
    >
      <span {...stylex.attrs(viewStyles.artifactCardSpan)}>
        <Icon name={bodyIcon[props.card.body]} size={20} />
      </span>
      <span {...stylex.attrs(viewStyles.artifactCardSpan2)}>
        <span {...stylex.attrs(viewStyles.artifactCardSpan3)}>{props.card.title}</span>
        <span {...stylex.attrs(viewStyles.artifactCardSpan4)}>
          {kindLabel(props.card)}
          <Show when={props.card.body === "html"}> · {t("web.artifact.card.version", { version: props.card.version })}</Show>
          <Show when={props.card.note}>{(note) => <> · {note()}</>}</Show>
        </span>
      </span>
    </A>
  );
}
