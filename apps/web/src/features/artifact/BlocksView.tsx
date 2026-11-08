import { type JSX, Portal } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Agent, type ArtifactId, ownerId, type Suggestion, type TextSpan } from "@vibevalley/protocol";

import { createExternal } from "#/base/external.ts";
import { api } from "#/infra/api.ts";
import { followArtifact, followSuggestions } from "#/infra/gateway.ts";
import { ready, useAgents } from "#/infra/query.ts";
import { createAct } from "#/ui/act.ts";
import { hexColor, swatches } from "#/ui/cast.ts";
import { Checkbox } from "#/ui/Checkbox.tsx";
import { AgentFace } from "#/ui/Face.tsx";
import { Icon } from "#/ui/Icon.tsx";

import { knownTypes, plainOf } from "./blocks";
import { BlockEditor, type EditBlock } from "./editor";

const variantStyles = stylex.create({
  blocksViewArticle: {
    display: "flex",
    minHeight: "0",
    flex: "1",
    flexDirection: "column",
  },
  blocksViewP: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    paddingBottom: "calc(var(--spacing) * 2)",
    paddingLeft: "35px",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  blocksViewPVariant: {
    color: "var(--color-berry)",
  },
  blocksViewPVariant2: {
    color: "var(--color-muted)",
  },
});

const viewStyles = stylex.create({
  taskCheckbox: { marginTop: "var(--spacing)" },
  blocksViewDiv: {
    minHeight: "0",
    flex: "1",
    overflowY: "auto",
    paddingRight: "calc(var(--spacing) * 3)",
  },
  artifactAppend: {
    display: "block",
    height: "calc(var(--spacing) * 16)",
    width: "100%",
    cursor: "text",
    paddingLeft: "35px",
    textAlign: "left",
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
    color: "var(--color-faint)",
  },
  artifactSuggestions: {
    marginBottom: "calc(var(--spacing) * 2)",
    flexShrink: "0",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    padding: "calc(var(--spacing) * 2)",
  },
  suggestionsListH2: {
    paddingInline: "var(--spacing)",
    paddingBottom: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  artifactSuggestion: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--spacing)",
    borderTopStyle: {
      default: "solid",
      ":first-child": "solid",
    },
    borderTopWidth: {
      default: "1px",
      ":first-child": "0",
    },
    borderColor: "var(--color-line)",
    paddingInline: "var(--spacing)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
  },
  suggestionsListDiv: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  suggestionsListSpan: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  suggestionsListSpan2: {
    marginLeft: "var(--spacing)",
  },
  suggestionsListP: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-berry)",
  },
  suggestionsListDiv2: {
    display: "flex",
    gap: "calc(var(--spacing) * 1.5)",
  },
  suggestionAccept: {
    cursor: {
      default: "pointer",
      ":disabled": "default",
    },
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--color-leaf)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * .5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-page)",
    opacity: {
      default: null,
      ":disabled": ".5",
    },
  },
  suggestionReject: {
    cursor: {
      default: "pointer",
      ":disabled": "default",
    },
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--color-hover)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * .5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
    opacity: {
      default: null,
      ":disabled": ".5",
    },
  },
  suggestionDiffDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * .5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  suggestionDiffP: {
    whiteSpace: "pre-wrap",
    color: "var(--color-muted)",
    textDecorationLine: "line-through",
  },
  suggestionDiffP2: {
    whiteSpace: "pre-wrap",
    color: "var(--color-leaf)",
  },
  suggestionDiffP3: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-berry)",
  },
  markSpan: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  blockRowSpan: {
    width: "22px",
    flexShrink: "0",
    paddingTop: "3px",
  },
  blockRowSpan2: {
    flexShrink: "0",
  },
  blockRowDiv: {
    minWidth: "0",
    flex: "1",
  },
  blockRowHr: {
    marginBlock: "calc(var(--spacing) * 2)",
    borderColor: "var(--color-line)",
  },
  blockRowSpan3: {
    width: "26px",
    flexShrink: "0",
    paddingTop: "1px",
  },
  placeholderDiv: {
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--color-hover)",
    paddingInline: "calc(var(--spacing) * 2.5)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
  blockFieldSpan: {
    color: "var(--color-faint)",
  },
});

/** The owner's lines on the attribution bar. */
const ownerColor = "#c8a46e";

/** Who wrote a block last, as the bar beside it shows. */
function authorColor(updatedBy: string, agent: Agent | undefined) {
  if (updatedBy === ownerId) return ownerColor;
  if (agent?.look.trim) return hexColor(agent.look.trim);
  let h = 0;
  for (let i = 0; i < updatedBy.length; i++) h = (h * 31 + updatedBy.charCodeAt(i)) & 0x7fffffff;
  const trim = swatches.trim[h % swatches.trim.length];
  return trim === undefined ? ownerColor : hexColor(trim);
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

/** Keyed by the id by its caller: one editor for the page's life, handed to onEditor for what the page's menu does with it. */
export interface QuoteTarget {
  readonly id: string;
  readonly rev: number;
  readonly type: string;
  readonly text: string;
}

/** suggestionsAt: where the open suggestions are drawn (the artifacts page's side panel); without it, above the blocks. */
export function BlocksView(props: {
  id: ArtifactId;
  onEditor?: (editor: BlockEditor) => void;
  onQuote?: ((block: QuoteTarget) => void) | undefined;
  suggestionsAt?: HTMLElement | undefined;
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
    let stopSuggestions: (() => void) | undefined;
    stopSuggestions = followSuggestions(String(props.id), (e) => setSuggestions(e.suggestions));
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
      stopSuggestions?.();
      editor.dispose();
    };
  });
  // The editor changes its blocks in place and bumps its version; each version is drawn as fresh rows, matched by id.
  const version = createExternal(editor.subscribe, () => editor.version);
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
        showFace: writing || (b.updatedBy !== ownerId && b.updatedBy !== lastAuthor),
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
      blocks={editor.blocks}
      agents={agents()}
      working={working()}
      onAccept={(suggestion) => void resolve(suggestion, true)}
      onReject={(suggestion) => void resolve(suggestion, false)}
    />
  );
  return (
    <article
      aria-label={(version(), editor.artifact?.title) ?? ""}
      data-testid="artifact-blocks"
      data-key={props.id}
      data-state={(version(), editor.error ? "error" : editor.busy ? "saving" : "saved")}
      data-blocks={(version(), editor.blocks.length)}
      data-writing={(version(), editor.othersWriting) ? "" : undefined}
      {...stylex.attrs(variantStyles.blocksViewArticle)}
    >
      <Show when={props.suggestionsAt} fallback={suggestionsList()}>
        {(at) => <Portal mount={at()}>{suggestionsList()}</Portal>}
      </Show>
      <p
        role="status"
        {...stylex.attrs(
          variantStyles.blocksViewP,
          (version(), editor.error !== undefined) ? variantStyles.blocksViewPVariant : variantStyles.blocksViewPVariant2,
        )}
      >
        {(version(), editor.blocks.length > 0 || editor.busy || editor.error !== undefined) ? status() : ""}
      </p>
      <div {...stylex.attrs(viewStyles.blocksViewDiv)}>
        <For each={rows()} keyed={(r) => r.block.id}>
          {(row) => <BlockRow editor={editor} row={row()} agent={agents().get(row().updatedBy)} onQuote={props.onQuote} />}
        </For>
        {/* Below the last block: a click starts a new paragraph. */}
        <button
          type="button"
          data-testid="artifact-append"
          aria-label={t("web.artifact.blocks.append")}
          {...stylex.attrs(viewStyles.artifactAppend)}
          onClick={() => editor.append()}
        >
          {(version(), editor.blocks.length === 0 && !editor.busy) ? t("web.artifact.blocks.start") : ""}
        </button>
      </div>
    </article>
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
    <Show when={open().length > 0}>
      <section data-testid="artifact-suggestions" {...stylex.attrs(viewStyles.artifactSuggestions)}>
        <h2 {...stylex.attrs(viewStyles.suggestionsListH2)}>{t("web.artifact.suggestions.title", { n: open().length })}</h2>
        <For each={open()} keyed={(s) => s.id}>
          {(s) => {
            const block = () => props.blocks.find((b) => b.id === s().blockId);
            const stale = () => {
              const b = block();
              return b === undefined || b.rev !== s().baseRev;
            };
            const agent = () => props.agents.get(s().author);
            const who = () => (s().author === ownerId ? t("web.artifact.blocks.owner") : (agent()?.name ?? s().author));
            const changeKind = () =>
              s().change.delete === true ? "delete" : s().change.type !== undefined ? "type" : s().change.attrs !== undefined ? "attrs" : "text";
            return (
              <article
                data-testid="artifact-suggestion"
                data-key={s().id}
                data-status={stale() ? "stale" : "open"}
                data-change={changeKind()}
                {...stylex.attrs(viewStyles.artifactSuggestion)}
              >
                <div {...stylex.attrs(viewStyles.suggestionsListDiv)}>
                  <AgentFace agentId={s().author} look={agent()?.look} runtime={agent()?.runtime} size={16} />
                  <span {...stylex.attrs(viewStyles.suggestionsListSpan)}>
                    {t("web.artifact.suggestions.by", { name: who() })}
                    <span {...stylex.attrs(viewStyles.suggestionsListSpan2)}>{t("web.artifact.suggestions.rev", { rev: s().baseRev })}</span>
                  </span>
                </div>
                <SuggestionDiff suggestion={s()} block={block()} />
                <Show when={stale()}>
                  <p {...stylex.attrs(viewStyles.suggestionsListP)}>{t("web.artifact.suggestions.stale")}</p>
                </Show>
                <div {...stylex.attrs(viewStyles.suggestionsListDiv2)}>
                  <button
                    type="button"
                    data-testid="suggestion-accept"
                    disabled={stale() || props.working === s().id}
                    {...stylex.attrs(viewStyles.suggestionAccept)}
                    onClick={() => props.onAccept(s())}
                  >
                    {t("web.artifact.suggestions.accept")}
                  </button>
                  <button
                    type="button"
                    data-testid="suggestion-reject"
                    disabled={props.working === s().id}
                    {...stylex.attrs(viewStyles.suggestionReject)}
                    onClick={() => props.onReject(s())}
                  >
                    {t("web.artifact.suggestions.reject")}
                  </button>
                </div>
              </article>
            );
          }}
        </For>
      </section>
    </Show>
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
    <Show
      when={change().delete === true}
      fallback={
        <div {...stylex.attrs(viewStyles.suggestionDiffDiv)}>
          <Show when={change().type !== undefined}>
            <p>{t("web.artifact.suggestions.type", { type: typeName(change().type ?? "") })}</p>
          </Show>
          <Show when={change().attrs !== undefined}>
            <p>{t("web.artifact.suggestions.attrs", { attrs: attrText(change().attrs ?? {}) })}</p>
          </Show>
          <Show when={change().text !== undefined}>
            <p {...stylex.attrs(viewStyles.suggestionDiffP)}>{props.block?.text ?? ""}</p>
            <p {...stylex.attrs(viewStyles.suggestionDiffP2)}>{plainOf(change().text ?? [])}</p>
          </Show>
        </div>
      }
    >
      <p {...stylex.attrs(viewStyles.suggestionDiffP3)}>{t("web.artifact.suggestions.delete")}</p>
    </Show>
  );
}

const barHeight = (type: string) => (type === "divider" ? 16 : type === "heading" ? 28 : 20);

function BlockRow(props: { editor: BlockEditor; row: Row; agent?: Agent | undefined; onQuote?: ((block: QuoteTarget) => void) | undefined }) {
  const r = () => props.row;
  const writer = () => (r().updatedBy === ownerId ? t("web.artifact.blocks.owner") : (props.agent?.name ?? r().updatedBy));
  const mark = (): JSX.Element | undefined => {
    switch (r().type) {
      case "bulleted":
        return "•";
      case "numbered":
        return `${r().number ?? 1}.`;
      case "memory_item":
        return <span {...stylex.attrs(viewStyles.markSpan)}>{t("web.artifact.blocks.memoryItem")}</span>;
      case "todo":
        return (
          <Checkbox
            styles={viewStyles.taskCheckbox}
            checked={r().attrs.checked ?? false}
            label={r().attrs.checked === true ? t("web.artifact.blocks.done") : t("web.artifact.blocks.notDone")}
            onChange={() => props.editor.toggle(r().block)}
          />
        );
      default:
        return undefined;
    }
  };
  const box = () => (r().type === "quote" ? "border-l-[3px] border-line pl-3" : r().type === "code" ? "rounded-md bg-code-bg px-3 py-2 text-code-ink" : "");
  const kind = () =>
    !knownTypes.has(r().type) ? "unknown" : r().type === "divider" ? "divider" : r().type === "image" ? "image" : r().type === "issue_ref" ? "issue" : "text";
  return (
    <div
      data-block={r().block.id}
      data-type={r().type}
      data-writing={r().writing ? "" : undefined}
      class={["group/row flex items-start pb-0.5", r().type === "heading" ? "pt-2.5" : "pt-0.5"]}
    >
      <span {...stylex.attrs(viewStyles.blockRowSpan)}>
        <Show when={r().showFace}>
          <AgentFace agentId={r().updatedBy} look={props.agent?.look} runtime={props.agent?.runtime} size={18} />
        </Show>
      </span>
      <span
        title={r().writing ? t("web.artifact.blocks.writing", { who: writer() }) : t("web.artifact.blocks.wrote", { who: writer() })}
        aria-label={r().writing ? t("web.artifact.blocks.writing", { who: writer() }) : undefined}
        class={["mt-0.5 mr-2.5 shrink-0 rounded-sm", r().writing ? "w-1 animate-pulse" : "w-[3px]"]}
        style={{ height: `${barHeight(r().type)}px`, background: authorColor(r().updatedBy, props.agent) }}
      />
      <span {...stylex.attrs(viewStyles.blockRowSpan2)} style={{ width: `${20 * r().depth}px` }} />
      <div {...stylex.attrs(viewStyles.blockRowDiv)}>
        {/* One shape for every text block: a block that changes type keeps its field, and the field its focus. */}
        <Show
          when={kind() === "text"}
          fallback={
            <Show when={kind() !== "divider"} fallback={<hr {...stylex.attrs(viewStyles.blockRowHr)} />}>
              <Placeholder
                text={
                  kind() === "image"
                    ? t("web.artifact.blocks.image", { alt: r().attrs.alt ?? "", src: r().attrs.src ?? "" }).trim()
                    : kind() === "issue"
                      ? t("web.artifact.blocks.issue", { id: r().attrs.issueId ?? "" })
                      : t("web.artifact.blocks.unknown", { type: r().type })
                }
              />
            </Show>
          }
        >
          <div class={["flex items-start", box()]}>
            <Show when={mark() !== undefined}>
              <span {...stylex.attrs(viewStyles.blockRowSpan3)}>{mark()}</span>
            </Show>
            <div {...stylex.attrs(viewStyles.blockRowDiv)}>
              <BlockField editor={props.editor} row={r()} />
            </div>
          </div>
        </Show>
        <Show when={r().problem}>
          <p {...stylex.attrs(viewStyles.suggestionsListP)}>{r().problem}</p>
        </Show>
      </div>
      <Show when={props.onQuote}>
        <button
          type="button"
          data-testid="artifact-quote-block"
          aria-label={t("web.artifact.canvas.quote")}
          title={t("web.artifact.canvas.quote")}
          class="mt-0.5 ml-1 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted opacity-0 group-hover/row:opacity-100 hover:bg-hover focus-visible:opacity-100"
          onClick={() => props.onQuote?.({ id: r().block.id, rev: r().block.rev, type: r().type, text: r().text })}
        >
          <Icon name="chat" size={14} />
        </button>
      </Show>
    </div>
  );
}

function Placeholder(props: { text: string }) {
  return <div {...stylex.attrs(viewStyles.placeholderDiv)}>{props.text}</div>;
}

/** A block's whole type: size, line height and weight from one place, so no two font sizes meet on one element. */
function typeStyle(r: Row) {
  switch (r.type) {
    case "heading":
      return (r.attrs.level ?? 1) <= 1
        ? "text-2xl leading-8 font-semibold"
        : r.attrs.level === 2
          ? "text-xl leading-7 font-semibold"
          : "text-lg leading-7 font-semibold";
    case "code":
      return "font-mono text-sm leading-6";
    case "quote":
      return "text-base leading-6 text-muted";
    default:
      return r.type === "todo" && r.attrs.checked === true ? "text-base leading-6 text-muted line-through" : "text-base leading-6";
  }
}

function Marked(props: { spans: readonly TextSpan[] }) {
  return (
    <For each={props.spans}>
      {(s) => {
        const cls = {
          "font-semibold": !(s.marks.bold !== true),
          italic: !(s.marks.italic !== true),
          "rounded-xs bg-hover px-0.5 font-mono": !(s.marks.code !== true),
          "line-through": !(s.marks.strike !== true),
          "text-water underline": !!s.marks.link,
        };
        return (
          <Show when={s.marks.link} fallback={<span class={cls}>{s.t}</span>}>
            {(link) => (
              <a href={link()} target="_blank" rel="noreferrer" class={cls}>
                {s.t}
              </a>
            )}
          </Show>
        );
      }}
    </For>
  );
}

/** A block's text: the marks drawn until it is clicked into, then a plain field of its own. */
function BlockField(props: { editor: BlockEditor; row: Row }) {
  const [editing, setEditing] = createSignal(false);
  // focused is the editor's live flag, read again when editing changes: the editor sets it without a new version.
  const shown = () => editing() || props.row.wanted || props.row.block.focused;
  return (
    <Show
      when={shown()}
      fallback={
        <div
          role="textbox"
          tabindex={0}
          aria-label={t("web.artifact.blocks.block", { id: props.row.block.id })}
          onFocus={() => setEditing(true)}
          onClick={() => setEditing(true)}
          class={["min-h-6 cursor-text break-words whitespace-pre-wrap", typeStyle(props.row)]}
        >
          <Show
            when={props.row.text}
            fallback={<span {...stylex.attrs(viewStyles.blockFieldSpan)}>{props.row.type === "heading" ? t("web.artifact.blocks.heading") : " "}</span>}
          >
            <Marked spans={props.row.spans} />
          </Show>
        </div>
      }
    >
      <Field editor={props.editor} row={props.row} focusNow={editing() && !props.row.wanted} onLeave={() => setEditing(false)} />
    </Show>
  );
}

function Field(props: { editor: BlockEditor; row: Row; focusNow: boolean; onLeave: () => void }) {
  let el!: HTMLTextAreaElement;
  const b = () => props.row.block;
  // Clicked into: the field takes the focus once it is on the page.
  const focusNow = untrack(() => props.focusNow);
  onSettled(() => {
    if (focusNow) el.focus();
  });
  // The editor moved the text under the caret, or asked for this block to take the focus.
  createEffect(
    () => props.row,
    (row) => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
      if (row.wanted) {
        props.editor.focusId = undefined;
        el.focus();
      }
      const block = row.block;
      if (block.caret !== undefined && document.activeElement === el) {
        el.setSelectionRange(block.caret, block.caret);
        block.caret = undefined;
      }
    },
  );
  const key = (e: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) => {
    const field = e.currentTarget;
    const block = b();
    if (block.composing || e.isComposing || field.selectionStart !== field.selectionEnd) return;
    const at = field.selectionStart;
    if (e.key === "Backspace" && at === 0) {
      e.preventDefault();
      props.editor.backspaceAtStart(block);
    } else if ((e.key === "ArrowUp" && at === 0) || (e.key === "ArrowDown" && at === field.value.length)) {
      const next = props.editor.neighbour(block, e.key === "ArrowUp" ? -1 : 1);
      if (!next) return;
      e.preventDefault();
      props.editor.moveTo(next, e.key === "ArrowUp" ? next.text.length : 0);
    }
  };
  return (
    <textarea
      ref={(t) => (el = t)}
      aria-label={t("web.artifact.blocks.block", { id: b().id })}
      rows={1}
      value={props.row.text}
      placeholder={props.row.type === "heading" ? t("web.artifact.blocks.heading") : undefined}
      spellcheck="false"
      onFocus={() => props.editor.focus(b(), true)}
      onBlur={() => {
        props.editor.focus(b(), false);
        props.onLeave();
      }}
      onCompositionStart={() => (b().composing = true)}
      onCompositionEnd={(e) => props.editor.composition(b(), false, e.currentTarget.value)}
      onInput={(e) => props.editor.edited(b(), e.currentTarget.value, e.currentTarget.selectionStart)}
      onKeyDown={key}
      class={["block w-full resize-none overflow-hidden bg-transparent outline-none placeholder:text-faint", typeStyle(props.row)]}
    />
  );
}
