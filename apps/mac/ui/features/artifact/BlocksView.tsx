import { effect, keymap, signal, Scroll, Text, untracked, View, type InputRef, type JSX } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import {
  type Agent,
  type ArtifactId,
  type ArtifactPresence,
  type ArtifactType,
  type BlockId,
  type Suggestion,
  type TextSpan,
  userId,
} from "@vibevalley/protocol";
import { blockId as brandBlockId } from "@vibevalley/protocol/schema";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { Checkbox } from "../../design/Checkbox";
import { hexColor, swatches } from "../../design/domain/cast";
import { AgentFace } from "../../design/domain/Face";
import { Icon } from "../../design/Icon";
import type { IconName } from "../../design/icons";
import { Kbd } from "../../design/layout";
import { motionClass } from "../../design/motion";
import { CountPill } from "../../design/Tag";
import { Bubble } from "../../design/Tip";
import { tone } from "../../design/tone";
import { api } from "../../infra/api";
import { createExternal } from "../../infra/base/external";
import { hostApi } from "../../infra/bridge";
import { followArtifact, followSuggestions } from "../../infra/gateway";
import { ready, useAgents } from "../../infra/query";
import { createEffect, createMemo, createSignal, onSettled, untrack } from "../../infra/solid";
import { knownTypes, plainOf } from "./blocks";
import { BlockEditor, type EditBlock } from "./editor";
import { useArtifactPresence, useReportViewContext } from "./store";

/** The user's lines on the attribution bar. */
const userColor = () => tone("cream-300");

/** Who wrote a block last, as the bar beside it shows. */
function authorColor(updatedBy: string, agent: Agent | undefined) {
  if (updatedBy === userId) return userColor();
  if (agent?.look.trim) return hexColor(agent.look.trim);
  let h = 0;
  for (let i = 0; i < updatedBy.length; i++) h = (h * 31 + updatedBy.charCodeAt(i)) & 0x7fffffff;
  const trim = swatches.trim[h % swatches.trim.length];
  return trim === undefined ? userColor() : hexColor(trim);
}

function presenceColor(peer: ArtifactPresence, agent: Agent | undefined): string {
  if (peer.color && /^#[0-9a-f]{6}$/iu.test(peer.color)) return peer.color;
  switch (peer.color?.toLowerCase()) {
    case "coral":
    case "berry":
      return tone("berry");
    case "teal":
    case "leaf":
      return tone("leaf");
    case "blue":
    case "water":
      return tone("water");
    case "wheat":
      return tone("wheat");
    default:
      return authorColor(peer.id, agent);
  }
}

/** Suggestions anchored with Loro durable cursors survive intervening block revisions without going stale. */
function isSuggestionStale(suggestion: Suggestion, block: EditBlock | undefined): boolean {
  if (block === undefined) return true;
  if (suggestion.cursorStart !== undefined || suggestion.cursorEnd !== undefined) return false;
  return block.rev !== suggestion.baseRev;
}

/** A block as one drawing of the editor shows it; `block` is the editor's own, for its actions. */
interface Row {
  readonly block: EditBlock;
  readonly type: string;
  readonly attrs: EditBlock["attrs"];
  readonly text: string;
  readonly spans: readonly TextSpan[];
  readonly updatedBy: string;
  readonly problem: string | undefined;
  readonly depth: number;
  readonly number: number | undefined;
  readonly writing: boolean;
  readonly showFace: boolean;
  readonly wanted: boolean;
}

export interface QuoteTarget {
  readonly id: string;
  readonly rev: number;
  readonly type: string;
  readonly text: string;
}

/** Keyed by the id by its caller: one editor for the page's life, handed to onEditor for what the page's menu does with
 * it. onRail: where the open suggestions are drawn is the caller's (the artifacts page's side panel); without it, above
 * the blocks. */
export function BlocksView(props: {
  id: ArtifactId;
  artifactType?: ArtifactType | undefined;
  onEditor?: (editor: BlockEditor) => void;
  onQuote?: ((block: QuoteTarget) => void) | undefined;
  onRail?: ((list: () => JSX.Element) => void) | undefined;
}) {
  const editor = new BlockEditor(
    api,
    untrack(() => props.id),
  );
  untrack(() => props.onEditor)?.(editor);
  const [suggestions, setSuggestions] = createSignal<Suggestion[]>([]);
  const [working, setWorking] = createSignal<string>();
  const acting = createAct();
  const presence = useArtifactPresence(() => props.id);
  onSettled(() => {
    let stop: (() => void) | undefined;
    const stopSuggestions = followSuggestions(String(props.id), (e) => setSuggestions(e.suggestions));
    void editor.load().then(() => {
      if (editor.artifact === undefined) return;
      editor.setLive(true);
      stop = followArtifact(
        String(props.id),
        editor.artifact.seq,
        (e) => {
          if (e._tag === "Blocks") editor.receive(e);
          else {
            editor.setLive(false);
            void editor.load();
          }
        },
        () => editor.setLive(false),
      );
    });
    return () => {
      stop?.();
      stopSuggestions();
      editor.dispose();
    };
  });
  // The editor changes its blocks in place and bumps its version; each version is drawn as fresh rows, matched by id.
  const version = createExternal(editor.subscribe, () => editor.version);
  const resolvedType = () => props.artifactType ?? (version(), editor.artifact?.artifactType) ?? "docs";
  const isOutline = () => resolvedType() === "outline";
  useReportViewContext(
    () => props.id,
    () => {
      version();
      const focused = editor.focusId;
      return {
        artifactType: resolvedType(),
        title: editor.artifact?.title ?? "",
        ...(editor.artifact?.seq !== undefined ? { seq: editor.artifact.seq } : {}),
        ...(focused ? { selectedBlockIds: [brandBlockId(focused)] } : {}),
      };
    },
  );
  const all = useAgents();
  const agents = createMemo(() => new Map(ready(all, []).map((a) => [a.id, a])));
  const remotePeers = createMemo(() => presence.peers().filter((p) => p.id !== userId));
  const peersByBlock = createMemo(() => {
    const map = new Map<string, ArtifactPresence[]>();
    for (const p of remotePeers()) {
      if (!p.blockId) continue;
      const list = map.get(p.blockId);
      if (list) list.push(p);
      else map.set(p.blockId, [p]);
    }
    return map;
  });
  const unplacedPeers = createMemo(() => {
    version();
    const blockIds = new Set(editor.blocks.map((b) => String(b.id)));
    return remotePeers().filter((p) => !p.blockId || !blockIds.has(String(p.blockId)));
  });
  const openSuggestions = createMemo(() => suggestions().filter((s) => s.status === "open"));
  const openSuggestionsByBlock = createMemo(() => {
    const map = new Map<string, Suggestion[]>();
    for (const s of openSuggestions()) {
      const list = map.get(s.blockId);
      if (list) list.push(s);
      else map.set(s.blockId, [s]);
    }
    return map;
  });
  const activeSuggestion = createMemo(() => {
    version();
    const open = openSuggestions();
    if (open.length === 0) return undefined;
    const focusedId = editor.blocks.find((b) => b.focused)?.id ?? editor.focusId;
    return (focusedId ? open.find((s) => s.blockId === focusedId) : undefined) ?? open[0];
  });
  const publishCursor = (blockId: BlockId, start: number, end: number) => {
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    presence.publish({
      id: userId,
      name: t("web.artifact.blocks.user"),
      kind: low === high ? "block_cursor" : "selection",
      blockId,
      offset: low,
      ...(low !== high ? { endOffset: high } : {}),
    });
  };
  const rows = createMemo((): Row[] => {
    version();
    const numbers = editor.numbers;
    let lastAuthor: string | undefined;
    return editor.blocks.map((b) => {
      const writing = editor.writing(b);
      const row: Row = {
        block: b,
        type: b.type,
        attrs: { ...b.attrs },
        text: b.text,
        spans: b.spans,
        updatedBy: b.updatedBy,
        problem: b.problem,
        depth: editor.depthOf(b),
        number: numbers.get(b.id),
        writing,
        showFace: writing || (b.updatedBy !== userId && b.updatedBy !== lastAuthor),
        wanted: editor.focusId === b.id,
      };
      lastAuthor = b.updatedBy;
      return row;
    });
  });
  const status = () => {
    version();
    return (
      editor.error ??
      (editor.busy
        ? t("web.artifact.blocks.saving")
        : [
            t("web.artifact.blocks.saved"),
            t("web.artifact.blocks.blocks", { n: editor.blocks.length }),
            ...(editor.othersWriting ? [t("web.artifact.blocks.helpersWriting")] : []),
          ].join(" · "))
    );
  };
  const resolve = async (suggestion: Suggestion, accept: boolean) => {
    setWorking(suggestion.id);
    const artifact = props.id;
    const done = await acting.run(async () => {
      const result = accept
        ? await api.artifact.suggestion.accept({ id: artifact, suggestion: suggestion.id })
        : await api.artifact.suggestion.reject({ id: artifact, suggestion: suggestion.id });
      await editor.load();
      return result;
    });
    if (done) setSuggestions((list) => list.map((x) => (x.id === done.id ? done : x)));
    setWorking(undefined);
  };

  effect(() => {
    const target = activeSuggestion();
    if (!target || working() !== undefined) return;
    version();
    const block = editor.blocks.find((b) => b.id === target.blockId);
    const stale = isSuggestionStale(target, block);
    const offs: (() => void)[] = [];
    if (!stale) {
      offs.push(keymap.bind("tab", () => void resolve(target, true), { when: "always" }));
    }
    offs.push(keymap.bind("escape", () => void resolve(target, false), { when: "always" }));
    return () => offs.forEach((off) => off());
  });

  const suggestionsList = () => (
    <SuggestionsList
      list={suggestions()}
      blocks={(version(), editor.blocks)}
      agents={agents()}
      working={working()}
      onAccept={(suggestion) => void resolve(suggestion, true)}
      onReject={(suggestion) => void resolve(suggestion, false)}
    />
  );
  untrack(() => props.onRail)?.(suggestionsList);
  const state = () => (version(), editor.error ? "error" : editor.busy ? "saving" : "saved");
  return (
    <View
      accessibilityLabel={(version(), editor.artifact?.title) ?? ""}
      accessibilityValue={{ text: `${state()} ${(version(), editor.blocks.length)}${(version(), editor.othersWriting) ? " writing" : ""}` }}
      testID="artifact-blocks"
      class="min-h-0 flex-1"
    >
      <If when={!props.onRail}>{suggestionsList()}</If>
      <View class={`min-h-5 flex-row flex-wrap items-center gap-1.5 pb-2 ${isOutline() ? "pl-3" : "pl-8.75"}`}>
        <If when={(version(), editor.error !== undefined)}>
          <View class="size-1.5 shrink-0 rounded-full bg-berry" />
        </If>
        <If when={(version(), editor.error === undefined && (editor.busy || editor.othersWriting))}>
          <View class="size-1.5 shrink-0 rounded-full bg-wheat" />
        </If>
        <Text class={`truncate text-xs tabular-nums ${(version(), editor.error !== undefined) ? "font-medium text-berry" : "text-muted"}`}>
          {(version(), editor.blocks.length > 0 || editor.busy || editor.error !== undefined) ? status() : ""}
        </Text>
        <If when={unplacedPeers().length > 0}>
          <View class="ml-auto flex-row flex-wrap items-center gap-1">
            <Each of={unplacedPeers()} key={(p) => p.id}>
              {(peer) => <PresencePill peer={peer()} agent={agents().get(peer().id)} />}
            </Each>
          </View>
        </If>
      </View>
      <Scroll class="min-h-0 flex-1" contentClass="pr-3">
        <Each of={rows()} key={(r) => r.block.id}>
          {(row) => (
            <BlockRow
              editor={editor}
              row={row()}
              outline={isOutline()}
              agent={agents().get(row().updatedBy)}
              agents={agents()}
              peers={peersByBlock().get(row().block.id) ?? []}
              suggestions={openSuggestionsByBlock().get(row().block.id) ?? []}
              activeSuggestionId={activeSuggestion()?.id}
              hasOpenSuggestion={activeSuggestion() !== undefined}
              working={working()}
              onAcceptSuggestion={(s) => void resolve(s, true)}
              onRejectSuggestion={(s) => void resolve(s, false)}
              onPresence={publishCursor}
              onBlurPresence={() => presence.clear(userId)}
              onQuote={props.onQuote}
            />
          )}
        </Each>
        {/* Below the last block: a press starts a new paragraph or outline bullet. */}
        <View
          role="button"
          testID="artifact-append"
          accessibilityLabel={t("web.artifact.blocks.append")}
          onPress={() => editor.append()}
          class={`h-16 w-full pt-1.5 ${isOutline() ? "pl-3" : "pl-8.75"}`}
        >
          <Text class="text-base text-faint">{(version(), editor.blocks.length === 0 && !editor.busy) ? t("web.artifact.blocks.start") : ""}</Text>
        </View>
      </Scroll>
    </View>
  );
}

function PresencePill(props: { peer: ArtifactPresence; agent?: Agent | undefined }) {
  const color = () => presenceColor(props.peer, props.agent);
  const label = () => {
    const parts = [props.peer.name];
    if (props.peer.status) parts.push(props.peer.status);
    else if (props.peer.kind === "selection" && props.peer.offset !== undefined && props.peer.endOffset !== undefined) {
      parts.push(`${props.peer.offset}–${props.peer.endOffset}`);
    }
    return parts.join(" · ");
  };
  return (
    <View
      testID="artifact-presence-pill"
      accessibilityLabel={label()}
      class="h-5 shrink-0 flex-row items-center gap-1 rounded-sm border border-line bg-side px-1.5"
    >
      <View class="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color() }} />
      <Text class="max-w-36 truncate text-2xs font-medium text-ink">{label()}</Text>
    </View>
  );
}

function SuggestionsList(props: {
  list: readonly Suggestion[];
  blocks: readonly EditBlock[];
  agents: Map<string, Agent>;
  working: string | undefined;
  onAccept: (s: Suggestion) => void;
  onReject: (s: Suggestion) => void;
}) {
  const open = () => props.list.filter((s) => s.status === "open");
  return (
    <If when={open().length > 0}>
      <View testID="artifact-suggestions" class="mb-2.5 shrink-0 rounded-lg border border-line bg-page p-2.5">
        <View class="flex-row items-center justify-between gap-2 px-0.5 pb-1.5">
          <Text class="text-xs font-semibold text-muted">{t("web.artifact.suggestions.title", { n: open().length })}</Text>
          <CountPill count={open().length} />
        </View>
        <Each of={open()} key={(s) => s.id}>
          {(s, i) => {
            const block = () => props.blocks.find((b) => b.id === s().blockId);
            const stale = () => isSuggestionStale(s(), block());
            const agent = () => props.agents.get(s().author);
            const who = () => (s().author === userId ? t("web.artifact.blocks.user") : (agent()?.name ?? s().author));
            return (
              <View
                testID="artifact-suggestion"
                accessibilityValue={{ text: stale() ? "stale" : "open" }}
                class={`gap-1.5 border-line px-0.5 py-2 ${i() > 0 ? "border-t" : ""}`}
              >
                <View class="flex-row items-center gap-1.5">
                  <AgentFace agentId={s().author} look={agent()?.look} runtime={agent()?.runtime} size={16} />
                  <Text class="min-w-0 flex-1 truncate text-xs text-muted tabular-nums">
                    {`${t("web.artifact.suggestions.by", { name: who() })} ${t("web.artifact.suggestions.rev", { rev: s().baseRev })}`}
                  </Text>
                </View>
                <SuggestionDiff suggestion={s()} block={block()} />
                <If when={stale()}>
                  <View class="rounded-sm bg-bad-soft px-2 py-1">
                    <Text class="text-xs font-medium text-berry">{t("web.artifact.suggestions.stale")}</Text>
                  </View>
                </If>
                <View class="flex-row items-center gap-1.5 pt-0.5">
                  <Button
                    tone="primary"
                    size="compact"
                    testID="suggestion-accept"
                    disabled={stale() || props.working === s().id}
                    onPress={() => props.onAccept(s())}
                  >
                    {t("web.artifact.suggestions.accept")}
                  </Button>
                  <Button tone="plain" size="compact" testID="suggestion-reject" disabled={props.working === s().id} onPress={() => props.onReject(s())}>
                    {t("web.artifact.suggestions.reject")}
                  </Button>
                </View>
              </View>
            );
          }}
        </Each>
      </View>
    </If>
  );
}

const typeName = (type: string) => {
  switch (type) {
    case "heading":
      return t("web.artifact.suggestions.types.heading");
    case "bulleted":
      return t("web.artifact.suggestions.types.bulleted");
    case "numbered":
      return t("web.artifact.suggestions.types.numbered");
    case "todo":
      return t("web.artifact.suggestions.types.todo");
    case "quote":
      return t("web.artifact.suggestions.types.quote");
    case "code":
      return t("web.artifact.suggestions.types.code");
    case "divider":
      return t("web.artifact.suggestions.types.divider");
    case "image":
      return t("web.artifact.suggestions.types.image");
    case "issue_ref":
      return t("web.artifact.suggestions.types.issueRef");
    case "memory_item":
      return t("web.artifact.suggestions.types.memoryItem");
    default:
      return t("web.artifact.suggestions.types.paragraph");
  }
};

const attrName = (key: string) => {
  switch (key) {
    case "level":
      return t("web.artifact.suggestions.attrLevel");
    case "checked":
      return t("web.artifact.suggestions.attrChecked");
    case "language":
      return t("web.artifact.suggestions.attrLanguage");
    default:
      return key;
  }
};

const attrText = (attrs: object) =>
  Object.entries(attrs)
    .map(([k, v]) => `${attrName(k)} ${String(v)}`)
    .join(" / ");

function SuggestionDiff(props: { suggestion: Suggestion; block: EditBlock | undefined }) {
  const change = () => props.suggestion.change;
  const spanSlice = () => {
    const start = props.suggestion.startOffset;
    const end = props.suggestion.endOffset;
    const text = props.block?.text ?? "";
    if (start === undefined || end === undefined || start > end || end > text.length) return undefined;
    return { before: text.slice(0, start), target: text.slice(start, end), after: text.slice(end) };
  };
  return (
    <If
      when={change().delete === true}
      else={
        <View class="gap-1">
          <If when={change().type !== undefined}>
            <Text class="text-xs font-medium text-ink">{t("web.artifact.suggestions.type", { type: typeName(change().type ?? "") })}</Text>
          </If>
          <If when={change().attrs !== undefined}>
            <Text class="text-xs text-muted">{t("web.artifact.suggestions.attrs", { attrs: attrText(change().attrs ?? {}) })}</Text>
          </If>
          <If when={change().text !== undefined}>
            <View class="gap-0.5 rounded-sm bg-side px-2 py-1.5">
              <If
                when={spanSlice()}
                else={
                  <>
                    <If when={(props.block?.text ?? "") !== ""}>
                      <Text class="text-xs text-muted line-through">{props.block?.text ?? ""}</Text>
                    </If>
                    <Text class="text-xs font-medium text-ok-ink">{plainOf(change().text ?? [])}</Text>
                  </>
                }
              >
                {(slice) => (
                  <Text class="text-xs text-ink">
                    {slice().before}
                    <If when={slice().target !== ""}>
                      <Text class="text-muted line-through">{slice().target}</Text>
                    </If>
                    <Text class="font-medium text-ok-ink">{plainOf(change().text ?? [])}</Text>
                    {slice().after}
                  </Text>
                )}
              </If>
            </View>
          </If>
        </View>
      }
    >
      <View class="rounded-sm bg-bad-soft px-2 py-1">
        <Text class="text-xs font-medium text-berry">{t("web.artifact.suggestions.delete")}</Text>
      </View>
    </If>
  );
}

const barHeight = (type: string) => (type === "divider" ? 16 : type === "heading" ? 28 : 20);

function BlockRow(props: {
  editor: BlockEditor;
  row: Row;
  outline: boolean;
  agent?: Agent | undefined;
  agents: Map<string, Agent>;
  peers: readonly ArtifactPresence[];
  suggestions: readonly Suggestion[];
  activeSuggestionId: string | undefined;
  hasOpenSuggestion: boolean;
  working: string | undefined;
  onAcceptSuggestion: (s: Suggestion) => void;
  onRejectSuggestion: (s: Suggestion) => void;
  onPresence: (blockId: BlockId, start: number, end: number) => void;
  onBlurPresence: () => void;
  onQuote?: ((block: QuoteTarget) => void) | undefined;
}) {
  const r = () => props.row;
  const writer = () => (r().updatedBy === userId ? t("web.artifact.blocks.user") : (props.agent?.name ?? r().updatedBy));
  const mark = (): JSX.Element | undefined => {
    switch (r().type) {
      case "bulleted":
        return props.outline ? <View class="mt-2 ml-1.5 size-1.5 shrink-0 rounded-full bg-faint" /> : <Text class="text-base text-muted">•</Text>;
      case "numbered":
        return <Text class="text-base text-muted tabular-nums">{`${r().number ?? 1}.`}</Text>;
      case "memory_item":
        return <Text class="text-xs font-medium text-muted">{t("web.artifact.blocks.memoryItem")}</Text>;
      case "todo":
        return (
          <Checkbox
            class="mt-1"
            checked={r().attrs.checked ?? false}
            label={r().attrs.checked === true ? t("web.artifact.blocks.done") : t("web.artifact.blocks.notDone")}
            onChange={() => props.editor.toggle(r().block)}
          />
        );
      default:
        return undefined;
    }
  };
  const box = () => (r().type === "quote" ? "border-l-3 border-line pl-3" : r().type === "code" ? "rounded-md bg-code-bg px-3 py-2" : "");
  const kind = () =>
    !knownTypes.has(r().type) ? "unknown" : r().type === "divider" ? "divider" : r().type === "image" ? "image" : r().type === "issue_ref" ? "issue" : "text";
  const authorTip = () => (r().writing ? t("web.artifact.blocks.writing", { who: writer() }) : t("web.artifact.blocks.wrote", { who: writer() }));
  const showGutter = () => !props.outline || r().writing || r().updatedBy !== userId;
  return (
    <View
      testID="artifact-block"
      accessibilityLabel={r().block.id}
      accessibilityValue={{ text: r().type }}
      class={`group pb-0.5 ${r().type === "heading" ? "pt-2.5" : "pt-0.5"}`}
    >
      <View class="flex-row items-start">
        <If when={!props.outline}>
          <View class="w-5.5 shrink-0 pt-0.75">
            <If when={r().showFace}>
              <AgentFace agentId={r().updatedBy} look={props.agent?.look} runtime={props.agent?.runtime} size={18} />
            </If>
          </View>
        </If>
        <If when={showGutter()} else={<View class="w-3 shrink-0" />}>
          <View
            testID="artifact-author-bar"
            tooltip={<Bubble text={authorTip()} />}
            accessibilityLabel={r().writing ? t("web.artifact.blocks.writing", { who: writer() }) : undefined}
            class={`mt-0.5 mr-2.5 shrink-0 rounded-sm ${r().writing ? `w-1 ${motionClass("animate-pulse")}` : "w-0.75"}`}
            style={{ height: barHeight(r().type), backgroundColor: authorColor(r().updatedBy, props.agent) }}
          />
        </If>
        <View class="shrink-0" style={{ width: 20 * r().depth }} />
        <View class="min-w-0 flex-1">
          {/* One shape for every text block: a block that changes type keeps its field, and the field its focus. */}
          <If
            when={kind() === "text"}
            else={
              <If when={kind() !== "divider"} else={<View class="my-2.5 h-px bg-line" />}>
                <Placeholder
                  icon={kind() === "image" ? "image" : kind() === "issue" ? "issues" : "info"}
                  text={
                    kind() === "image"
                      ? t("web.artifact.blocks.image", { alt: r().attrs.alt ?? "", src: r().attrs.src ?? "" }).trim()
                      : kind() === "issue"
                        ? t("web.artifact.blocks.issue", { id: r().attrs.issueId ?? "" })
                        : t("web.artifact.blocks.unknown", { type: r().type })
                  }
                />
              </If>
            }
          >
            <View class={`flex-row items-start ${box()}`}>
              <If when={mark() !== undefined}>
                <View class="w-6.5 shrink-0 pt-px">{mark()}</View>
              </If>
              <View class="min-w-0 flex-1">
                <BlockField
                  editor={props.editor}
                  row={r()}
                  outline={props.outline}
                  hasOpenSuggestion={props.hasOpenSuggestion}
                  onPresence={props.onPresence}
                  onBlurPresence={props.onBlurPresence}
                />
              </View>
              <If when={props.peers.length > 0}>
                <View class="ml-2 shrink-0 flex-row flex-wrap items-center gap-1 pt-0.5">
                  <Each of={props.peers} key={(p) => p.id}>
                    {(peer) => <PresencePill peer={peer()} agent={props.agents.get(peer().id)} />}
                  </Each>
                </View>
              </If>
            </View>
          </If>
          <If when={props.suggestions.length > 0}>
            <View class="mt-1 gap-1">
              <Each of={props.suggestions} key={(s) => s.id}>
                {(s) => {
                  const stale = () => isSuggestionStale(s(), r().block);
                  const isActive = () => props.activeSuggestionId === s().id;
                  const sugAgent = () => props.agents.get(s().author);
                  const who = () => (s().author === userId ? t("web.artifact.blocks.user") : (sugAgent()?.name ?? s().author));
                  return (
                    <View
                      testID="artifact-inline-suggestion"
                      class={`gap-1.5 rounded-md border px-2.5 py-1.5 ${isActive() ? "border-accent bg-ok-soft" : "border-line bg-side"}`}
                    >
                      <View class="flex-row items-center gap-1.5">
                        <Text class="min-w-0 flex-1 truncate text-2xs font-medium text-muted">{t("web.artifact.suggestions.by", { name: who() })}</Text>
                        <If when={isActive() && !stale()}>
                          <View class="flex-row items-center gap-1">
                            <Kbd>Tab</Kbd>
                            <Text class="text-2xs text-muted">{t("web.artifact.suggestions.accept")}</Text>
                            <Kbd>Esc</Kbd>
                            <Text class="text-2xs text-muted">{t("web.artifact.suggestions.reject")}</Text>
                          </View>
                        </If>
                      </View>
                      <SuggestionDiff suggestion={s()} block={r().block} />
                      <View class="flex-row items-center gap-1.5">
                        <Button
                          tone="primary"
                          size="compact"
                          testID="inline-suggestion-accept"
                          disabled={stale() || props.working === s().id}
                          onPress={() => props.onAcceptSuggestion(s())}
                        >
                          {t("web.artifact.suggestions.accept")}
                        </Button>
                        <Button
                          tone="plain"
                          size="compact"
                          testID="inline-suggestion-reject"
                          disabled={props.working === s().id}
                          onPress={() => props.onRejectSuggestion(s())}
                        >
                          {t("web.artifact.suggestions.reject")}
                        </Button>
                      </View>
                    </View>
                  );
                }}
              </Each>
            </View>
          </If>
          <If when={r().problem}>
            <View class="mt-1 rounded-sm bg-bad-soft px-2 py-1">
              <Text class="text-xs font-medium text-berry">{r().problem ?? ""}</Text>
            </View>
          </If>
        </View>
        <If when={props.onQuote}>
          <View
            role="button"
            testID="artifact-quote-block"
            accessibilityLabel={t("web.artifact.canvas.quote")}
            tooltip={<Bubble text={t("web.artifact.canvas.quote")} />}
            onPress={() => props.onQuote?.({ id: r().block.id, rev: r().block.rev, type: r().type, text: r().text })}
            class={`mt-0.5 ml-1 size-6 shrink-0 items-center justify-center rounded-md opacity-0 ${motionClass("transition-opacity duration-120 ease-out")} group-hover:opacity-100 hover:bg-hover focus:opacity-100 focus-visible:outline-2 focus-visible:outline-focus`}
          >
            <Icon name="chat" size={14} tone="muted" />
          </View>
        </If>
      </View>
    </View>
  );
}

function Placeholder(props: { icon: IconName; text: string }) {
  return (
    <View class="flex-row items-center gap-2 rounded-md border border-dashed border-line bg-side px-3 py-2">
      <Icon name={props.icon} size={14} tone="muted" />
      <Text class="min-w-0 flex-1 text-sm text-muted">{props.text}</Text>
    </View>
  );
}

/** A block's whole type: size, line height and weight from one place, so no two font sizes meet on one element. */
function typeStyle(r: Row): string {
  switch (r.type) {
    case "heading":
      return (r.attrs.level ?? 1) <= 1
        ? "text-2xl font-semibold text-ink"
        : r.attrs.level === 2
          ? "text-xl font-semibold text-ink"
          : "text-lg font-semibold text-ink";
    case "code":
      return "font-mono text-sm text-code-ink";
    case "quote":
      return "text-base text-muted";
    default:
      return r.type === "todo" && r.attrs.checked === true ? "text-base text-muted line-through" : "text-base text-ink";
  }
}

function Marked(props: { spans: readonly TextSpan[]; class: string }) {
  const look = (s: TextSpan) =>
    [
      s.marks.bold === true ? "font-semibold" : "",
      s.marks.italic === true ? "italic" : "",
      s.marks.code === true ? "font-mono" : "",
      s.marks.strike === true ? "line-through" : "",
      s.marks.link ? "text-water underline" : "",
    ].join(" ");
  return (
    <Text class={props.class}>
      {props.spans.map((s) =>
        s.marks.link ? (
          <Text role="link" class={look(s)} onPress={() => void hostApi.openUrl(s.marks.link ?? "")}>
            {s.t}
          </Text>
        ) : (
          <Text class={look(s)} style={s.marks.code === true ? { backgroundColor: tone("hover") } : undefined}>
            {s.t}
          </Text>
        ),
      )}
    </Text>
  );
}

/** A block's text: the marks drawn until it is pressed, then a plain field of its own. */
function BlockField(props: {
  editor: BlockEditor;
  row: Row;
  outline: boolean;
  hasOpenSuggestion: boolean;
  onPresence: (blockId: BlockId, start: number, end: number) => void;
  onBlurPresence: () => void;
}) {
  const editing = signal(false);
  // A block the editor asks to take the focus stays a box until it is left: the focus lands a frame later in the app
  // (a native field), and a drawing in between (the server's echo) no longer says it is wanted.
  effect(() => {
    if (props.row.wanted) editing.set(true);
  });
  // focused is the editor's live flag, read again when editing changes: the editor sets it without a new version.
  const shown = () => editing() || props.row.wanted || props.row.block.focused;
  return (
    <If
      when={shown()}
      else={
        <View
          role="button"
          testID="artifact-block-text"
          accessibilityLabel={t("web.artifact.blocks.block", { id: props.row.block.id })}
          onPress={() => editing.set(true)}
          class="min-h-6"
        >
          <If
            when={props.row.text}
            else={<Text class={`${typeStyle(props.row)} text-faint`}>{props.row.type === "heading" ? t("web.artifact.blocks.heading") : " "}</Text>}
          >
            <Marked spans={props.row.spans} class={typeStyle(props.row)} />
          </If>
        </View>
      }
    >
      <Field
        editor={props.editor}
        row={props.row}
        outline={props.outline}
        hasOpenSuggestion={props.hasOpenSuggestion}
        focusNow={editing() && !props.row.wanted}
        onPresence={props.onPresence}
        onBlurPresence={props.onBlurPresence}
        onLeave={() => editing.set(false)}
      />
    </If>
  );
}

function Field(props: {
  editor: BlockEditor;
  row: Row;
  outline: boolean;
  hasOpenSuggestion: boolean;
  focusNow: boolean;
  onPresence: (blockId: BlockId, start: number, end: number) => void;
  onBlurPresence: () => void;
  onLeave: () => void;
}) {
  let el: InputRef | undefined;
  const b = () => props.row.block;
  const sel = signal({ start: 0, end: 0 });
  const placed = signal<{ start: number } | undefined>(undefined);
  const height = signal(24);
  const focused = signal(false);
  // Pressed into: the field takes the focus once it is on the page, the caret at the end.
  const focusNow = untrack(() => props.focusNow);
  onSettled(() => {
    if (!focusNow) return;
    const end = untracked(() => props.row.text.length);
    placed.set({ start: end });
    sel.set({ start: end, end });
    el?.focus();
  });
  // The editor moved the text under the caret, or asked for this block to take the focus.
  createEffect(
    () => props.row,
    (row) => {
      if (row.wanted) {
        props.editor.focusId = undefined;
        queueMicrotask(() => el?.focus());
      }
      const block = row.block;
      if (block.caret !== undefined) {
        placed.set({ start: block.caret });
        sel.set({ start: block.caret, end: block.caret });
        block.caret = undefined;
      }
    },
  );
  effect(() => {
    if (!focused()) return;
    const { start, end } = sel();
    const offs: (() => void)[] = [];
    if (props.outline && !props.hasOpenSuggestion && !b().composing) {
      offs.push(keymap.bind("tab", () => props.editor.indent(b()), { when: "always" }));
      offs.push(keymap.bind("shift+tab", () => props.editor.outdent(b()), { when: "always" }));
    }
    if (start === end && !b().composing) {
      const go = (step: 1 | -1) => {
        const next = props.editor.neighbour(b(), step);
        if (next) props.editor.moveTo(next, step === -1 ? next.text.length : 0);
      };
      if (start === 0) offs.push(keymap.bind("up", () => go(-1), { when: "always" }));
      if (end === props.row.text.length) offs.push(keymap.bind("down", () => go(1), { when: "always" }));
    }
    return () => offs.forEach((off) => off());
  });
  return (
    <Input
      ref={(r) => (el = r)}
      multiline
      submitBehavior="newline"
      autoCorrect={false}
      autoCapitalize="none"
      testID="artifact-block-field"
      accessibilityLabel={t("web.artifact.blocks.block", { id: b().id })}
      value={props.row.text}
      selectedRange={placed()}
      placeholder={props.row.type === "heading" ? t("web.artifact.blocks.heading") : undefined}
      onFocus={() => {
        focused.set(true);
        props.editor.focus(b(), true);
        const cur = untracked(sel);
        props.onPresence(b().id, cur.start, cur.end);
      }}
      onBlur={() => {
        focused.set(false);
        props.editor.focus(b(), false);
        props.onBlurPresence();
        props.onLeave();
      }}
      onCompositionChange={(e) => {
        if (e.composing) b().composing = true;
        else props.editor.composition(b(), false, b().text);
      }}
      onChange={(e) => {
        const was = props.row.text;
        const at = Math.max(0, untracked(sel).start + (e.value.length - was.length));
        sel.set({ start: at, end: at });
        props.editor.edited(b(), e.value, at);
        props.onPresence(b().id, at, at);
      }}
      onSelectionChange={(e) => {
        sel.set({ start: e.start, end: e.end });
        if (untracked(focused)) props.onPresence(b().id, e.start, e.end);
      }}
      onKeyPress={(e) => {
        const { start, end } = untracked(sel);
        if (e.key === "Backspace" && start === 0 && end === 0 && !b().composing) props.editor.backspaceAtStart(b());
      }}
      onContentSizeChange={(e) => height.set(Math.max(24, e.size.height))}
      class={`w-full bg-transparent placeholder:text-faint ${typeStyle(props.row)}`}
      style={{ height: height() }}
    />
  );
}
