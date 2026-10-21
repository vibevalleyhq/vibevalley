// The farm's log: what you and the manager said in the general channel and every
// helper's turn report, newest first. Voice captions carry no times, so the log keeps to the typed lines.

import type { ChatMessage, CoreState, Issue, Outcome } from "@vibevalley/protocol";
import { useCore } from "../../data/frame";
import { generalOf, messagesIn, spentText } from "../../rules/chat";
import { AgentFace, ManagerFace } from "../../ui/Face";
import { DashedLine, PxMarkdown } from "../kit";
import { useFarm } from "../store";
import { clockOf, FarmEmpty, FarmTag } from "./bits";

const outcomeTag: Record<Outcome, [text: string, fill: string, ink: string]> = {
  completed: ["做完", "#efcf92", "#2f1f13"],
  failed: ["没过", "#f0cda6", "#c84a3a"],
  interrupted: ["叫停", "#e2c995", "#67482d"],
};

/** The turn reports, newest first. */
const turnReportsOf = (s: CoreState | undefined) => (s?.chat?.messages ?? []).filter((m) => m.kind === "report" && m.final).sort((a, b) => b.at - a.at);

const issueOfSession = (s: CoreState | undefined, session: string): Issue | undefined => (s?.issues ?? []).find((i) => i.sessions.includes(session));

type Row = { kind: "said" | "report"; message: ChatMessage };

export function FarmLog() {
  const s = useCore();
  const look = useFarm((st) => st.managerLook);
  const chat = s?.chat;
  const rows: Row[] = [
    ...messagesIn(chat, generalOf(chat)?.id ?? "")
      .filter((m) => m.kind === "chat" && (m.fromKind === "user" || m.fromKind === "manager"))
      .map((message) => ({ kind: "said" as const, message })),
    ...turnReportsOf(s).map((message) => ({ kind: "report" as const, message })),
  ].sort((a, b) => b.message.at - a.message.at);
  if (rows.length === 0) return <FarmEmpty text="还没有事。开工以后，你和管家说的话、谁做完了什么，都记在这里。" />;
  return (
    <div className="flex flex-col">
      {rows.slice(0, 80).map((row, i) => (
        <div key={row.message.id}>
          {i > 0 && <DashedLine />}
          <div className="flex items-start gap-2.5 py-2">
            <span className="w-11 shrink-0 pt-1.5 text-right text-[12px] text-bark-400">{clockOf(row.message.at)}</span>
            {row.kind === "said" ? (
              <Said m={row.message} look={look} />
            ) : (
              <Report r={row.message} issue={issueOfSession(s, row.message.session ?? row.message.from)} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Said({ m, look }: { m: ChatMessage; look: string }) {
  const you = m.fromKind === "user";
  return (
    <>
      {you ? (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center bg-leaf-500 text-[12px] text-cream-50">你</span>
      ) : (
        <ManagerFace size={32} look={look} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px]">{you ? "你" : "管家"}</span>
          <FarmTag text={you ? "说" : m.final ? "答" : "正在说"} ink="#67482d" />
        </div>
        <div className={`mt-0.5 text-[13px] ${you ? "text-bark-900" : "text-bark-800"}`}>
          <PxMarkdown text={m.text} />
        </div>
      </div>
    </>
  );
}

function Report({ r, issue }: { r: ChatMessage; issue?: Issue }) {
  const outcome = r.outcome ?? "completed";
  const [text, fill, ink] = outcomeTag[outcome];
  return (
    <>
      <AgentFace agentId={r.agent ?? ""} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px]">{r.name}</span>
          <FarmTag text={text} fill={fill} ink={ink} />
        </div>
        {issue && <p className="mt-0.5 text-[13px]">{issue.title}</p>}
        <p className={`line-clamp-4 text-[12px] ${outcome === "failed" ? "text-berry" : "text-bark-600"}`}>{r.text}</p>
        {r.spent && <p className="text-[12px] text-bark-400">这一轮花了 {spentText(r.spent)}</p>}
      </div>
    </>
  );
}
