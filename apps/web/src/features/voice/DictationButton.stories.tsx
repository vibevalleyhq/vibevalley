import { stories, story } from "@vibevalley/stories";

import { DictationMark, type DictationState } from "./DictationButton";

export default stories({
  title: "组件/语音/听写",
  stories: {
    States: story({
      note: "每个输入框边上的听写键：没设好、能说、在听、在转写；没听到或服务端出错时，原因在悬停里。",
      args: { state: "idle", problem: "" },
      grid: { rows: ["state", ["unset", "idle", "recording", "transcribing"]], cols: "pseudo" },
      render: (a) => <DictationMark state={a.state as DictationState} problem={a.problem || undefined} onClick={() => undefined} />,
    }),
    Failed: story({
      note: "上一次没成：键还是能按，悬停说为什么。",
      args: { problem: "没听到声音：麦克风没给权限" },
      render: (a) => <DictationMark state="idle" problem={a.problem} onClick={() => undefined} />,
    }),
  },
});
