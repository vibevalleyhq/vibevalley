import { signal, Text, View } from "nsh";
import { Button } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { motionClass } from "../../design/motion";
import { Bubble } from "../../design/Tip";
import { act } from "../../infra/bridge";
import { gitToneTextClass, ShellIconButton, startEllipsis } from "../chrome";
import type { GitRow } from "./model";

export function FileRow(props: { row: GitRow; staged: boolean }) {
  const hovered = signal(false);
  const confirmingDiscard = signal(false);
  const name = () => props.row.path.split("/").pop() ?? props.row.path;
  const dir = () => props.row.path.slice(0, Math.max(0, props.row.path.length - name().length - 1));
  const showActions = () => hovered() || confirmingDiscard();
  return (
    <View
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      class={`mx-1.5 h-6.5 flex-row items-center gap-1 rounded-md px-1.5 ${showActions() ? "bg-hover" : "bg-transparent"}`}
    >
      <Button
        onPress={() => {
          confirmingDiscard.set(false);
          act({ type: "open_diff", path: props.row.path, staged: props.staged });
        }}
        accessibilityLabel={`Open diff of ${props.row.path}`}
        tooltip={<Bubble text={props.row.path} />}
        class="h-6.5 min-w-0 flex-1 flex-row items-center gap-1.5 rounded-sm focus-visible:outline-2 focus-visible:outline-focus"
      >
        <Text class={`shrink truncate text-sm ${gitToneTextClass(props.row.tone)}`}>{name()}</Text>
        <If when={dir()}>
          {(d) => (
            <Text class="min-w-0 flex-1 truncate text-2xs text-muted" style={startEllipsis}>
              {d()}
            </Text>
          )}
        </If>
      </Button>
      <If
        when={confirmingDiscard()}
        else={
          <If when={hovered()}>
            <View class="shrink-0 flex-row items-center gap-0.5">
              <If
                when={props.staged}
                else={
                  <>
                    <ShellIconButton
                      compact
                      danger
                      icon="undo"
                      label={t("web.shell.git.discardPath", { path: props.row.path })}
                      onPress={() => confirmingDiscard.set(true)}
                    />
                    <ShellIconButton
                      compact
                      icon="add"
                      label={t("web.shell.git.stagePath", { path: props.row.path })}
                      onPress={() => act({ type: "stage", paths: [props.row.path] })}
                    />
                  </>
                }
              >
                <ShellIconButton
                  compact
                  icon="minus"
                  label={t("web.shell.git.unstagePath", { path: props.row.path })}
                  onPress={() => act({ type: "unstage", paths: [props.row.path] })}
                />
              </If>
            </View>
          </If>
        }
      >
        <View class="shrink-0 flex-row items-center gap-1">
          <Button
            onPress={() => {
              confirmingDiscard.set(false);
              act({ type: "discard", paths: [props.row.path] });
            }}
            class={`h-5 justify-center rounded-sm bg-berry px-1.5 ${motionClass("transition-opacity duration-120 ease-out")} active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
          >
            <Text class="text-2xs font-medium text-page">{t("web.shell.git.confirmDiscard")}</Text>
          </Button>
          <Button
            onPress={() => confirmingDiscard.set(false)}
            class={`h-5 justify-center rounded-sm bg-selected px-1.5 ${motionClass("transition-opacity duration-120 ease-out")} hover:bg-hover active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
          >
            <Text class="text-2xs text-ink">{t("web.shell.git.cancel")}</Text>
          </Button>
        </View>
      </If>
      <Text class={`w-4 shrink-0 text-center font-mono text-2xs font-semibold ${gitToneTextClass(props.row.tone)}`}>{props.row.code}</Text>
    </View>
  );
}
