// The project rail: one tile per open project, ⌘1…9 hints, attention dots.
import { Text, View } from "nsh";
import { Button } from "nsh/base";

import { act } from "../bridge";
import { pressTransition } from "../motion";
import { radius, tok } from "../tokens";

export type RailTab = {
  id: number;
  title: string;
  active: boolean;
  kind: string;
  running?: boolean;
  runningAgent?: string | null;
  runningLabel?: string | null;
  attention?: boolean;
};

export type RailWorktree = {
  path: string;
  branch: string | null;
  main: boolean;
};

export type RailProject = {
  id: number;
  name: string;
  path: string;
  initials: string;
  active: boolean;
  attention: boolean;
  terminals: number;
  shortcut: string | null;
  branch?: string | null;
  mainRoot?: string | null;
  worktrees?: RailWorktree[];
  tabs?: RailTab[];
};

export type RailFrame = { projects: RailProject[]; panel: string; inspectorOpen?: boolean };

const panels = [
  { id: "files", glyph: "▤", label: "Files" },
  { id: "git", glyph: "⑂", label: "Source Control" },
  { id: "agents", glyph: "✦", label: "Agents" },
];

export function ProjectRail(props: { frame: RailFrame | null }) {
  const p = () => tok();
  return (
    <View
      role="toolbar"
      accessibilityLabel="Projects"
      style={{ width: 52, alignItems: "center", paddingVertical: 10, gap: 8, borderRightWidth: 1, borderRightColor: p().border }}
    >
      {(props.frame?.projects ?? []).map((proj) => (
        <Button
          onPress={() => act({ type: "activate_project", id: proj.id })}
          accessibilityLabel={`${proj.name}${proj.shortcut ? `, ${proj.shortcut}` : ""}`}
          tooltip={`${proj.name} — ${proj.path}${proj.shortcut ? ` (${proj.shortcut})` : ""}`}
          class="active:scale-[0.98]"
          style={{
            width: 36,
            height: 36,
            borderRadius: radius.md,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: proj.active ? p().primary : p().tile,
            borderWidth: 1,
            borderColor: proj.active ? p().primary : p().border,
            ...pressTransition(),
          }}
        >
          <Text style={{ fontSize: 12, fontWeight: "600", color: proj.active ? p().onPrimary : p().text }}>{proj.initials}</Text>
          {proj.attention ? (
            <View
              accessibilityLabel="Needs attention"
              style={{ position: "absolute", top: -2, right: -2, width: 8, height: 8, borderRadius: 4, backgroundColor: p().alert }}
            />
          ) : null}
        </Button>
      ))}
      <Button
        onPress={() => act({ type: "add_project" })}
        accessibilityLabel="Add project"
        class="hover:bg-[#f0f0f0] dark:hover:bg-[#232326]"
        style={{ width: 36, height: 36, borderRadius: radius.md, alignItems: "center", justifyContent: "center" }}
      >
        <Text style={{ fontSize: 18, color: p().muted }}>+</Text>
      </Button>
      <View style={{ flex: 1 }} />
      {panels.map((panel) => (
        <Button
          onPress={() => act({ type: "show_panel", panel: panel.id })}
          accessibilityLabel={panel.label}
          tooltip={panel.label}
          style={{
            width: 36,
            height: 32,
            borderRadius: radius.sm,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: props.frame?.panel === panel.id ? p().subtle : "transparent",
          }}
        >
          <Text style={{ fontSize: 15, color: props.frame?.panel === panel.id ? p().ink : p().muted }}>{panel.glyph}</Text>
        </Button>
      ))}
    </View>
  );
}
