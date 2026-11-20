// Gallery: every component's stories on one scrolling page, for review and
// for the tests. `story` shows one story alone (the tests' screenshots).
// The app agent can host it as the `stories` view; it needs no bridge.
import { colorScheme, reduceMotion, Scroll, setColorScheme, signal, Text, View } from "nsh";
import { Button } from "nsh/base";

import { pressTransition } from "../motion";
import { TipBubble } from "../surfaces/shared";
import { cardShadow, radius, tok, type as ty } from "../tokens";
import { agentStories } from "./stories/agent.story";
import { issueStories } from "./stories/issue.story";
import type { Story } from "./stories/story";

export const stories: Story[] = [...agentStories, ...issueStories];

function SchemeOption(props: { label: string; active: boolean; onSelect: () => void; tip: string }) {
  const p = () => tok();
  return (
    <Button
      onPress={props.onSelect}
      selected={props.active}
      accessibilityLabel={props.active ? props.label : "Switch light and dark"}
      tooltip={<TipBubble text={props.tip} />}
      style={{
        height: 24,
        paddingHorizontal: 10,
        borderRadius: 999,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: props.active ? p().surface : "transparent",
        boxShadow: props.active ? cardShadow(p()) : [],
        ...pressTransition(),
      }}
      hoverStyle={{ backgroundColor: props.active ? p().surface : p().subtle }}
      focusVisibleStyle={{ outlineWidth: 2, outlineColor: p().focus, outlineOffset: 2, outlineStyle: "solid" }}
    >
      <Text style={{ fontSize: 11.5, lineHeight: 14, fontWeight: props.active ? "600" : "500", color: props.active ? p().ink : p().muted }}>{props.label}</Text>
    </Button>
  );
}

function FilterChip(props: { label: string; active: boolean; onPress: () => void }) {
  const p = () => tok();
  return (
    <Button
      onPress={props.onPress}
      selected={props.active}
      style={{
        height: 26,
        paddingHorizontal: 10,
        borderRadius: 999,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: props.active ? p().primary : p().surface,
        borderWidth: 1,
        borderColor: props.active ? p().primary : p().border,
        ...pressTransition(),
      }}
      hoverStyle={{ backgroundColor: props.active ? p().primary : p().subtle }}
      focusVisibleStyle={{ outlineWidth: 2, outlineColor: p().focus, outlineOffset: 2, outlineStyle: "solid" }}
    >
      <Text style={{ fontSize: 11.5, lineHeight: 14, fontWeight: props.active ? "600" : "500", color: props.active ? p().onPrimary : p().text }}>
        {props.label}
      </Text>
    </Button>
  );
}

export function Gallery(props: { story?: string | null; width?: number }) {
  const p = () => tok();
  const selected = signal<string | null>(null);
  const maxWidth = () => props.width ?? 640;
  const shown = () => {
    if (props.story) return stories.filter((s) => s.id === props.story);
    const pick = selected();
    return pick ? stories.filter((s) => s.id === pick) : stories;
  };
  const dark = () => colorScheme() === "dark";
  return (
    <Scroll style={{ flex: 1, backgroundColor: p().canvas }} contentStyle={{ padding: 20, gap: 20 }}>
      <View style={{ maxWidth: maxWidth(), width: "100%", gap: 12, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: p().border }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flex: 1, minWidth: 180 }}>
            <Text role="header" accessibilityLevel={1} style={{ fontSize: 15, lineHeight: 20, fontWeight: "600", color: p().ink }}>
              VibeValley components
            </Text>
            <View
              style={{
                height: 18,
                paddingHorizontal: 6,
                borderRadius: 999,
                backgroundColor: p().tile,
                borderWidth: 1,
                borderColor: p().border,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ fontFamily: ty.mono.fontFamily, fontSize: 10.5, lineHeight: 14, color: p().muted, fontVariant: ["tabular-nums"] }}>
                {shown().length.toLocaleString()}
              </Text>
            </View>
          </View>
          <View
            style={{
              height: 24,
              paddingHorizontal: 8,
              borderRadius: 999,
              backgroundColor: p().tile,
              borderWidth: 1,
              borderColor: p().border,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ fontSize: 11, lineHeight: 14, color: p().muted }}>{reduceMotion() ? "Reduced motion" : "Full motion"}</Text>
          </View>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 2,
              padding: 2,
              borderRadius: 999,
              backgroundColor: p().tile,
              borderWidth: 1,
              borderColor: p().border,
            }}
          >
            <SchemeOption label="Light" active={!dark()} onSelect={() => setColorScheme("light")} tip="Switch to light theme" />
            <SchemeOption label="Dark" active={dark()} onSelect={() => setColorScheme("dark")} tip="Switch to dark theme" />
          </View>
        </View>
        {!props.story && stories.length > 1 ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <FilterChip label="All" active={selected() === null} onPress={() => selected.set(null)} />
            <Each of={stories} key={(s) => s.id}>
              {(s) => <FilterChip label={s().title} active={selected() === s().id} onPress={() => selected.set(s().id)} />}
            </Each>
          </View>
        ) : null}
      </View>
      <Each of={shown()} key={(s) => s.id}>
        {(s) => (
          <View
            testID={`story-${s().id}`}
            style={{
              maxWidth: maxWidth(),
              width: "100%",
              borderRadius: radius.card,
              borderWidth: 1,
              borderColor: p().border,
              backgroundColor: p().canvas,
              overflow: "hidden",
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                paddingHorizontal: 14,
                paddingVertical: 9,
                backgroundColor: p().surface,
                borderBottomWidth: 1,
                borderBottomColor: p().border,
              }}
            >
              <Text role="header" accessibilityLevel={2} style={{ fontSize: 12, lineHeight: 16, fontWeight: "600", color: p().ink }}>
                {s().title}
              </Text>
              <Text style={{ fontFamily: ty.mono.fontFamily, fontSize: 11, lineHeight: 14, color: p().faint }}>{s().id}</Text>
            </View>
            <View style={{ padding: 16, backgroundColor: p().canvas }}>{s().render()}</View>
          </View>
        )}
      </Each>
    </Scroll>
  );
}
