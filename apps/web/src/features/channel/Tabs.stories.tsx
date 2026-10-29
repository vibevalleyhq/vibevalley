import type { Cron } from "@vibevalley/protocol";
import { stories, story } from "@vibevalley/stories";
import { CronCard } from "./Tabs";

const now = Date.now();

const cron = (more: Partial<Cron>): Cron => ({
  id: "c1",
  name: "每天的站会",
  text: "看一眼昨天交的活，写三行进展发到这里。",
  channel: "general",
  when: { kind: "daily", time: "09:30" },
  tz: "Asia/Shanghai",
  enabled: true,
  created: now - 7 * 86_400_000,
  lastRun: now - 86_400_000,
  by: "owner",
  ...more,
});

export default stories({
  title: "组件/频道/定时任务",
  stories: {
    States: story({
      note: "开着、关着、管家提的等你批准。",
      args: { state: "enabled" },
      grid: { rows: ["state", ["enabled", "disabled", "pending"]] },
      render: (a) => (
        <div class="w-[28rem]">
          <CronCard
            s={cron(a.state === "disabled" ? { enabled: false } : a.state === "pending" ? { pending: true, by: "orchestrator", lastRun: undefined } : {})}
          />
        </div>
      ),
    }),
  },
});
