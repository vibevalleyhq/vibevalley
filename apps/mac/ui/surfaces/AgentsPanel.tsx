// The agents panel: the decision inbox, the project's tasks with their
// status, and a box to start a new task.
import { Scroll, signal, Text, View } from "nsh";
import { Button, Input } from "nsh/base";

import { act } from "../bridge";
import { DecisionInbox, type Decision } from "../components/DecisionInbox";
import { StatusBadge, type Tone } from "../components/StatusBadge";
import { radius, tok, type as ty } from "../tokens";
import { Empty, PrimaryButton, SectionHead } from "./shared";

export type TaskRow = {
  id: string;
  title: string;
  runtime: string;
  tone: Tone;
  label: string;
  branch: string | null;
  error: string | null;
  updatedMs: number;
  live: boolean;
};

export type AgentsFrame = {
  tasks: TaskRow[];
  selected: string | null;
  runtimes: { id: string; name: string }[];
  counts: { running: number; waiting: number; review: number; failed: number };
};

export function AgentsPanel(props: { agents: AgentsFrame | null; inbox: { entries: Decision[] } | null }) {
  const p = () => tok();
  const prompt = signal("");
  const runtime = signal<string>("scripted");
  const start = () => {
    const text = prompt().trim();
    if (!text) return;
    act({ type: "create_task", prompt: text, runtime: runtime() });
    prompt.set("");
  };
  return (
    <Scroll style={{ flex: 1 }}>
      <View style={{ padding: 10 }}>
        <DecisionInbox entries={props.inbox?.entries ?? []} onDecide={(entry, choice) => act({ type: "decide", id: entry.id, choice })} />
      </View>
      <SectionHead title="New task" />
      <View style={{ paddingHorizontal: 12, gap: 8 }}>
        <Input
          value={prompt()}
          onChange={({ value }) => prompt.set(value)}
          placeholder="Describe what the agent should do"
          multiline
          style={{
            minHeight: 56,
            borderRadius: radius.sm,
            borderWidth: 1,
            borderColor: p().border,
            backgroundColor: p().surface,
            color: p().ink,
            padding: 8,
            fontSize: 13,
          }}
        />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <Each of={props.agents?.runtimes ?? []} key={(r) => r.id}>
            {(r) => (
              <Button
                onPress={() => runtime.set(r().id)}
                accessibilityLabel={`Run with ${r().name}`}
                style={{
                  height: 24,
                  paddingHorizontal: 8,
                  borderRadius: 999,
                  justifyContent: "center",
                  borderWidth: 1,
                  borderColor: runtime() === r().id ? p().ink : p().border,
                  backgroundColor: runtime() === r().id ? p().subtle : "transparent",
                }}
              >
                <Text style={{ ...ty.label, color: runtime() === r().id ? p().ink : p().text }}>{r().name}</Text>
              </Button>
            )}
          </Each>
        </View>
        <PrimaryButton label="Start task" disabled={!prompt().trim()} onPress={start} />
      </View>
      <SectionHead title="Tasks" count={props.agents?.tasks.length ?? 0} />
      {props.agents?.tasks.length ? (
        <Each of={props.agents.tasks} key={(t) => t.id}>
          {(t) => (
            <Button
              onPress={() => act({ type: "select_task", id: t().id })}
              accessibilityLabel={`${t().title}, ${t().label}`}
              class="hover:bg-[#f0f0f0] dark:hover:bg-[#232326]"
              style={{
                minHeight: 44,
                paddingHorizontal: 12,
                paddingVertical: 6,
                gap: 4,
                backgroundColor: props.agents?.selected === t().id ? p().subtle : "transparent",
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ ...ty.body, fontSize: 13, color: p().ink, flex: 1, numberOfLines: 1, writingDirection: "auto" }}>{t().title}</Text>
                <StatusBadge tone={t().tone} label={t().label} live={t().live} />
              </View>
              <Text style={{ ...ty.label, color: p().muted, numberOfLines: 1 }}>
                {t().runtime}
                {t().branch ? ` · ${t().branch}` : ""}
              </Text>
            </Button>
          )}
        </Each>
      ) : (
        <Empty text="Tasks you start will appear here, each in its own worktree." />
      )}
      <View style={{ height: 16 }} />
    </Scroll>
  );
}
