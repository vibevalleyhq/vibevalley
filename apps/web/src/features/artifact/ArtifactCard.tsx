import { Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { ArtifactBody, ArtifactCard as Card, ArtifactListRequest } from "@vibevalley/protocol";
import { artifactId } from "@vibevalley/protocol/schema";

import { api } from "@/infra/api";
import { useQuery } from "@/infra/query";
import { useRouter } from "@/infra/router";
import { A } from "@/ui/A";
import { Icon } from "@/ui/Icon";
import type { IconName } from "@/ui/icons";

// Artifacts (docs/subsystems/artifact.md) are not in the frame: they are read when shown, and read again every few
// seconds while shown, so a new version a helper hands in comes up on its own.
const fresh = 5_000;

export const useArtifact = (id: () => string) =>
  useQuery(() => ({ queryKey: ["artifacts", "one", id()], queryFn: () => api.artifact.get({ id: artifactId(id()) }), refetchInterval: fresh, retry: false }));

export const useArtifacts = (q: () => ArtifactListRequest) =>
  useQuery(() => ({ queryKey: ["artifacts", "list", q()], queryFn: () => api.artifact.list(q()), refetchInterval: fresh }));

/** Where an artifact is looked at; a version other than the latest is in the query string. */
export const artifactHref = (id: string, version?: number) => `/artifacts/${id}${version != null && version !== 0 ? `?v=${version}` : ""}`;

export const bodyLabel: Record<ArtifactBody, string> = { blocks: t("web.artifact.body.blocks"), html: t("web.artifact.body.html") };
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
