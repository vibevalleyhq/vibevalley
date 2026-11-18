import { Canvas, Text, View, type CanvasRenderingContext2D, type JSX, type ViewStyle } from "nsh";

import { lcd } from "./lcd";

export function Words(props: { children: JSX.Element; align?: "center" | "right"; dim?: boolean; style?: ViewStyle }) {
  return (
    <Text style={{ fontFamily: "FusionPixel", fontSize: 12, lineHeight: 18, color: props.dim ? lcd.dark : lcd.ink, textAlign: props.align, ...props.style }}>
      {props.children}
    </Text>
  );
}
export function Board(props: {
  width: number;
  height: number;
  zoom?: number;
  label: string;
  id?: string;
  draw: (ctx: CanvasRenderingContext2D) => void;
  children?: JSX.Element;
}) {
  const zoom = () => props.zoom ?? 1;
  return (
    <View
      style={{ position: "relative", width: props.width * zoom() + 4, height: props.height * zoom() + 4, borderWidth: 2, borderColor: lcd.ink, flexShrink: 0 }}
    >
      <Canvas
        testID={props.id}
        accessible
        role="image"
        accessibilityLabel={props.label}
        style={{ width: props.width * zoom(), height: props.height * zoom() }}
        draw={(ctx) => {
          ctx.scale(zoom(), zoom());
          props.draw(ctx);
        }}
      />
      {props.children}
    </View>
  );
}
export function Cover(props: { lines: string[]; solid?: boolean }) {
  return (
    <View
      style={{
        pointerEvents: "none",
        position: "absolute",
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: props.solid ? "transparent" : "#c9dc9acc",
      }}
    >
      <View style={{ backgroundColor: props.solid ? lcd.paper : "transparent", paddingHorizontal: 4 }}>
        <Words align="center">{props.lines.join("\n")}</Words>
      </View>
    </View>
  );
}
export function Stats(props: { label: string; value: number | string }) {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", width: "100%" }}>
      <Words>{props.label}</Words>
      <Words>{props.value}</Words>
    </View>
  );
}
export function Help(props: { lines: string[] }) {
  return (
    <View style={{ flex: 1, justifyContent: "flex-end", marginBottom: 5 }}>
      <Words dim align="center">
        {props.lines.join("\n")}
      </Words>
    </View>
  );
}
