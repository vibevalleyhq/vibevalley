import type { OrchestratorEval } from "@vibevalley/protocol";
import { stories, story } from "@vibevalley/stories";

import { failedRound, finishedRound, liveRound, nowAfter } from "./session.samples";
import { Trajectory } from "./Trajectory";
import { WorkLog } from "./WorkLog";

const twoRounds = [...finishedRound, ...liveRound];

export default stories({
  title: "界面/执行/干活的经过",
  stories: {
    Finished: story({
      note: "一轮做完：交给它的话、想起的、想的、读改跑（失败的那次红着）、重试、用了多少、它说的。",
      render: () => (
        <div class="w-full max-w-2xl">
          <WorkLog steps={finishedRound} now={nowAfter(finishedRound)} />
        </div>
      ),
    }),
    Live: story({
      note: "第二轮还在跑：上一轮折起来，这一轮开着，命令还没回来。",
      render: () => (
        <div class="w-full max-w-2xl">
          <WorkLog steps={twoRounds} now={nowAfter(twoRounds)} working />
        </div>
      ),
    }),
    Failed: story({
      note: "这一轮出错停了：原因在最后一行。",
      render: () => (
        <div class="w-full max-w-2xl">
          <WorkLog steps={failedRound} now={nowAfter(failedRound)} />
        </div>
      ),
    }),
    Trajectory: story({
      fill: true,
      note: "轨迹：每一轮的瀑布图（问、模型、工具三条道），点开一步看输入输出；能把一步标成「做错了」，留给管家的评测。",
      args: { marking: "ok" },
      controls: { marking: { kind: "choice", options: ["ok", "refused"] } },
      render: (a) => (
        <Trajectory
          steps={twoRounds}
          now={nowAfter(twoRounds)}
          working
          onMarkWrong={(step, want) =>
            a.marking === "ok"
              ? Promise.resolve({ name: `case-${step}`, want } as unknown as OrchestratorEval)
              : Promise.reject(new Error("评测存不下：磁盘满了"))
          }
        />
      ),
    }),
  },
});
