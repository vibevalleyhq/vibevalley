// Collapsible: a panel shown and hidden by its trigger (Base UI's Collapsible). The trigger says whether it is expanded
// and which panel it controls; the panel is unmounted while closed unless keepMounted, then only hidden.

import { createContext, createUniqueId, omit, Show, useContext } from "solid-js";
import { type ButtonProps, call, createControllable, type DivProps, flag } from "./internal/state";

interface Ctx {
  readonly open: () => boolean;
  readonly setOpen: (open: boolean) => void;
  readonly disabled: () => boolean;
  readonly panelId: string;
}

const Context = createContext<Ctx>();
const use = () => {
  const c = useContext(Context);
  if (!c) throw new Error("Collapsible parts belong inside Collapsible.Root");
  return c;
};

export interface CollapsibleRootProps extends DivProps {
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  disabled?: boolean | undefined;
}

function Root(props: CollapsibleRootProps) {
  const rest = omit(props, "open", "defaultOpen", "onOpenChange", "disabled", "children");
  const [open, setOpen] = createControllable({ value: () => props.open, initial: props.defaultOpen ?? false, onChange: (v) => props.onOpenChange?.(v) });
  const ctx: Ctx = { open, setOpen, disabled: () => Boolean(props.disabled), panelId: createUniqueId() };
  return (
    <Context value={ctx}>
      <div {...rest} data-open={flag(open())} data-closed={flag(!open())} data-disabled={flag(ctx.disabled())}>
        {props.children}
      </div>
    </Context>
  );
}

function Trigger(props: ButtonProps) {
  const c = use();
  const rest = omit(props, "onClick");
  return (
    <button
      type="button"
      {...rest}
      aria-expanded={c.open() ? "true" : "false"}
      aria-controls={c.open() ? c.panelId : undefined}
      disabled={c.disabled() || props.disabled}
      data-panel-open={flag(c.open())}
      data-disabled={flag(c.disabled())}
      onClick={(e) => {
        call(props.onClick, e);
        if (!e.defaultPrevented) c.setOpen(!c.open());
      }}
    />
  );
}

export interface CollapsiblePanelProps extends DivProps {
  /** Kept in the page while closed, only hidden. */
  keepMounted?: boolean | undefined;
}

function Panel(props: CollapsiblePanelProps) {
  const c = use();
  const rest = omit(props, "keepMounted");
  return (
    <Show when={c.open() || props.keepMounted}>
      <div id={c.panelId} {...rest} hidden={!c.open()} data-open={flag(c.open())} data-closed={flag(!c.open())} />
    </Show>
  );
}

export const Collapsible = { Root, Trigger, Panel };
