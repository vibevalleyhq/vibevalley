import { useQuery } from "@tanstack/react-query";
import type { ChangedFile, Changes, Issue, Session } from "@vibevalley/protocol";
import { useState } from "react";
import { api, reasonOf } from "../../data/api";
import { issueTitle } from "../../rules/issues";
import { changeKind, lineCounts, nothingChanged, patchLines, patchMarkOf } from "../../rules/issueState";
import { ago } from "../../rules/time";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { TextArea } from "../../ui/Field";
import { useRun } from "./data";
import { Note } from "./Sheet";

/** Closing an issue: harvest it (its checklist first) or let the helper go. `review` opens straight on the checklist. */
export function CloseIssueDialog({ issue, session, review = false, onClose }: { issue: Issue; session: Session; review?: boolean; onClose: () => void }) {
  const [reviewing, setReviewing] = useState(review);
  const run = useRun();
  const working = session.phase._tag === "working" || session.phase._tag === "arriving";
  return (
    <Dialog open onClose={onClose} title={`关上「${issueTitle(issue)}」`} wide={reviewing}>
      {reviewing ? (
        <HarvestReview issue={issue.id} onDone={onClose} />
      ) : (
        <div>
          <p className="text-base">
            {working
              ? `${session.name} 还在干这张工单。关上就是叫停它、让它收工，分支上的改动不合进主分支。`
              : `收获就是把 ${session.name} 的分支合进项目的主分支，先看一遍收成清单；不收就是让它收工，改动不合进去。`}
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {!working && (
              <Button tone="primary" onClick={() => setReviewing(true)}>
                看收成清单，收获
              </Button>
            )}
            <Button
              tone="danger"
              onClick={async () => {
                await run(() => api.issue.status({ id: issue.id, body: { status: "canceled" } }));
                onClose();
              }}
            >
              {working ? "叫停并收工" : "不收，直接收工"}
            </Button>
            <Button onClick={onClose}>算了</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** What the branch brings before it is merged. */
export function HarvestReview({ issue, onDone }: { issue: string; onDone: () => void }) {
  const changes = useQuery({ queryKey: ["issues", "changes", issue], queryFn: () => api.issue.changes({ id: issue }) });
  const run = useRun();
  if (changes.isPending) return <p className="py-10 text-center text-sm text-muted">正在看它改了什么…</p>;
  if (changes.error)
    return (
      <div>
        <Note tone="berry">
          <span className="text-berry">看不了改动：{reasonOf(changes.error)}</span>
        </Note>
        <Button className="mt-4" onClick={onDone}>
          先不收
        </Button>
      </div>
    );
  const c = changes.data;
  const empty = nothingChanged(c);
  const take = () => {
    void run(() => api.issue.status({ id: issue, body: { status: "done" } }));
    onDone();
  };
  const resolve = () => {
    void run(() => api.issue.resolve({ id: issue }));
    onDone();
  };
  return (
    <div className="flex flex-col gap-3">
      <ChangesHead changes={c} />
      {c.conflicts.length > 0 ? (
        <Note tone="berry">
          <div className="font-semibold text-berry">合进 {c.base} 会冲突，先没法收</div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {c.conflicts.map((f) => (
              <span key={f} className="rounded bg-page px-1.5 font-mono text-xs text-berry">
                {f}
              </span>
            ))}
          </div>
          <div className="mt-1.5 text-xs text-muted">让它在自己的分支上把 {c.base} 合进来、解决冲突、跑一遍测试再提交；做完再来收。</div>
        </Note>
      ) : (
        empty && (
          <Note>
            <span className="text-muted">这一单没有改动。收获就是请它收工。</span>
          </Note>
        )
      )}
      {c.behind > 0 && c.conflicts.length === 0 && (
        <p className="text-xs text-muted">
          它干活这段时间，{c.base} 上多了 {c.behind} 个提交；收获时会合在一起（多一个合并提交）。
        </p>
      )}
      {c.uncommitted.length > 0 && (
        <Note tone="wheat">
          <div>还有 {c.uncommitted.length} 个文件没提交，收获时会先帮它提交：</div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {c.uncommitted.map((f) => (
              <span key={f.path} className="rounded bg-page px-1.5 py-0.5 font-mono text-xs">
                {changeKind(f.status).mark} {f.path}
              </span>
            ))}
          </div>
        </Note>
      )}
      <div className="flex flex-wrap gap-2">
        {c.conflicts.length > 0 ? (
          <Button tone="danger" onClick={resolve}>
            让它解决冲突
          </Button>
        ) : (
          <Button tone="primary" onClick={take}>
            {empty ? "请它收工" : `确认收获，合进 ${c.base}`}
          </Button>
        )}
        <Button onClick={onDone}>先不收</Button>
      </div>
      <ChangesBody changes={c} />
    </div>
  );
}

export function ChangesHead({ changes: c }: { changes: Changes }) {
  const [added, removed] = lineCounts(c);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="rounded bg-selected px-1.5 text-xs">项目 {c.project}</span>
      {c.branch && (
        <span className="font-mono text-xs">
          {c.branch} → {c.base}
        </span>
      )}
      <span className="text-xs text-muted">
        {c.commits.length} 个提交 · {c.files.length} 个文件
      </span>
      {c.files.length > 0 && <PlusMinus added={added} removed={removed} />}
    </div>
  );
}

/** The commits and the files, each file opening to its patch. */
export function ChangesBody({ changes: c }: { changes: Changes }) {
  const now = Date.now();
  return (
    <>
      {c.commits.length > 0 && (
        <section>
          <h3 className="mt-2 mb-1 text-xs font-semibold text-muted">提交 {c.commits.length}</h3>
          {c.commits.map((m) => (
            <div key={m.hash} className="flex items-center gap-2.5 py-0.5">
              <span className="font-mono text-xs text-muted">{m.hash}</span>
              <span className="min-w-0 flex-1 truncate text-sm">{m.subject}</span>
              <span className="text-xs text-faint">{ago(m.at, now)}</span>
            </div>
          ))}
        </section>
      )}
      {c.files.length > 0 && (
        <section>
          <h3 className="mt-2 mb-1 text-xs font-semibold text-muted">改了的文件 {c.files.length}</h3>
          <div className="divide-y divide-line overflow-hidden rounded-md border border-line">
            {c.files.map((f) => (
              <FileRow key={f.path} file={f} conflict={c.conflicts.includes(f.path)} />
            ))}
          </div>
        </section>
      )}
    </>
  );
}

export const PlusMinus = ({ added, removed }: { added: number; removed: number }) => (
  <span className="font-mono text-xs">
    <span className="text-accent">+{added}</span> <span className="text-berry">−{removed}</span>
  </span>
);

const kindLook: Record<string, string> = { A: "bg-leaf/20 text-accent", M: "bg-wheat/20 text-bark", D: "bg-berry/15 text-berry" };

function FileRow({ file: f, conflict }: { file: ChangedFile; conflict: boolean }) {
  const [open, setOpen] = useState(false);
  const kind = changeKind(f.status);
  const hasPatch = !!f.patch;
  return (
    <div>
      <button
        type="button"
        disabled={!hasPatch}
        aria-expanded={hasPatch ? open : undefined}
        onClick={() => setOpen(!open)}
        className={`flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left ${hasPatch ? "cursor-pointer hover:bg-hover" : ""} ${open ? "bg-hover" : ""}`}
      >
        <span
          title={kind.label}
          className={`flex size-5 shrink-0 items-center justify-center rounded text-xs font-semibold ${kindLook[f.status] ?? "bg-selected"}`}
        >
          {kind.mark}
        </span>
        <span title={f.path} className={`min-w-0 flex-1 truncate font-mono text-xs ${conflict ? "text-berry" : ""}`}>
          {f.path}
        </span>
        {conflict && <span className="rounded bg-berry/15 px-1.5 text-xs text-berry">冲突</span>}
        {f.added < 0 ? <span className="font-mono text-xs text-muted">二进制</span> : <PlusMinus added={Math.round(f.added)} removed={Math.round(f.removed)} />}
      </button>
      {open && f.patch && <Patch text={f.patch} />}
    </div>
  );
}

const patchLook = { added: "bg-leaf/20 text-accent", removed: "bg-berry/10 text-berry", hunk: "text-water", plain: "" } as const;

function Patch({ text }: { text: string }) {
  return (
    <pre className="mx-2 mb-2 max-h-80 overflow-auto rounded-md border border-line bg-page py-1 font-mono text-xs leading-[1.4]">
      {patchLines(text).map((line, i) => (
        <div key={i} className={`px-2 ${patchLook[patchMarkOf(line)]}`}>
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

/** Reopening a closed issue: a new helper of the same profile goes on with it. */
export function ReopenDialog({ issue, onClose, onReopened }: { issue: Issue; onClose: () => void; onReopened: () => void }) {
  const [text, setText] = useState("");
  const run = useRun();
  return (
    <Dialog open onClose={onClose} title="重开这张工单">
      <p className="text-base">「{issueTitle(issue)}」由同一个帮工档案的新帮工接着做，它会知道这张工单原来要做什么、上一次是怎么关的。</p>
      <TextArea
        className="mt-4"
        rows={3}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="这次要它做什么（不填就是接着做完）"
        aria-label="这次要做什么"
      />
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>算了</Button>
        <Button
          tone="primary"
          onClick={async () => {
            const got = await run(() => api.issue.status({ id: issue.id, body: { status: "todo", text: text.trim() } }));
            onClose();
            if (got) onReopened();
          }}
        >
          重开
        </Button>
      </div>
    </Dialog>
  );
}
