// Interactive generative UI view backed by native Rust `vibevalley/rich` (`VvGenUi`
// via vibevalley-genui + native nsh elements), with a lightweight interactive fallback
// for stock `nsh test` where the native rich UI set is unavailable.
import { signal, Text, untracked, View } from "nsh";
import { z } from "zod";

import { jsonString } from "@vibevalley/protocol/schema";

import { useDesignHost, type DesignGenUiActionEvent } from "../host";

/** Formats a GenUI action event into a concise human-readable line for toasts or channel feedback. */
export function formatGenUiAction(event: DesignGenUiActionEvent): string {
  const action = event.action.trim();
  const payload = event.payload.trim();
  if (action === "state_change") return payload;
  if (!action) return payload;
  return payload ? `${action}: ${payload}` : action;
}

export interface GenUiProps {
  spec: string;
  streaming?: boolean;
  onAction?: (event: DesignGenUiActionEvent) => void;
  class?: string | undefined;
}

type FallbackControl =
  | { readonly id: string; readonly kind: "switch"; readonly bind: string; readonly label: string }
  | {
      readonly id: string;
      readonly kind: "select";
      readonly bind: string;
      readonly label: string;
      readonly options: readonly { readonly value: string; readonly label: string }[];
    }
  | {
      readonly id: string;
      readonly kind: "tabs";
      readonly bind: string;
      readonly tabs: readonly { readonly id: string; readonly label: string }[];
    };

const FallbackSelectOptionSchema = z.object({ value: z.string(), label: z.string() });
const FallbackTabSchema = z.object({ id: z.string(), label: z.string() });
const FallbackNodeSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string(), kind: z.literal("switch"), bind: z.string(), label: z.string() }),
  z.object({ id: z.string(), kind: z.literal("select"), bind: z.string(), label: z.string(), options: z.array(FallbackSelectOptionSchema) }),
  z.object({ id: z.string(), kind: z.literal("tabs"), bind: z.string(), tabs: z.array(FallbackTabSchema) }),
]);

const FallbackPatchSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("title"), title: z.string() }),
  z.object({ op: z.literal("state_init"), state: z.record(z.string(), z.unknown()) }),
  z.object({ op: z.literal("set_node"), node: z.unknown() }),
]);
const FallbackPatchJsonSchema = jsonString(FallbackPatchSchema);

function parseFallbackSpec(spec: string): { title?: string; state: Record<string, unknown>; controls: FallbackControl[] } {
  let title: string | undefined;
  const state: Record<string, unknown> = {};
  const controls: FallbackControl[] = [];
  for (const rawLine of spec.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith("{")) continue;
    const patch = FallbackPatchJsonSchema.safeParse(line);
    if (!patch.success) continue;
    switch (patch.data.op) {
      case "title":
        title = patch.data.title;
        break;
      case "state_init":
        Object.assign(state, patch.data.state);
        break;
      case "set_node": {
        const node = FallbackNodeSchema.safeParse(patch.data.node);
        if (node.success) controls.push(node.data);
        break;
      }
    }
  }
  return { ...(title !== undefined ? { title } : {}), state, controls };
}

export function GenUi(props: GenUiProps) {
  const native = useDesignHost().rich();
  if (native) {
    const VvGenUi = native.VvGenUi;
    return <VvGenUi spec={props.spec} streaming={props.streaming} onAction={props.onAction} class={props.class} />;
  }
  return <GenUiFallback spec={props.spec} onAction={props.onAction} class={props.class} />;
}

function formatStateValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function asSwitch(c: FallbackControl) {
  return c.kind === "switch" ? c : undefined;
}

function asSelect(c: FallbackControl) {
  return c.kind === "select" ? c : undefined;
}

function asTabs(c: FallbackControl) {
  return c.kind === "tabs" ? c : undefined;
}

function GenUiFallback(props: { spec: string; onAction?: ((event: DesignGenUiActionEvent) => void) | undefined; class?: string | undefined }) {
  const parsed = () => parseFallbackSpec(props.spec);
  const overrides = signal<Record<string, unknown>>({});
  const stateOf = (bind: string): unknown => {
    const current = overrides();
    return Object.hasOwn(current, bind) ? current[bind] : parsed().state[bind];
  };
  const setState = (bind: string, value: string | boolean) => {
    overrides.set({ ...untracked(overrides), [bind]: value });
    props.onAction?.({ action: "state_change", payload: `${bind}=${String(value)}` });
  };
  return (
    <View testID="genui" accessibilityLabel="GenUI" class={`my-2 max-w-full gap-2 rounded-md border border-line bg-side p-3 ${props.class ?? ""}`}>
      <If when={parsed().title}>{(title) => <Text class="text-sm font-semibold text-ink">{title()}</Text>}</If>
      <If when={parsed().controls.length > 0} else={<Text class="font-mono text-xs text-muted">{props.spec}</Text>}>
        <View class="gap-2">
          <Each of={parsed().controls} key={(c) => c.id}>
            {(ctrl) => (
              <>
                <If when={asSwitch(ctrl())}>
                  {(sw) => {
                    const checked = () => Boolean(stateOf(sw().bind));
                    return (
                      <View
                        role="button"
                        testID={`genui-switch-${sw().id}`}
                        accessibilityLabel={sw().label}
                        accessibilityState={{ checked: checked() }}
                        onPress={() => setState(sw().bind, !checked())}
                        class="flex-row items-center gap-2 self-start rounded-md border border-line bg-page px-2.5 py-1 hover:bg-hover"
                      >
                        <Text class="text-xs font-medium text-ink">{`${sw().label}: ${checked() ? "on" : "off"}`}</Text>
                      </View>
                    );
                  }}
                </If>
                <If when={asSelect(ctrl())}>
                  {(sel) => (
                    <View class="flex-row flex-wrap items-center gap-1.5">
                      <Text class="text-xs text-muted">{sel().label}</Text>
                      <Each of={sel().options} key={(o) => o.value}>
                        {(opt) => {
                          const selected = () => formatStateValue(stateOf(sel().bind)) === opt().value;
                          return (
                            <View
                              role="button"
                              testID={`genui-select-${sel().id}-${opt().value}`}
                              accessibilityState={{ selected: selected() }}
                              onPress={() => setState(sel().bind, opt().value)}
                              class={`rounded-sm border px-2 py-0.5 ${selected() ? "border-accent bg-selected" : "border-line bg-page hover:bg-hover"}`}
                            >
                              <Text class="text-xs text-ink">{opt().label}</Text>
                            </View>
                          );
                        }}
                      </Each>
                    </View>
                  )}
                </If>
                <If when={asTabs(ctrl())}>
                  {(tabs) => (
                    <View class="flex-row flex-wrap items-center gap-1.5">
                      <Each of={tabs().tabs} key={(tab) => tab.id}>
                        {(tab) => {
                          const active = () => (formatStateValue(stateOf(tabs().bind)) || tabs().tabs[0]?.id || "") === tab().id;
                          return (
                            <View
                              role="tab"
                              testID={`genui-tab-${tabs().id}-${tab().id}`}
                              accessibilityState={{ selected: active() }}
                              onPress={() => setState(tabs().bind, tab().id)}
                              class={`rounded-sm border px-2 py-0.5 ${active() ? "border-accent bg-selected" : "border-line bg-page hover:bg-hover"}`}
                            >
                              <Text class="text-xs text-ink">{tab().label}</Text>
                            </View>
                          );
                        }}
                      </Each>
                    </View>
                  )}
                </If>
              </>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}
