import { effect, keymap, Scroll, signal, Text, untracked, View, windowSize } from "nsh";

import { t } from "@vibevalley/i18n";

import { Button } from "../../../design/Button";
import { TextArea } from "../../../design/Field";
import { Markdown } from "../../../design/Markdown";
import { Segmented } from "../../../design/Segmented";

type DocsMode = "split" | "edit" | "read";

export interface DocsViewProps {
  readonly title: string;
  readonly version?: number | undefined;
  readonly content: string;
  readonly draft: string;
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly onDraftChange: (next: string) => void;
  readonly onSave: () => void;
  readonly onRevert: () => void;
}

export function DocsView(props: DocsViewProps) {
  const mode = signal<DocsMode>(untracked(() => (windowSize().width >= 960 ? "split" : "edit")));

  effect(() => {
    if (props.version !== undefined || !props.dirty || props.busy) return;
    return keymap.bind("mod+s", () => props.onSave(), { when: "always" });
  });

  return (
    <View testID="artifact-docs-view" class="min-h-0 flex-1 bg-page">
      <If
        when={props.version === undefined}
        else={
          <Scroll class="min-h-0 flex-1" contentClass="mx-auto w-full max-w-3xl px-6 py-6">
            <Markdown size="doc" text={props.content} />
          </Scroll>
        }
      >
        <View class="h-9 shrink-0 flex-row items-center gap-2 border-b border-line bg-side px-3">
          <Segmented
            testid="artifact-docs-mode"
            label={t("web.artifact.page.viewMode")}
            value={mode()}
            onChange={(v) => mode.set(v)}
            options={[
              { value: "split", label: t("web.artifact.docs.split") },
              { value: "edit", label: t("web.artifact.docs.edit") },
              { value: "read", label: t("web.artifact.docs.read") },
            ]}
          />
          <Text class="font-mono text-2xs text-muted tabular-nums">{t("web.artifact.docs.chars", { n: props.draft.length })}</Text>
          <If when={props.dirty}>
            <View class="flex-row items-center gap-1 rounded-sm bg-warn-soft px-1.5 py-0.5">
              <View class="size-1.5 rounded-full bg-wheat" />
              <Text class="text-2xs font-medium text-warn-ink">{t("web.artifact.page.unsaved")}</Text>
            </View>
          </If>
          <View class="min-w-0 flex-1" />
          <If when={props.dirty}>
            <Button size="compact" tone="quiet" testID="artifact-docs-revert" disabled={props.busy} onPress={() => props.onRevert()}>
              {t("web.artifact.page.discard")}
            </Button>
          </If>
          <Button tone="primary" size="compact" testID="artifact-file-save" disabled={props.busy || !props.dirty} onPress={() => props.onSave()}>
            {t("web.artifact.whiteboard.save")}
          </Button>
        </View>

        <If
          when={mode() === "read"}
          else={
            <View class="min-h-0 flex-1 flex-row">
              <View class={`min-h-0 min-w-0 flex-1 p-4 ${mode() === "split" ? "border-r border-line" : ""}`}>
                <TextArea
                  testID="artifact-docs-editor"
                  accessibilityLabel={props.title}
                  rows={22}
                  value={props.draft}
                  onInput={(v) => props.onDraftChange(v)}
                  class="min-h-0 flex-1 font-mono text-xs leading-relaxed"
                />
              </View>
              <If when={mode() === "split"}>
                <Scroll testID="artifact-docs-preview" class="min-h-0 min-w-0 flex-1 bg-page" contentClass="mx-auto w-full max-w-3xl px-6 py-5">
                  <Markdown size="doc" text={props.draft} />
                </Scroll>
              </If>
            </View>
          }
        >
          <Scroll testID="artifact-docs-preview" class="min-h-0 flex-1 bg-page" contentClass="mx-auto w-full max-w-3xl px-6 py-6">
            <Markdown size="doc" text={props.draft} />
          </Scroll>
        </If>
      </If>
    </View>
  );
}
