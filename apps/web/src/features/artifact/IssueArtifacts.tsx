import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { IssueId } from "@vibevalley/protocol";

import { ready } from "#/infra/query.ts";

import { ArtifactCard, useArtifacts } from "./ArtifactCard";

const viewStyles = stylex.create({
  issueArtifactsDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 1.5)",
  },
});

/** The artifacts made for an issue, latest version each; nothing when there are none. */
export function IssueArtifacts(props: { issue: IssueId; heading: JSX.Element }) {
  const all = useArtifacts(() => ({ issue: props.issue }));
  return (
    <Show when={(ready(all, undefined) ?? []).length > 0 ? ready(all, undefined) : undefined}>
      {(list) => (
        <section aria-label={t("web.artifact.issue.title")} data-testid="issue-artifacts">
          {props.heading}
          <div {...stylex.attrs(viewStyles.issueArtifactsDiv)}>
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
