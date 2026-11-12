import type { JSX } from "@solidjs/web";

import { stories, story } from "@vibevalley/stories";

import { DictationMark, type DictationState } from "./DictationButton";

const styles = {
  placement: (marginLeft: number): JSX.CSSProperties => ({ "--indent": `${marginLeft}px` }),
};

export default stories({
  title: "组件/语音/听写",
  stories: {
    Composition: story({
      args: { recording: true, surface: true, indent: 4 },
      render: (a) => (
        <div class="contents" style={styles.placement(a.indent)}>
          <DictationMark
            state={a.recording ? "recording" : "idle"}
            bar
            surface={a.surface}
            class="ml-(--indent) w-7 h-7 rounded-md"
            onClick={() => undefined}
          />
        </div>
      ),
    }),
    States: story({
      note: "每个输入框边上的听写键：没设好（点了去设置）、能说、在听、在转写；工作台的框在听时，键是「说完了」（bar）。",
      args: { state: "idle", problem: "" },
      grid: { rows: ["state", ["unset", "idle", "recording", "transcribing"]], cols: "pseudo" },
      render: (a) => <DictationMark state={a.state as DictationState} problem={a.problem || undefined} onClick={() => undefined} />,
    }),
    InTheBox: story({
      note: "工作台的聊天框在听时：旁边是听写条，键成了「说完了」。",
      render: () => <DictationMark state="recording" bar onClick={() => undefined} />,
    }),
    Failed: story({
      note: "上一次没成：键还是能按，悬停说为什么；工作台的框里另有一行说。",
      args: { problem: "没听到声音：麦克风没给权限" },
      render: (a) => <DictationMark state="idle" problem={a.problem} onClick={() => undefined} />,
    }),
  },
});
