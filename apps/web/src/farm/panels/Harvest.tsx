// Harvesting a helper's plot and the warehouse of what was harvested; the checklist's rules are src/rules/issueState.ts.

import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { Changes, Session } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { useAgents } from "../../data/agents";
import { useCore, useFrames } from "../../data/frame";
import { changeKind, lineCounts, nothingChanged } from "../../rules/issueState";
import { issueTitle } from "../../rules/issues";
import { ago } from "../../rules/time";
import { FarmSection, PxButton, SpriteIcon } from "../kit";
import { fire, useFarmCommands } from "../commands";
import { farm } from "../store";
import { issueOf } from "../world/plots";
import { harvestedOf } from "../hud/rules";
import { FarmEmpty, FarmTag, FileRow, PlusMinus, tint, Tinted } from "./bits";

const xs = "text-[12px] text-bark-600";

export function HarvestReview({ session, onDone }: { session: Session; onDone: () => void }) {
  const id = issueOf(session);
  const changes = useQuery({ queryKey: ["issues", "changes", id], queryFn: () => api.issue.changes({ id }) });
  if (changes.isPending) return <p className="py-10 text-center text-[13px] text-bark-600">正在看它改了什么…</p>;
  if (changes.error)
    return (
      <div className="flex flex-col items-start gap-3">
        <Tinted color={tint("#c84a3a", 0.12)}>
          <p className="text-[13px] text-berry">看不了改动：{reasonOf(changes.error)}</p>
        </Tinted>
        <PxButton onClick={onDone}>先不收</PxButton>
      </div>
    );
  return <Ready session={session} changes={changes.data} onDone={onDone} />;
}

function Ready({ session, changes, onDone }: { session: Session; changes: Changes; onDone: () => void }) {
  const commands = useFarmCommands();
  const now = Date.now();
  const [added, removed] = lineCounts(changes);
  const empty = nothingChanged(changes);
  const { conflicts } = changes;
  const take = () => {
    fire(commands.harvest(session));
    onDone();
  };
  const resolve = () => {
    fire(commands.resolve(session));
    onDone();
  };
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-1.5">
        <FarmTag text={`项目 ${changes.project}`} fill="#a5743f" ink="#f7e8c4" />
        {changes.branch && <FarmTag text={`${changes.branch} → ${changes.base}`} ink="#46301d" />}
        <span className={xs}>
          {changes.commits.length} 个提交 · {changes.files.length} 个文件
        </span>
        {changes.files.length > 0 && <PlusMinus added={added} removed={removed} />}
      </div>
      {conflicts.length > 0 ? (
        <Tinted color={tint("#c84a3a", 0.12)} className="mt-3 py-2.5">
          <p className="text-[13px] text-berry">合进 {changes.base} 会冲突，先没法收</p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {conflicts.map((f) => (
              <FarmTag key={f} text={f} fill="#f7e8c4" ink="#c84a3a" />
            ))}
          </div>
          <p className={`mt-1.5 ${xs}`}>让它在自己的分支上把 {changes.base} 合进来、解决冲突、跑一遍测试再提交；做完再来收。</p>
        </Tinted>
      ) : (
        empty && (
          <Tinted className="mt-3">
            <p className="text-[13px] text-bark-600">这一单没有改动。收获就是请它收工。</p>
          </Tinted>
        )
      )}
      {changes.behind > 0 && conflicts.length === 0 && (
        <p className={`mt-2 ${xs}`}>
          它干活这段时间，{changes.base} 上多了 {Math.round(changes.behind)} 个提交；收获时会合在一起（多一个合并提交）。
        </p>
      )}
      {changes.uncommitted.length > 0 && (
        <Tinted color={tint("#e5a93c", 0.2)} className="mt-3">
          <p className="text-[12px] text-bark-800">还有 {changes.uncommitted.length} 个文件没提交，收获时会先帮它提交：</p>
          <div className="mt-1 flex flex-wrap gap-1">
            {changes.uncommitted.map((f) => (
              <span key={f.path} className="bg-cream-50 px-1.5 py-0.5 font-mono text-[12.5px]">
                {changeKind(f.status).mark} {f.path}
              </span>
            ))}
          </div>
        </Tinted>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {conflicts.length > 0 ? (
          <PxButton tone="danger" onClick={resolve}>
            让它解决冲突
          </PxButton>
        ) : (
          <PxButton tone="primary" onClick={take}>
            {empty ? "请它收工" : `确认收获，合进 ${changes.base}`}
          </PxButton>
        )}
        <PxButton onClick={onDone}>先不收</PxButton>
      </div>
      {changes.commits.length > 0 && (
        <FarmSection title="提交">
          {changes.commits.map((c) => (
            <div key={c.hash} className="flex items-center gap-2 py-px">
              <span className="font-mono text-[12.5px] text-bark-500">{c.hash}</span>
              <span className="min-w-0 flex-1 truncate text-[13px]">{c.subject}</span>
              <span className="text-[12px] text-bark-400">{ago(c.at, now)}</span>
            </div>
          ))}
        </FarmSection>
      )}
      {changes.files.length > 0 && (
        <FarmSection title="改了的文件">
          <div className="flex flex-col gap-1">
            {changes.files.map((f) => (
              <FileRow key={f.path} file={f} conflict={conflicts.includes(f.path)} />
            ))}
          </div>
        </FarmSection>
      )}
    </div>
  );
}

export function Warehouse() {
  const core = useCore();
  const { frame } = useFrames();
  const agents = new Map((useAgents().data ?? []).map((a) => [a.id, a]));
  const navigate = useNavigate();
  const stored = harvestedOf(core);
  if (stored.length === 0) return <FarmEmpty text="仓库还空着。收获进主分支的活会放在这里。" />;
  const graphs = frame?.graphs ?? [];
  const now = Date.now();
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {stored.map((i) => (
        <button
          key={i.id}
          type="button"
          aria-label={issueTitle(i, graphs)}
          onClick={() => {
            if (i.graph) farm.openTaskBoard(i.id);
            else void navigate(`/issues/${encodeURIComponent(i.id)}`);
          }}
          className="flex cursor-pointer items-start gap-3 bg-cream-100 p-3 text-left hover:bg-cream-200"
        >
          <SpriteIcon name={i.graph ? "icon-task-board" : "icon-harvest"} size={40} />
          <span className="min-w-0 flex-1">
            <span className="line-clamp-2 text-[13px]">{issueTitle(i, graphs)}</span>
            <span className={`mt-1 block ${xs}`}>
              {[
                i.graph ? "种植计划" : undefined,
                i.assignee ? (agents.get(i.assignee)?.name ?? i.assignee) : undefined,
                i.project,
                i.closedAt !== undefined ? `${ago(i.closedAt, now)}收的` : undefined,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
