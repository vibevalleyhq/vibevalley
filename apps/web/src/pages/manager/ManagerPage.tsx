// 管家: who the manager is, and its 记性, 轨迹 (every round, a round markable as wrong),
// 旧账 (the conversation it folded away) and 声音 (what it says on a call); /manager/<tab>.

import { Link, useNavigate, useParams } from "react-router";
import { managerAgent } from "@vibevalley/protocol";
import { api } from "../../data/api";
import { useFarm } from "../../farm/store";
import { managerLooks } from "../../farm/tools";
import { ManagerFace } from "../../ui/Face";
import { ArchivePanel, ManagerMemoryPanel } from "../Memory";
import { VoiceForm } from "../settings/VoiceForm";
import { TrajectoryLog } from "../Trajectory";

const tabs = [
  { id: "memory", label: "记性" },
  { id: "trajectory", label: "轨迹" },
  { id: "archive", label: "旧账" },
  { id: "voice", label: "声音" },
] as const;

type Tab = (typeof tabs)[number]["id"];

export function ManagerPage() {
  const asked = useParams()["*"];
  const at: Tab = tabs.find((t) => t.id === asked)?.id ?? "memory";
  const navigate = useNavigate();
  const chosen = useFarm((s) => s.managerLook);
  const look = managerLooks.find((l) => l.id === chosen);
  const head = (
    <div className="flex items-center gap-4 pt-4">
      <span className="flex size-18 shrink-0 items-center justify-center rounded-lg bg-hover">
        <ManagerFace size={64} look={chosen} />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <Link to="/agents" className="text-xs text-muted hover:underline">
          ← 全部帮工
        </Link>
        <h1 className="text-2xl font-semibold">管家</h1>
        <p className="text-sm text-muted">
          管家不下地：听你说要做什么，派帮工去做，盯着进度，转告结果。{look ? `长相是${look.name}，在农场的管家面板里换。` : ""}
        </p>
      </div>
    </div>
  );
  const bar = (
    <div role="tablist" aria-label="管家的" className="flex gap-1 border-b border-line pb-2">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === at}
          onClick={() => navigate(`/manager/${t.id}`)}
          className={`h-8 cursor-pointer rounded-md px-3 text-base ${t.id === at ? "bg-selected font-semibold" : "text-muted hover:bg-hover hover:text-ink"}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
  // The trajectory takes the whole content area, its rows scrolling under a fixed head; the other tabs are a column.
  if (at === "trajectory")
    return (
      <div className="flex h-full min-h-0 flex-col gap-4 px-4 pb-4">
        {head}
        {bar}
        <div className="min-h-0 flex-1">
          <TrajectoryLog
            id={managerAgent}
            asked="收到"
            empty="管家还没开过口。"
            title="管家每一轮的经过"
            about="它收到的话、调的每个工具（点一行看参数和结果）、它说的话。新的在下面，一直留着最近的 1000 步。哪一轮做错了，在它收到的话上点「这一轮做错了」，写一句应该怎样，存成一条评测。"
            onMarkWrong={(on, want) => api.manager.markWrong({ body: { on, want } })}
          />
        </div>
      </div>
    );
  return (
    <div className="h-full overflow-y-auto px-4 pb-4">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        {head}
        {bar}
        {at === "memory" ? <ManagerMemoryPanel /> : at === "archive" ? <ArchivePanel /> : <VoiceForm part="agent" />}
      </div>
    </div>
  );
}
