// One task's transcript in a pane: messages, tool calls as cards and
// groups, the thinking loader while the agent has not called a tool yet,
// and a reply box.
import { Scroll, signal, Text, View } from "nsh";
import { Input } from "nsh/base";

import { act, frame, param } from "../bridge";
import { StatusBadge, type Tone } from "../components/StatusBadge";
import { ThinkingLoader } from "../components/ThinkingLoader";
import type { ToolCall } from "../components/ToolCallCard";
import { ToolCallGroup } from "../components/ToolCallGroup";
import { radius, tok, type as ty } from "../tokens";
import { PrimaryButton } from "./shared";

type Block =
  | { kind: "user" | "assistant" | "thinking" | "note" | "question" | "error"; text: string }
  | { kind: "tools"; calls: ToolCall[] }
  | { kind: "turn_end" };

type TranscriptFrame = {
  blocks: Block[];
  running: boolean;
  thinking: boolean;
  task?: { id: string; title: string; tone: Tone; label: string; createdMs: number };
};

function Message(props: { block: Block }) {
  const p = () => tok();
  const b = props.block;
  if (b.kind === "tools") return <ToolCallGroup calls={b.calls} />;
  if (b.kind === "turn_end") return <View style={{ height: 1, backgroundColor: p().border, marginVertical: 4 }} />;
  const color = b.kind === "error" ? p().danger : b.kind === "note" || b.kind === "thinking" ? p().muted : p().ink;
  return (
    <View
      style={{
        alignSelf: b.kind === "user" ? "flex-end" : "stretch",
        maxWidth: b.kind === "user" ? "80%" : "100%",
        backgroundColor: b.kind === "user" ? p().subtle : "transparent",
        borderRadius: radius.card,
        paddingHorizontal: b.kind === "user" ? 12 : 2,
        paddingVertical: b.kind === "user" ? 8 : 2,
      }}
    >
      <Text
        style={{
          ...ty.body,
          color,
          fontStyle: b.kind === "thinking" ? "italic" : "normal",
          fontSize: b.kind === "note" ? 12 : 13.5,
          userSelect: "text",
          writingDirection: "auto",
        }}
      >
        {b.text}
      </Text>
    </View>
  );
}

export function AgentPane() {
  const f = frame<TranscriptFrame>("transcript");
  const taskId = param("taskId", "");
  const reply = signal("");
  const p = () => tok();
  const send = () => {
    const text = reply().trim();
    if (!text) return;
    act({ type: "prompt_task", id: taskId, text });
    reply.set("");
  };
  return (
    <View style={{ flex: 1, backgroundColor: p().canvas }}>
      <View
        style={{ height: 40, flexDirection: "row", alignItems: "center", paddingHorizontal: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: p().border }}
      >
        <Text style={{ ...ty.title, color: p().ink, flex: 1, numberOfLines: 1, writingDirection: "auto" }}>{f()?.task?.title ?? "Agent"}</Text>
        {f()?.task ? <StatusBadge tone={f()!.task!.tone} label={f()!.task!.label} live={f()!.running} /> : null}
        {f()?.running ? (
          <Text onPress={() => act({ type: "abort_task", id: taskId })} style={{ ...ty.label, color: p().danger }}>
            Stop
          </Text>
        ) : null}
      </View>
      <Scroll style={{ flex: 1 }} contentStyle={{ padding: 14, gap: 10 }}>
        {!f() || f()!.blocks.length === 0 ? (
          <Text style={{ ...ty.body, color: p().muted }}>The agent's messages and tool calls will appear here.</Text>
        ) : (
          <Each of={f()!.blocks} key="index">
            {(b) => <Message block={b()} />}
          </Each>
        )}
        {f()?.thinking ? <ThinkingLoader sinceMs={f()?.task?.createdMs ?? Date.now()} /> : null}
      </Scroll>
      <View style={{ flexDirection: "row", gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: p().border, alignItems: "flex-end" }}>
        <Input
          value={reply()}
          onChange={({ value }) => reply.set(value)}
          onSubmit={send}
          placeholder="Reply to the agent"
          style={{
            flex: 1,
            minHeight: 32,
            borderRadius: radius.sm,
            borderWidth: 1,
            borderColor: p().border,
            backgroundColor: p().surface,
            color: p().ink,
            paddingHorizontal: 8,
            fontSize: 13,
          }}
        />
        <PrimaryButton label="Send" disabled={!reply().trim()} onPress={send} />
      </View>
    </View>
  );
}
