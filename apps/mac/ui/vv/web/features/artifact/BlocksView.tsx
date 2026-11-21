// Ported from VibeValley apps/web/src/features/artifact/BlocksView.tsx: a
// blocks artifact written together: each block's author bar and face, the
// marks drawn until a block is pressed, then a box of its own; open
// suggestions to take or turn down; VibeValley's BlockEditor (vendored,
// packages/artifact/src/editor.ts) does the rest.
//
// The box is nsh/base's multiline Input. Return types a line break, which
// the editor turns into a new block (code keeps it); Backspace at the start
// is read from onKeyPress; ↑ at the start and ↓ at the end are keymap
// bindings held only while the caret is there. Not here: the suggestions
// put into the page's side panel with a Portal; `onRail` hands the page the
// list to draw there instead.
import { effect, keymap, signal, Scroll, Text, untracked, View, type InputRef, type JSX } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import { type Agent, type ArtifactId, userId, type Suggestion, type TextSpan } from "@vibevalley/protocol";
import { blockId as brandBlockId } from "@vibevalley/protocol/schema";

import { hostApi } from "../../../../bridge";
import { createEffect, createMemo, createSignal, onSettled, untrack } from "../../../solid";
import { createExternal } from "../../base/external";
import { api } from "../../infra/api";
import { followArtifact, followSuggestions } from "../../infra/gateway";
import { ready, useAgents } from "../../infra/query";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { Checkbox } from "../../ui/Checkbox";
import { hexColor, swatches } from "../../ui/domain/cast";
import { AgentFace } from "../../ui/domain/Face";
import { Icon } from "../../ui/Icon";
import type { IconName } from "../../ui/icons";
import { CountPill } from "../../ui/Tag";
import { Bubble } from "../../ui/Tip";
import { tone } from "../../ui/tone";
import { knownTypes, plainOf } from "./blocks";
import { BlockEditor, type EditBlock } from "./editor";
import { useReportViewContext } from "./store";

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
  useReportViewContext(
    () => props.id,
    () => {
      version();
      const focused = editor.focusId;
      return {
        artifactType: "docs",
        title: editor.artifact?.title ?? "",
        ...(editor.artifact?.seq !== undefined ? { seq: editor.artifact.seq } : {}),
        ...(focused ? { selectedBlockIds: [brandBlockId(focused)] } : {}),
      };
    },
  );
  const all = useAgents();
  const agents = createMemo(() => new Map(ready(all, []).map((a) => [a.id, a])));
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
      <View class="min-h-5 flex-row items-center gap-1.5 pb-2 pl-8.75">
        <If when={(version(), editor.error !== undefined)}>
          <View class="size-1.5 shrink-0 rounded-full bg-berry" />
        </If>
        <If when={(version(), editor.error === undefined && (editor.busy || editor.othersWriting))}>
          <View class="size-1.5 shrink-0 rounded-full bg-wheat" />
        </If>
        <Text class={`truncate text-xs tabular-nums ${(version(), editor.error !== undefined) ? "font-medium text-berry" : "text-muted"}`}>
          {(version(), editor.blocks.length > 0 || editor.busy || editor.error !== undefined) ? status() : ""}
        </Text>
      </View>
      <Scroll class="min-h-0 flex-1" contentClass="pr-3">
        <Each of={rows()} key={(r) => r.block.id}>
          {(row) => <BlockRow editor={editor} row={row()} agent={agents().get(row().updatedBy)} onQuote={props.onQuote} />}
        </Each>
        {/* Below the last block: a press starts a new paragraph. */}
        <View
          role="button"
          testID="artifact-append"
          accessibilityLabel={t("web.artifact.blocks.append")}
          onPress={() => editor.append()}
          class="h-16 w-full pt-1.5 pl-8.75"
        >
          <Text class="text-base text-faint">{(version(), editor.blocks.length === 0 && !editor.busy) ? t("web.artifact.blocks.start") : ""}</Text>
        </View>
      </Scroll>
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
            const stale = () => {
              const b = block();
              return b === undefined || b.rev !== s().baseRev;
            };
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
              <If when={(props.block?.text ?? "") !== ""}>
                <Text class="text-xs text-muted line-through">{props.block?.text ?? ""}</Text>
              </If>
              <Text class="text-xs font-medium text-ok-ink">{plainOf(change().text ?? [])}</Text>
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

function BlockRow(props: { editor: BlockEditor; row: Row; agent?: Agent | undefined; onQuote?: ((block: QuoteTarget) => void) | undefined }) {
  const r = () => props.row;
  const writer = () => (r().updatedBy === userId ? t("web.artifact.blocks.user") : (props.agent?.name ?? r().updatedBy));
  const mark = (): JSX.Element | undefined => {
    switch (r().type) {
      case "bulleted":
        return <Text class="text-base text-muted">•</Text>;
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
  return (
    <View
      testID="artifact-block"
      accessibilityLabel={r().block.id}
      accessibilityValue={{ text: r().type }}
      class={`group flex-row items-start pb-0.5 ${r().type === "heading" ? "pt-2.5" : "pt-0.5"}`}
    >
      <View class="w-5.5 shrink-0 pt-0.75">
        <If when={r().showFace}>
          <AgentFace agentId={r().updatedBy} look={props.agent?.look} runtime={props.agent?.runtime} size={18} />
        </If>
      </View>
      <View
        testID="artifact-author-bar"
        tooltip={<Bubble text={authorTip()} />}
        accessibilityLabel={r().writing ? t("web.artifact.blocks.writing", { who: writer() }) : undefined}
        class={`mt-0.5 mr-2.5 shrink-0 rounded-sm transition duration-120 ease-out ${r().writing ? "w-1 animate-pulse" : "w-0.75"}`}
        style={{ height: barHeight(r().type), backgroundColor: authorColor(r().updatedBy, props.agent) }}
      />
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
              <BlockField editor={props.editor} row={r()} />
            </View>
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
          class="mt-0.5 ml-1 size-6 shrink-0 items-center justify-center rounded-md opacity-0 transition duration-120 ease-out group-hover:opacity-100 hover:bg-hover focus:opacity-100 focus-visible:outline-2 focus-visible:outline-focus"
        >
          <Icon name="chat" size={14} tone="muted" />
        </View>
      </If>
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
function BlockField(props: { editor: BlockEditor; row: Row }) {
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
      <Field editor={props.editor} row={props.row} focusNow={editing() && !props.row.wanted} onLeave={() => editing.set(false)} />
    </If>
  );
}

function Field(props: { editor: BlockEditor; row: Row; focusNow: boolean; onLeave: () => void }) {
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
  // ↑ at the start and ↓ at the end go to the block before or after; elsewhere the input moves the caret itself.
  effect(() => {
    if (!focused()) return;
    const { start, end } = sel();
    if (start !== end || b().composing) return;
    const offs: (() => void)[] = [];
    const go = (step: 1 | -1) => {
      const next = props.editor.neighbour(b(), step);
      if (next) props.editor.moveTo(next, step === -1 ? next.text.length : 0);
    };
    if (start === 0) offs.push(keymap.bind("up", () => go(-1), { when: "always" }));
    if (end === props.row.text.length) offs.push(keymap.bind("down", () => go(1), { when: "always" }));
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
      }}
      onBlur={() => {
        focused.set(false);
        props.editor.focus(b(), false);
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
      }}
      onSelectionChange={(e) => sel.set({ start: e.start, end: e.end })}
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
