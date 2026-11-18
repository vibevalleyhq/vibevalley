// Gallery: every component's stories on one scrolling page, for review and
// for the tests. `story` shows one story alone (the tests' screenshots).
// The app agent can host it as the `stories` view; it needs no bridge.
import { Scroll, setColorScheme, colorScheme, reduceMotion, Text, View } from "nsh";

import { tok, type as ty } from "../tokens";
import { agentStories } from "./stories/agent.story";
import { issueStories } from "./stories/issue.story";
import type { Story } from "./stories/story";

export const stories: Story[] = [...agentStories, ...issueStories];

export function Gallery(props: { story?: string | null; width?: number }) {
  const p = () => tok();
  const shown = () => (props.story ? stories.filter((s) => s.id === props.story) : stories);
  return (
    <Scroll style={{ flex: 1, backgroundColor: p().canvas }} contentStyle={{ padding: 20, gap: 28 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Text role="header" accessibilityLevel={1} style={{ ...ty.title, fontWeight: "600", color: p().ink, flex: 1 }}>
          VibeValley components
        </Text>
        <Text style={{ ...ty.label, color: p().muted }}>{reduceMotion() ? "Reduced motion" : "Full motion"}</Text>
        <View
          onPress={() => setColorScheme(colorScheme() === "dark" ? "light" : "dark")}
          role="button"
          accessibilityLabel="Switch light and dark"
          style={{ height: 28, paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: p().border, justifyContent: "center" }}
          hoverStyle={{ backgroundColor: p().subtle }}
          focusVisibleStyle={{ outlineWidth: 2, outlineColor: p().focus, outlineOffset: 2, outlineStyle: "solid" }}
        >
          <Text style={{ ...ty.label, color: p().ink }}>{colorScheme() === "dark" ? "Dark" : "Light"}</Text>
        </View>
      </View>
      <Each of={shown()} key={(s) => s.id}>
        {(s) => (
          <View testID={`story-${s().id}`} style={{ gap: 10, maxWidth: props.width ?? 640 }}>
            <Text role="header" accessibilityLevel={2} style={{ ...ty.label, fontWeight: "600", color: p().muted, letterSpacing: 0.4 }}>
              {s().title}
            </Text>
            {s().render()}
          </View>
        )}
      </Each>
    </Scroll>
  );
}
