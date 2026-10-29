import type { JSX } from "@solidjs/web";
import type { InboxItem, InboxKind } from "@vibevalley/protocol";
import { stories, story } from "@vibevalley/stories";
import type { CallPhase } from "@/features/voice";
import { lcd } from "./lcd";
import { OrchestratorLine, RingingScreen } from "./screens";

/** The handset's screen, without the handset: the farm's store and the room are not here. */
function Screen(props: { children: JSX.Element }) {
  return (
    <div class="flex h-[25rem] w-60 flex-col p-[2px] font-pixel text-[12px]" style={{ background: lcd.paper, color: lcd.ink }}>
      {props.children}
    </div>
  );
}

const ring = (kind: InboxKind, label: string, text: string): InboxItem => ({
  id: `c-${kind}`,
  kind,
  from: { kind: "session", id: "w1", name: "老周", agent: "老周" },
  who: "老周",
  text,
  at: Date.now(),
  target: { kind: "session", id: "w1" },
  words: { label, title: label, body: text, tray: "" },
});

export default stories({
  title: "界面/农场/电话",
  themes: ["light"],
  frame: "bg-cream-50 font-pixel text-[12px] text-bark-900",
  stories: {
    "Call the orchestrator": story({
      note: "打给管家的每一步：没打、在接、接通了管家还没来、在说、在挂，和没打通（原因写在屏上）。",
      args: { phase: "idle", agentHere: false, problem: "" },
      grid: { cols: ["phase", ["idle", "connecting", "live", "ending"]], rows: ["agentHere", [false, true]] },
      render: (a) => (
        <Screen>
          <OrchestratorLine phase={a.phase as CallPhase} agentHere={a.agentHere} problem={a.problem || undefined} onKey={() => undefined} />
        </Screen>
      ),
    }),
    "Call failed": story({
      args: { problem: "声网的钥匙没设：设置 › 语音" },
      render: (a) => (
        <Screen>
          <OrchestratorLine phase="idle" agentHere={false} problem={a.problem} onKey={() => undefined} />
        </Screen>
      ),
    }),
    Ringing: story({
      note: "帮工打进来：交活、要你答、出了问题，各有各的一行。",
      args: { kind: "review" },
      grid: { cols: ["kind", ["review", "ask", "fix"]] },
      render: (a) => {
        const calls: Record<string, InboxItem> = {
          review: ring("review", "交活了", "修好登录：过期回到登录页，加了两条测试。"),
          ask: ring("ask", "有问题", "过期以后回登录页，还是原地弹框？"),
          fix: ring("fix", "卡住了", "测试起不来：缺一个环境变量。"),
        };
        return (
          <Screen>
            <RingingScreen call={calls[a.kind]!} onAnswer={() => undefined} onDecline={() => undefined} />
          </Screen>
        );
      },
    }),
  },
});
