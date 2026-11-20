import { Canvas, Text, View, type CanvasRenderingContext2D, type JSX, type ViewStyle } from "nsh";

export function Words(props: { children: JSX.Element; align?: "center" | "right"; dim?: boolean; style?: ViewStyle }) {
  const alignClass = props.align === "center" ? "text-center" : props.align === "right" ? "text-right" : "";
  return (
    <Text class={`font-pixel text-xs leading-[18px] ${props.dim === true ? "text-lcd-dark" : "text-lcd-ink"} ${alignClass}`} style={props.style}>
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
    <View class="relative shrink-0" style={{ width: props.width * zoom(), height: props.height * zoom() }}>
      <View class="pointer-events-none absolute -inset-0.5 border-2 border-lcd-ink" />
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
    <View class={`pointer-events-none absolute inset-0 items-center justify-center ${props.solid === true ? "bg-transparent" : "bg-lcd-panel"}`}>
      <View class={`px-1 ${props.solid === true ? "bg-lcd-paper" : "bg-transparent"}`}>
        <Words align="center">{props.lines.join("\n")}</Words>
      </View>
    </View>
  );
}
export function Stats(props: { label: string; value: number | string }) {
  return (
    <View class="w-full flex-row justify-between">
      <Words>{props.label}</Words>
      <Words>{props.value}</Words>
    </View>
  );
}
export function Help(props: { lines: string[] }) {
  return (
    <View class="mb-[5px] flex-1 justify-end">
      <Words dim align="center">
        {props.lines.join("\n")}
      </Words>
    </View>
  );
}
