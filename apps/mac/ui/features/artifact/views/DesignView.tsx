import { computed, effect, Scroll, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { Button } from "../../../design/Button";
import { TextInput } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { Empty, Toggle } from "../../../design/layout";
import { Segmented } from "../../../design/Segmented";
import { mix } from "../../../design/tone";
import { type DesignFrameModel, type DesignNode, type DesignPropDef, resolveDesignColor, resolveDesignExpr } from "./previewModel";

function PropControl(props: {
  readonly prop: DesignPropDef;
  readonly value: string | number | boolean;
  readonly onChange: (val: string | number | boolean) => void;
}) {
  return (
    <View class="gap-1.5 rounded-md border border-line bg-page p-2.5">
      <View class="flex-row items-center justify-between gap-2">
        <Text class="text-xs font-medium text-ink">{props.prop.label}</Text>
        <Text class="font-mono text-2xs text-faint">{props.prop.name}</Text>
      </View>

      <If when={props.prop.type === "boolean"}>
        <Toggle
          testid={`design-prop-${props.prop.name}`}
          label={props.value === true ? t("web.artifact.design.enabled") : t("web.artifact.design.disabled")}
          checked={props.value === true}
          onChange={(checked) => props.onChange(checked)}
        />
      </If>

      <If when={props.prop.type === "select"}>
        <View class="flex-row flex-wrap gap-1">
          <Each of={props.prop.options} key={(opt) => opt}>
            {(opt) => (
              <Button size="compact" tone={String(props.value) === opt() ? "primary" : "plain"} onPress={() => props.onChange(opt())}>
                {opt()}
              </Button>
            )}
          </Each>
        </View>
      </If>

      <If when={props.prop.type === "text" || props.prop.type === "number" || props.prop.type === "color"}>
        <TextInput
          testID={`design-prop-${props.prop.name}`}
          accessibilityLabel={props.prop.label}
          value={String(props.value)}
          onInput={(v) => props.onChange(props.prop.type === "number" && Number.isFinite(Number(v)) ? Number(v) : v)}
        />
      </If>
    </View>
  );
}

function isNodeVisible(node: DesignNode, propValues: Readonly<Record<string, string | number | boolean>>): boolean {
  if (node.visibleWhen === undefined) return true;
  if (!Object.hasOwn(propValues, node.visibleWhen)) return true;
  const val = propValues[node.visibleWhen];
  return val !== false && val !== "" && val !== 0;
}

function DesignNodeCanvas(props: {
  readonly node: DesignNode;
  readonly theme: "light" | "dark";
  readonly propValues: Readonly<Record<string, string | number | boolean>>;
  readonly depth: number;
}) {
  const visible = () => isNodeVisible(props.node, props.propValues);
  const labelText = () => resolveDesignExpr(props.node.text || props.node.name, props.propValues);
  const fillBg = () => resolveDesignColor(props.node.fill, props.theme, props.propValues);
  const fgColor = () => resolveDesignColor(props.node.color, props.theme, props.propValues);
  const visibleChildren = computed(() => props.node.children.filter((c) => isNodeVisible(c, props.propValues)));
  const surfaceBg = () => resolveDesignColor("{color.surface}", props.theme);
  const panelBg = () => resolveDesignColor("{color.panel}", props.theme);
  const inkColor = () => resolveDesignColor("{color.ink}", props.theme);
  const mutedColor = () => resolveDesignColor("{color.muted}", props.theme);
  const accentBg = () => resolveDesignColor("{color.accent}", props.theme);
  const borderColor = () => resolveDesignColor("{color.border}", props.theme);

  return (
    <If when={visible()}>
      <If when={props.node.kind === "divider"}>
        <View class="my-1 h-px w-full" style={borderColor() !== undefined ? { backgroundColor: borderColor() } : undefined} />
      </If>

      <If when={props.node.kind === "text"}>
        <Text
          class={props.node.variant === "heading" || props.depth <= 1 ? "text-base font-semibold" : props.node.variant === "muted" ? "text-xs" : "text-sm"}
          style={{
            color: fgColor() ?? (props.node.variant === "muted" ? mutedColor() : inkColor()),
          }}
        >
          {labelText()}
        </Text>
      </If>

      <If when={props.node.kind === "badge"}>
        <View
          class="self-start rounded-full border px-2.5 py-0.5"
          style={{
            backgroundColor: fillBg() ?? panelBg(),
            borderColor: borderColor(),
          }}
        >
          <Text class="text-2xs font-semibold" style={{ color: fgColor() ?? inkColor() }}>
            {labelText()}
          </Text>
        </View>
      </If>

      <If when={props.node.kind === "button"}>
        <View
          class="items-center justify-center self-start px-3.5 py-2"
          style={{
            borderRadius: props.node.radius,
            backgroundColor: fillBg() ?? (props.node.variant === "primary" ? accentBg() : panelBg()),
            borderWidth: 1,
            borderColor: props.node.variant === "primary" ? (fillBg() ?? accentBg()) : borderColor(),
          }}
        >
          <Text
            class="text-xs font-semibold"
            style={{
              color: fgColor() ?? (props.node.variant === "primary" ? surfaceBg() : inkColor()),
            }}
          >
            {labelText()}
          </Text>
        </View>
      </If>

      <If when={props.node.kind === "input"}>
        <View
          class="justify-center border px-3 py-2"
          style={{
            borderRadius: props.node.radius,
            backgroundColor: fillBg() ?? surfaceBg(),
            borderColor: borderColor(),
          }}
        >
          <Text class="text-xs" style={{ color: mutedColor() }}>
            {labelText()}
          </Text>
        </View>
      </If>

      <If when={props.node.kind === "image" || props.node.kind === "icon"}>
        <View
          class="items-center justify-center gap-1 border p-3"
          style={{
            borderRadius: props.node.radius,
            minHeight: Math.min(140, props.node.height ?? 92),
            backgroundColor: fillBg() ?? panelBg(),
            borderColor: borderColor(),
          }}
        >
          <Icon name={props.node.kind === "icon" ? "bolt" : "image"} size={18} tone="muted" />
          <Text class="font-mono text-2xs" style={{ color: mutedColor() }}>
            {props.node.src ?? labelText()}
          </Text>
        </View>
      </If>

      <If when={props.node.kind === "table"}>
        <View class="overflow-hidden border" style={{ borderRadius: props.node.radius, borderColor: borderColor(), backgroundColor: surfaceBg() }}>
          <If when={props.node.columns.length > 0}>
            <View class="flex-row gap-2 border-b px-3 py-1.5" style={{ borderColor: borderColor(), backgroundColor: panelBg() }}>
              <Each of={props.node.columns} key={(c) => c}>
                {(c) => (
                  <Text class="min-w-0 flex-1 truncate text-2xs font-semibold" style={{ color: mutedColor() }}>
                    {c()}
                  </Text>
                )}
              </Each>
            </View>
          </If>
          <Each of={props.node.rows} key={(_, idx) => String(idx)}>
            {(r) => (
              <View class="flex-row gap-2 border-t px-3 py-1.5" style={{ borderColor: borderColor() }}>
                <Each of={r()} key={(_, idx) => String(idx)}>
                  {(cell) => (
                    <Text class="min-w-0 flex-1 truncate text-xs" style={{ color: inkColor() }}>
                      {resolveDesignExpr(cell(), props.propValues)}
                    </Text>
                  )}
                </Each>
              </View>
            )}
          </Each>
        </View>
      </If>

      <If
        when={
          props.node.kind !== "divider" &&
          props.node.kind !== "text" &&
          props.node.kind !== "badge" &&
          props.node.kind !== "button" &&
          props.node.kind !== "input" &&
          props.node.kind !== "image" &&
          props.node.kind !== "icon" &&
          props.node.kind !== "table"
        }
      >
        <View
          class={props.node.kind === "grid" ? "flex-row flex-wrap" : props.node.direction === "horizontal" ? "flex-row flex-wrap items-start" : "flex-col"}
          style={{
            gap: props.node.gap,
            padding: props.node.padding,
            borderRadius: props.node.radius,
            backgroundColor: fillBg() ?? (props.node.kind === "card" ? panelBg() : undefined),
            borderWidth: 1,
            borderColor: props.node.kind === "card" ? borderColor() : mix("line", 0),
            minWidth: props.node.kind === "card" ? 200 : undefined,
            flexGrow: props.node.kind === "card" ? 1 : undefined,
          }}
        >
          <If when={visibleChildren().length === 0 && labelText().length > 0}>
            <Text class="text-xs font-medium" style={{ color: inkColor() }}>
              {labelText()}
            </Text>
          </If>
          <Each of={visibleChildren()} key={(child) => child.id}>
            {(child) => <DesignNodeCanvas node={child()} theme={props.theme} propValues={props.propValues} depth={props.depth + 1} />}
          </Each>
        </View>
      </If>
    </If>
  );
}

export function DesignView(props: {
  readonly frames: readonly DesignFrameModel[];
  readonly activeFramePath: string | undefined;
  readonly onSelectFrame: (path: string) => void;
}) {
  const currentFrame = computed((): DesignFrameModel | undefined => props.frames.find((f) => f.path === props.activeFramePath) ?? props.frames.at(0));
  const previewTheme = signal<"light" | "dark">("light");
  const propOverrides = signal<Record<string, string | number | boolean>>({});

  effect(() => {
    const f = currentFrame();
    if (f === undefined) return;
    if (untracked(() => Object.keys(propOverrides())).length > 0) {
      propOverrides.set({});
    }
    previewTheme.set(f.theme);
  });

  const resolvedPropValues = computed((): Record<string, string | number | boolean> => {
    const f = currentFrame();
    const out: Record<string, string | number | boolean> = {};
    if (f !== undefined) {
      for (const p of f.props) {
        out[p.name] = p.value;
      }
    }
    for (const [k, v] of Object.entries(propOverrides())) {
      out[k] = v;
    }
    return out;
  });

  const setPropValue = (name: string, value: string | number | boolean) => {
    propOverrides.set({ ...untracked(propOverrides), [name]: value });
  };

  return (
    <View testID="artifact-design-view" class="min-h-0 flex-1">
      <View class="shrink-0 flex-row flex-wrap items-center justify-between gap-2 border-b border-line bg-side px-3 py-1.5">
        <Scroll horizontal class="min-w-0 flex-1" contentClass="flex-row items-center gap-1.5">
          <Each of={props.frames} key={(f) => f.path}>
            {(f) => (
              <Button size="compact" tone={currentFrame()?.path === f().path ? "primary" : "plain"} onPress={() => props.onSelectFrame(f().path)}>
                {f().name}
              </Button>
            )}
          </Each>
        </Scroll>
        <View class="shrink-0 flex-row items-center gap-2">
          <If when={currentFrame()}>{(f) => <Text class="font-mono text-2xs text-muted tabular-nums">{`${f().width} × ${f().height}`}</Text>}</If>
          <Segmented
            testid="design-theme-toggle"
            label={t("web.artifact.designSystem.previewTheme")}
            value={previewTheme()}
            onChange={(v) => previewTheme.set(v)}
            options={[
              { value: "light" as const, icon: "themeLight", label: t("web.artifact.design.themeLight") },
              { value: "dark" as const, icon: "themeDark", label: t("web.artifact.design.themeDark") },
            ]}
          />
        </View>
      </View>

      <If when={currentFrame()} else={<Empty icon="devices">{t("web.artifact.design.emptyCanvas")}</Empty>}>
        {(frame) => {
          const canvasBg = () =>
            resolveDesignColor(frame().background ?? "{color.surface}", previewTheme(), resolvedPropValues()) ??
            resolveDesignColor("{color.surface}", previewTheme());
          const hasContent = () => frame().root !== undefined || frame().nodes.length > 0;
          return (
            <View class="min-h-0 flex-1 flex-row">
              <Scroll testID="design-artboard-canvas" class="min-h-0 min-w-0 flex-1 bg-side" contentClass="items-center p-5">
                <View
                  class="w-full max-w-4xl overflow-hidden rounded-xl border border-line shadow-raise"
                  style={canvasBg() !== undefined ? { backgroundColor: canvasBg() } : undefined}
                >
                  <View class="flex-row items-center justify-between border-b border-line px-4 py-2 opacity-80">
                    <Text class="font-mono text-2xs font-semibold" style={{ color: resolveDesignColor("{color.muted}", previewTheme()) }}>
                      {frame().name}
                    </Text>
                    <Text class="font-mono text-2xs tabular-nums" style={{ color: resolveDesignColor("{color.muted}", previewTheme()) }}>
                      {`${frame().width} × ${frame().height}`}
                    </Text>
                  </View>

                  <View class="p-4">
                    <If
                      when={hasContent()}
                      else={
                        <View class="items-center justify-center gap-2 py-12">
                          <Icon name="devices" size={24} tone="muted" />
                          <Text class="text-xs text-muted">{t("web.artifact.design.emptyCanvas")}</Text>
                        </View>
                      }
                    >
                      <If when={frame().root}>
                        {(rootNode) => <DesignNodeCanvas node={rootNode()} theme={previewTheme()} propValues={resolvedPropValues()} depth={0} />}
                      </If>
                      <If when={frame().root === undefined && frame().nodes.length > 0}>
                        <View class="flex-row flex-wrap gap-3">
                          <Each of={frame().nodes} key={(n) => n.id}>
                            {(n) => <DesignNodeCanvas node={n()} theme={previewTheme()} propValues={resolvedPropValues()} depth={1} />}
                          </Each>
                        </View>
                      </If>
                    </If>
                  </View>
                </View>
              </Scroll>

              <If when={frame().props.length > 0}>
                <View testID="design-props-panel" class="w-64 shrink-0 border-l border-line bg-side">
                  <View class="border-b border-line px-3 py-2">
                    <Text class="text-xs font-semibold text-muted">{t("web.artifact.design.propsTitle")}</Text>
                  </View>
                  <Scroll class="min-h-0 flex-1" contentClass="gap-2.5 p-3">
                    <Each of={frame().props} key={(p) => p.name}>
                      {(p) => <PropControl prop={p()} value={resolvedPropValues()[p().name] ?? p().value} onChange={(val) => setPropValue(p().name, val)} />}
                    </Each>
                  </Scroll>
                </View>
              </If>
            </View>
          );
        }}
      </If>
    </View>
  );
}
