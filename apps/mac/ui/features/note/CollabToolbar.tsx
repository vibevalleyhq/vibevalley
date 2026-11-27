import { computed, Scroll, signal, Text, View, windowSize } from "nsh";
import { Popover } from "nsh/base";

import { t } from "@vibevalley/i18n";
import { type Note, type NotePresence, type Suggestion, type SuggestionId, userId } from "@vibevalley/protocol";

import { Button } from "../../design/Button";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import { motionClass, popupTransition } from "../../design/motion";
import { CountPill } from "../../design/Tag";

export interface CollabToolbarProps {
  readonly note: Note;
  readonly peers: readonly NotePresence[];
  readonly suggestions: readonly Suggestion[];
  readonly onAcceptSuggestion: (id: SuggestionId) => Promise<void> | void;
  readonly onRejectSuggestion: (id: SuggestionId) => Promise<void> | void;
  readonly onToggleHistory: () => void;
  readonly onToggleFiles: () => void;
}

function peerInitial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : "?";
}

/** Compact collaboration toolbar showing live peer presence, pending AI/human review suggestions, History, and Files toggles. */
export function CollabToolbar(props: CollabToolbarProps) {
  const drawerOpen = signal(false);
  const busyId = signal<SuggestionId | undefined>(undefined);

  const remotePeers = computed(() => props.peers.filter((p) => p.id !== userId));
  const openSuggestions = computed(() => props.suggestions.filter((s) => s.status === "open"));

  const runResolve = (id: SuggestionId, fn: (id: SuggestionId) => Promise<void> | void) => {
    busyId.set(id);
    void Promise.resolve(fn(id)).finally(() => {
      if (busyId() === id) busyId.set(undefined);
    });
  };

  return (
    <View testID="note-collab-toolbar" class="shrink-0 flex-row items-center gap-1.5">
      <If when={remotePeers().length > 0}>
        <View testID="collab-presence-list" class="flex-row items-center gap-1">
          <Each of={remotePeers()} key={(p) => p.id}>
            {(peer) => (
              <View testID={`collab-peer-${peer().id}`} class="h-6 flex-row items-center gap-1.5 rounded-full border border-line bg-side pr-2 pl-1">
                <View class="size-4 items-center justify-center rounded-full bg-accent">
                  <Text class="text-2xs font-semibold text-page">{peerInitial(peer().name)}</Text>
                </View>
                <Text class="max-w-24 truncate text-2xs font-medium text-ink">{peer().status ? `${peer().name} · ${peer().status}` : peer().name}</Text>
              </View>
            )}
          </Each>
        </View>
      </If>

      <If when={openSuggestions().length > 0}>
        <Popover
          open={drawerOpen()}
          onOpenChange={(e) => drawerOpen.set(e.open)}
          placement="bottom"
          align="end"
          offset={4}
          popupClass={`flex-col overflow-hidden rounded-lg border border-line-strong bg-elevated shadow-float ${motionClass("transition-opacity duration-120 ease-out")}`}
          popupStartingClass={popupTransition("opacity-0")}
          popupEndingClass={popupTransition("opacity-0")}
          popupStyle={{
            width: Math.min(384, Math.max(260, windowSize().width - 24)),
            maxHeight: Math.min(360, Math.max(180, Math.round(windowSize().height * 0.6))),
          }}
          trigger={
            <View
              role="button"
              testID="collab-suggestions-toggle"
              accessibilityState={{ expanded: drawerOpen() }}
              class={`h-7 flex-row items-center gap-1.5 rounded-md border px-2 ${
                drawerOpen() ? "border-accent bg-warn-soft" : "border-line bg-warn-soft hover:border-faint"
              }`}
            >
              <Icon name="edit" size={12} tone="warn-ink" />
              <Text class="text-xs font-medium text-warn-ink">{t("web.note.suggestions.title", { n: openSuggestions().length })}</Text>
            </View>
          }
        >
          <View testID="collab-suggestions-popover" class="min-h-0 flex-1">
            <View class="flex-row items-center justify-between border-b border-line bg-side px-3 py-2">
              <View class="flex-row items-center gap-1.5">
                <Text class="text-xs font-semibold text-ink">{t("web.note.suggestions.title", { n: openSuggestions().length })}</Text>
                <CountPill count={openSuggestions().length} />
              </View>
              <IconButton icon="close" size={12} label={t("web.note.canvas.close")} onClick={() => drawerOpen.set(false)} />
            </View>
            <Scroll class="max-h-72" contentClass="gap-2 p-2.5">
              <Each of={openSuggestions()} key={(s) => s.id}>
                {(sug) => (
                  <View testID={`collab-suggestion-${sug().id}`} class="gap-2 rounded-md border border-line bg-page p-2.5">
                    <View class="flex-row items-center justify-between gap-2">
                      <Text class="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{t("web.note.suggestions.by", { name: sug().author })}</Text>
                      <Text class="shrink-0 font-mono text-2xs text-faint">{sug().path}</Text>
                    </View>
                    <Text class="line-clamp-3 text-xs leading-relaxed text-muted">
                      {sug().change.summary ??
                        (sug().change.delete === true ? t("web.note.suggestions.delete") : (sug().change.content ?? sug().change.patch ?? ""))}
                    </Text>
                    <View class="flex-row items-center justify-end gap-1.5">
                      <Button
                        size="compact"
                        tone="quiet"
                        testID={`collab-suggestion-reject-${sug().id}`}
                        disabled={busyId() === sug().id}
                        onPress={() => runResolve(sug().id, props.onRejectSuggestion)}
                      >
                        {t("web.note.suggestions.reject")}
                      </Button>
                      <Button
                        size="compact"
                        tone="primary"
                        testID={`collab-suggestion-accept-${sug().id}`}
                        disabled={busyId() === sug().id}
                        onPress={() => runResolve(sug().id, props.onAcceptSuggestion)}
                      >
                        {t("web.note.suggestions.accept")}
                      </Button>
                    </View>
                  </View>
                )}
              </Each>
            </Scroll>
          </View>
        </Popover>
      </If>

      <IconButton icon="clock" size={14} label={t("web.note.timeline.title")} testid="collab-toggle-history" onClick={props.onToggleHistory} />
      <IconButton icon="folder" size={14} label={t("web.note.page.filesTab")} testid="collab-toggle-files" onClick={props.onToggleFiles} />
    </View>
  );
}
