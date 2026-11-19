// Ported from VibeValley apps/web/src/features/artifact/IssueArtifacts.tsx.
import { View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import type { IssueId } from "@vibevalley/protocol";

import { ready } from "../../infra/query";
import { ArtifactCard, useArtifacts } from "./ArtifactCard";

/** The artifacts made for an issue, latest version each; nothing when there are none. */
export function IssueArtifacts(props: { issue: IssueId; heading: JSX.Element }) {
  const all = useArtifacts(() => ({ issue: props.issue }));
  return (
    <If when={(ready(all, undefined) ?? []).length > 0 ? ready(all, undefined) : undefined}>
      {(list) => (
        <View accessibilityLabel={t("web.artifact.issue.title")} testID="issue-artifacts">
          {props.heading}
          <View class="gap-1.5">
            <Each of={list()} key={(a) => a.id}>
              {(a) => <ArtifactCard card={{ id: a().id, title: a().title, body: a().body, version: a().version, note: a().versions.at(-1)?.note ?? "" }} />}
            </Each>
          </View>
        </View>
      )}
    </If>
  );
}
