import { t } from "@vibevalley/i18n";
import { For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { ready } from "@/base/query";
import { ArtifactCard } from "./ArtifactCard";
import { useArtifacts } from "./queries";

/** The artifacts made for an issue, latest version each; nothing when there are none. */
export function IssueArtifacts(props: { issue: string; heading: JSX.Element }) {
  const all = useArtifacts(() => ({ issue: props.issue }));
  return (
    <Show when={(ready(all, undefined) ?? []).length > 0 ? ready(all, undefined) : undefined}>
      {(list) => (
        <section aria-label={t("web.artifact.issue.title")} data-testid="issue-artifacts">
          {props.heading}
          <div class="flex flex-col gap-1.5">
            <For each={list()} keyed={(a) => a.id}>
              {(a) => (
                <ArtifactCard
                  card={{
                    id: a().id,
                    title: a().title,
                    body: a().body,
                    version: a().version,
                    note: a().versions.at(-1)?.note ?? "",
                  }}
                />
              )}
            </For>
          </div>
        </section>
      )}
    </Show>
  );
}
