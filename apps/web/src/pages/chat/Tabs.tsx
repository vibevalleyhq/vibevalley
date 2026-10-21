import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { Conversation, Schedule } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { useCore } from "../../data/frame";
import { chatPath, jobThreadOf, phaseText } from "../../rules/chat";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { useToast } from "../../ui/Toast";
import { Empty, HelperFace, PhaseGlyph } from "./bits";

const card = "rounded-lg border border-line bg-page p-3";

/** The sessions arranged in this channel; the general holds those arranged in no channel. */
export function Jobs({ channel }: { channel: Conversation }) {
  const core = useCore();
  const navigate = useNavigate();
  const sessions = (core?.sessions ?? []).filter((h) => (h.channel ? h.channel === channel.id : channel.kind === "general"));
  if (sessions.length === 0) return <Empty icon="icon-tasks">这个频道里还没有活。在聊天里跟管家说一件要做的事，它会派帮工，活就列在这里。</Empty>;
  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-4">
      {sessions.map((h) => {
        const thread = jobThreadOf(core?.chat, h);
        return (
          <div key={h.id} className={`${card} flex items-center gap-3`}>
            <HelperFace agent={h.agent} size={36} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm">
                <span className="font-semibold">{h.name}</span>
                <span className="text-xs text-muted">
                  {"  "}@{h.id} {h.project ?? ""}
                  {h.branch ? ` · ${h.branch}` : ""}
                </span>
              </span>
              <span className="truncate text-sm">{h.brief}</span>
              <span className="flex items-center gap-1 text-xs text-muted">
                <PhaseGlyph phase={h.phase} />
                <span className="truncate">{phaseText(h, Date.now())}</span>
              </span>
            </div>
            {thread && (
              <Button icon="button-thread" onClick={() => navigate(chatPath(thread))}>
                工单串
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function Schedules({ channel }: { channel: Conversation }) {
  const schedules = (useCore()?.schedules ?? []).filter((s) => s.channel === channel.id);
  if (schedules.length === 0)
    return <Empty icon="icon-clock">这个频道还没有定时。跟管家说「每天早上九点跑一遍测试」，它会定在这里；到点了频道里出现一条，再派活。</Empty>;
  return (
    <div className="flex flex-col gap-3 overflow-y-auto p-4">
      {schedules.map((s) => (
        <ScheduleCard key={s.id} s={s} />
      ))}
    </div>
  );
}

function ScheduleCard({ s }: { s: Schedule }) {
  const toast = useToast();
  const [deleting, setDeleting] = useState(false);
  const act = (p: Promise<void>) => p.catch((e) => toast(reasonOf(e), "bad"));
  const setEnabled = (enabled: boolean) => act(api.schedule.update({ id: s.id, body: { enabled } }));
  const remove = () => act(api.schedule.delete({ id: s.id }));
  // The second press deletes; a press anywhere else takes the first back.
  useEffect(() => {
    if (!deleting) return;
    const away = () => setDeleting(false);
    const t = setTimeout(() => document.addEventListener("pointerdown", away, { once: true }));
    return () => {
      clearTimeout(t);
      document.removeEventListener("pointerdown", away);
    };
  }, [deleting]);
  const meta = [
    s.whenText ?? "",
    s.pending ? (s.nextText ?? "") : `下次 ${s.nextText ?? ""}`,
    ...(s.agent ? [`直接派 ${s.agent}`] : []),
    ...(s.by === "manager" ? ["管家定的"] : []),
  ].join(" · ");
  return (
    <div className={`${card} flex items-start gap-3 ${s.enabled || s.pending ? "" : "opacity-60"}`} aria-label={`定时「${s.name}」`}>
      <Icon name="icon-clock" size={20} className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm">
          <span className="font-semibold">{s.name}</span>
          <span className="text-xs text-muted">
            {"  "}
            {meta}
          </span>
        </span>
        <span className="text-sm">{s.text}</span>
      </div>
      {s.pending ? (
        <div className="flex gap-2">
          <Button tone="primary" icon="mark-check" aria-label={`同意定时「${s.name}」`} onClick={() => void setEnabled(true)}>
            同意
          </Button>
          <Button icon="mark-cross" aria-label={`不要定时「${s.name}」`} onClick={() => void remove()}>
            不要
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button tone={s.enabled ? "primary" : "plain"} onClick={() => void setEnabled(!s.enabled)}>
            {s.enabled ? "开着" : "关着"}
          </Button>
          {deleting ? (
            <Button tone="danger" onPointerDown={(e) => e.stopPropagation()} onClick={() => void remove()}>
              确定删？
            </Button>
          ) : (
            <Button icon="button-delete" title="删掉" aria-label={`删掉定时「${s.name}」`} onClick={() => setDeleting(true)} />
          )}
        </div>
      )}
    </div>
  );
}
