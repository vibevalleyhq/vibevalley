// The project rail: one tile per open project, ⌘1…9 hints, attention dots.
import { Text, View } from "nsh";
import { Button } from "nsh/base";

import { act } from "../bridge";
import { pressTransition } from "../motion";
import { radius, tok } from "../tokens";
import { focusRing, SurfaceIcon, type SurfaceIconName, TipBubble } from "./shared";

export type RailRunningState = "working" | "ready" | "idle";

export type RailTab = {
  id: number;
  title: string;
  active: boolean;
  kind: string;
  running?: boolean;
  runningState?: RailRunningState;
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

const panels: { id: string; icon: SurfaceIconName; label: string }[] = [
  { id: "files", icon: "folder", label: "Files" },
  { id: "git", icon: "git-branch", label: "Source Control" },
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
          tooltip={<TipBubble text={`${proj.name} — ${proj.path}${proj.shortcut ? ` (${proj.shortcut})` : ""}`} />}
          activeStyle={{ opacity: 0.82 }}
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
          hoverStyle={proj.active ? undefined : { backgroundColor: p().subtle }}
          focusVisibleStyle={focusRing(p())}
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
        tooltip={<TipBubble text="Add project" />}
        activeStyle={{ opacity: 0.82 }}
        style={{ width: 36, height: 36, borderRadius: radius.md, alignItems: "center", justifyContent: "center", ...pressTransition() }}
        hoverStyle={{ backgroundColor: p().tile }}
        focusVisibleStyle={focusRing(p())}
      >
        <SurfaceIcon name="plus" size={14} color={p().muted} />
      </Button>
      <View style={{ flex: 1 }} />
      {panels.map((panel) => {
        const active = props.frame?.panel === panel.id;
        return (
          <Button
            onPress={() => act({ type: "show_panel", panel: panel.id })}
            accessibilityLabel={panel.label}
            tooltip={<TipBubble text={panel.label} />}
            activeStyle={{ opacity: 0.82 }}
            style={{
              width: 36,
              height: 32,
              borderRadius: radius.sm,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: active ? p().subtle : "transparent",
              ...pressTransition(),
            }}
            hoverStyle={active ? undefined : { backgroundColor: p().tile }}
            focusVisibleStyle={focusRing(p())}
          >
            <SurfaceIcon name={panel.icon} size={14} color={active ? p().ink : p().muted} />
          </Button>
        );
      })}
    </View>
  );
}
