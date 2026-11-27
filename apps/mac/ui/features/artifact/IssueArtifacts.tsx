import { computed, signal, Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import { ARTIFACT_TYPES, type ArtifactType, type IssueId } from "@vibevalley/protocol";
import { artifactId } from "@vibevalley/protocol/schema";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { Dialog } from "../../design/Dialog";
import { Field, Select, TextInput } from "../../design/Field";
import { IconButton } from "../../design/IconButton";
import { toast } from "../../design/toasts";
import { api } from "../../infra/api";
import { ready, useQueryClient } from "../../infra/query";
import { ArtifactCard, artifactTypeLabel, useArtifacts } from "./ArtifactCard";

/** Linked artifacts for an issue with searchable link picker, new linked artifact creation, and unlink controls. */
export function IssueArtifacts(props: { issue: IssueId; heading: JSX.Element }) {
  const queries = useQueryClient();
  const linked = useArtifacts(() => ({ issue: props.issue }));
  const workspace = useArtifacts(() => ({}));
  const act = createAct();
  const newOpen = signal(false);
  const newTitle = signal("");
  const newType = signal<ArtifactType>("docs");

  const linkedList = computed(() => ready(linked, undefined) ?? []);
  const unlinkedOptions = computed(() =>
    (ready(workspace, undefined) ?? [])
      .filter((a) => a.issue !== props.issue)
      .map((a) => ({
        value: a.id,
        label: `${a.title} · ${artifactTypeLabel(a.artifactType)}`,
      })),
  );
  const typeOptions = computed(() =>
    ARTIFACT_TYPES.map((type) => ({
      value: type,
      label: artifactTypeLabel(type),
    })),
  );

  const linkArtifact = (id: string) => {
    if (!id || act.busy()) return;
    void act.run(async () => {
      const updated = await api.artifact.update({ id: artifactId(id), issue: props.issue });
      await queries.invalidate({ prefix: ["artifacts"] });
      toast(t("web.artifact.issue.linkedToast", { title: updated.title }));
    });
  };

  const unlinkArtifact = (id: string, title: string) => {
    if (act.busy()) return;
    void act.run(async () => {
      await api.artifact.update({ id: artifactId(id), issue: "" });
      await queries.invalidate({ prefix: ["artifacts"] });
      toast(t("web.artifact.issue.unlinkedToast", { title }));
    });
  };

  const openNew = () => {
    newTitle.set("");
    newType.set("docs");
    newOpen.set(true);
  };

  const createLinked = () => {
    const title = newTitle().trim();
    if (!title || act.busy()) return;
    const type = newType();
    void act.run(async () => {
      const made = await api.artifact.create({ title, artifactType: type, issue: props.issue });
      await queries.invalidate({ prefix: ["artifacts"] });
      newOpen.set(false);
      toast(t("web.artifact.issue.linkedToast", { title: made.title }));
    });
  };

  return (
    <View accessibilityLabel={t("web.artifact.issue.title")} testID="issue-artifacts" class="gap-2">
      {props.heading}
      <If
        when={linkedList().length > 0}
        else={
          <Text testID="issue-artifacts-empty" class="text-xs text-faint">
            {t("web.artifact.issue.empty")}
          </Text>
        }
      >
        <View class="gap-1.5">
          <Each of={linkedList()} key={(a) => a.id}>
            {(a) => (
              <View testID={`issue-artifact-row-${a().id}`} class="max-w-md flex-row items-center gap-1.5">
                <View class="min-w-0 flex-1">
                  <ArtifactCard
                    card={{
                      id: a().id,
                      title: a().title,
                      artifactType: a().artifactType,
                      version: a().version,
                      note: a().versions.at(-1)?.note ?? "",
                    }}
                  />
                </View>
                <IconButton
                  icon="close"
                  size={12}
                  label={t("web.artifact.issue.unlink", { title: a().title })}
                  testid={`issue-artifact-unlink-${a().id}`}
                  disabled={act.busy()}
                  onClick={() => unlinkArtifact(a().id, a().title)}
                />
              </View>
            )}
          </Each>
        </View>
      </If>
      <View class="flex-row flex-wrap items-center gap-2 pt-0.5">
        <Select
          quiet
          size="control"
          searchable
          class="min-w-48 max-w-xs flex-1"
          label={t("web.artifact.issue.linkExisting")}
          testid="issue-artifact-link-picker"
          value=""
          placeholder={t("web.artifact.issue.linkExisting")}
          searchPlaceholder={t("web.artifact.issue.linkPlaceholder")}
          emptyText={t("web.artifact.issue.linkEmpty")}
          disabled={act.busy()}
          options={unlinkedOptions()}
          onChange={linkArtifact}
        />
        <Button size="compact" tone="quiet" icon="add" testID="issue-artifact-new" disabled={act.busy()} onPress={openNew}>
          {t("web.artifact.issue.new")}
        </Button>
      </View>
      <Dialog
        open={newOpen()}
        onClose={() => newOpen.set(false)}
        title={t("web.artifact.issue.newDialogTitle")}
        size="sm"
        height="auto"
        testid="issue-artifact-new-dialog"
      >
        <View class="gap-3.5 px-5 py-4">
          <Field label={t("web.artifact.issue.newTitle")}>
            <TextInput
              testID="issue-artifact-new-title"
              value={newTitle()}
              placeholder={t("web.artifact.issue.newTitlePlaceholder")}
              onInput={(v) => newTitle.set(v)}
              onSubmit={createLinked}
              autoFocus
            />
          </Field>
          <Field label={t("web.artifact.issue.newType")}>
            <Select
              label={t("web.artifact.issue.newType")}
              testid="issue-artifact-new-type"
              value={newType()}
              options={typeOptions()}
              onChange={(v) => newType.set(v)}
            />
          </Field>
          <View class="flex-row items-center justify-end gap-2 border-t border-line pt-3">
            <Button tone="quiet" testID="issue-artifact-new-cancel" onPress={() => newOpen.set(false)}>
              {t("web.base.form.never")}
            </Button>
            <Button tone="primary" testID="issue-artifact-new-submit" disabled={act.busy() || newTitle().trim() === ""} onPress={createLinked}>
              {t("web.artifact.issue.newCreate")}
            </Button>
          </View>
        </View>
      </Dialog>
    </View>
  );
}
