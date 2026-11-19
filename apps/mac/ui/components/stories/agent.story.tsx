// Stories of the agent views, from the event fixtures.
import { Text, View } from "nsh";

import { tok, type as ty } from "../../tokens";
import { cut, ended, events } from "../fixtures";
import { StatusBadge } from "../StatusBadge";
import { ThinkingLoader, thinkingOf } from "../ThinkingLoader";
import { callsFromEvents, ToolCallCard, type ToolCall } from "../ToolCallCard";
import { ToolCallGroup } from "../ToolCallGroup";
import type { Story } from "./story";

function callNamed(stream: ReturnType<typeof callsFromEvents>, id: string): ToolCall {
  const c = stream.find((x) => x.id === id);
  if (!c) throw new Error(`no call ${id}`);
  return c;
}

const note = (text: string) => <Text style={{ ...ty.label, color: tok().muted }}>{text}</Text>;

export const agentStories: Story[] = [
  {
    id: "status-badge",
    title: "StatusBadge",
    render: () => (
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          <StatusBadge tone="running" label="Working" live />
          <StatusBadge tone="done" label="Done" />
          <StatusBadge tone="failed" label="Stuck" />
          <StatusBadge tone="alert" label="Needs you" />
          <StatusBadge tone="idle" label="Queued" />
        </View>
        <View style={{ width: 260 }}>
          <StatusBadge
            tone="alert"
            label="把终端面板在窗口缩放时的回滚内容保留下来，并且在助手往里面持续输出很长的工具结果时保持光标所在行稳定 · keep the cursor row stable"
          />
        </View>
      </View>
    ),
  },
  {
    id: "thinking-loader",
    title: "ThinkingLoader",
    render: () => {
      const thinking = thinkingOf(cut(events.claude, 3, 2400));
      const done = thinkingOf(ended(events.claude));
      const long = thinkingOf(cut(events.long, 3, 61_000));
      return (
        <View style={{ gap: 10 }}>
          {thinking ? <ThinkingLoader sinceMs={thinking.sinceMs} thought={thinking.thought} /> : null}
          {done ? <ThinkingLoader sinceMs={done.sinceMs} doneMs={done.doneMs} /> : null}
          {long ? <ThinkingLoader sinceMs={long.sinceMs} thought={long.thought} variant="plain" /> : null}
          <ThinkingLoader sinceMs={Date.now()} label="Thinking" />
        </View>
      );
    },
  },
  {
    id: "tool-call-card",
    title: "ToolCallCard",
    render: () => {
      const running = callsFromEvents(cut(events.claude, 8, 3400));
      const run = callsFromEvents(ended(events.claude));
      const long = callsFromEvents(ended(events.long));
      const codex = callsFromEvents(ended(events.codex));
      const bare: ToolCall = { ...callNamed(run, "toolu_05"), input: null, output: "" };
      return (
        <View style={{ gap: 10 }}>
          <ToolCallCard call={callNamed(running, "toolu_03")} />
          <ToolCallCard call={callNamed(run, "toolu_01")} defaultOpen />
          <ToolCallCard call={callNamed(run, "toolu_03")} onRetry={() => {}} />
          <ToolCallCard call={codex[0]} />
          <ToolCallCard call={long[0]} defaultOpen />
          <ToolCallCard call={long[1]} />
          <ToolCallCard call={bare} defaultOpen />
        </View>
      );
    },
  },
  {
    id: "tool-call-group",
    title: "ToolCallGroup",
    render: () => (
      <View style={{ gap: 10 }}>
        <ToolCallGroup calls={callsFromEvents(cut(events.claude, 8, 5200))} />
        <ToolCallGroup calls={callsFromEvents(ended(events.claude))} onRetry={() => {}} />
        <ToolCallGroup calls={callsFromEvents(ended(events.claude)).slice(0, 2)} defaultOpen />
        <ToolCallGroup calls={[]} />
        {note("The host decides when calls are grouped; a group of none shows its empty state.")}
      </View>
    ),
  },
];
