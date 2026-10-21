// 文档: the documents on the left, the one open on the right, written block by block with the
// helpers. A block shows its marks until it is clicked into; then it is a plain field (marks are kept through the edit),
// and Enter splits it, Backspace at its start joins it to the one before, Up and Down at its ends move between blocks.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate, useParams } from "react-router";
import {
  type Agent,
  blockBulleted,
  blockCode,
  blockDivider,
  blockHeading,
  blockImage,
  blockIssueRef,
  blockMemoryItem,
  blockNumbered,
  blockQuote,
  blockTodo,
  type DocSpan,
  docOwner,
} from "@vibevalley/protocol";
import { useAgents } from "../../data/agents";
import { api, reasonOf } from "../../data/api";
import { hexColor, swatches } from "../../rules/cast";
import { knownTypes } from "../../rules/docBlocks";
import { Button } from "../../ui/Button";
import { AgentFace } from "../../ui/Face";
import { Icon } from "../../ui/Icon";
import { TextInput } from "../../ui/Field";
import { DocEditor, type EditBlock } from "./editor";

const docPath = (id?: string) => (id === undefined ? "/docs" : `/docs/${encodeURIComponent(id)}`);

/** The owner's lines on the attribution bar. */
const ownerColor = "#c8a46e";

/** Who wrote a block last, as the bar beside it shows: the owner's colour, or the helper's (its look's trim, else a colour
 * picked from its id, the same every time). */
function authorColor(updatedBy: string, agent: Agent | undefined) {
  if (updatedBy === docOwner) return ownerColor;
  if (agent?.look.trim) return hexColor(agent.look.trim);
  let h = 0;
  for (let i = 0; i < updatedBy.length; i++) h = (h * 31 + updatedBy.charCodeAt(i)) & 0x7fffffff;
  return hexColor(swatches.trim[h % swatches.trim.length]!);
}

export function DocsPage() {
  const id = useParams()["*"] || undefined;
  const navigate = useNavigate();
  const client = useQueryClient();
  const [title, setTitle] = useState("");
  const [problem, setProblem] = useState<string>();
  const docs = useQuery({ queryKey: ["docs"], queryFn: () => api.doc.list() });
  const list = docs.data ?? [];
  const open = (id && decodeURIComponent(id)) || list[0]?.id;
  const create = async () => {
    try {
      const made = await api.doc.create({ body: { title } });
      setTitle("");
      setProblem(undefined);
      await client.invalidateQueries({ queryKey: ["docs"] });
      void navigate(docPath(made.doc.id));
    } catch (e) {
      setProblem(reasonOf(e));
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 lg:flex-row">
      <nav
        aria-label="文档列表"
        className={`${id ? "hidden lg:flex" : "flex"} shrink-0 flex-col gap-2 rounded-lg border border-line bg-page p-2 lg:w-65 lg:overflow-y-auto`}
      >
        <h2 className="px-2 pt-1.5 text-base font-semibold">文档</h2>
        <form
          className="flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <TextInput aria-label="新文档的标题" placeholder="新文档的标题" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Button type="submit" tone="primary" icon="button-add">
            新文档
          </Button>
        </form>
        {(problem || docs.error) && <p className="px-2 text-xs text-berry">{problem ?? reasonOf(docs.error)}</p>}
        {docs.data && list.length === 0 && <p className="px-2 text-xs text-muted">还没有文档。写个标题，点「新文档」。</p>}
        <ul className="flex flex-col gap-0.5">
          {list.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                aria-current={d.id === open ? "page" : undefined}
                onClick={() => navigate(docPath(d.id))}
                className={`w-full cursor-pointer truncate rounded-md px-2 py-1.5 text-left text-sm font-medium ${d.id === open ? "bg-selected" : "hover:bg-hover"}`}
              >
                {d.title}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className={`${id ? "flex" : "hidden lg:flex"} min-h-0 min-w-0 flex-1 flex-col gap-2`}>
        {id && (
          <div className="lg:hidden">
            <Button icon="button-back" onClick={() => navigate(docPath())}>
              全部文档
            </Button>
          </div>
        )}
        {open && <DocView key={open} id={open} />}
      </div>
    </div>
  );
}

function useEditor(id: string) {
  const [editor] = useState(() => new DocEditor(api, id));
  useEffect(() => {
    void editor.load();
    return () => editor.dispose();
  }, [editor]);
  useSyncExternalStore(editor.subscribe, () => editor.version);
  return editor;
}

function DocView({ id }: { id: string }) {
  const editor = useEditor(id);
  const agents = new Map((useAgents().data ?? []).map((a) => [a.id, a]));
  const numbers = editor.numbers;
  let lastAuthor: string | undefined;
  const status =
    editor.error ?? (editor.busy ? "在存……" : ["都存好了", `${editor.blocks.length} 块`, ...(editor.othersWriting ? ["帮工在写"] : [])].join(" · "));
  return (
    <article aria-label={editor.doc?.title ?? "文档"} className="flex min-h-0 flex-1 flex-col rounded-lg border border-line bg-page pt-4 pr-5 pb-2 pl-2">
      <div className="flex items-start gap-2 pb-1 pl-[35px]">
        <h1 className="min-w-0 flex-1 text-2xl font-semibold">{editor.doc?.title ?? ""}</h1>
        <Button icon="button-play" onClick={() => void editor.demo()}>
          演示：几个帮工一起写
        </Button>
      </div>
      <p role="status" className={`pb-3 pl-[35px] text-xs ${editor.error ? "text-berry" : "text-muted"}`}>
        {status}
      </p>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {editor.blocks.map((b) => {
          const writing = editor.writing(b);
          const row = (
            <BlockRow
              key={b.id}
              editor={editor}
              block={b}
              depth={editor.depthOf(b)}
              number={numbers.get(b.id)}
              agent={agents.get(b.updatedBy)}
              showFace={writing || (b.updatedBy !== docOwner && b.updatedBy !== lastAuthor)}
              writing={writing}
            />
          );
          lastAuthor = b.updatedBy;
          return row;
        })}
        {/* Below the last block: a click starts a new paragraph. */}
        <button type="button" aria-label="在末尾写一段" className="block h-16 w-full cursor-text" onClick={() => editor.append()} />
      </div>
    </article>
  );
}

const barHeight = (type: string) => (type === blockDivider ? 16 : type === blockHeading ? 28 : 20);

function BlockRow({
  editor,
  block: b,
  depth,
  number,
  agent,
  showFace,
  writing,
}: {
  editor: DocEditor;
  block: EditBlock;
  depth: number;
  number?: number;
  agent?: Agent;
  showFace: boolean;
  writing: boolean;
}) {
  const writer = b.updatedBy === docOwner ? "主人" : (agent?.name ?? b.updatedBy);
  let body;
  if (!knownTypes.has(b.type)) body = <Placeholder text={`这一块是「${b.type}」，这个版本的客户端还画不了，只能看不能改`} />;
  else if (b.type === blockDivider) body = <hr className="my-2 border-line" />;
  else if (b.type === blockImage) body = <Placeholder text={`图片：${b.attrs.alt ?? ""} ${b.attrs.src ?? ""}`.trim()} />;
  else if (b.type === blockIssueRef) body = <Placeholder text={`工单 ${b.attrs.issueId ?? ""}`} />;
  else {
    const mark =
      b.type === blockBulleted ? (
        "•"
      ) : b.type === blockNumbered ? (
        `${number ?? 1}.`
      ) : b.type === blockMemoryItem ? (
        <span className="text-xs text-muted">记性</span>
      ) : b.type === blockTodo ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={b.attrs.checked ?? false}
          aria-label={b.attrs.checked ? "做完了" : "没做完"}
          onClick={() => editor.toggle(b)}
          className={`mt-[3px] flex size-4 cursor-pointer items-center justify-center rounded-[3px] border-[1.5px] ${b.attrs.checked ? "border-leaf-600 bg-leaf" : "border-bark-400 bg-paper"}`}
        >
          {b.attrs.checked && <Icon name="mark-check" size={10} />}
        </button>
      ) : undefined;
    const box = b.type === blockQuote ? "border-l-[3px] border-cream-300 pl-3" : b.type === blockCode ? "rounded-md bg-ink-100 px-3 py-2" : "";
    // One shape for every text block: a block that changes type keeps its field, and the field its focus.
    body = (
      <div className={`flex items-start ${box}`}>
        {mark !== undefined ? <span className="w-[26px] shrink-0 pt-px">{mark}</span> : null}
        <div className="min-w-0 flex-1">
          <BlockField editor={editor} block={b} />
        </div>
      </div>
    );
  }
  return (
    <div data-block={b.id} className={`flex items-start pb-0.5 ${b.type === blockHeading ? "pt-2.5" : "pt-0.5"}`}>
      <span className="w-[22px] shrink-0 pt-[3px]">{showFace && <AgentFace agentId={b.updatedBy} look={agent?.look} size={18} />}</span>
      <span
        title={writing ? `${writer} 在写` : `${writer} 写的`}
        aria-label={writing ? `${writer} 在写` : undefined}
        className={`mt-0.5 mr-2.5 shrink-0 rounded-sm ${writing ? "w-1 animate-pulse" : "w-[3px]"}`}
        style={{ height: barHeight(b.type), background: authorColor(b.updatedBy, agent) }}
      />
      <span className="shrink-0" style={{ width: 20 * depth }} />
      <div className="min-w-0 flex-1">
        {body}
        {b.problem && <p className="text-xs text-berry">{b.problem}</p>}
      </div>
    </div>
  );
}

function Placeholder({ text }: { text: string }) {
  return <div className="rounded-md border border-line bg-ink-100 px-2.5 py-1.5 text-sm text-muted">{text}</div>;
}

function typeStyle(b: EditBlock) {
  switch (b.type) {
    case blockHeading:
      return (b.attrs.level ?? 1) <= 1 ? "text-2xl font-semibold" : b.attrs.level === 2 ? "text-xl font-semibold" : "text-lg font-semibold";
    case blockCode:
      return "font-mono text-sm";
    case blockQuote:
      return "text-muted";
    default:
      return b.type === blockTodo && b.attrs.checked ? "text-muted line-through" : "";
  }
}

function Marked({ spans }: { spans: readonly DocSpan[] }) {
  return (
    <>
      {spans.map((s, i) => {
        const m = s.marks;
        const cls = [
          m.bold && "font-semibold",
          m.italic && "italic",
          m.code && "rounded bg-[#2f1f1314] px-0.5 font-mono",
          m.strike && "line-through",
          m.link && "text-[#3f6e2a] underline",
        ]
          .filter(Boolean)
          .join(" ");
        return m.link ? (
          <a key={i} href={m.link} target="_blank" rel="noreferrer" className={cls}>
            {s.t}
          </a>
        ) : (
          <span key={i} className={cls}>
            {s.t}
          </span>
        );
      })}
    </>
  );
}

/** A block's text: the marks drawn until it is clicked into, then a plain field of its own. */
function BlockField({ editor, block: b }: { editor: DocEditor; block: EditBlock }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [editing, setEditing] = useState(false);
  const wanted = editor.focusId === b.id;
  const shown = editing || wanted || b.focused;
  const style = typeStyle(b);
  // The editor moved the text under the caret, or asked for this block to take the focus.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    if (wanted) {
      editor.focusId = undefined;
      el.focus();
    }
    if (b.caret !== undefined && document.activeElement === el) {
      el.setSelectionRange(b.caret, b.caret);
      b.caret = undefined;
    }
  });
  if (!shown)
    return (
      <div
        role="textbox"
        tabIndex={0}
        aria-label={`块 ${b.id}`}
        onFocus={() => setEditing(true)}
        onClick={() => setEditing(true)}
        className={`min-h-6 cursor-text text-base leading-6 break-words whitespace-pre-wrap ${style}`}
      >
        {b.text ? <Marked spans={b.spans} /> : <span className="text-faint">{b.type === blockHeading ? "标题" : " "}</span>}
      </div>
    );
  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (b.composing || e.nativeEvent.isComposing || el.selectionStart !== el.selectionEnd) return;
    const at = el.selectionStart;
    if (e.key === "Backspace" && at === 0) {
      e.preventDefault();
      editor.backspaceAtStart(b);
    } else if ((e.key === "ArrowUp" && at === 0) || (e.key === "ArrowDown" && at === el.value.length)) {
      const next = editor.neighbour(b, e.key === "ArrowUp" ? -1 : 1);
      if (!next) return;
      e.preventDefault();
      editor.moveTo(next, e.key === "ArrowUp" ? next.text.length : 0);
    }
  };
  return (
    <textarea
      ref={ref}
      aria-label={`块 ${b.id}`}
      rows={1}
      autoFocus={editing && !wanted}
      value={b.text}
      placeholder={b.type === blockHeading ? "标题" : undefined}
      spellCheck={false}
      onFocus={() => editor.focus(b, true)}
      onBlur={() => {
        editor.focus(b, false);
        setEditing(false);
      }}
      onCompositionStart={() => (b.composing = true)}
      onCompositionEnd={(e) => editor.composition(b, false, e.currentTarget.value)}
      onChange={(e) => editor.edited(b, e.target.value, e.target.selectionStart)}
      onKeyDown={key}
      className={`block w-full resize-none overflow-hidden bg-transparent text-base leading-6 outline-none placeholder:text-faint ${style}`}
    />
  );
}
