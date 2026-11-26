import { effect, keymap, Scroll, View } from "nsh";

import { TextArea } from "../../../design/Field";
import { Markdown } from "../../../design/Markdown";

export type DocsMode = "split" | "edit" | "read";

export interface DocsViewProps {
  readonly title: string;
  readonly version?: number | undefined;
  readonly mode: DocsMode;
  readonly content: string;
  readonly draft: string;
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly onDraftChange: (next: string) => void;
  readonly onSave: () => void;
}

export function DocsView(props: DocsViewProps) {
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
        <If
          when={props.mode === "read"}
          else={
            <View class="min-h-0 flex-1 flex-row">
              <View class={`min-h-0 min-w-0 flex-1 p-4 ${props.mode === "split" ? "border-r border-line" : ""}`}>
                <TextArea
                  testID="artifact-docs-editor"
                  accessibilityLabel={props.title}
                  rows={22}
                  value={props.draft}
                  onInput={(v) => props.onDraftChange(v)}
                  class="min-h-0 flex-1 font-mono text-xs leading-relaxed"
                />
              </View>
              <If when={props.mode === "split"}>
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
