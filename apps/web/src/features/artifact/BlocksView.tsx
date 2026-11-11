import { type JSX, Portal } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Agent, type ArtifactId, userId, type Suggestion, type TextSpan } from "@vibevalley/protocol";

import { createExternal } from "#/base/external.ts";
import { api } from "#/infra/api.ts";
import { followArtifact, followSuggestions } from "#/infra/gateway.ts";
import { ready, useAgents } from "#/infra/query.ts";
import { createAct } from "#/ui/act.ts";
import { Checkbox } from "#/ui/Checkbox.tsx";
import { hexColor, swatches } from "#/ui/domain/cast.ts";
import { AgentFace } from "#/ui/domain/Face.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { styleProps } from "#/ui/positioner.ts";

import { knownTypes, plainOf } from "./blocks";
import { blockRow } from "./blocks.stylex";
import { BlockEditor, type EditBlock } from "./editor";

const blockStyles = stylex.create({
  row: {
    display: "flex",
    alignItems: "flex-start",
    paddingBottom: "0.125rem",
  },
  headingRow: {
    paddingTop: "0.625rem",
  },
  bodyRow: {
    paddingTop: "0.125rem",
  },
  content: {
    display: "flex",
    alignItems: "flex-start",
  },
  quote: {
    borderLeftStyle: "solid",
    borderLeftWidth: "3px",
    borderColor: "var(--wb-line)",
    paddingLeft: "0.75rem",
  },
  code: {
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--wb-code-bg)",
    paddingInline: "0.75rem",
    paddingBlock: "0.5rem",
    color: "var(--wb-code-ink)",
  },
  quoteButton: {
    marginTop: "0.125rem",
    marginLeft: "0.25rem",
    display: "inline-flex",
    width: "1.5rem",
    height: "1.5rem",
    flexShrink: "0",
    cursor: "pointer",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    color: "var(--wb-muted)",
    opacity: {
      default: "0",
      ":focus-visible": "1",
      "@media (hover: hover)": {
        default: null,
        [stylex.when.ancestor(":hover", blockRow)]: 1,
      },
    },
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
    },
  },
  title: {
    fontSize: "var(--text-2xl)",
    lineHeight: "2rem",
    fontWeight: "var(--font-weight-semibold)",
  },
  heading: {
    fontSize: "var(--text-xl)",
    lineHeight: "1.75rem",
    fontWeight: "var(--font-weight-semibold)",
  },
  subheading: {
    fontSize: "var(--text-lg)",
    lineHeight: "1.75rem",
    fontWeight: "var(--font-weight-semibold)",
  },
  codeText: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-sm)",
    lineHeight: "1.5rem",
  },
  quoteText: {
    fontSize: "var(--text-base)",
    lineHeight: "1.5rem",
    color: "var(--wb-muted)",
  },
  completeText: {
    fontSize: "var(--text-base)",
    lineHeight: "1.5rem",
    color: "var(--wb-muted)",
    textDecorationLine: "line-through",
  },
  bodyText: {
    fontSize: "var(--text-base)",
    lineHeight: "1.5rem",
  },
  bold: {
    fontWeight: "var(--font-weight-semibold)",
  },
  italic: {
    fontStyle: "italic",
  },
  inlineCode: {
    borderRadius: "var(--radius-xs)",
    backgroundColor: "var(--wb-hover)",
    paddingInline: "0.125rem",
    fontFamily: "var(--font-mono)",
  },
  strike: {
    textDecorationLine: "line-through",
  },
  link: {
    color: "var(--wb-water)",
    textDecorationLine: "underline",
  },
  field: {
    minHeight: "1.5rem",
    cursor: "text",
    overflowWrap: "break-word",
    whiteSpace: "pre-wrap",
  },
  editor: {
    display: "block",
    width: "100%",
    resize: "none",
    overflow: "hidden",
    backgroundColor: "transparent",
    outlineStyle: "none",
    "::placeholder": {
      color: "var(--wb-faint)",
    },
  },
});

const writingPulse = stylex.keyframes({ "50%": { opacity: 0.5 } });

const viewStyles = stylex.create({
  blockRowSpan: {
    marginTop: "0.125rem",
    marginRight: "0.625rem",
    flexShrink: "0",
    borderRadius: "var(--radius-sm)",
  },
  blockRowSpanPrimary: {
    width: "3px",
    animationName: null,
    animationDuration: null,
    animationDelay: null,
    animationTimingFunction: null,
    animationIterationCount: null,
    animationDirection: null,
    animationFillMode: null,
    animationPlayState: null,
  },
  blockRowSpanSecondary: {
    width: "0.25rem",
    animationName: { default: writingPulse, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "2s",
    animationDelay: "0s",
    animationTimingFunction: "cubic-bezier(.4, 0, .6, 1)",
    animationIterationCount: "infinite",
    animationDirection: "normal",
    animationFillMode: "none",
    animationPlayState: "running",
  },
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
    paddingBottom: "0.5rem",
    paddingLeft: "35px",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  blocksViewPTone: {
    color: "var(--color-berry)",
  },
  blocksViewPAlt: {
    color: "var(--color-muted)",
  },
  taskCheckbox: { marginTop: "0.25rem" },
  blocksViewDiv: {
    minHeight: "0",
    flex: "1",
    overflowY: "auto",
    paddingRight: "0.75rem",
  },
  artifactAppend: {
    display: "block",
    height: "4rem",
    width: "100%",
    cursor: "text",
    paddingLeft: "35px",
    textAlign: "left",
    fontSize: "var(--text-base)",
    lineHeight: "var(--leading-base)",
    color: "var(--color-faint)",
  },
  artifactSuggestions: {
    marginBottom: "0.5rem",
    flexShrink: "0",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    padding: "0.5rem",
  },
  suggestionsListH2: {
    paddingInline: "0.25rem",
    paddingBottom: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  artifactSuggestion: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
    borderTopStyle: {
      default: "solid",
      ":first-child": "solid",
    },
    borderTopWidth: {
      default: "1px",
      ":first-child": "0",
    },
    borderColor: "var(--color-line)",
    paddingInline: "0.25rem",
    paddingBlock: "0.375rem",
  },
  suggestionsListDiv: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
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
    marginLeft: "0.25rem",
  },
  suggestionsListP: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-berry)",
  },
  suggestionsListDiv2: {
    display: "flex",
    gap: "0.375rem",
  },
  suggestionAccept: {
    cursor: {
      default: "pointer",
      ":disabled": "default",
    },
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--color-leaf)",
    paddingInline: "0.5rem",
    paddingBlock: "0.125rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
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
    paddingInline: "0.5rem",
    paddingBlock: "0.125rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
    opacity: {
      default: null,
      ":disabled": ".5",
    },
  },
  suggestionDiffDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "0.125rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
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
    lineHeight: "var(--leading-sm)",
    color: "var(--color-berry)",
  },
  markSpan: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  blockRowSpan2: {
    width: "22px",
    flexShrink: "0",
    paddingTop: "3px",
  },
  blockRowSpan22: {
    flexShrink: "0",
  },
  blockRowDiv: {
    minWidth: "0",
    flex: "1",
  },
  blockRowHr: {
    marginBlock: "0.5rem",
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
    paddingInline: "0.625rem",
    paddingBlock: "0.375rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
  blockFieldSpan: {
    color: "var(--color-faint)",
  },
});

/** The user's lines on the attribution bar. */
const userColor = "var(--color-cream-300)";

/** Who wrote a block last, as the bar beside it shows. */
function authorColor(updatedBy: string, agent: Agent | undefined) {
  if (updatedBy === userId) return userColor;
  if (agent?.look.trim) return hexColor(agent.look.trim);
  let h = 0;
  for (let i = 0; i < updatedBy.length; i++) h = (h * 31 + updatedBy.charCodeAt(i)) & 0x7fffffff;
  const trim = swatches.trim[h % swatches.trim.length];
  return trim === undefined ? userColor : hexColor(trim);
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
      {...stylex.attrs(viewStyles.blocksViewArticle)}
    >
      <Show when={props.suggestionsAt} fallback={suggestionsList()}>
        {(at) => <Portal mount={at()}>{suggestionsList()}</Portal>}
      </Show>
      <p
        role="status"
        {...stylex.attrs(viewStyles.blocksViewP, (version(), editor.error !== undefined) ? viewStyles.blocksViewPTone : viewStyles.blocksViewPAlt)}
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
            const who = () => (s().author === userId ? t("web.artifact.blocks.user") : (agent()?.name ?? s().author));
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
  const writer = () => (r().updatedBy === userId ? t("web.artifact.blocks.user") : (props.agent?.name ?? r().updatedBy));
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
  const box = () => (r().type === "quote" ? blockStyles.quote : r().type === "code" ? blockStyles.code : undefined);
  const kind = () =>
    !knownTypes.has(r().type) ? "unknown" : r().type === "divider" ? "divider" : r().type === "image" ? "image" : r().type === "issue_ref" ? "issue" : "text";
  return (
    <div
      data-block={r().block.id}
      data-type={r().type}
      data-writing={r().writing ? "" : undefined}
      {...styleProps([blockRow, blockStyles.row, r().type === "heading" ? blockStyles.headingRow : blockStyles.bodyRow])}
    >
      <span {...stylex.attrs(viewStyles.blockRowSpan2)}>
        <Show when={r().showFace}>
          <AgentFace agentId={r().updatedBy} look={props.agent?.look} runtime={props.agent?.runtime} size={18} />
        </Show>
      </span>
      <span
        title={r().writing ? t("web.artifact.blocks.writing", { who: writer() }) : t("web.artifact.blocks.wrote", { who: writer() })}
        aria-label={r().writing ? t("web.artifact.blocks.writing", { who: writer() }) : undefined}
        {...stylex.attrs(viewStyles.blockRowSpan, r().writing ? viewStyles.blockRowSpanSecondary : viewStyles.blockRowSpanPrimary)}
        style={{ height: `${barHeight(r().type)}px`, background: authorColor(r().updatedBy, props.agent) }}
      />
      <span {...stylex.attrs(viewStyles.blockRowSpan22)} style={{ width: `${20 * r().depth}px` }} />
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
          <div {...styleProps([blockStyles.content, box()])}>
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
          {...styleProps(blockStyles.quoteButton)}
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
function typeStyle(r: Row): stylex.StyleXStyles {
  switch (r.type) {
    case "heading":
      return (r.attrs.level ?? 1) <= 1 ? blockStyles.title : r.attrs.level === 2 ? blockStyles.heading : blockStyles.subheading;
    case "code":
      return blockStyles.codeText;
    case "quote":
      return blockStyles.quoteText;
    default:
      return r.type === "todo" && r.attrs.checked === true ? blockStyles.completeText : blockStyles.bodyText;
  }
}

function Marked(props: { spans: readonly TextSpan[] }) {
  return (
    <For each={props.spans}>
      {(s) => {
        const styles: stylex.StyleXStyles = [
          s.marks.bold === true && blockStyles.bold,
          s.marks.italic === true && blockStyles.italic,
          s.marks.code === true && blockStyles.inlineCode,
          s.marks.strike === true && blockStyles.strike,
          !!s.marks.link && blockStyles.link,
        ];
        return (
          <Show when={s.marks.link} fallback={<span {...styleProps(styles)}>{s.t}</span>}>
            {(link) => (
              <a href={link()} target="_blank" rel="noreferrer" {...styleProps(styles)}>
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
          {...styleProps([blockStyles.field, typeStyle(props.row)])}
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
      {...styleProps([blockStyles.editor, typeStyle(props.row)])}
    />
  );
}
